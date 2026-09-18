import { resolveCharset } from '../../lib/schema.js';
import { buildFontAtlas, sortedRampIndices, FONT_STACK } from '../fontAtlas.js';
import { gridForAscii, hexToRgb } from '../params.js';

/**
 * CPU backend — the universal fallback, and the only path for effects that are
 * inherently sequential (pixel sorting, error-diffusion dithering).
 *
 * Everything works on a single reusable ImageData buffer plus one scratch
 * canvas; no per-frame allocation once the size settles.
 */

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function lumaAt(d, i) {
  return (LUMA_R * d[i] + LUMA_G * d[i + 1] + LUMA_B * d[i + 2]) / 255;
}

function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

const BAYER8 = (() => {
  const m = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  return m.map((row) => row.map((v) => (v + 0.5) / 64));
})();

function bayerValue(x, y, size) {
  if (size === 2) return BAYER8[(y % 2) * 4][(x % 2) * 4];
  if (size === 4) return BAYER8[(y % 4) * 2][(x % 4) * 2];
  return BAYER8[y % 8][x % 8];
}

/* ------------------------------------------------------------ adjustments */

function hueRotateRgb(r, g, b, angle) {
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  const k = 0.57735;
  const dot = k * (r + g + b);
  // Rodrigues rotation around the grey axis.
  const cr = k * (g - b);
  const cg = k * (b - r);
  const cb = k * (r - g);
  return [
    r * cs + cr * sn + k * dot * (1 - cs),
    g * cs + cg * sn + k * dot * (1 - cs),
    b * cs + cb * sn + k * dot * (1 - cs),
  ];
}

function applyAdjustments(img, settings) {
  const a = settings.adjustments;
  const d = img.data;
  const { width: w, height: h } = img;

  if (a.sharpness > 0.001) {
    const copy = new Uint8ClampedArray(d);
    const amt = a.sharpness * 2;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const center = copy[i + c];
          const blur =
            (copy[i - 4 + c] + copy[i + 4 + c] + copy[i - w * 4 + c] + copy[i + w * 4 + c]) * 0.25;
          d[i + c] = center + (center - blur) * amt;
        }
      }
    }
  }

  const bright = a.brightness * 255;
  const contrast = 1 + a.contrast * 1.6;
  const sat = 1 + a.saturation;
  const invGamma = 1 / Math.max(a.gamma, 0.001);
  const hueRad = (a.hue * Math.PI) / 180;
  const doHue = Math.abs(hueRad) > 0.0001;
  const gradA = hexToRgb(a.gradientFrom);
  const gradB = hexToRgb(a.gradientTo);
  const mode = a.colorMode;

  // Gamma is the expensive term; a 256-entry LUT keeps it out of the inner loop.
  const gammaLut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) gammaLut[i] = Math.pow(i / 255, invGamma) * 255;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] + bright;
    let g = d[i + 1] + bright;
    let b = d[i + 2] + bright;

    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    if (doHue) {
      const [hr, hg, hb] = hueRotateRgb(r / 255, g / 255, b / 255, hueRad);
      r = hr * 255;
      g = hg * 255;
      b = hb * 255;
    }

    const l = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    r = l + (r - l) * sat;
    g = l + (g - l) * sat;
    b = l + (b - l) * sat;

    r = gammaLut[Math.max(0, Math.min(255, r | 0))];
    g = gammaLut[Math.max(0, Math.min(255, g | 0))];
    b = gammaLut[Math.max(0, Math.min(255, b | 0))];

    if (mode === 'mono') {
      const m = LUMA_R * r + LUMA_G * g + LUMA_B * b;
      r = g = b = m;
    } else if (mode === 'gradient') {
      const t = (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;
      r = (gradA[0] + (gradB[0] - gradA[0]) * t) * 255;
      g = (gradA[1] + (gradB[1] - gradA[1]) * t) * 255;
      b = (gradA[2] + (gradB[2] - gradA[2]) * t) * 255;
    }

    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
  return img;
}

