import { createWebGL2Backend } from './gl/webgl2Backend.js';
import { createCpuBackend } from './cpu/cpuBackend.js';
import { requiresCpu, applyAudio, effectAudioLevel } from './params.js';

export { buildFontAtlas, sortedRampIndices, clearAtlasCache } from './fontAtlas.js';
export { analyzeAscii } from './cpu/cpuBackend.js';
export { gridForAscii, requiresCpu } from './params.js';

/**
 * ascify renderer.
 *
 * A self-contained library: hand it a canvas and a frame source, and it picks
 * the best available backend (WebGPU -> WebGL2 -> CPU), clamps resolution to
 * something the device can sustain, and runs a frame loop that pauses when the
 * tab is hidden. It has no React dependency and no knowledge of the UI.
 */

const isMobile = () =>
  typeof matchMedia !== 'undefined' &&
  (matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 768px)').matches);

/**
 * Pick the render resolution.
 *
 * Phones get a hard pixel budget rather than a dimension cap: a 4K video on a
 * mid-range phone will thermally throttle long before it drops frames, and the
 * effects are all low-frequency enough that the loss is invisible.
 */
export function computeRenderSize(srcW, srcH, settings, viewport) {
  const mobile = isMobile();
  const quality = settings.render.quality === 'auto' ? (mobile ? 'medium' : 'high') : settings.render.quality;

  const budgets = {
    low: mobile ? 360_000 : 720_000,
    medium: mobile ? 720_000 : 1_600_000,
    high: mobile ? 1_400_000 : 4_000_000,
  };

  let w = Math.max(1, srcW);
  let h = Math.max(1, srcH);

  const maxDim = settings.render.maxDimension;
  if (Math.max(w, h) > maxDim) {
    const k = maxDim / Math.max(w, h);
    w = Math.round(w * k);
    h = Math.round(h * k);
  }

  // Never render meaningfully above what the preview surface can show.
  if (viewport?.width && viewport?.height) {
    const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 2 : 3);
    const viewMax = Math.max(viewport.width, viewport.height) * dpr;
    if (Math.max(w, h) > viewMax) {
      const k = viewMax / Math.max(w, h);
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
  }

  const budget = budgets[quality] ?? budgets.medium;
  if (w * h > budget) {
    const k = Math.sqrt(budget / (w * h));
    w = Math.round(w * k);
    h = Math.round(h * k);
  }

  return { width: Math.max(2, w), height: Math.max(2, h) };
}

/**
 * Choose a backend for `canvas`.
 *
 * Deliberately async and done exactly once per canvas: a canvas element is
 * bound to the first context type it is given, forever. Asking for 'webgpu'
 * after 'webgl2' returns null, so there is no such thing as swapping a backend
 * in place — the caller must supply a fresh canvas to change it. That is why
 * this runs before any context exists rather than upgrading later.
 */
/**
 * Can this device actually run the WebGL2 backend?
 *
 * Asked on a throwaway canvas, because the answer is not just "is there a
 * context" — the shaders have to compile and link too, and on mobile GPUs that
 * is where it fails. Probing matters because a canvas is bound to the first
 * context type it is given *forever*: if WebGL2 were attempted directly on the
 * display canvas and threw at shader compilation, the canvas would already be
 * a WebGL canvas, getContext('2d') would then return null, and the CPU
 * fallback would be impossible. The app would die on exactly the low-end
 * devices the fallback exists for.
 */
let webgl2Supported = null;

function webgl2Works(onError) {
  // Only a success is cached. Browsers cap live WebGL contexts, so re-probing
  // on every engine creation burns that budget — but a failure can equally be
  // a transient shortage while old contexts are still being reclaimed, and
  // caching that would permanently strand a capable machine on the CPU path.
  if (webgl2Supported === true) return true;
  const probe = document.createElement('canvas');
  probe.width = 2;
  probe.height = 2;
  try {
    const backend = createWebGL2Backend(probe);
    if (!backend) return false;
    backend.dispose();
    webgl2Supported = true;
    return true;
  } catch (err) {
    onError?.(err);
    return false;
  } finally {
    probe.width = 0;
    probe.height = 0;
  }
}

