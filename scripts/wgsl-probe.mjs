#!/usr/bin/env -S deno run --unstable-webgpu --allow-read
/**
 * Executes the project's real WGSL through the real pass chain and reads the
 * pixels back.
 *
 * Browsers are the only place the WebGPU backend normally runs, and a headless
 * Chromium without WebGPU cannot test it at all. Deno ships wgpu natively, so
 * this harness builds the same bind group layouts, pipelines and render-target
 * chain as src/renderer/gpu/webgpuBackend.js, drives one frame, and copies the
 * result into a readable buffer. Validation errors that a browser would only
 * report through `uncapturederror` surface here as hard failures.
 *
 *   deno run --unstable-webgpu --allow-read scripts/wgsl-probe.mjs
 */
import { WGSL } from '../src/renderer/gpu/shaders.wgsl.js';
import { makeLayouts, makePipeline, probeWebGPU } from '../src/renderer/gpu/webgpuBackend.js';
import { packEffectUniforms, hexToRgb } from '../src/renderer/params.js';
import { DEFAULT_SETTINGS } from '../src/lib/schema.js';

const W = 64;
const H = 64;
const UNIFORM_FLOATS = 13 * 4;
const RAMP_MAX = 128;

const EFFECT_ID = {
  ascii: 0, waveLines: 1, dithering: 2, halftone: 3, dots: 4, contour: 5,
  edgeDetection: 6, crosshatch: 7, blockify: 8, threshold: 9, noiseField: 10,
  matrixRain: 11, vhs: 12, voronoi: 13,
};

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
};

const adapter = await navigator.gpu?.requestAdapter();
if (!adapter) {
  console.error('wgsl-probe: no WebGPU adapter available');
  Deno.exit(1);
}
const device = await adapter.requestDevice();

const errors = [];
device.addEventListener?.('uncapturederror', (e) => errors.push(String(e.error)));

/**
 * Red-dominant top, blue-dominant bottom (so orientation is checkable), over a
 * left-to-right brightness ramp that crosses 0.5 luminance (so threshold-style
 * effects have both sides of their cut present).
 */
function sourcePixels() {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = (x + 0.5) / W;
      const top = y < H / 2;
      data[i] = Math.round((top ? 255 : 40) * v);
      data[i + 1] = Math.round(200 * v);
      data[i + 2] = Math.round((top ? 40 : 255) * v);
      data[i + 3] = 255;
    }
  }
  return data;
}

/** A 2x2-cell atlas with ink in three of four cells. */
function atlasPixels() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cell = (y < 32 ? 0 : 2) + (x < 32 ? 0 : 1);
      const ink = cell === 0 ? 0 : 255; // glyph 0 is blank, like a space
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = ink;
    }
  }
  return { data, size, cols: 2, rows: 2, count: 4 };
}

const module = device.createShaderModule({ code: WGSL });
const info = await module.getCompilationInfo();
const fatal = info.messages.filter((m) => m.type === 'error');
check('WGSL compiles', fatal.length === 0, fatal.map((m) => `${m.lineNum}: ${m.message}`).join(' | '));
if (fatal.length) Deno.exit(1);

