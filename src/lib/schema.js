/**
 * Single source of truth for every persisted setting.
 *
 * Everything here is a number, a boolean, or a short string — by construction
 * there is nowhere to hide pixel data. The persistence layer (lib/db.js)
 * refuses to write anything that is not shaped like this object, which is what
 * makes the "no media is ever stored" guarantee mechanical rather than a
 * promise. Bump SCHEMA_VERSION on any incompatible change: a mismatch causes
 * the stored record to be discarded, not migrated by guesswork.
 */
export const SCHEMA_VERSION = 3;

/** Slider/param descriptor: drives both the UI and the clamp-on-load logic. */
const n = (def, min, max, step = 0.01, label, unit) => ({
  kind: 'number',
  def,
  min,
  max,
  step,
  label,
  unit,
});
const b = (def, label) => ({ kind: 'bool', def, label });
const e = (def, options, label) => ({ kind: 'enum', def, options, label });
const s = (def, label, maxLength = 512) => ({ kind: 'string', def, label, maxLength });

export const CHARSETS = {
  standard: ' .:-=+*#%@',
  detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  block: ' ░▒▓█',
  blocksQuarter: ' ▗▖▝▘▚▞▙▟▛▜█',
  binary: ' 01',
  hex: ' 0123456789ABCDEF',
  dots: ' ⠁⠃⠇⠏⠟⠿⡿⣿',
  shades: ' ·∙•●',
  minimal: ' .*#',
  arrows: ' ←↖↑↗→↘↓↙',
  math: ' ·−+±×÷≡█',
  custom: null, // resolved from settings.ascii.customCharset
};

export const CHARSET_LABELS = {
  standard: 'standard',
  detailed: 'detailed (70)',
  block: 'block shades',
  blocksQuarter: 'quadrant blocks',
  binary: 'binary',
  hex: 'hex',
  dots: 'braille dots',
  shades: 'dot shades',
  minimal: 'minimal',
  arrows: 'arrows',
  math: 'math',
  custom: 'custom…',
};

/**
 * Effect catalogue. `params` are per-effect and are stored under
 * settings.effectParams[id]. Order here is the order shown in the UI.
 */
