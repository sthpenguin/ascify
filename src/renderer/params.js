import { EFFECTS } from '../lib/schema.js';

/** '#rrggbb' -> [r,g,b] in 0..1. Falls back to green on malformed input. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return [0, 1, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex([r, g, b]) {
  const c = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Character-grid dimensions.
 *
 * `outputWidth` wins when set; otherwise the cell size follows `scale`. Rows
 * are derived from the atlas's glyph aspect so characters stay un-stretched.
 */
export function gridForAscii(settings, width, height, atlas) {
  const { scale, outputWidth } = settings.ascii;
  const glyphAspect = atlas ? atlas.cellW / atlas.cellH : 0.6;

  let cols;
  if (outputWidth && outputWidth >= 1) {
    cols = Math.round(outputWidth);
  } else {
    const cellPx = Math.max(1, scale * 2);
    cols = Math.round(width / cellPx);
  }
  cols = Math.max(1, Math.min(1000, cols));

  let rows = Math.round((height / width) * cols * glyphAspect);
  rows = Math.max(1, Math.min(1000, rows));

  return { cols, rows };
}

const DITHER_MATRIX_SIZE = { bayer2: 2, bayer4: 4, bayer8: 8 };

/** Effects whose algorithm is inherently sequential and runs on the CPU. */
export function requiresCpu(effect, params) {
  if (effect === 'pixelSort') return true;
  if (effect === 'dithering') {
    return params?.matrix === 'floydSteinberg' || params?.matrix === 'atkinson';
  }
  return false;
}

const RAD = Math.PI / 180;

/**
 * Flatten a per-effect parameter object into the generic uP[8]/uM[4] uniforms.
 * The slot layout here is the contract the fragment shader reads.
 */
export function packEffectUniforms(effect, p, audio = 0) {
  const f = new Float32Array(8);
  const i = new Int32Array(4);
  const boost = 1 + audio;

  switch (effect) {
    case 'waveLines':
      f[0] = p.rows;
      f[1] = p.amplitude * boost;
      f[2] = p.frequency;
      f[3] = p.lineWidth;
      f[4] = p.phase;
      break;
    case 'dithering':
      f[0] = p.levels;
      f[1] = p.scale;
      i[0] = DITHER_MATRIX_SIZE[p.matrix] ?? 8;
      break;
    case 'halftone':
      f[0] = p.cell;
      f[1] = p.angle * RAD;
      f[2] = p.sharpness;
      i[0] = ['circle', 'square', 'diamond', 'line'].indexOf(p.shape);
      break;
    case 'dots':
      f[0] = p.cell;
      f[1] = p.minRadius;
      f[2] = p.maxRadius * boost;
      f[3] = p.jitter;
      break;
    case 'contour':
      f[0] = p.levels;
      f[1] = p.thickness;
      f[2] = p.smooth;
      i[0] = p.filled ? 1 : 0;
      break;
    case 'edgeDetection':
      f[0] = p.strength * boost;
      f[1] = p.threshold;
      i[0] = ['sobel', 'prewitt', 'scharr', 'laplacian'].indexOf(p.operator);
      i[1] = p.invert ? 1 : 0;
      break;
    case 'crosshatch':
      f[0] = p.spacing;
      f[1] = p.angle * RAD;
      f[2] = p.layers;
      f[3] = p.lineWidth;
      break;
    case 'blockify':
      f[0] = p.block;
      f[1] = p.gap;
      f[2] = p.roundness;
      break;
    case 'threshold':
      f[0] = Math.min(1, Math.max(0, p.level - audio * 0.25));
      f[1] = p.softness;
      i[0] = p.invert ? 1 : 0;
      break;
    case 'noiseField':
      f[0] = p.scale;
      f[1] = p.speed;
      f[2] = p.strength;
      f[3] = p.octaves;
      break;
    case 'matrixRain':
      f[0] = p.columns;
      f[1] = p.speed * boost;
      f[2] = p.trail;
      f[3] = p.glow;
      break;
    case 'vhs':
      f[0] = p.chromaShift * boost;
      f[1] = p.scanlines;
      f[2] = p.noise;
      f[3] = p.jitter;
      f[4] = p.tracking;
      break;
    case 'voronoi':
      f[0] = p.cells;
      f[1] = p.jitter;
      f[2] = p.border;
      i[0] = p.sample === 'average' ? 1 : 0;
      break;
    default:
      break;
  }
  return { floats: f, ints: i };
}

/**
 * Apply audio-reactive modulation to a settings object, returning a new object
 * only when audio is actually driving something (so the steady state is free).
 */
export function applyAudio(settings, level) {
  const a = settings.audio;
  if (!a.enabled || level <= 0) return settings;
  const amount = level * a.sensitivity;

  switch (a.target) {
    case 'scale':
      return {
        ...settings,
        ascii: { ...settings.ascii, scale: clampParam(settings.ascii.scale * (1 + amount * 0.6), 1, 20) },
      };
    case 'brightness':
      return {
        ...settings,
        adjustments: {
          ...settings.adjustments,
          brightness: clampParam(settings.adjustments.brightness + amount * 0.5, -1, 1),
        },
      };
    case 'contrast':
      return {
        ...settings,
        adjustments: {
          ...settings.adjustments,
          contrast: clampParam(settings.adjustments.contrast + amount * 0.6, -1, 1),
        },
      };
    case 'threshold':
      return {
        ...settings,
        ascii: { ...settings.ascii, threshold: clampParam(settings.ascii.threshold + amount * 0.4, 0, 1) },
      };
    case 'effectPrimary':
      // Handled downstream by packEffectUniforms via the `audio` argument.
      return settings;
    default:
      return settings;
  }
}

function clampParam(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** The audio level that should reach packEffectUniforms for this config. */
export function effectAudioLevel(settings, level) {
  if (!settings.audio.enabled) return 0;
  return settings.audio.target === 'effectPrimary' ? level * settings.audio.sensitivity : 0;
}

export function effectParamDefs(effect) {
  return EFFECTS[effect]?.params ?? {};
}