/* ---------------------------------------------------------- ascii analysis */

/**
 * Reduce an adjusted frame to a character grid.
 *
 * This is the shared source of truth for the CPU renderer *and* for the .txt,
 * .svg and Three.js exports, so what you see is exactly what you export.
 */
export function analyzeAscii(img, settings, atlas) {
  const { cols, rows } = gridForAscii(settings, img.width, img.height, atlas);
  const { data, width: w, height: h } = img;
  const ascii = settings.ascii;
  const ramp = resolveCharset(ascii);
  const order = sortedRampIndices(atlas).reverse(); // light -> dark by ink
  const cells = new Array(cols * rows);

  const cellW = w / cols;
  const cellH = h / rows;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor(cx * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cellW));
      const y0 = Math.floor(cy * cellH);
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cellH));

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      let lmin = 1;
      let lmax = 0;

      // Sample at most 4x4 taps per cell regardless of cell size.
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const i = (y * w + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          const l = lumaAt(data, i);
          if (l < lmin) lmin = l;
          if (l > lmax) lmax = l;
          n++;
        }
      }
      if (!n) n = 1;
      r /= n;
      g /= n;
      b /= n;

      let l = (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;
      const localContrast = lmax - lmin;
      l = l + (Math.min(1, l * 0.55 + localContrast * 1.35) - l) * ascii.spatialWeight;
      l += ascii.tilt * ((cx / cols + cy / rows) * 0.5 - 0.5);
      l = (l - ascii.threshold) / Math.max(1 - ascii.threshold, 0.001);
      l = Math.min(1, Math.max(0, l));

      const slot = Math.round(l * (order.length - 1));
      const glyphIndex = order[Math.min(order.length - 1, Math.max(0, slot))];

      cells[cy * cols + cx] = {
        char: ramp[glyphIndex] ?? ' ',
        luma: l,
        color: `#${((1 << 24) + (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b))
          .toString(16)
          .slice(1)}`,
      };
    }
  }

  return { cols, rows, cells, cellW, cellH };
}

/* ------------------------------------------------------------------ effects */

function effectDithering(img, out, p) {
  const { data: d, width: w, height: h } = img;
  const o = out.data;
  const levels = Math.max(2, p.levels | 0);
  const step = 255 / (levels - 1);
  const scale = Math.max(1, p.scale | 0);
  const diffusion = p.matrix === 'floydSteinberg' || p.matrix === 'atkinson';

  if (!diffusion) {
    const size = p.matrix === 'bayer2' ? 2 : p.matrix === 'bayer4' ? 4 : 8;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.floor(x / scale) * scale;
        const sy = Math.floor(y / scale) * scale;
        const si = (sy * w + sx) * 4;
        const i = (y * w + x) * 4;
        const t = (bayerValue(Math.floor(x / scale), Math.floor(y / scale), size) - 0.5) * step;
        for (let c = 0; c < 3; c++) {
          o[i + c] = Math.round((d[si + c] + t) / step) * step;
        }
        o[i + 3] = 255;
      }
    }
    return;
  }

  // Error diffusion: needs a float working buffer and strict scan order.
  const buf = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    buf[j] = d[i];
    buf[j + 1] = d[i + 1];
    buf[j + 2] = d[i + 2];
  }

  const fs = [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16],
  ];
  const atkinson = [
    [1, 0, 1 / 8],
    [2, 0, 1 / 8],
    [-1, 1, 1 / 8],
    [0, 1, 1 / 8],
    [1, 1, 1 / 8],
    [0, 2, 1 / 8],
  ];
  const kernel = p.matrix === 'atkinson' ? atkinson : fs;
  const serpentine = p.serpentine !== false;

  for (let y = 0; y < h; y++) {
    const leftToRight = !serpentine || y % 2 === 0;
    for (let k = 0; k < w; k++) {
      const x = leftToRight ? k : w - 1 - k;
      const j = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const old = buf[j + c];
        const nv = Math.round(old / step) * step;
        buf[j + c] = nv;
        const err = old - nv;
        for (const [dx, dy, wgt] of kernel) {
          const ox = x + (leftToRight ? dx : -dx);
          const oy = y + dy;
          if (ox < 0 || ox >= w || oy >= h) continue;
          buf[(oy * w + ox) * 3 + c] += err * wgt;
        }
      }
    }
  }

  for (let i = 0, j = 0; i < o.length; i += 4, j += 3) {
    o[i] = buf[j];
    o[i + 1] = buf[j + 1];
    o[i + 2] = buf[j + 2];
    o[i + 3] = 255;
  }
}