const uniformBuffer = device.createBuffer({
  size: UNIFORM_FLOATS * 4,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
const rampBuffer = device.createBuffer({
  size: RAMP_MAX * 4,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

const tex = (w, h, extra = 0) =>
  device.createTexture({
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT | extra,
  });

const srcTex = tex(W, H);
const fxTex = tex(W, H);
const outTex = tex(W, H, GPUTextureUsage.COPY_SRC);
const atlas = atlasPixels();
const atlasTex = tex(atlas.size, atlas.size);

device.queue.writeTexture({ texture: srcTex }, sourcePixels(), { bytesPerRow: W * 4 }, { width: W, height: H });
device.queue.writeTexture({ texture: atlasTex }, atlas.data, { bytesPerRow: atlas.size * 4 },
  { width: atlas.size, height: atlas.size });

/* The production layouts, imported rather than reimplemented: a test that
   builds its own bind groups cannot catch a layout regression. */
const layouts = makeLayouts(device);

device.pushErrorScope('validation');
const pipes = {
  cells: makePipeline(device, module, layouts.cells, 'fsCells', 'rgba8unorm'),
  main: makePipeline(device, module, layouts.main, 'fsMain', 'rgba8unorm'),
  post: makePipeline(device, module, layouts.post, 'fsPost', 'rgba8unorm'),
};
const pipeErr = await device.popErrorScope();
check('pipelines build', !pipeErr, pipeErr ? String(pipeErr.message).slice(0, 220) : '');

// The shipped startup probe, exercised exactly as the engine calls it. This is
// what decides whether WebGPU is trusted at all, so it must be tested directly.
const probeErrors = [];
const probed = await probeWebGPU((e) => probeErrors.push(String(e?.message ?? e)));
check('production probeWebGPU accepts this device', !!probed,
  probeErrors.join(' | ') || 'returned null');
probed?.device?.destroy?.();

function writeUniforms(settings, grid, rampLen) {
  const a = settings.adjustments;
  const u = new Float32Array(UNIFORM_FLOATS);
  const ga = hexToRgb(a.gradientFrom);
  const gb = hexToRgb(a.gradientTo);
  const { floats, ints } = packEffectUniforms(settings.effect, settings.effectParams[settings.effect] ?? {}, 0);
  u.set([W, H, 1 / W, 1 / H], 0);
  u.set([grid.cols, grid.rows, atlas.cols, atlas.rows], 4);
  u.set([a.brightness, a.contrast, a.saturation, (a.hue * Math.PI) / 180], 8);
  u.set([a.sharpness, a.gamma, a.colorMode === 'mono' ? 1 : a.colorMode === 'gradient' ? 2 : 0, a.backgroundIntensity], 12);
  u.set([ga[0], ga[1], ga[2], 0], 16);
  u.set([gb[0], gb[1], gb[2], 0], 20);
  u.set([EFFECT_ID[settings.effect] ?? 0, settings.ascii.spacing, settings.ascii.threshold, settings.ascii.tilt], 24);
  u.set([settings.ascii.spatialWeight, rampLen, atlas.count, 0], 28);
  u.set([floats[0], floats[1], floats[2], floats[3]], 32);
  u.set([floats[4], floats[5], floats[6], floats[7]], 36);
  u.set([ints[0], ints[1], ints[2], ints[3]], 40);
  u.set([settings.post.bloom, settings.post.bloomThreshold, settings.post.scanlines, settings.post.vignette], 44);
  u.set([settings.post.chromatic, settings.post.grain, 0, 0], 48);
  device.queue.writeBuffer(uniformBuffer, 0, u);
}

async function renderOnce(settings) {
  const isAscii = settings.effect === 'ascii';
  const grid = isAscii ? { cols: 16, rows: 16 } : { cols: 1, rows: 1 };
  const cellTex = tex(grid.cols, grid.rows);

  const ramp = new Uint32Array(RAMP_MAX);
  // Light -> dark, matching the renderer's ink-sorted ordering.
  ramp.set([0, 1, 2, 3]);
  device.queue.writeBuffer(rampBuffer, 0, ramp);
  writeUniforms(settings, grid, 4);

  const bgCells = device.createBindGroup({ layout: layouts.cells, entries: [
    { binding: 0, resource: { buffer: uniformBuffer } },
    { binding: 2, resource: sampler },
    { binding: 4, resource: srcTex.createView() },
  ]});
  const bgMain = device.createBindGroup({ layout: layouts.main, entries: [
    { binding: 0, resource: { buffer: uniformBuffer } },
    { binding: 1, resource: { buffer: rampBuffer } },
    { binding: 2, resource: sampler },
    { binding: 3, resource: nearest },
    { binding: 4, resource: srcTex.createView() },
    { binding: 5, resource: cellTex.createView() },
    { binding: 6, resource: atlasTex.createView() },
  ]});
  const bgPost = device.createBindGroup({ layout: layouts.post, entries: [
    { binding: 0, resource: { buffer: uniformBuffer } },
    { binding: 2, resource: sampler },
    { binding: 7, resource: fxTex.createView() },
  ]});

  device.pushErrorScope('validation');
  const enc = device.createCommandEncoder();
  const pass = (pipe, view, bg) => {
    const p = enc.beginRenderPass({ colorAttachments: [
      { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }]});
    p.setPipeline(pipe);
    p.setBindGroup(0, bg);
    p.draw(3);
    p.end();
  };
  if (isAscii) pass(pipes.cells, cellTex.createView(), bgCells);
  pass(pipes.main, fxTex.createView(), bgMain);
  pass(pipes.post, outTex.createView(), bgPost);

  const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
  const readBuf = device.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyTextureToBuffer({ texture: outTex }, { buffer: readBuf, bytesPerRow }, { width: W, height: H });
  device.queue.submit([enc.finish()]);
  const err = await device.popErrorScope();

  await readBuf.mapAsync(GPUMapMode.READ);
  const px = new Uint8Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  readBuf.destroy();
  cellTex.destroy();

  let max = 0;
  let topR = 0;
  let botB = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * bytesPerRow + x * 4;
      max = Math.max(max, px[i], px[i + 1], px[i + 2]);
      if (y < H / 4) topR += px[i];
      if (y > (H * 3) / 4) botB += px[i + 2];
    }
  }
  return { max, topR, botB, err: err ? String(err.message).slice(0, 300) : null };
}

console.log('\nascify WGSL probe (Deno / native wgpu)\n');

for (const effect of ['ascii', 'blockify', 'vhs', 'threshold']) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.effect = effect;
  const r = await renderOnce(settings);
  check(`${effect} produces pixels`, r.max > 8 && !r.err,
    r.err ? r.err : `max=${r.max} topR=${r.topR} botB=${r.botB}`);
  if (effect !== 'threshold' && !r.err) {
    check(`${effect} keeps orientation`, r.topR > r.botB * 0.2 && r.topR > 0,
      `topRed=${r.topR} bottomBlue=${r.botB}`);
  }
}

if (errors.length) check('no uncaptured errors', false, errors.slice(0, 2).join(' | '));
else check('no uncaptured errors', true);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall WGSL probe checks passed\n');
Deno.exit(failures ? 1 : 0);
