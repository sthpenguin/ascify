import { buildFontAtlas, sortedRampIndices } from '../fontAtlas.js';
import { resolveCharset } from '../../lib/schema.js';
import { packEffectUniforms, gridForAscii, hexToRgb } from '../params.js';
import { WGSL } from './shaders.wgsl.js';

/**
 * WebGPU backend.
 *
 * Two things here are load-bearing and were both learned the hard way.
 *
 * 1. Each pass gets its own bind group layout, binding only the resources that
 *    pass's entry point actually reads. A single shared layout is tempting, but
 *    it necessarily binds the render targets too — and a texture cannot be a
 *    sampled resource and a colour attachment at the same time. WebGPU rejects
 *    the pass, writes nothing, and reports it through `uncapturederror` rather
 *    than throwing, so the result is a silently black canvas that looks like a
 *    working backend.
 *
 * 2. Nothing is trusted until it has been seen to draw. `probeWebGPU` renders a
 *    known-bright frame through the real pipeline and reads the pixels back
 *    before the display canvas is touched at all. A device that cannot draw is
 *    rejected while falling back is still free.
 *
 * At runtime, `uncapturederror` and `device.lost` both escalate to `onFatal`,
 * so a GPU that degrades mid-session hands over to WebGL2 instead of going
 * black.
 */

const UNIFORM_FLOATS = 13 * 4; // 13 vec4<f32>
const RAMP_MAX = 128;
const FRAG = GPUShaderStage.FRAGMENT;

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

/** Natural pixel dimensions of any CanvasImageSource the pipeline accepts. */
function frameSize(frame) {
  return {
    width: frame.videoWidth ?? frame.naturalWidth ?? frame.width ?? 0,
    height: frame.videoHeight ?? frame.naturalHeight ?? frame.height ?? 0,
  };
}

/**
 * Per-pass bind group layouts. Exported so scripts/wgsl-probe.mjs tests the
 * real binding shape rather than a copy of it — the shared-layout bug this
 * file documents is invisible to a test that builds its own layouts.
 */
export function makeLayouts(device) {
  return {
    // fsCells reads the uniforms, the linear sampler and the source only.
    cells: device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: FRAG, buffer: { type: 'uniform' } },
        { binding: 2, visibility: FRAG, sampler: {} },
        { binding: 4, visibility: FRAG, texture: { sampleType: 'float' } },
      ],
    }),
    // fsMain additionally reads the ramp, the cell grid and the glyph atlas.
    main: device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: FRAG, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FRAG, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: FRAG, sampler: {} },
        { binding: 3, visibility: FRAG, sampler: { type: 'non-filtering' } },
        { binding: 4, visibility: FRAG, texture: { sampleType: 'float' } },
        { binding: 5, visibility: FRAG, texture: { sampleType: 'float' } },
        { binding: 6, visibility: FRAG, texture: { sampleType: 'float' } },
      ],
    }),
    // fsPost reads only the effect output.
    post: device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: FRAG, buffer: { type: 'uniform' } },
        { binding: 2, visibility: FRAG, sampler: {} },
        { binding: 7, visibility: FRAG, texture: { sampleType: 'float' } },
      ],
    }),
  };
}

export function makePipeline(device, module, layout, entryPoint, format) {
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: entryPoint, targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
}

export function renderPass(encoder, pipeline, view, bindGroup) {
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}

/**
 * Prove this device can actually draw before committing the display canvas.
 *
 * Renders a deliberately bright synthetic frame through the real pipelines into
 * an offscreen target and reads it back. Using a known input rather than the
 * user's first frame matters: a genuinely dark photo would otherwise look
 * identical to a broken backend.
 *
 * Returns the live device on success so the caller does not pay for a second
 * one, or null if WebGPU is unavailable, invalid, or renders black.
 */