export const EFFECTS = {
  ascii: {
    label: 'ascii',
    blurb: 'Luminance-mapped character grid',
    params: {},
  },
  waveLines: {
    label: 'waveLines',
    blurb: 'Horizontal scanlines displaced by brightness',
    params: {
      rows: n(90, 8, 400, 1, 'rows'),
      amplitude: n(0.55, 0, 3, 0.01, 'amplitude'),
      frequency: n(2.2, 0.1, 20, 0.1, 'frequency'),
      lineWidth: n(1.3, 0.2, 8, 0.1, 'line width'),
      phase: n(0, 0, 6.283, 0.01, 'phase'),
    },
  },
  dithering: {
    label: 'dithering',
    blurb: 'Ordered / error-diffusion quantisation',
    params: {
      matrix: e('bayer8', ['bayer2', 'bayer4', 'bayer8', 'atkinson', 'floydSteinberg'], 'matrix'),
      levels: n(2, 2, 16, 1, 'levels'),
      scale: n(1, 1, 12, 1, 'pixel scale'),
      serpentine: b(true, 'serpentine scan'),
    },
  },
  halftone: {
    label: 'halftone',
    blurb: 'Print-style dot screen',
    params: {
      cell: n(8, 2, 48, 1, 'cell size'),
      angle: n(45, 0, 180, 1, 'screen angle', '°'),
      shape: e('circle', ['circle', 'square', 'diamond', 'line'], 'shape'),
      sharpness: n(0.6, 0, 1, 0.01, 'edge sharpness'),
    },
  },
  pixelSort: {
    label: 'pixelSort',
    blurb: 'Threshold-bounded span sorting',
    params: {
      threshold: n(0.45, 0, 1, 0.01, 'threshold'),
      direction: e('horizontal', ['horizontal', 'vertical'], 'direction'),
      maxSpan: n(140, 4, 600, 1, 'max span'),
      key: e('brightness', ['brightness', 'hue', 'saturation'], 'sort key'),
      reverse: b(false, 'reverse'),
    },
  },
  dots: {
    label: 'dots',
    blurb: 'Variable-radius stipple grid',
    params: {
      cell: n(9, 2, 40, 1, 'cell size'),
      minRadius: n(0.05, 0, 1, 0.01, 'min radius'),
      maxRadius: n(0.62, 0, 1.2, 0.01, 'max radius'),
      jitter: n(0, 0, 1, 0.01, 'jitter'),
    },
  },
  contour: {
    label: 'contour',
    blurb: 'Iso-luminance topographic bands',
    params: {
      levels: n(9, 2, 40, 1, 'levels'),
      thickness: n(0.5, 0.05, 3, 0.01, 'thickness'),
      smooth: n(0.5, 0, 1, 0.01, 'smoothing'),
      filled: b(false, 'filled bands'),
    },
  },
  edgeDetection: {
    label: 'edgeDetection',
    blurb: 'Gradient-operator outlines',
    params: {
      operator: e('sobel', ['sobel', 'prewitt', 'scharr', 'laplacian'], 'operator'),
      strength: n(1.4, 0.1, 6, 0.05, 'strength'),
      threshold: n(0.12, 0, 1, 0.01, 'threshold'),
      invert: b(false, 'invert'),
    },
  },
  crosshatch: {
    label: 'crosshatch',
    blurb: 'Pen-and-ink tonal hatching',
    params: {
      spacing: n(7, 2, 30, 0.5, 'spacing'),
      angle: n(35, 0, 180, 1, 'base angle', '°'),
      layers: n(4, 1, 6, 1, 'layers'),
      lineWidth: n(0.9, 0.2, 4, 0.05, 'line width'),
    },
  },
  blockify: {
    label: 'blockify',
    blurb: 'Mosaic averaging with gutters',
    params: {
      block: n(14, 2, 96, 1, 'block size'),
      gap: n(0.08, 0, 0.6, 0.01, 'gap'),
      roundness: n(0, 0, 1, 0.01, 'roundness'),
    },
  },
  threshold: {
    label: 'threshold',
    blurb: 'Hard two-tone cut',
    params: {
      level: n(0.5, 0, 1, 0.01, 'level'),
      softness: n(0.04, 0, 0.5, 0.005, 'softness'),
      invert: b(false, 'invert'),
    },
  },
  noiseField: {
    label: 'noiseField',
    blurb: 'Animated value-noise displacement',
    params: {
      scale: n(3.4, 0.2, 20, 0.1, 'noise scale'),
      speed: n(0.35, 0, 3, 0.01, 'speed'),
      strength: n(0.35, 0, 2, 0.01, 'strength'),
      octaves: n(3, 1, 6, 1, 'octaves'),
    },
  },
  matrixRain: {
    label: 'matrixRain',
    blurb: 'Falling glyph columns masked by the source',
    params: {
      columns: n(70, 10, 300, 1, 'columns'),
      speed: n(1, 0, 6, 0.05, 'speed'),
      trail: n(0.72, 0, 1, 0.01, 'trail length'),
      glow: n(0.5, 0, 1, 0.01, 'head glow'),
    },
  },
  vhs: {
    label: 'vhs',
    blurb: 'Tape chroma bleed, tracking and noise',
    params: {
      chromaShift: n(0.35, 0, 3, 0.01, 'chroma shift'),
      scanlines: n(0.45, 0, 1, 0.01, 'scanlines'),
      noise: n(0.22, 0, 1, 0.01, 'noise'),
      jitter: n(0.25, 0, 1, 0.01, 'jitter'),
      tracking: n(0.18, 0, 1, 0.01, 'tracking error'),
    },
  },
  voronoi: {
    label: 'voronoi',
    blurb: 'Cellular flat-shading',
    params: {
      cells: n(900, 16, 6000, 1, 'cells'),
      jitter: n(0.85, 0, 1, 0.01, 'jitter'),
      border: n(0.06, 0, 0.5, 0.005, 'border width'),
      sample: e('center', ['center', 'average'], 'colour sample'),
    },
  },
};