function effectPixelSort(img, out, p) {
  const { data: d, width: w, height: h } = img;
  const o = out.data;
  o.set(d);

  const horizontal = p.direction !== 'vertical';
  const lanes = horizontal ? h : w;
  const laneLen = horizontal ? w : h;
  const maxSpan = Math.max(4, p.maxSpan | 0);
  const threshold = p.threshold;
  const reverse = !!p.reverse;

  const keyOf = (i) => {
    const r = d[i] / 255;
    const g = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    if (p.key === 'hue') {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const c = max - min;
      if (c === 0) return 0;
      let hDeg;
      if (max === r) hDeg = ((g - b) / c) % 6;
      else if (max === g) hDeg = (b - r) / c + 2;
      else hDeg = (r - g) / c + 4;
      return ((hDeg * 60 + 360) % 360) / 360;
    }
    if (p.key === 'saturation') {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return max === 0 ? 0 : (max - min) / max;
    }
    return LUMA_R * r + LUMA_G * g + LUMA_B * b;
  };

  const idx = (lane, pos) => (horizontal ? (lane * w + pos) * 4 : (pos * w + lane) * 4);

  const span = [];
  for (let lane = 0; lane < lanes; lane++) {
    let start = -1;
    for (let pos = 0; pos <= laneLen; pos++) {
      const inside = pos < laneLen && keyOf(idx(lane, pos)) > threshold;
      if (inside && start < 0) start = pos;
      const ends = !inside || pos - start >= maxSpan;
      if (start >= 0 && ends) {
        const end = pos;
        span.length = 0;
        for (let q = start; q < end; q++) {
          const i = idx(lane, q);
          span.push([keyOf(i), d[i], d[i + 1], d[i + 2]]);
        }
        span.sort((a, b2) => (reverse ? b2[0] - a[0] : a[0] - b2[0]));
        for (let q = start; q < end; q++) {
          const i = idx(lane, q);
          const s = span[q - start];
          o[i] = s[1];
          o[i + 1] = s[2];
          o[i + 2] = s[3];
          o[i + 3] = 255;
        }
        start = inside && pos - start >= maxSpan ? pos : -1;
      }
    }
  }
}

function effectThreshold(img, out, p) {
  const d = img.data;
  const o = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = lumaAt(d, i);
    let t = p.softness > 0.001
      ? Math.min(1, Math.max(0, (l - (p.level - p.softness)) / (2 * p.softness)))
      : l > p.level
        ? 1
        : 0;
    if (p.invert) t = 1 - t;
    const v = t * 255;
    o[i] = o[i + 1] = o[i + 2] = v;
    o[i + 3] = 255;
  }
}