/**
 * Choose a backend for `canvas`.
 *
 * Deliberately async and done exactly once per canvas: a canvas element is
 * bound to the first context type it is given, forever. Asking for 'webgpu'
 * after 'webgl2' returns null, so there is no such thing as swapping a backend
 * in place — the caller must supply a fresh canvas to change it.
 */
async function selectBackend(canvas, pref, onError, onFatal) {
  if (pref === 'auto' || pref === 'webgpu') {
    if (navigator.gpu) {
      try {
        // Only fetched on devices that actually have WebGPU.
        const { createWebGPUBackend, probeWebGPU } = await import('./gpu/webgpuBackend.js');
        // Probe on its own resources first. The probe renders a known-bright
        // frame and reads the pixels back, so a device that produces black —
        // the failure mode that otherwise looks exactly like success — is
        // rejected here, while the display canvas is still untouched and
        // falling back is still possible.
        const probed = await probeWebGPU(onError);
        if (probed) {
          const gpu = await createWebGPUBackend(canvas, { onError, onFatal, probed });
          if (gpu) return gpu;
        }
      } catch (err) {
        // WebGPU is the preference, not a requirement.
        onError?.(err);
      }
    }
  }

  if (pref !== 'cpu' && webgl2Works(onError)) {
    try {
      const gl = createWebGL2Backend(canvas);
      if (gl) return gl;
    } catch (err) {
      onError?.(err);
    }
  }

  const cpu = createCpuBackend(canvas);
  if (!cpu) {
    throw new Error('No usable rendering backend: neither WebGL2 nor 2D canvas is available.');
  }
  return cpu;
}

/**
 * Create a renderer bound to `canvas`.
 *
 * @param canvas          a *fresh* canvas with no context yet
 * @param opts.settings   initial settings (the backend preference is read once)
 * @param opts.onFatal    called with the backend to try next when the current
 *                        one dies; the host should remount a canvas and
 *                        re-create the engine with that preference
 */
