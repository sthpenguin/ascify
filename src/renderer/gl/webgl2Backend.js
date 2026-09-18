import {
  VERT,
  ADJUST_FRAG,
  CELL_FRAG,
  GLYPH_FRAG,
  EFFECT_FRAG,
  POST_FRAG,
  BRIGHT_FRAG,
  BLUR_FRAG,
  BLIT_FRAG,
  EFFECT_INDEX,
} from './shaders.js';
import { buildFontAtlas, sortedRampIndices } from '../fontAtlas.js';
import { resolveCharset } from '../../lib/schema.js';
import { packEffectUniforms, gridForAscii, hexToRgb } from '../params.js';

/**
 * WebGL2 backend.
 *
 * Pass order: upload -> adjust -> (ascii: cells -> glyphs | effect) -> post.
 * Intermediate targets are ping-ponged and reallocated only when the render
 * size changes, so a steady-state 60fps loop allocates nothing.
 */

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl, fragSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`program link failed: ${log}`);
  }
  // Uniform locations are resolved lazily and memoised per program.
  const cache = new Map();
  prog.u = (name) => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
    return cache.get(name);
  };
  return prog;
}

function createTarget(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

function disposeTarget(gl, t) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

export function createWebGL2Backend(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true, // export reads the drawing buffer back
    powerPreference: 'high-performance',
    desynchronized: true,
  });
  if (!gl) return null;

  const programs = {
    adjust: link(gl, ADJUST_FRAG),
    cells: link(gl, CELL_FRAG),
    glyph: link(gl, GLYPH_FRAG),
    effect: link(gl, EFFECT_FRAG),
    post: link(gl, POST_FRAG),
    bright: link(gl, BRIGHT_FRAG),
    blur: link(gl, BLUR_FRAG),
    blit: link(gl, BLIT_FRAG),
  };

  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const srcTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const atlasTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let targets = { adjust: null, fx: null, cells: null, bloomA: null, bloomB: null };
  let size = { w: 0, h: 0 };
  let cellSize = { w: 0, h: 0 };
  let atlasKey = '';
  let rampCache = { key: '', indices: [] };
  let srcSignature = '';

  function ensureTargets(w, h) {
    if (size.w === w && size.h === h) return;
    disposeTarget(gl, targets.adjust);
    disposeTarget(gl, targets.fx);
    disposeTarget(gl, targets.bloomA);
    disposeTarget(gl, targets.bloomB);
    targets.adjust = createTarget(gl, w, h);
    targets.fx = createTarget(gl, w, h);
    const bw = Math.max(1, w >> 2);
    const bh = Math.max(1, h >> 2);
    targets.bloomA = createTarget(gl, bw, bh);
    targets.bloomB = createTarget(gl, bw, bh);
    size = { w, h };
  }

  function ensureCells(cols, rows) {
    if (cellSize.w === cols && cellSize.h === rows) return;
    disposeTarget(gl, targets.cells);
    targets.cells = createTarget(gl, cols, rows);
    // Cell data must not bleed between neighbours.
    gl.bindTexture(gl.TEXTURE_2D, targets.cells.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    cellSize = { w: cols, h: rows };
  }

  function draw(target) {
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  function uploadSource(frame, w, h) {
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const sig = `${w}x${h}`;
    if (sig !== srcSignature) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      srcSignature = sig;
    } else {
      // Same dimensions: a sub-image upload avoids reallocating every frame.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  function uploadAtlas(atlas) {
    if (atlas.key === atlasKey) return;
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    atlasKey = atlas.key;
  }

  function runAdjust(settings, w, h) {
    const a = settings.adjustments;
    const p = programs.adjust;
    gl.useProgram(p);
    bindTex(0, srcTex);
    gl.uniform1i(p.u('uSrc'), 0);
    gl.uniform2f(p.u('uTexel'), 1 / w, 1 / h);
    gl.uniform1f(p.u('uBrightness'), a.brightness);
    gl.uniform1f(p.u('uContrast'), a.contrast);
    gl.uniform1f(p.u('uSaturation'), a.saturation);
    gl.uniform1f(p.u('uHue'), (a.hue * Math.PI) / 180);
    gl.uniform1f(p.u('uSharpness'), a.sharpness);
    gl.uniform1f(p.u('uGamma'), a.gamma);
    gl.uniform1i(p.u('uColorMode'), a.colorMode === 'mono' ? 1 : a.colorMode === 'gradient' ? 2 : 0);
    const ga = hexToRgb(a.gradientFrom);
    const gb = hexToRgb(a.gradientTo);
    gl.uniform3f(p.u('uGradA'), ga[0], ga[1], ga[2]);
    gl.uniform3f(p.u('uGradB'), gb[0], gb[1], gb[2]);
    draw(targets.adjust);
  }

  function runAscii(settings, w, h, time, audio) {
    const chars = resolveCharset(settings.ascii);
    const atlas = buildFontAtlas(chars, { size: 32 });
    uploadAtlas(atlas);

    if (rampCache.key !== atlas.key) {
      rampCache = { key: atlas.key, indices: sortedRampIndices(atlas).reverse() };
    }
    // GLSL array is capped at 128 entries; longer ramps are sampled down.
    let ramp = rampCache.indices;
    if (ramp.length > 128) {
      const step = ramp.length / 128;
      ramp = Array.from({ length: 128 }, (_, i) => ramp[Math.floor(i * step)]);
    }

    const { cols, rows } = gridForAscii(settings, w, h, atlas);
    ensureCells(cols, rows);

    const cp = programs.cells;
    gl.useProgram(cp);
    bindTex(0, targets.adjust.tex);
    gl.uniform1i(cp.u('uSrc'), 0);
    gl.uniform2f(cp.u('uGrid'), cols, rows);
    gl.uniform2f(cp.u('uTexel'), 1 / w, 1 / h);
    gl.uniform1f(cp.u('uThreshold'), settings.ascii.threshold);
    gl.uniform1f(cp.u('uTilt'), settings.ascii.tilt);
    gl.uniform1f(cp.u('uSpatial'), settings.ascii.spatialWeight);
    gl.uniform1f(cp.u('uAudio'), audio);
    draw(targets.cells);

    const gp = programs.glyph;
    gl.useProgram(gp);
    bindTex(0, targets.cells.tex);
    bindTex(1, atlasTex);
    bindTex(2, targets.adjust.tex);
    gl.uniform1i(gp.u('uCells'), 0);
    gl.uniform1i(gp.u('uAtlas'), 1);
    gl.uniform1i(gp.u('uSrc'), 2);
    gl.uniform2f(gp.u('uGrid'), cols, rows);
    gl.uniform2f(gp.u('uAtlasGrid'), atlas.cols, atlas.rows);
    gl.uniform1f(gp.u('uCount'), atlas.count);
    gl.uniform1f(gp.u('uSpacing'), settings.ascii.spacing);
    gl.uniform1f(gp.u('uBackground'), settings.adjustments.backgroundIntensity);
    gl.uniform1i(gp.u('uRampLen'), ramp.length);
    gl.uniform1iv(gp.u('uRamp'), new Int32Array(ramp));
    draw(targets.fx);
  }

  function runEffect(settings, w, h, time, audio) {
    const id = settings.effect;
    const atlas = buildFontAtlas(['0', '1', 'ｱ', 'ｲ', 'ｳ', 'ｴ', 'ｵ', 'ﾊ', 'ﾋ', 'ﾌ', 'ﾍ', 'ﾎ', 'A', 'Z'], {
      size: 32,
    });
    if (id === 'matrixRain') uploadAtlas(atlas);

    const p = programs.effect;
    gl.useProgram(p);
    bindTex(0, targets.adjust.tex);
    bindTex(1, atlasTex);
    gl.uniform1i(p.u('uSrc'), 0);
    gl.uniform1i(p.u('uAtlas'), 1);
    gl.uniform2f(p.u('uResolution'), w, h);
    gl.uniform2f(p.u('uTexel'), 1 / w, 1 / h);
    gl.uniform2f(p.u('uAtlasGrid'), atlas.cols, atlas.rows);
    gl.uniform1f(p.u('uAtlasCount'), atlas.count);
    gl.uniform1f(p.u('uTime'), time);
    gl.uniform1f(p.u('uAudio'), audio);
    gl.uniform1f(p.u('uBackground'), settings.adjustments.backgroundIntensity);
    gl.uniform1i(p.u('uEffect'), EFFECT_INDEX[id] ?? 0);
    const { floats, ints } = packEffectUniforms(id, settings.effectParams[id] ?? {}, audio);
    gl.uniform1fv(p.u('uP[0]'), floats);
    gl.uniform1iv(p.u('uM[0]'), ints);
    draw(targets.fx);
  }

  function runPost(settings, w, h, time) {
    const post = settings.post;
    const needsBloom = post.bloom > 0.001;

    if (needsBloom) {
      const bp = programs.bright;
      gl.useProgram(bp);
      bindTex(0, targets.fx.tex);
      gl.uniform1i(bp.u('uSrc'), 0);
      gl.uniform1f(bp.u('uThreshold'), post.bloomThreshold);
      draw(targets.bloomA);

      const blur = programs.blur;
      gl.useProgram(blur);
      gl.uniform1i(blur.u('uSrc'), 0);
      bindTex(0, targets.bloomA.tex);
      gl.uniform2f(blur.u('uDir'), 1 / targets.bloomA.w, 0);
      draw(targets.bloomB);
      bindTex(0, targets.bloomB.tex);
      gl.uniform2f(blur.u('uDir'), 0, 1 / targets.bloomA.h);
      draw(targets.bloomA);
    }

    const p = programs.post;
    gl.useProgram(p);
    bindTex(0, targets.fx.tex);
    bindTex(1, needsBloom ? targets.bloomA.tex : targets.fx.tex);
    gl.uniform1i(p.u('uSrc'), 0);
    gl.uniform1i(p.u('uBloom'), 1);
    gl.uniform2f(p.u('uResolution'), w, h);
    gl.uniform1f(p.u('uBloomAmount'), needsBloom ? post.bloom : 0);
    gl.uniform1f(p.u('uScanlines'), post.scanlines);
    gl.uniform1f(p.u('uVignette'), post.vignette);
    gl.uniform1f(p.u('uChromatic'), post.chromatic);
    gl.uniform1f(p.u('uGrain'), post.grain);
    gl.uniform1f(p.u('uTime'), time);
    draw(null);
  }

  return {
    name: 'webgl2',
    gl,
    canvas,

    resize(w, h) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ensureTargets(w, h);
    },

    /** Upload a CPU-produced frame (used for pixelSort and error diffusion). */
    renderFromCpu(imageSource, settings, w, h, time) {
      this.resize(w, h);
      uploadSource(imageSource, w, h);
      const p = programs.blit;
      gl.useProgram(p);
      bindTex(0, srcTex);
      gl.uniform1i(p.u('uSrc'), 0);
      draw(targets.fx);
      runPost(settings, w, h, time);
    },

    render(frame, settings, w, h, time, audio = 0) {
      this.resize(w, h);
      uploadSource(frame, w, h);
      runAdjust(settings, w, h);
      if (settings.effect === 'ascii') runAscii(settings, w, h, time, audio);
      else runEffect(settings, w, h, time, audio);
      runPost(settings, w, h, time);
    },

    isLost: () => gl.isContextLost(),

    dispose() {
      for (const t of Object.values(targets)) disposeTarget(gl, t);
      targets = { adjust: null, fx: null, cells: null, bloomA: null, bloomB: null };
      for (const p of Object.values(programs)) gl.deleteProgram(p);
      gl.deleteTexture(srcTex);
      gl.deleteTexture(atlasTex);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
