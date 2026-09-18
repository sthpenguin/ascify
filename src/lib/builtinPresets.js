/**
 * Built-in preset gallery.
 *
 * Each entry is a partial settings object merged over whatever is current, so
 * a preset changes only what it cares about. They are plain data and go through
 * the same sanitiser as everything else.
 */
export const BUILTIN_PRESETS = [
  {
    name: 'terminal',
    blurb: 'Classic green-on-black ASCII',
    settings: {
      effect: 'ascii',
      adjustments: { colorMode: 'gradient', gradientFrom: '#003300', gradientTo: '#00ff66', contrast: 0.25, backgroundIntensity: 0 },
      ascii: { scale: 6, spacing: 0.08, charset: 'standard', threshold: 0.05, spatialWeight: 0.2 },
      post: { bloom: 0.35, bloomThreshold: 0.55, scanlines: 0.25, vignette: 0.3 },
    },
  },
  {
    name: 'newsprint',
    blurb: 'Halftone dot screen, high contrast mono',
    settings: {
      effect: 'halftone',
      adjustments: { colorMode: 'mono', contrast: 0.35, gamma: 1.2, backgroundIntensity: 0 },
      effectParams: { halftone: { cell: 6, angle: 45, shape: 'circle', sharpness: 0.75 } },
      post: { bloom: 0, scanlines: 0, vignette: 0.15, grain: 0.12 },
    },
  },
  {
    name: 'gameboy',
    blurb: 'Four-tone ordered dither',
    settings: {
      effect: 'dithering',
      adjustments: { colorMode: 'gradient', gradientFrom: '#0f380f', gradientTo: '#9bbc0f', contrast: 0.2 },
      effectParams: { dithering: { matrix: 'bayer4', levels: 4, scale: 3, serpentine: true } },
      post: { bloom: 0, scanlines: 0, vignette: 0.2 },
    },
  },
  {
    name: 'blueprint',
    blurb: 'Edge outlines on a technical-drawing ground',
    settings: {
      effect: 'edgeDetection',
      adjustments: { colorMode: 'gradient', gradientFrom: '#04121f', gradientTo: '#7fd4ff', backgroundIntensity: 0.12 },
      effectParams: { edgeDetection: { operator: 'scharr', strength: 1.1, threshold: 0.08, invert: false } },
      post: { bloom: 0.25, bloomThreshold: 0.6, grain: 0.08 },
    },
  },
  {
    name: 'tape',
    blurb: 'Worn VHS transfer',
    settings: {
      effect: 'vhs',
      adjustments: { saturation: 0.25, contrast: 0.1 },
      effectParams: { vhs: { chromaShift: 0.6, scanlines: 0.55, noise: 0.28, jitter: 0.35, tracking: 0.3 } },
      post: { vignette: 0.35, grain: 0.18, chromatic: 0.15 },
    },
  },
  {
    name: 'topo',
    blurb: 'Contour map bands',
    settings: {
      effect: 'contour',
      adjustments: { colorMode: 'gradient', gradientFrom: '#0a1a0a', gradientTo: '#7dffb0', contrast: 0.15 },
      effectParams: { contour: { levels: 14, thickness: 0.4, smooth: 0.6, filled: false } },
      post: { bloom: 0.3, bloomThreshold: 0.5 },
    },
  },
  {
    name: 'mosaic',
    blurb: 'Chunky colour blocks',
    settings: {
      effect: 'blockify',
      adjustments: { saturation: 0.4, contrast: 0.2 },
      effectParams: { blockify: { block: 22, gap: 0.14, roundness: 0.35 } },
      post: { bloom: 0.15, vignette: 0.2 },
    },
  },
  {
    name: 'rainfall',
    blurb: 'Matrix columns over the source',
    settings: {
      effect: 'matrixRain',
      adjustments: { colorMode: 'mono', brightness: -0.1, contrast: 0.3, backgroundIntensity: 0.18 },
      effectParams: { matrixRain: { columns: 90, speed: 1.3, trail: 0.8, glow: 0.7 } },
      post: { bloom: 0.55, bloomThreshold: 0.45, scanlines: 0.2 },
    },
  },
  {
    name: 'ink',
    blurb: 'Pen-and-ink crosshatching',
    settings: {
      effect: 'crosshatch',
      adjustments: { colorMode: 'mono', contrast: 0.3, gamma: 1.15 },
      effectParams: { crosshatch: { spacing: 5, angle: 35, layers: 5, lineWidth: 0.8 } },
      post: { grain: 0.1, vignette: 0.18 },
    },
  },
  {
    name: 'shatter',
    blurb: 'Threshold-driven pixel sorting',
    settings: {
      effect: 'pixelSort',
      adjustments: { saturation: 0.3, contrast: 0.15 },
      effectParams: { pixelSort: { threshold: 0.5, direction: 'vertical', maxSpan: 220, key: 'brightness', reverse: false } },
      post: { bloom: 0.2, chromatic: 0.12 },
    },
  },
];