export async function createEngine(canvas, { settings: initialSettings, onStats, onBackendChange, onError, onFatal } = {}) {
  let settings = initialSettings ?? null;
  let backend = null;
  let cpuAssist = null; // CPU backend used for sequential effects
  let assistCanvas = null;
  let source = null;
  let running = false;
  let rafId = 0;
  let lastTime = 0;
  let startTime = performance.now();
  let audioLevel = 0;
  let viewport = null;
  let disposed = false;

  const stats = { fps: 0, backend: 'none', width: 0, height: 0, frames: 0 };
  let fpsAccum = 0;
  let fpsFrames = 0;

  backend = await selectBackend(
    canvas,
    settings?.render.backend ?? 'auto',
    onError,
    // A backend that fails after creation (device lost, uncaptured error) asks
    // the host for a fresh canvas one rung down rather than going black.
    (next) => {
      stop();
      onFatal?.(next);
    },
  );
  if (disposed) {
    backend.dispose?.();
    return null;
  }
  stats.backend = backend.name;
  onBackendChange?.(backend.name);

  function ensureCpuAssist() {
    if (cpuAssist) return cpuAssist;
    assistCanvas = document.createElement('canvas');
    cpuAssist = createCpuBackend(assistCanvas);
    return cpuAssist;
  }

  /** The backend died mid-frame: stop and ask the host for a fresh canvas. */
  function degrade(err) {
    onError?.(err);
    const next = backend.name === 'webgpu' ? 'webgl2' : backend.name === 'webgl2' ? 'cpu' : null;
    stop();
    if (next && onFatal) onFatal(next);
  }

  function currentRenderSize() {
    if (!source || !settings) return { width: 0, height: 0 };
    const w = source.width || 1;
    const h = source.height || 1;
    return computeRenderSize(w, h, settings, viewport);
  }

  function renderFrame(now) {
    if (!source || !settings || !backend) return;

    const time = (now - startTime) / 1000;
    const { width, height } = currentRenderSize();
    if (width < 2 || height < 2) return;

    stats.width = width;
    stats.height = height;

    const effSettings = applyAudio(settings, audioLevel);
    const audioForEffect = effectAudioLevel(settings, audioLevel);
    const frame = source.frame();
    if (!frame) return;

    // Videos report readyState before the first decoded frame exists; drawing
    // then throws on some browsers and produces a black frame on others.
    if (frame instanceof HTMLVideoElement && frame.readyState < 2) return;

    const params = effSettings.effectParams[effSettings.effect] ?? {};
    const needsCpu = requiresCpu(effSettings.effect, params);

    try {
      if (needsCpu && backend.name !== 'cpu') {
        // Sequential effect on a GPU backend: compute pixels on the CPU, then
        // hand the result back to the GPU so post-processing still runs there.
        const assist = ensureCpuAssist();
        assist.render(frame, effSettings, width, height, time, audioForEffect);
        if (backend.renderFromCpu) {
          backend.renderFromCpu(assistCanvas, effSettings, width, height, time);
        } else {
          backend.render(assistCanvas, effSettings, width, height, time, audioForEffect);
        }
      } else {
        backend.render(frame, effSettings, width, height, time, audioForEffect);
      }
    } catch (err) {
      // Backend blew up mid-frame — hand the host the next one down.
      degrade(err);
      return;
    }

    stats.frames++;
  }

  function loop(now) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);

    const fpsCap = settings?.render.fpsCap ?? 60;
    const minDelta = 1000 / (fpsCap + 0.5);
    const delta = now - lastTime;
    if (lastTime && delta < minDelta) return;

    const dt = lastTime ? Math.min(0.1, delta / 1000) : 0.016;
    lastTime = now;

    source?.tick?.(dt);
    renderFrame(now);

    fpsAccum += delta;
    fpsFrames++;
    if (fpsAccum >= 500) {
      stats.fps = Math.round((fpsFrames * 1000) / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
      onStats?.({ ...stats });
    }
  }

  function start() {
    if (running || disposed) return;
    running = true;
    lastTime = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  const onVisibility = () => {
    if (!settings?.render.pauseWhenHidden) return;
    if (document.hidden) {
      stop();
      source?.pause?.();
    } else if (source) {
      source.play?.();
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    get backendName() {
      return stats.backend;
    },
    get stats() {
      return { ...stats };
    },

    /**
     * Update settings. The backend preference is *not* re-read here — changing
     * it requires a new canvas, which is the host's job (see `onFatal`).
     */
    setSettings(next) {
      settings = next;
    },

    setSource(next) {
      source = next;
      startTime = performance.now();
      stats.frames = 0;
    },

    setViewport(rect) {
      viewport = rect;
    },

    setAudioLevel(level) {
      audioLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    },

    /** Render exactly one frame (still images, scrubbing, export). */
    renderOnce() {
      renderFrame(performance.now());
      // Stills never enter the loop, so this is the only chance to report.
      onStats?.({ ...stats });
    },

    renderSize: currentRenderSize,

    /** Character grid for the current frame — the export path's entry point. */
    asciiGrid(overrideSettings) {
      if (!source || !settings) return null;
      const s = overrideSettings ?? settings;
      const { width, height } = computeRenderSize(source.width, source.height, s, viewport);
      const frame = source.frame();
      if (!frame) return null;
      return ensureCpuAssist().computeAsciiGrid(frame, s, width, height);
    },

    start,
    stop,
    isRunning: () => running,

    /** Diagnostic passthrough to the active backend, when it offers one. */
    debugState: () => ({ name: backend?.name, ...(backend?.debugState?.() ?? {}) }),

    dispose() {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      backend?.dispose?.();
      backend = null;
      cpuAssist?.dispose?.();
      cpuAssist = null;
      if (assistCanvas) {
        assistCanvas.width = 0;
        assistCanvas.height = 0;
        assistCanvas = null;
      }
      source = null;
    },
  };
}