function effectEdge(img, out, p) {
  const { data: d, width: w, height: h } = img;
  const o = out.data;
  const op = p.operator;
  const k2 = op === 'scharr' ? 10 : op === 'prewitt' ? 1 : 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const cl = (xx, yy) =>
        lumaAt(d, (Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))) * 4);
      let mag;
      if (op === 'laplacian') {
        mag = Math.abs(cl(x, y - 1) + cl(x, y + 1) + cl(x - 1, y) + cl(x + 1, y) - 4 * cl(x, y));
      } else {
        const gx =
          cl(x + 1, y - 1) + k2 * cl(x + 1, y) + cl(x + 1, y + 1) -
          (cl(x - 1, y - 1) + k2 * cl(x - 1, y) + cl(x - 1, y + 1));
        const gy =
          cl(x - 1, y - 1) + k2 * cl(x, y - 1) + cl(x + 1, y - 1) -
          (cl(x - 1, y + 1) + k2 * cl(x, y + 1) + cl(x + 1, y + 1));
        mag = Math.hypot(gx, gy);
      }
      mag = Math.min(1, mag * p.strength);
      mag = mag < p.threshold ? 0 : mag;
      if (p.invert) mag = 1 - mag;
      const v = mag * 255;
      o[i] = o[i + 1] = o[i + 2] = v;
      o[i + 3] = 255;
    }
  }
}

function effectNoiseField(img, out, p, time) {
  const { data: d, width: w, height: h } = img;
  const o = out.data;
  const oct = Math.max(1, p.octaves | 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let amp = 0.5;
      let fx = (x / w) * p.scale;
      let fy = (y / h) * p.scale;
      let dx = 0;
      let dy = 0;
      for (let k = 0; k < oct; k++) {
        dx += (valueNoise(fx + time * p.speed, fy) - 0.5) * amp;
        dy += (valueNoise(fy - time * p.speed * 0.8, fx) - 0.5) * amp;
        fx *= 2.03;
        fy *= 2.03;
        amp *= 0.5;
      }
      const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * p.strength * w * 0.15)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * p.strength * h * 0.15)));
      const si = (sy * w + sx) * 4;
      const i = (y * w + x) * 4;
      o[i] = d[si];
      o[i + 1] = d[si + 1];
      o[i + 2] = d[si + 2];
      o[i + 3] = 255;
    }
  }
}

function effectVoronoi(img, out, p) {
  const { data: d, width: w, height: h } = img;
  const o = out.data;
  const aspect = w / h;
  const gx = Math.max(1, Math.floor(Math.sqrt(p.cells * aspect)));
  const gy = Math.max(1, Math.floor(p.cells / gx));
  const sites = new Float32Array(gx * gy * 2);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const k = (j * gx + i) * 2;
      sites[k] = (i + 0.5 + (hash2(i, j) - 0.5) * p.jitter) / gx;
      sites[k + 1] = (j + 0.5 + (hash2(i + 91, j + 17) - 0.5) * p.jitter) / gy;
    }
  }

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const cj = Math.min(gy - 1, Math.floor(v * gy));
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const ci = Math.min(gx - 1, Math.floor(u * gx));
      let best = Infinity;
      let second = Infinity;
      let bi = ci;
      let bj = cj;
      for (let jj = cj - 1; jj <= cj + 1; jj++) {
        if (jj < 0 || jj >= gy) continue;
        for (let ii = ci - 1; ii <= ci + 1; ii++) {
          if (ii < 0 || ii >= gx) continue;
          const k = (jj * gx + ii) * 2;
          const ddx = (u - sites[k]) * aspect;
          const ddy = v - sites[k + 1];
          const dist = ddx * ddx + ddy * ddy;
          if (dist < best) {
            second = best;
            best = dist;
            bi = ii;
            bj = jj;
          } else if (dist < second) second = dist;
        }
      }
      const k = (bj * gx + bi) * 2;
      const sx = Math.min(w - 1, Math.max(0, Math.round(sites[k] * w)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(sites[k + 1] * h)));
      const si = (sy * w + sx) * 4;
      const i = (y * w + x) * 4;
      const edge = Math.sqrt(second) - Math.sqrt(best);
      const ink = p.border > 0.0001 ? Math.min(1, edge / p.border) : 1;
      o[i] = d[si] * ink;
      o[i + 1] = d[si + 1] * ink;
      o[i + 2] = d[si + 2] * ink;
      o[i + 3] = 255;
    }
  }
}