export const EFFECT_IDS = Object.keys(EFFECTS);

/** Global image adjustments, applied before the effect in every backend. */
export const ADJUSTMENT_DEFS = {
  brightness: n(0, -1, 1, 0.01, 'brightness'),
  contrast: n(0, -1, 1, 0.01, 'contrast'),
  saturation: n(0, -1, 1, 0.01, 'saturation'),
  hue: n(0, 0, 360, 1, 'hue', '°'),
  sharpness: n(0, 0, 2, 0.01, 'sharpness'),
  gamma: n(1, 0.1, 3, 0.01, 'gamma'),
  colorMode: e('original', ['original', 'mono', 'gradient'], 'colour mode'),
  backgroundIntensity: n(0, 0, 1, 0.01, 'background intensity'),
  gradientFrom: s('#00ff00', 'gradient from', 9),
  gradientTo: s('#004400', 'gradient to', 9),
};

export const ASCII_DEFS = {
  scale: n(8, 1, 20, 0.1, 'scale'),
  spacing: n(0.1, 0, 1, 0.01, 'spacing'),
  outputWidth: n(0, 0, 500, 1, 'output width'),
  charset: e('standard', Object.keys(CHARSETS), 'charset'),
  customCharset: s(' .:-=+*#%@', 'custom charset', 256),
  threshold: n(0, 0, 1, 0.01, 'threshold'),
  tilt: n(0, -1, 1, 0.01, 'tilt'),
  spatialWeight: n(0, 0, 1, 0.01, 'spatial weight'),
  invert: b(false, 'invert ramp'),
};

export const POST_DEFS = {
  bloom: n(0, 0, 2, 0.01, 'bloom'),
  bloomThreshold: n(0.7, 0, 1, 0.01, 'bloom threshold'),
  scanlines: n(0, 0, 1, 0.01, 'scanlines'),
  vignette: n(0, 0, 1, 0.01, 'vignette'),
  chromatic: n(0, 0, 1, 0.01, 'chromatic aberration'),
  grain: n(0, 0, 1, 0.01, 'film grain'),
};

export const RENDER_DEFS = {
  backend: e('auto', ['auto', 'webgpu', 'webgl2', 'cpu'], 'backend'),
  quality: e('auto', ['auto', 'low', 'medium', 'high'], 'quality'),
  maxDimension: n(1600, 240, 4096, 16, 'max dimension', 'px'),
  fpsCap: n(60, 15, 120, 1, 'fps cap'),
  pauseWhenHidden: b(true, 'pause when tab hidden'),
};

export const AUDIO_DEFS = {
  enabled: b(false, 'audio reactive'),
  sensitivity: n(1, 0, 4, 0.01, 'sensitivity'),
  smoothing: n(0.7, 0, 0.98, 0.01, 'smoothing'),
  target: e('scale', ['scale', 'brightness', 'contrast', 'threshold', 'effectPrimary'], 'drive'),
  band: e('all', ['all', 'bass', 'mid', 'treble'], 'band'),
};

function defsToDefaults(defs) {
  const out = {};
  for (const [k, d] of Object.entries(defs)) out[k] = d.def;
  return out;
}

function effectParamDefaults() {
  const out = {};
  for (const [id, meta] of Object.entries(EFFECTS)) out[id] = defsToDefaults(meta.params);
  return out;
}

export const DEFAULT_SETTINGS = Object.freeze({
  version: SCHEMA_VERSION,
  effect: 'ascii',
  adjustments: defsToDefaults(ADJUSTMENT_DEFS),
  ascii: defsToDefaults(ASCII_DEFS),
  effectParams: effectParamDefaults(),
  post: defsToDefaults(POST_DEFS),
  render: defsToDefaults(RENDER_DEFS),
  audio: defsToDefaults(AUDIO_DEFS),
});

