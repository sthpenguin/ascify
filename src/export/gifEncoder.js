/**
 * Minimal GIF89a encoder — median-cut palette plus LZW, no dependencies.
 *
 * Written rather than imported because every GIF library on npm is larger than
 * this file and would have to be precached by the service worker. It handles
 * the case ascify actually produces: a handful of frames of already-quantised,
 * low-entropy output.
 */

class ByteStream {
  constructor() {
    this.bytes = [];
  }
  byte(b) {
    this.bytes.push(b & 0xff);
  }
  short(v) {
    this.byte(v);
    this.byte(v >> 8);
  }
  string(s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  raw(arr) {
    for (const b of arr) this.byte(b);
  }
  toUint8Array() {
    return Uint8Array.from(this.bytes);
  }
}

/* ------------------------------------------------------------ median cut */

function medianCut(pixels, maxColors) {
  // pixels: Uint8ClampedArray RGBA. Sample rather than read every pixel;
  // 16k samples is plenty to place 256 palette entries.
  const total = pixels.length / 4;
  const stride = Math.max(1, Math.floor(total / 16384));
  const samples = [];
  for (let i = 0; i < total; i += stride) {
    const j = i * 4;
    samples.push([pixels[j], pixels[j + 1], pixels[j + 2]]);
  }
  if (!samples.length) samples.push([0, 0, 0]);

  let boxes = [samples];
  while (boxes.length < maxColors) {
    // Split the box with the widest channel range.
    let bestIdx = -1;
    let bestRange = -1;
    let bestChannel = 0;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let min = 255;
        let max = 0;
        for (const p of box) {
          if (p[c] < min) min = p[c];
          if (p[c] > max) max = p[c];
        }
        const range = max - min;
        if (range > bestRange) {
          bestRange = range;
          bestIdx = b;
          bestChannel = c;
        }
      }
    }
    if (bestIdx < 0 || bestRange <= 0) break;
    const box = boxes[bestIdx];
    box.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = box.length >> 1;
    boxes.splice(bestIdx, 1, box.slice(0, mid), box.slice(mid));
  }

  const palette = boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n = box.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });

  while (palette.length < 2) palette.push([0, 0, 0]);
  return palette;
}

function buildLookup(palette) {
  // 5-bit-per-channel cache: 32k entries, filled lazily.
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0];
      const dg = g - p[1];
      const db = b - p[2];
      const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    cache[key] = best;
    return best;
  };
}

/* -------------------------------------------------------------------- LZW */

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();

  const out = [];
  let cur = 0;
  let curBits = 0;

  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };

  const reset = () => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };

  emit(clearCode);
  reset();

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      dict.set(key, nextCode++);
      if (nextCode - 1 === 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      reset();
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (curBits > 0) out.push(cur & 0xff);
  return out;
}

/* ----------------------------------------------------------------- writer */

export function createGifEncoder({ width, height, loop = 0, maxColors = 256 }) {
  const s = new ByteStream();
  let wroteHeader = false;

  function header() {
    s.string('GIF89a');
    s.short(width);
    s.short(height);
    s.byte(0x70); // no global colour table; 8-bit colour resolution
    s.byte(0);
    s.byte(0);
    // NETSCAPE2.0 application extension carries the loop count.
    s.byte(0x21);
    s.byte(0xff);
    s.byte(11);
    s.string('NETSCAPE2.0');
    s.byte(3);
    s.byte(1);
    s.short(loop);
    s.byte(0);
    wroteHeader = true;
  }

  return {
    /**
     * @param {ImageData} imageData
     * @param {number} delayMs  frame delay; GIF stores hundredths of a second
     */
    addFrame(imageData, delayMs = 100) {
      if (!wroteHeader) header();

      const palette = medianCut(imageData.data, maxColors);
      const lookup = buildLookup(palette);
      const px = imageData.data;
      const count = px.length / 4;
      const indices = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const j = i * 4;
        indices[i] = lookup(px[j], px[j + 1], px[j + 2]);
      }

      // Graphic control extension (delay only; frames are fully opaque).
      s.byte(0x21);
      s.byte(0xf9);
      s.byte(4);
      s.byte(0x04); // disposal: restore to background
      s.short(Math.max(2, Math.round(delayMs / 10)));
      s.byte(0);
      s.byte(0);

      // Image descriptor with a local colour table.
      let bits = 1;
      while (1 << bits < palette.length) bits++;
      const tableSize = 1 << bits;
      s.byte(0x2c);
      s.short(0);
      s.short(0);
      s.short(width);
      s.short(height);
      s.byte(0x80 | (bits - 1));
      for (let i = 0; i < tableSize; i++) {
        const c = palette[i] ?? [0, 0, 0];
        s.byte(c[0]);
        s.byte(c[1]);
        s.byte(c[2]);
      }

      const minCodeSize = Math.max(2, bits);
      s.byte(minCodeSize);
      const data = lzwEncode(indices, minCodeSize);
      for (let i = 0; i < data.length; i += 255) {
        const chunk = data.slice(i, i + 255);
        s.byte(chunk.length);
        s.raw(chunk);
      }
      s.byte(0);
    },

    finish() {
      if (!wroteHeader) header();
      s.byte(0x3b);
      return new Blob([s.toUint8Array()], { type: 'image/gif' });
    },
  };
}