function effectVhs(img, out, p, time) {
  const { data: d, width: w, height: h } = img;
  const o = out.data;
  const shift = Math.round(p.chromaShift * 0.01 * w);
  for (let y = 0; y < h; y++) {
    const wob = Math.round((hash2(y, Math.floor(time * 24)) - 0.5) * p.jitter * 0.02 * w);
    const bandSeed = Math.floor((y / h) * 12 - time * 1.3);
    const band = hash2(bandSeed, 7) > 1 - p.tracking * 0.35 ? 1 : 0;
    const tear = band ? Math.round((hash2(bandSeed, 31) - 0.5) * 0.08 * p.tracking * w) : 0;
    const scan = 1 - p.scanlines * 0.5 * (0.5 + 0.5 * Math.sin(y * Math.PI));
    for (let x = 0; x < w; x++) {
      const base = x + wob + tear;
      const cx = (c) => Math.min(w - 1, Math.max(0, base + c));
      const i = (y * w + x) * 4;
      const ir = (y * w + cx(shift)) * 4;
      const ig = (y * w + cx(0)) * 4;
      const ib = (y * w + cx(-shift)) * 4;
      const n = (hash2(x + Math.floor(time * 60), y) - 0.5) * p.noise * 150;
      o[i] = d[ir] * scan + n;
      o[i + 1] = d[ig + 1] * scan + n;
      o[i + 2] = d[ib + 2] * scan + n;
      o[i + 3] = 255;
    }
  }
}

function effectContour(img, out, p) {
  const { data: d, width: w, height: h } = img;
  const o = out.data;
  const levels = Math.max(2, p.levels | 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const q = (xx, yy) =>
        Math.floor(
          lumaAt(d, (Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))) * 4) *
            levels,
        );
      const c = q(x, y);
      const isEdge = c !== q(x + 1, y) || c !== q(x, y + 1);
      if (p.filled) {
        const v = (c / levels) * 255;
        o[i] = o[i + 1] = o[i + 2] = v;
      } else {
        const v = isEdge ? 255 : 0;
        o[i] = d[i] * (isEdge ? 1 : 0);
        o[i + 1] = d[i + 1] * (isEdge ? 1 : 0);
        o[i + 2] = d[i + 2] * (isEdge ? 1 : 0);
        if (isEdge) {
          o[i] = Math.max(o[i], v * 0.6);
          o[i + 1] = Math.max(o[i + 1], v * 0.8);
          o[i + 2] = Math.max(o[i + 2], v * 0.6);
        }
      }
      o[i + 3] = 255;
    }
  }
}

/* ------------------------------------------------------------- draw-based */

function drawBackground(ctx, scratch, w, h, intensity) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  if (intensity > 0.001) {
    ctx.save();
    ctx.globalAlpha = intensity;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }
}

function sampleColor(img, x, y) {
  const w = img.width;
  const h = img.height;
  const i = (Math.min(h - 1, Math.max(0, y | 0)) * w + Math.min(w - 1, Math.max(0, x | 0))) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], lumaAt(img.data, i)];
}