/**
 * One device per page, shared by every backend instance.
 *
 * A GPUAdapter can only ever vend a single device — a second requestDevice()
 * on it fails with "adapter is consumed". Engine creation is async and can run
 * more than once (a backend switch, React's double-invoked effects), so
 * probing per engine raced two adapters against each other: one call won, the
 * other failed or handed back a device the first would later destroy, and the
 * survivor rendered into nothing. Caching makes repeat probes free and keeps
 * exactly one device alive.
 */
let shared = null;
let sharedPending = null;
/** Held only to keep the adapter from being collected while its device lives. */
let adapterRef = null;

/** Called when a device dies so the next probe builds a fresh one. */
export function invalidateSharedDevice() {
  shared = null;
  sharedPending = null;
  adapterRef = null;
}

export async function probeWebGPU(onError) {
  if (shared) return shared;
  if (sharedPending) return sharedPending;
  sharedPending = probeWebGPUUncached(onError).then((result) => {
    shared = result;
    sharedPending = null;
    return result;
  });
  return sharedPending;
}

async function probeWebGPUUncached(onError) {
  if (!navigator.gpu) return null;

  let device = null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    device = await adapter.requestDevice();
    if (!device) return null;
    // Dawn drops a device whose adapter has been released, so the adapter is
    // kept alive alongside it for as long as the device is in use.
    adapterRef = adapter;

    const module = device.createShaderModule({ code: WGSL });
    const compilation = await module.getCompilationInfo?.();
    const fatal = compilation?.messages?.filter((m) => m.type === 'error') ?? [];
    if (fatal.length) {
      onError?.(new Error(`WGSL: ${fatal[0].message}`));
      device.destroy?.();
      return null;
    }

    const layouts = makeLayouts(device);
    device.pushErrorScope('validation');

    const pipelines = {
      cells: makePipeline(device, module, layouts.cells, 'fsCells', 'rgba8unorm'),
      main: makePipeline(device, module, layouts.main, 'fsMain', 'rgba8unorm'),
      post: makePipeline(device, module, layouts.post, 'fsPost', 'rgba8unorm'),
    };

    const SIZE = 32;
    const usage =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
    const mk = (w, h, extra = 0) =>
      device.createTexture({ size: { width: w, height: h }, format: 'rgba8unorm', usage: usage | extra });

    const srcTex = mk(SIZE, SIZE);
    const cellTex = mk(8, 8);
    const fxTex = mk(SIZE, SIZE);
    const outTex = mk(SIZE, SIZE, GPUTextureUsage.COPY_SRC);
    const atlasTex = mk(16, 16);

    // A fully white source and a fully inked atlas: whatever the effect, the
    // output cannot legitimately be black.
    device.queue.writeTexture(
      { texture: srcTex },
      new Uint8Array(SIZE * SIZE * 4).fill(255),
      { bytesPerRow: SIZE * 4 },
      { width: SIZE, height: SIZE },
    );
    device.queue.writeTexture(
      { texture: atlasTex },
      new Uint8Array(16 * 16 * 4).fill(255),
      { bytesPerRow: 16 * 4 },
      { width: 16, height: 16 },
    );

    const uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const rampBuffer = device.createBuffer({
      size: RAMP_MAX * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const u = new Float32Array(UNIFORM_FLOATS);
    u.set([SIZE, SIZE, 1 / SIZE, 1 / SIZE], 0);
    u.set([8, 8, 1, 1], 4); // grid 8x8, atlas 1x1 cell
    u.set([0, 0, 0, 0], 8); // no adjustments
    u.set([0, 1, 0, 0], 12); // gamma 1
    u.set([0, 0, 0, 0], 16);
    u.set([0, 0, 0, 0], 20);
    u.set([0, 0, 0, 0], 24); // effect 0 = ascii, no spacing/threshold/tilt
    u.set([0, 1, 1, 0], 28); // rampLen 1, atlasCount 1
    device.queue.writeBuffer(uniformBuffer, 0, u);
    device.queue.writeBuffer(rampBuffer, 0, new Uint32Array(RAMP_MAX));

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

    const bgCells = device.createBindGroup({
      layout: layouts.cells,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: sampler },
        { binding: 4, resource: srcTex.createView() },
      ],
    });
    const bgMain = device.createBindGroup({
      layout: layouts.main,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: rampBuffer } },
        { binding: 2, resource: sampler },
        { binding: 3, resource: nearest },
        { binding: 4, resource: srcTex.createView() },
        { binding: 5, resource: cellTex.createView() },
        { binding: 6, resource: atlasTex.createView() },
      ],
    });
    const bgPost = device.createBindGroup({
      layout: layouts.post,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: sampler },
        { binding: 7, resource: fxTex.createView() },
      ],
    });

    const bytesPerRow = 256; // 32px * 4 bytes, already 256-aligned
    const readback = device.createBuffer({
      size: bytesPerRow * SIZE,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = device.createCommandEncoder();
    renderPass(encoder, pipelines.cells, cellTex.createView(), bgCells);
    renderPass(encoder, pipelines.main, fxTex.createView(), bgMain);
    renderPass(encoder, pipelines.post, outTex.createView(), bgPost);
    encoder.copyTextureToBuffer(
      { texture: outTex },
      { buffer: readback, bytesPerRow },
      { width: SIZE, height: SIZE },
    );
    device.queue.submit([encoder.finish()]);

    const validationError = await device.popErrorScope();
    if (validationError) {
      onError?.(new Error(`WebGPU validation: ${validationError.message}`));
      device.destroy?.();
      return null;
    }

    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange());
    let max = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    readback.unmap();

    for (const t of [srcTex, cellTex, fxTex, outTex, atlasTex]) t.destroy();
    readback.destroy();
    uniformBuffer.destroy();
    rampBuffer.destroy();

    if (max < 8) {
      onError?.(new Error('WebGPU probe rendered black; falling back.'));
      device.destroy?.();
      return null;
    }

    return { device, module, layouts };
  } catch (err) {
    onError?.(err);
    device?.destroy?.();
    return null;
  }
}

