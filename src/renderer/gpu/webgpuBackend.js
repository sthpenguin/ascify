import { buildFontAtlas, sortedRampIndices } from '../fontAtlas.js';
import { resolveCharset } from '../../lib/schema.js';
import { packEffectUniforms, gridForAscii, hexToRgb } from '../params.js';
import { WGSL } from './shaders.wgsl.js';

/**
 * WebGPU backend — loaded lazily, and only after the engine has confirmed
 * `navigator.gpu` exists. Any failure here (adapter refused, shader rejected,
 * device lost) makes the engine fall back to WebGL2 permanently, so this file
 * never has to be the thing that keeps the app running.
 *
 * Adjustments are folded into the fragment shaders rather than run as a
 * separate pass: on GPU the redundant work is cheaper than the extra
 * render-target round trip, and it keeps the pipeline to three passes.
 */

const UNIFORM_FLOATS = 13 * 4; // 13 vec4<f32>
const RAMP_MAX = 128;

function makeTexture(device, w, h, usage, format = 'rgba8unorm') {
  return device.createTexture({ size: { width: Math.max(1, w), height: Math.max(1, h) }, format, usage });
}

export async function createWebGPUBackend(canvas) {
  if (!navigator.gpu) return null;

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  if (!device) return null;

  const context = canvas.getContext('webgpu');
  if (!context) return null;

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  let deviceLost = false;
  device.lost.then(() => {
    deviceLost = true;
  });

  const module = device.createShaderModule({ code: WGSL });

  const uniformBuffer = device.createBuffer({
    size: UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const rampBuffer = device.createBuffer({
    size: RAMP_MAX * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  function makePipeline(entry, target) {
    return device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: entry, targets: [{ format: target }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  let pipelines;
  try {
    pipelines = {
      cells: makePipeline('fsCells', 'rgba8unorm'),
      main: makePipeline('fsMain', 'rgba8unorm'),
      post: makePipeline('fsPost', format),
    };
  } catch (err) {
    device.destroy?.();
    throw err;
  }

  let size = { w: 0, h: 0 };
  let cellDims = { w: 0, h: 0 };
  let srcTex = null;
  let atlasTex = null;
  let fxTex = null;
  let cellTex = null;
  let atlasKey = '';
  let rampCache = { key: '', list: [] };
  const uniforms = new Float32Array(UNIFORM_FLOATS);

  function ensureSize(w, h) {
    if (size.w === w && size.h === h) return;
    srcTex?.destroy();
    fxTex?.destroy();
    srcTex = makeTexture(
      device,
      w,
      h,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    );
    fxTex = makeTexture(
      device,
      w,
      h,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    );
    size = { w, h };
  }

  function ensureCells(cols, rows) {
    if (cellDims.w === cols && cellDims.h === rows) return;
    cellTex?.destroy();
    cellTex = makeTexture(
      device,
      cols,
      rows,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    );
    cellDims = { w: cols, h: rows };
  }

  function ensureAtlas(atlas) {
    if (atlas.key === atlasKey && atlasTex) return;
    atlasTex?.destroy();
    atlasTex = makeTexture(
      device,
      atlas.canvas.width,
      atlas.canvas.height,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    );
    device.queue.copyExternalImageToTexture(
      { source: atlas.canvas },
      { texture: atlasTex },
      { width: atlas.canvas.width, height: atlas.canvas.height },
    );
    atlasKey = atlas.key;
  }

  function bindGroupFor() {
    return device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: rampBuffer } },
        { binding: 2, resource: sampler },
        { binding: 3, resource: nearest },
        { binding: 4, resource: srcTex.createView() },
        { binding: 5, resource: (cellTex ?? srcTex).createView() },
        { binding: 6, resource: (atlasTex ?? srcTex).createView() },
        { binding: 7, resource: fxTex.createView() },
      ],
    });
  }

  function writeUniforms(settings, w, h, time, audio, atlas, grid, rampLen) {
    const a = settings.adjustments;
    const u = uniforms;
    const ga = hexToRgb(a.gradientFrom);
    const gb = hexToRgb(a.gradientTo);
    const { floats, ints } = packEffectUniforms(
      settings.effect,
      settings.effectParams[settings.effect] ?? {},
      audio,
    );

    u.set([w, h, 1 / w, 1 / h], 0);
    u.set([grid.cols, grid.rows, atlas.cols, atlas.rows], 4);
    u.set([a.brightness, a.contrast, a.saturation, (a.hue * Math.PI) / 180], 8);
    u.set(
      [a.sharpness, a.gamma, a.colorMode === 'mono' ? 1 : a.colorMode === 'gradient' ? 2 : 0, a.backgroundIntensity],
      12,
    );
    u.set([ga[0], ga[1], ga[2], time], 16);
    u.set([gb[0], gb[1], gb[2], audio], 20);
    u.set(
      [EFFECT_ID[settings.effect] ?? 0, settings.ascii.spacing, settings.ascii.threshold, settings.ascii.tilt],
      24,
    );
    u.set([settings.ascii.spatialWeight, rampLen, atlas.count, 0], 28);
    u.set([floats[0], floats[1], floats[2], floats[3]], 32);
    u.set([floats[4], floats[5], floats[6], floats[7]], 36);
    u.set([ints[0], ints[1], ints[2], ints[3]], 40);
    u.set([settings.post.bloom, settings.post.bloomThreshold, settings.post.scanlines, settings.post.vignette], 44);
    u.set([settings.post.chromatic, settings.post.grain, 0, 0], 48);

    device.queue.writeBuffer(uniformBuffer, 0, u);
  }

  function pass(encoder, pipeline, view, bindGroup) {
    const p = encoder.beginRenderPass({
      colorAttachments: [
        { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    });
    p.setPipeline(pipeline);
    p.setBindGroup(0, bindGroup);
    p.draw(3);
    p.end();
  }

  return {
    name: 'webgpu',
    canvas,
    device,

    resize(w, h) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ensureSize(w, h);
    },

    render(frame, settings, w, h, time = 0, audio = 0) {
      if (deviceLost) throw new Error('webgpu device lost');
      this.resize(w, h);

      const isAscii = settings.effect === 'ascii';
      const chars = isAscii
        ? resolveCharset(settings.ascii)
        : ['0', '1', 'ｱ', 'ｲ', 'ｳ', 'ｴ', 'ｵ', 'ﾊ', 'ﾋ', 'ﾌ', 'ﾍ', 'ﾎ', 'A', 'Z'];
      const atlas = buildFontAtlas(chars, { size: 32 });
      ensureAtlas(atlas);

      if (rampCache.key !== atlas.key) {
        rampCache = { key: atlas.key, list: sortedRampIndices(atlas).reverse() };
      }
      let ramp = rampCache.list;
      if (ramp.length > RAMP_MAX) {
        const step = ramp.length / RAMP_MAX;
        ramp = Array.from({ length: RAMP_MAX }, (_, i) => ramp[Math.floor(i * step)]);
      }
      const rampData = new Uint32Array(RAMP_MAX);
      rampData.set(ramp.slice(0, RAMP_MAX));
      device.queue.writeBuffer(rampBuffer, 0, rampData);

      const grid = isAscii ? gridForAscii(settings, w, h, atlas) : { cols: 1, rows: 1 };
      ensureCells(grid.cols, grid.rows);

      // copyExternalImageToTexture handles video, canvas and ImageBitmap alike.
      device.queue.copyExternalImageToTexture(
        { source: frame, flipY: false },
        { texture: srcTex },
        { width: w, height: h },
      );

      writeUniforms(settings, w, h, time, audio, atlas, grid, ramp.length);

      const encoder = device.createCommandEncoder();
      const bg = bindGroupFor();
      if (isAscii) pass(encoder, pipelines.cells, cellTex.createView(), bg);
      // The cell texture changed, so the main pass needs a fresh binding.
      const bg2 = bindGroupFor();
      pass(encoder, pipelines.main, fxTex.createView(), bg2);
      const bg3 = bindGroupFor();
      pass(encoder, pipelines.post, context.getCurrentTexture().createView(), bg3);
      device.queue.submit([encoder.finish()]);
    },

    isLost: () => deviceLost,

    dispose() {
      srcTex?.destroy();
      fxTex?.destroy();
      cellTex?.destroy();
      atlasTex?.destroy();
      uniformBuffer.destroy();
      rampBuffer.destroy();
      device.destroy?.();
    },
  };
}

const EFFECT_ID = {
  ascii: 0,
  waveLines: 1,
  dithering: 2,
  halftone: 3,
  dots: 4,
  contour: 5,
  edgeDetection: 6,
  crosshatch: 7,
  blockify: 8,
  threshold: 9,
  noiseField: 10,
  matrixRain: 11,
  vhs: 12,
  voronoi: 13,
};