export const DEFAULT_UI = Object.freeze({
  version: SCHEMA_VERSION,
  mobileTab: 'input',
  leftOpen: true,
  rightOpen: true,
  openSections: { input: true, effects: true, presets: false, settings: true, processing: false, post: false, export: true },
  zoom: 1,
  panX: 0,
  panY: 0,
  /** Playhead position in seconds — a number, never a frame buffer. */
  videoTime: 0,
  showGrid: false,
});

const DEF_GROUPS = {
  adjustments: ADJUSTMENT_DEFS,
  ascii: ASCII_DEFS,
  post: POST_DEFS,
  render: RENDER_DEFS,
  audio: AUDIO_DEFS,
};

function coerce(def, value) {
  if (def.kind === 'number') {
    const v = Number(value);
    if (!Number.isFinite(v)) return def.def;
    return Math.min(def.max, Math.max(def.min, v));
  }
  if (def.kind === 'bool') return typeof value === 'boolean' ? value : def.def;
  if (def.kind === 'enum') return def.options.includes(value) ? value : def.def;
  if (def.kind === 'string') {
    if (typeof value !== 'string') return def.def;
    return value.slice(0, def.maxLength);
  }
  return def.def;
}

/**
 * Rebuild a settings object from untrusted input (IndexedDB, a shared URL).
 *
 * Keys are read *from the schema*, never copied from the input, so an
 * attacker-supplied or corrupted record cannot smuggle extra fields — including
 * a base64 image — into application state.
 */
export function sanitizeSettings(raw) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return out;

  if (EFFECT_IDS.includes(raw.effect)) out.effect = raw.effect;

  for (const [group, defs] of Object.entries(DEF_GROUPS)) {
    const src = raw[group];
    if (!src || typeof src !== 'object') continue;
    for (const [key, def] of Object.entries(defs)) {
      if (key in src) out[group][key] = coerce(def, src[key]);
    }
  }

  const ep = raw.effectParams;
  if (ep && typeof ep === 'object') {
    for (const [id, meta] of Object.entries(EFFECTS)) {
      const src = ep[id];
      if (!src || typeof src !== 'object') continue;
      for (const [key, def] of Object.entries(meta.params)) {
        if (key in src) out.effectParams[id][key] = coerce(def, src[key]);
      }
    }
  }

  out.version = SCHEMA_VERSION;
  return out;
}

export function sanitizeUi(raw) {
  const out = structuredClone(DEFAULT_UI);
  if (!raw || typeof raw !== 'object') return out;
  if (['input', 'effects', 'preview', 'settings', 'export'].includes(raw.mobileTab)) {
    out.mobileTab = raw.mobileTab;
  }
  if (typeof raw.leftOpen === 'boolean') out.leftOpen = raw.leftOpen;
  if (typeof raw.rightOpen === 'boolean') out.rightOpen = raw.rightOpen;
  if (typeof raw.showGrid === 'boolean') out.showGrid = raw.showGrid;
  if (raw.openSections && typeof raw.openSections === 'object') {
    for (const k of Object.keys(out.openSections)) {
      if (typeof raw.openSections[k] === 'boolean') out.openSections[k] = raw.openSections[k];
    }
  }
  const num = (v, min, max, d) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d;
  };
  out.zoom = num(raw.zoom, 0.1, 12, 1);
  out.panX = num(raw.panX, -1e5, 1e5, 0);
  out.panY = num(raw.panY, -1e5, 1e5, 0);
  out.videoTime = num(raw.videoTime, 0, 86400, 0);
  out.version = SCHEMA_VERSION;
  return out;
}

/** Resolve the active character ramp, honouring the custom editor. */
export function resolveCharset(ascii) {
  const raw = ascii.charset === 'custom' ? ascii.customCharset : CHARSETS[ascii.charset];
  const chars = Array.from(raw ?? CHARSETS.standard);
  const ramp = chars.length ? chars : Array.from(CHARSETS.standard);
  return ascii.invert ? [...ramp].reverse() : ramp;
}

export { DEF_GROUPS };