function drawHalftone(ctx, img, p) {
  const { width: w, height: h } = img;
  const cell = Math.max(2, p.cell);
  const ang = (p.angle * Math.PI) / 180;
  const cos = Math.cos(-ang);
  const sin = Math.sin(-ang);
  const diag = Math.hypot(w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(ang);
  for (let y = -diag / 2; y < diag / 2; y += cell) {
    for (let x = -diag / 2; x < diag / 2; x += cell) {
      const cxr = x + cell / 2;
      const cyr = y + cell / 2;
      const ix = cxr * cos - cyr * sin + w / 2;
      const iy = cxr * sin + cyr * cos + h / 2;
      if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;
      const [r, g, b, l] = sampleColor(img, ix, iy);
      const radius = Math.sqrt(Math.max(0, 1 - l)) * cell * 0.72;
      if (radius < 0.15) continue;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.beginPath();
      if (p.shape === 'square') ctx.rect(cxr - radius, cyr - radius, radius * 2, radius * 2);
      else if (p.shape === 'diamond') {
        ctx.moveTo(cxr, cyr - radius);
        ctx.lineTo(cxr + radius, cyr);
        ctx.lineTo(cxr, cyr + radius);
        ctx.lineTo(cxr - radius, cyr);
        ctx.closePath();
      } else if (p.shape === 'line') {
        ctx.rect(cxr - cell / 2, cyr - radius, cell, radius * 2);
      } else ctx.arc(cxr, cyr, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawDots(ctx, img, p) {
  const { width: w, height: h } = img;
  const cell = Math.max(2, p.cell);
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const jx = (hash2(x / cell, y / cell) - 0.5) * p.jitter * cell;
      const jy = (hash2(y / cell, x / cell) - 0.5) * p.jitter * cell;
      const cx = x + cell / 2 + jx;
      const cy = y + cell / 2 + jy;
      const [r, g, b, l] = sampleColor(img, cx, cy);
      const radius = (p.minRadius + (p.maxRadius - p.minRadius) * (1 - l)) * cell;
      if (radius < 0.15) continue;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBlockify(ctx, img, p) {
  const { width: w, height: h } = img;
  const block = Math.max(2, p.block);
  const inset = (block * p.gap) / 2;
  const size = block - inset * 2;
  if (size <= 0) return;
  const radius = (p.roundness * size) / 2;
  for (let y = 0; y < h; y += block) {
    for (let x = 0; x < w; x += block) {
      const [r, g, b] = sampleColor(img, x + block / 2, y + block / 2);
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.beginPath();
      ctx.roundRect(x + inset, y + inset, size, size, radius);
      ctx.fill();
    }
  }
}

function drawWaveLines(ctx, img, p, time) {
  const { width: w, height: h } = img;
  const rows = Math.max(2, p.rows | 0);
  const rowH = h / rows;
  ctx.lineWidth = p.lineWidth;
  ctx.lineJoin = 'round';
  for (let r = 0; r < rows; r++) {
    const cy = (r + 0.5) * rowH;
    ctx.beginPath();
    let started = false;
    for (let x = 0; x <= w; x += 2) {
      const [, , , l] = sampleColor(img, x, cy);
      const disp = Math.sin((x / w) * p.frequency * 20 + p.phase + time * 1.5) * p.amplitude * (0.5 - l) * rowH;
      const y = cy + disp;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    const [r0, g0, b0] = sampleColor(img, w / 2, cy);
    ctx.strokeStyle = `rgb(${r0 | 0},${g0 | 0},${b0 | 0})`;
    ctx.stroke();
  }
}

function drawCrosshatch(ctx, img, p) {
  const { width: w, height: h } = img;
  const diag = Math.hypot(w, h);
  const layers = Math.max(1, p.layers | 0);
  ctx.save();
  ctx.lineWidth = p.lineWidth;
  ctx.strokeStyle = 'rgba(200,255,200,0.85)';
  for (let layer = 0; layer < layers; layer++) {
    const need = 1 - (layer + 0.5) / layers;
    const angle = (p.angle * Math.PI) / 180 + layer * 0.9;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(angle);
    for (let y = -diag / 2; y < diag / 2; y += p.spacing) {
      ctx.beginPath();
      let drawing = false;
      for (let x = -diag / 2; x < diag / 2; x += 3) {
        const ix = x * Math.cos(angle) - y * Math.sin(angle) + w / 2;
        const iy = x * Math.sin(angle) + y * Math.cos(angle) + h / 2;
        const inside = ix >= 0 && ix < w && iy >= 0 && iy < h;
        const dark = inside && sampleColor(img, ix, iy)[3] <= need;
        if (dark && !drawing) {
          ctx.moveTo(x, y);
          drawing = true;
        } else if (dark) {
          ctx.lineTo(x, y);
        } else {
          drawing = false;
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawMatrixRain(ctx, img, p, time) {
  const { width: w, height: h } = img;
  const cols = Math.max(4, p.columns | 0);
  const cw = w / cols;
  const rows = Math.max(1, Math.floor(h / cw));
  const glyphs = '01ｱｲｳｴｵﾊﾋﾌﾍﾎAZ';
  ctx.font = `500 ${cw}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let c = 0; c < cols; c++) {
    const seed = hash2(c, 3);
    const head = (seed + time * p.speed * (0.35 + seed * 0.65)) % 1;
    for (let r = 0; r < rows; r++) {
      const rowNorm = 1 - (r + 0.5) / rows;
      let dist = head - rowNorm;
      dist -= Math.floor(dist);
      const tail = 1 - Math.min(1, dist / Math.max(p.trail, 0.02));
      if (tail <= 0.01) continue;
      const x = (c + 0.5) * cw;
      const y = (r + 0.5) * (h / rows);
      const [, , , l] = sampleColor(img, x, y);
      const alpha = tail * (0.25 + 0.75 * (1 - l));
      const glyph = glyphs[Math.floor(hash2(c, r + Math.floor(time * 8)) * glyphs.length)];
      ctx.fillStyle = dist < 0.06 ? `rgba(220,255,220,${alpha})` : `rgba(90,255,120,${alpha})`;
      ctx.fillText(glyph, x, y);
    }
  }
}

function drawAscii(ctx, img, settings, atlas) {
  const grid = analyzeAscii(img, settings, atlas);
  const { cols, rows, cells } = grid;
  const cw = img.width / cols;
  const ch = img.height / rows;
  const fontSize = ch * (1 - settings.ascii.spacing);
  ctx.font = `500 ${Math.max(1, fontSize)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = cells[y * cols + x];
      if (!cell || cell.char === ' ') continue;
      ctx.fillStyle = cell.color;
      ctx.fillText(cell.char, (x + 0.5) * cw, (y + 0.5) * ch);
    }
  }
  return grid;
}

/* ------------------------------------------------------------ post-process */

function applyPost(ctx, canvas, post, time) {
  const { width: w, height: h } = canvas;
  const hasPixelPost = post.scanlines > 0.001 || post.vignette > 0.001 || post.grain > 0.001;

  if (post.bloom > 0.001) {
    // Cheap bloom: a downscaled, blurred copy composited additively.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, post.bloom * 0.6);
    ctx.filter = `blur(${Math.max(1, Math.round(w / 180))}px) brightness(${1 + post.bloom * 0.3})`;
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = 'none';
    ctx.restore();
  }

  if (!hasPixelPost) return;

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const scan = 1 - post.scanlines * 0.45 * (0.5 + 0.5 * Math.sin(y * Math.PI));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let m = scan;
      if (post.vignette > 0.001) {
        const dx = x / w - 0.5;
        const dy = y / h - 0.5;
        const dist = Math.hypot(dx, dy) * 2 * 1.414;
        const v = Math.min(1, Math.max(0, (dist - 0.35) / 0.65));
        m *= 1 - post.vignette * v * v * (3 - 2 * v);
      }
      const n = post.grain > 0.001 ? (hash2(x + Math.floor(time * 97), y) - 0.5) * post.grain * 64 : 0;
      d[i] = d[i] * m + n;
      d[i + 1] = d[i + 1] * m + n;
      d[i + 2] = d[i + 2] * m + n;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* -------------------------------------------------------------- the backend */

export function createCpuBackend(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return null;

  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { alpha: false, willReadFrequently: true });

  let srcImage = null;
  let outImage = null;
  let lastGrid = null;

  function prepare(frame, settings, w, h) {
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
      srcImage = null;
      outImage = null;
    }
    sctx.drawImage(frame, 0, 0, w, h);
    if (!srcImage || srcImage.width !== w || srcImage.height !== h) {
      srcImage = sctx.getImageData(0, 0, w, h);
    } else {
      srcImage.data.set(sctx.getImageData(0, 0, w, h).data);
    }
    applyAdjustments(srcImage, settings);
    sctx.putImageData(srcImage, 0, 0);
    return srcImage;
  }

  function ensureOut(w, h) {
    if (!outImage || outImage.width !== w || outImage.height !== h) {
      outImage = ctx.createImageData(w, h);
    }
    return outImage;
  }

  return {
    name: 'cpu',
    canvas,
    ctx,

    resize(w, h) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    },

    /** Adjusted, effect-free pixels — used by the GPU-assisted CPU effects. */
    prepareOnly(frame, settings, w, h) {
      this.resize(w, h);
      return prepare(frame, settings, w, h);
    },

    render(frame, settings, w, h, time = 0, audio = 0) {
      this.resize(w, h);
      const img = prepare(frame, settings, w, h);
      const p = settings.effectParams[settings.effect] ?? {};
      const bg = settings.adjustments.backgroundIntensity;
      lastGrid = null;

      // Pixel-domain effects write a full buffer; draw-domain effects paint
      // over a background derived from the adjusted source.
      const pixelEffects = {
        dithering: effectDithering,
        pixelSort: effectPixelSort,
        threshold: effectThreshold,
        edgeDetection: effectEdge,
        contour: effectContour,
        voronoi: effectVoronoi,
      };

      if (settings.effect === 'noiseField') {
        const out = ensureOut(w, h);
        effectNoiseField(img, out, p, time);
        ctx.putImageData(out, 0, 0);
      } else if (settings.effect === 'vhs') {
        const out = ensureOut(w, h);
        effectVhs(img, out, p, time);
        ctx.putImageData(out, 0, 0);
      } else if (pixelEffects[settings.effect]) {
        const out = ensureOut(w, h);
        pixelEffects[settings.effect](img, out, p);
        ctx.putImageData(out, 0, 0);
      } else {
        drawBackground(ctx, scratch, w, h, bg);
        switch (settings.effect) {
          case 'ascii': {
            const chars = resolveCharset(settings.ascii);
            const atlas = buildFontAtlas(chars, { size: 32 });
            lastGrid = drawAscii(ctx, img, settings, atlas);
            break;
          }
          case 'halftone':
            drawHalftone(ctx, img, p);
            break;
          case 'dots':
            drawDots(ctx, img, p);
            break;
          case 'blockify':
            drawBlockify(ctx, img, p);
            break;
          case 'waveLines':
            drawWaveLines(ctx, img, p, time);
            break;
          case 'crosshatch':
            drawCrosshatch(ctx, img, p);
            break;
          case 'matrixRain':
            drawMatrixRain(ctx, img, p, time);
            break;
          default:
            ctx.drawImage(scratch, 0, 0);
        }
      }

      applyPost(ctx, canvas, settings.post, time);
    },

    /** The character grid from the last ascii render, if any. */
    lastAsciiGrid: () => lastGrid,

    /** Compute a grid on demand (export path, independent of what was drawn). */
    computeAsciiGrid(frame, settings, w, h) {
      this.resize(w, h);
      const img = prepare(frame, settings, w, h);
      const atlas = buildFontAtlas(resolveCharset(settings.ascii), { size: 32 });
      return analyzeAscii(img, settings, atlas);
    },

    isLost: () => false,

    dispose() {
      scratch.width = 0;
      scratch.height = 0;
      srcImage = null;
      outImage = null;
      lastGrid = null;
    },
  };
}

export { applyAdjustments };
