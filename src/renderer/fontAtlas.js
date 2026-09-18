/**
 * Glyph atlas, built on the CPU and uploaded once as a GPU texture.
 *
 * Rasterising text per-frame is the thing that kills ASCII renderers, so every
 * glyph in the active charset is drawn once into a grid canvas via fillText.
 * `getImageData` then measures each glyph's ink coverage, which lets the ramp
 * be sorted by actual darkness instead of trusting the order a user typed.
 *
 * Atlases are cached by (chars, size, font, weight); the cache is bounded and
 * holds only rendered glyph shapes — never anything derived from user media.
 */

const CACHE = new Map();
const MAX_CACHED = 8;

const FONT_STACK = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * @param {string[]} chars   ramp characters, dark -> light or as supplied
 * @param {object}   opts
 * @returns {{canvas, cols, rows, cellW, cellH, count, coverage:Float32Array, key:string}}
 */
export function buildFontAtlas(chars, { size = 32, weight = 500, font = FONT_STACK } = {}) {
  const list = chars.length ? chars : [' '];
  const key = `${size}|${weight}|${font}|${list.join('')}`;
  const hit = CACHE.get(key);
  if (hit) {
    // Refresh LRU position.
    CACHE.delete(key);
    CACHE.set(key, hit);
    return hit;
  }

  // Monospace cell: measure the widest glyph rather than assuming 0.6em.
  const probe = makeCanvas(8, 8);
  const pctx = probe.getContext('2d');
  pctx.font = `${weight} ${size}px ${font}`;
  let cellW = 0;
  for (const ch of list) cellW = Math.max(cellW, pctx.measureText(ch).width);
  cellW = Math.max(1, Math.ceil(cellW || size * 0.6));
  const cellH = Math.max(1, Math.ceil(size * 1.2));

  const count = list.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  const canvas = makeCanvas(cols * cellW, rows * cellH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';

  for (let i = 0; i < count; i++) {
    const cx = (i % cols) * cellW + cellW / 2;
    const cy = Math.floor(i / cols) * cellH + cellH / 2;
    ctx.fillText(list[i], cx, cy);
  }

  // Ink coverage per glyph, 0..1 — used to order and to normalise the ramp.
  const coverage = new Float32Array(count);
  try {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < count; i++) {
      const gx = (i % cols) * cellW;
      const gy = Math.floor(i / cols) * cellH;
      let sum = 0;
      for (let y = 0; y < cellH; y++) {
        let row = ((gy + y) * canvas.width + gx) * 4 + 3;
        for (let x = 0; x < cellW; x++, row += 4) sum += data[row];
      }
      coverage[i] = sum / (cellW * cellH * 255);
    }
  } catch {
    // Tainted or unavailable context: fall back to a linear assumption.
    for (let i = 0; i < count; i++) coverage[i] = count > 1 ? i / (count - 1) : 0;
  }

  const atlas = { canvas, cols, rows, cellW, cellH, count, coverage, key, chars: list };

  CACHE.set(key, atlas);
  if (CACHE.size > MAX_CACHED) {
    const oldest = CACHE.keys().next().value;
    const dropped = CACHE.get(oldest);
    CACHE.delete(oldest);
    if (dropped?.canvas) {
      dropped.canvas.width = 0;
      dropped.canvas.height = 0;
    }
  }
  return atlas;
}

/**
 * Ramp ordering: returns glyph indices sorted light -> dark by measured ink,
 * so any charset (including one a user typed in any order) maps monotonically
 * onto luminance.
 */
export function sortedRampIndices(atlas) {
  return Array.from({ length: atlas.count }, (_, i) => i).sort(
    (a, b) => atlas.coverage[a] - atlas.coverage[b],
  );
}

export function clearAtlasCache() {
  for (const atlas of CACHE.values()) {
    if (atlas.canvas) {
      atlas.canvas.width = 0;
      atlas.canvas.height = 0;
    }
  }
  CACHE.clear();
}

export { FONT_STACK };