export async function createWebGPUBackend(canvas, { onFatal, onError, probed } = {}) {
  const ready = probed ?? (await probeWebGPU(onError));
  if (!ready) return null;
  const { device, module, layouts } = ready;

  const context = canvas.getContext('webgpu');
  if (!context) {
    // This canvas cannot take a WebGPU context — almost always because it is
    // already bound to webgl2 or 2d, since a canvas keeps its first context
    // type for life. That says nothing about the device, which is shared:
    // destroying it here would break WebGPU for every backend built later,
    // including ones on a fresh canvas. Decline and let the caller fall back.
    return null;
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  let dead = false;
  let disposing = false;
  let lostInfo = null;
  let frames = 0;
  let verified = false;

  /** Any GPU failure is recoverable — hand back to WebGL2 rather than go black. */
  const die = (reason) => {
    if (dead) return;
    dead = true;
    onError?.(reason instanceof Error ? reason : new Error(String(reason)));
    onFatal?.('webgl2');
  };

  device.lost?.then((info) => {
    lostInfo = { reason: info?.reason, message: info?.message };
    // The shared device is gone; the next probe must build a new one.
    invalidateSharedDevice();
    // Only a loss caused by our own dispose() is expected. Anything else — including
    // reason 'destroyed', which also happens when a superseded engine tears down a
    // device this one is still using — must escalate. Treating 'destroyed' as
    // benign is what let a dead device keep accepting submissions silently: no
    // error, no fallback, and a permanently black canvas.
    if (!disposing) die(`WebGPU device lost (${info?.reason ?? 'unknown'}): ${info?.message ?? ''}`);
  });
  device.addEventListener?.('uncapturederror', (event) => {
    die(`WebGPU error: ${event.error?.message ?? event.error}`);
  });

  const pipelines = {
    cells: makePipeline(device, module, layouts.cells, 'fsCells', 'rgba8unorm'),
    main: makePipeline(device, module, layouts.main, 'fsMain', 'rgba8unorm'),
    post: makePipeline(device, module, layouts.post, 'fsPost', format),
  };

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

  const TEX_USAGE =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.RENDER_ATTACHMENT |
    // COPY_SRC costs nothing here and lets the intermediate stages be read back
    // for diagnosis; a black canvas is otherwise completely opaque to debug.
    GPUTextureUsage.COPY_SRC;
  const makeTexture = (w, h) =>
    device.createTexture({
      size: { width: Math.max(1, w), height: Math.max(1, h) },
      format: 'rgba8unorm',
      usage: TEX_USAGE,
    });

  let srcTex = null;
  let fxTex = null;
  let cellTex = null;
  let atlasTex = null;
  let srcDims = { w: 0, h: 0 };
  let renderDims = { w: 0, h: 0 };
  let cellDims = { w: 0, h: 0 };
  let atlasKey = '';
  let rampCache = { key: '', list: [] };
  const uniforms = new Float32Array(UNIFORM_FLOATS);

  /**
   * The source texture matches the frame's own dimensions, not the render size.
   * copyExternalImageToTexture copies a region and does not scale, so sizing it
   * to the render target would silently crop to the top-left of any frame
   * larger than the preview — the sampler does the scaling instead.
   */
  function ensureSource(w, h) {
    if (srcDims.w === w && srcDims.h === h) return;
    srcTex?.destroy();
    srcTex = makeTexture(w, h);
    srcDims = { w, h };
  }

  function ensureRenderSize(w, h) {
    if (renderDims.w === w && renderDims.h === h) return;
    fxTex?.destroy();
    fxTex = makeTexture(w, h);
    renderDims = { w, h };
  }

  function ensureCells(cols, rows) {
    if (cellDims.w === cols && cellDims.h === rows) return;
    cellTex?.destroy();
    cellTex = makeTexture(cols, rows);
    cellDims = { w: cols, h: rows };
  }

  function ensureAtlas(atlas) {
    if (atlas.key === atlasKey && atlasTex) return;
    atlasTex?.destroy();
    atlasTex = makeTexture(atlas.canvas.width, atlas.canvas.height);
    device.queue.copyExternalImageToTexture(
      { source: atlas.canvas },
      { texture: atlasTex },
      { width: atlas.canvas.width, height: atlas.canvas.height },
    );
    atlasKey = atlas.key;
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
      [
        a.sharpness,
        a.gamma,
        a.colorMode === 'mono' ? 1 : a.colorMode === 'gradient' ? 2 : 0,
        a.backgroundIntensity,
      ],
      12,
    );
    u.set([ga[0], ga[1], ga[2], time], 16);
    u.set([gb[0], gb[1], gb[2], audio], 20);
    u.set(
      [
        EFFECT_ID[settings.effect] ?? 0,
        settings.ascii.spacing,
        settings.ascii.threshold,
        settings.ascii.tilt,
      ],
      24,
    );
    u.set([settings.ascii.spatialWeight, rampLen, atlas.count, 0], 28);
    u.set([floats[0], floats[1], floats[2], floats[3]], 32);
    u.set([floats[4], floats[5], floats[6], floats[7]], 36);
    u.set([ints[0], ints[1], ints[2], ints[3]], 40);
    u.set(
      [settings.post.bloom, settings.post.bloomThreshold, settings.post.scanlines, settings.post.vignette],
      44,
    );
    u.set([settings.post.chromatic, settings.post.grain, 0, 0], 48);

    device.queue.writeBuffer(uniformBuffer, 0, u);
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
      ensureRenderSize(w, h);
    },

    render(frame, settings, w, h, time = 0, audio = 0) {
      if (dead) throw new Error('webgpu backend is no longer usable');
      // A lost device accepts submissions and silently discards them, so the
      // check has to happen here rather than relying on an error being raised.
      if (lostInfo) {
        die(`WebGPU device lost (${lostInfo.reason}): ${lostInfo.message ?? ''}`);
        throw new Error('webgpu device lost');
      }
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

      const natural = frameSize(frame);
      if (!natural.width || !natural.height) return;
      ensureSource(natural.width, natural.height);
      device.queue.copyExternalImageToTexture(
        { source: frame, flipY: false },
        { texture: srcTex },
        { width: natural.width, height: natural.height },
      );

      writeUniforms(settings, w, h, time, audio, atlas, grid, ramp.length);

      // Bind groups are built per pass and never include that pass's own render
      // target — see the note at the top of this file.
      const bgCells = device.createBindGroup({
        layout: layouts.cells,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 2, resource: sampler },
          { binding: 4, resource: srcTex.createView() },
        ],
      });
      const bgMain = device.createBindGroup({
        layout: layouts.main,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: { buffer: rampBuffer } },
          { binding: 2, resource: sampler },
          { binding: 3, resource: nearest },
          { binding: 4, resource: srcTex.createView() },
          { binding: 5, resource: cellTex.createView() },
          { binding: 6, resource: atlasTex.createView() },
        ],
      });
      const bgPost = device.createBindGroup({
        layout: layouts.post,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 2, resource: sampler },
          { binding: 7, resource: fxTex.createView() },
        ],
      });

      frames++;
      const encoder = device.createCommandEncoder();
      if (isAscii) renderPass(encoder, pipelines.cells, cellTex.createView(), bgCells);
      renderPass(encoder, pipelines.main, fxTex.createView(), bgMain);
      renderPass(encoder, pipelines.post, context.getCurrentTexture().createView(), bgPost);
      device.queue.submit([encoder.finish()]);

      // Belt and braces: whatever the cause, the user must never be left staring
      // at a black stage. The first real frame is read back once and compared
      // against the source — light in, no light out means this backend is not
      // working, and WebGL2 takes over.
      if (!verified) {
        verified = true;
        void this.verifyFirstFrame();
      }
    },

    /**
     * Confirms the first frame actually produced light.
     *
     * Compared against the source rather than judged alone, because a genuinely
     * dark image is a legitimate black frame and must not trigger a fallback.
     */
    async verifyFirstFrame() {
      try {
        const peak = async (texture, w, h) => {
          if (!texture || w < 1 || h < 1) return 0;
          const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
          const buf = device.createBuffer({
            size: bytesPerRow * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const enc = device.createCommandEncoder();
          enc.copyTextureToBuffer({ texture }, { buffer: buf, bytesPerRow }, { width: w, height: h });
          device.queue.submit([enc.finish()]);
          await buf.mapAsync(GPUMapMode.READ);
          const px = new Uint8Array(buf.getMappedRange());
          let max = 0;
          for (let i = 0; i < px.length; i += 4) {
            max = Math.max(max, px[i], px[i + 1], px[i + 2]);
          }
          buf.unmap();
          buf.destroy();
          return max;
        };

        const srcPeak = await peak(srcTex, srcDims.w, srcDims.h);
        if (dead || srcPeak < 8) return; // nothing to judge against
        const fxPeak = await peak(fxTex, renderDims.w, renderDims.h);
        if (!dead && fxPeak < 1) {
          die('WebGPU rendered a black frame from a non-black source.');
        }
      } catch (err) {
        // A readback that fails on a dying device is itself the answer.
        if (!disposing) die(err);
      }
    },

    /** Backend state, without touching the GPU. Diagnostic use only. */
    debugState() {
      return {
        dead,
        lostInfo,
        frames,
        srcDims: { ...srcDims },
        cellDims: { ...cellDims },
        renderDims: { ...renderDims },
        atlasKey: atlasKey.slice(0, 40),
        canvas: `${canvas.width}x${canvas.height}`,
      };
    },

    isLost: () => dead,

    dispose() {
      dead = true;
      disposing = true;
      // Everything this backend allocated goes; the device itself does not.
      // It is shared with any backend built after this one, and destroying it
      // here is precisely what used to leave the next backend rendering into a
      // dead device.
      srcTex?.destroy();
      fxTex?.destroy();
      cellTex?.destroy();
      atlasTex?.destroy();
      uniformBuffer.destroy();
      rampBuffer.destroy();
      try {
        context.unconfigure?.();
      } catch {
        /* already gone */
      }
    },
  };
}
