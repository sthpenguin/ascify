/**
 * GLSL ES 3.00 sources for the WebGL2 backend.
 *
 * Design notes:
 *  - Source textures are uploaded with UNPACK_FLIP_Y, so every pass can use the
 *    same `vUv = pos * 0.5 + 0.5` mapping and the final blit lands upright.
 *  - Effects write vec4(rgb, ink) where `ink` is coverage. Compositing against
 *    the background happens once, in COMPOSITE_CHUNK, so "background intensity"
 *    behaves identically for all fifteen effects.
 *  - Per-effect parameters ride in `uP[8]` / `uM[4]` rather than named uniforms,
 *    so adding an effect never means touching the uniform plumbing.
 */

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMMON = `
precision highp float;
precision highp int;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i + vec2(0.0, 0.0)), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

mat2 rot(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}
`;

/* ------------------------------------------------------------- adjustments */

export const ADJUST_FRAG = `#version 300 es
${COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uHue;        // radians
uniform float uSharpness;
uniform float uGamma;
uniform int   uColorMode;  // 0 original | 1 mono | 2 gradient
uniform vec3  uGradA;
uniform vec3  uGradB;

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}

void main() {
  vec3 c = texture(uSrc, vUv).rgb;

  // Unsharp mask: cheap 4-tap laplacian, skipped entirely when sharpness is 0.
  if (uSharpness > 0.001) {
    vec3 blur = (
      texture(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb +
      texture(uSrc, vUv - vec2(uTexel.x, 0.0)).rgb +
      texture(uSrc, vUv + vec2(0.0, uTexel.y)).rgb +
      texture(uSrc, vUv - vec2(0.0, uTexel.y)).rgb) * 0.25;
    c = clamp(c + (c - blur) * uSharpness * 2.0, 0.0, 1.0);
  }

  c = clamp(c + uBrightness, 0.0, 1.0);
  c = clamp((c - 0.5) * (1.0 + uContrast * 1.6) + 0.5, 0.0, 1.0);

  if (abs(uHue) > 0.0001) c = clamp(hueRotate(c, uHue), 0.0, 1.0);

  float l = luma(c);
  c = clamp(mix(vec3(l), c, 1.0 + uSaturation), 0.0, 1.0);

  c = pow(max(c, vec3(0.0)), vec3(1.0 / max(uGamma, 0.001)));

  if (uColorMode == 1) {
    c = vec3(luma(c));
  } else if (uColorMode == 2) {
    c = mix(uGradA, uGradB, clamp(luma(c), 0.0, 1.0));
  }

  fragColor = vec4(c, 1.0);
}`;

/* --------------------------------------------------------- ascii cell pass */

export const CELL_FRAG = `#version 300 es
${COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2 uGrid;     // cols, rows
uniform vec2 uTexel;    // source texel size
uniform float uThreshold;
uniform float uTilt;
uniform float uSpatial;
uniform float uAudio;

void main() {
  vec2 cell = floor(vUv * uGrid);
  vec2 cellSize = 1.0 / uGrid;
  vec2 origin = cell * cellSize;

  // 4x4 box average across the cell: enough to be stable under motion without
  // the cost of a full mip chain.
  vec3 sum = vec3(0.0);
  float lmin = 1.0;
  float lmax = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 o = (vec2(float(x), float(y)) + 0.5) * 0.25;
      vec3 s = texture(uSrc, origin + o * cellSize).rgb;
      sum += s;
      float sl = luma(s);
      lmin = min(lmin, sl);
      lmax = max(lmax, sl);
    }
  }
  vec3 avg = sum / 16.0;
  float l = luma(avg);

  // Spatial weight nudges glyph choice toward local contrast, so edges pick
  // denser characters than a flat patch of the same average brightness.
  float localContrast = lmax - lmin;
  l = mix(l, clamp(l * 0.55 + localContrast * 1.35, 0.0, 1.0), uSpatial);

  // Tilt biases the ramp along the image diagonal.
  l += uTilt * ((vUv.x + vUv.y) * 0.5 - 0.5);

  l = clamp((l - uThreshold) / max(1.0 - uThreshold, 0.001), 0.0, 1.0);
  l = clamp(l * (1.0 + uAudio), 0.0, 1.0);

  fragColor = vec4(avg, l);
}`;

/* -------------------------------------------------------- ascii glyph pass */

export const GLYPH_FRAG = `#version 300 es
${COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uCells;
uniform sampler2D uAtlas;
uniform sampler2D uSrc;
uniform vec2 uGrid;
uniform vec2 uAtlasGrid;   // atlas cols, rows
uniform float uCount;      // glyph count
uniform float uSpacing;
uniform float uBackground;
uniform int uRampLen;
uniform int uRamp[128];    // glyph indices ordered light -> dark

void main() {
  vec2 cell = floor(vUv * uGrid);
  vec2 local = fract(vUv * uGrid);

  vec4 info = texture(uCells, (cell + 0.5) / uGrid);
  float l = info.a;

  int slot = int(clamp(l * (float(uRampLen) - 1.0) + 0.5, 0.0, float(uRampLen) - 1.0));
  int glyph = uRamp[slot];

  // Spacing shrinks the glyph inside its cell; outside the inset there is no ink.
  float inset = uSpacing * 0.5;
  vec2 g = (local - inset) / max(1.0 - uSpacing, 0.001);
  float inside = step(0.0, g.x) * step(g.x, 1.0) * step(0.0, g.y) * step(g.y, 1.0);

  vec2 atlasCell = vec2(mod(float(glyph), uAtlasGrid.x), floor(float(glyph) / uAtlasGrid.x));
  // Atlas rows run top-down while UV runs bottom-up, so the row is mirrored.
  atlasCell.y = uAtlasGrid.y - 1.0 - atlasCell.y;
  vec2 auv = (atlasCell + clamp(g, 0.0, 1.0)) / uAtlasGrid;

  float ink = texture(uAtlas, auv).a * inside;

  vec3 bg = texture(uSrc, vUv).rgb * uBackground;
  fragColor = vec4(mix(bg, info.rgb, ink), 1.0);
}`;

/* ---------------------------------------------------------- effect switch */

export const EFFECT_FRAG = `#version 300 es
${COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform sampler2D uAtlas;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform vec2 uAtlasGrid;
uniform float uAtlasCount;
uniform float uTime;
uniform float uAudio;
uniform float uBackground;
uniform int uEffect;
uniform float uP[8];
uniform int uM[4];

vec3 src(vec2 uv) { return texture(uSrc, clamp(uv, vec2(0.0), vec2(1.0))).rgb; }
float srcL(vec2 uv) { return luma(src(uv)); }

/* --- ordered dither matrices ------------------------------------------- */
float bayer2(vec2 p) {
  vec2 q = mod(floor(p), 2.0);
  return (q.x + 2.0 * q.y) / 4.0;
}
float bayer4(vec2 p) {
  return (bayer2(p) + bayer2(floor(p * 0.5)) * 0.25) * 0.8 + 0.1;
}
float bayer8(vec2 p) {
  return (bayer4(p) + bayer4(floor(p * 0.5)) * 0.25) * 0.8 + 0.1;
}

/* --- gradient operators ------------------------------------------------ */
vec2 gradient(vec2 uv, int op) {
  float tl = srcL(uv + uTexel * vec2(-1.0,  1.0));
  float t  = srcL(uv + uTexel * vec2( 0.0,  1.0));
  float tr = srcL(uv + uTexel * vec2( 1.0,  1.0));
  float l  = srcL(uv + uTexel * vec2(-1.0,  0.0));
  float c  = srcL(uv);
  float r  = srcL(uv + uTexel * vec2( 1.0,  0.0));
  float bl = srcL(uv + uTexel * vec2(-1.0, -1.0));
  float b  = srcL(uv + uTexel * vec2( 0.0, -1.0));
  float br = srcL(uv + uTexel * vec2( 1.0, -1.0));

  if (op == 3) {
    float lap = (t + b + l + r) - 4.0 * c;
    return vec2(lap, 0.0);
  }
  float k = op == 1 ? 1.0 : (op == 2 ? 3.0 : 2.0);   // prewitt | scharr | sobel
  float k2 = op == 2 ? 10.0 : k;
  float gx = (tr + k2 * r + br) - (tl + k2 * l + bl);
  float gy = (tl + k2 * t + tr) - (bl + k2 * b + br);
  return vec2(gx, gy);
}

void main() {
  vec3 base = src(vUv);
  vec3 bg = base * uBackground;
  vec3 col = base;
  float ink = 1.0;
  vec2 px = vUv * uResolution;

  if (uEffect == 1) {
    /* waveLines */
    float rows = max(uP[0], 1.0);
    float amp = uP[1], freq = uP[2], lw = uP[3], phase = uP[4];
    float row = floor(vUv.y * rows);
    float rowCenter = (row + 0.5) / rows;
    float l = srcL(vec2(vUv.x, rowCenter));
    float disp = sin(vUv.x * freq * 20.0 + phase + uTime * 1.5) * amp * (0.5 - l) / rows;
    float d = abs(vUv.y - (rowCenter + disp)) * rows;
    ink = 1.0 - smoothstep(lw * 0.25, lw * 0.5, d);
    ink *= mix(0.35, 1.0, 1.0 - l);
    col = src(vec2(vUv.x, rowCenter));

  } else if (uEffect == 2) {
    /* dithering (ordered) */
    float levels = max(uP[0], 2.0);
    float scale = max(uP[1], 1.0);
    vec2 dp = floor(px / scale);
    float thr = uM[0] == 2 ? bayer2(dp) : (uM[0] == 4 ? bayer4(dp) : bayer8(dp));
    vec3 s = src((floor(px / scale) * scale + scale * 0.5) / uResolution);
    vec3 q = floor(s * (levels - 1.0) + thr) / (levels - 1.0);
    col = clamp(q, 0.0, 1.0);
    ink = 1.0;

  } else if (uEffect == 3) {
    /* halftone */
    float cell = max(uP[0], 1.0);
    float ang = uP[1];
    float sharp = uP[2];
    vec2 rp = rot(ang) * px;
    vec2 cid = floor(rp / cell);
    vec2 cc = (cid + 0.5) * cell;
    vec2 uvc = (rot(-ang) * cc) / uResolution;
    float l = srcL(uvc);
    float radius = sqrt(clamp(1.0 - l, 0.0, 1.0)) * 0.72;
    vec2 d = (rp - cc) / cell;
    float dist;
    if (uM[0] == 1)      dist = max(abs(d.x), abs(d.y));
    else if (uM[0] == 2) dist = abs(d.x) + abs(d.y);
    else if (uM[0] == 3) dist = abs(d.y);
    else                 dist = length(d);
    float edge = mix(0.22, 0.01, sharp);
    ink = 1.0 - smoothstep(radius - edge, radius + edge, dist);
    col = src(uvc);

  } else if (uEffect == 4) {
    /* dots */
    float cell = max(uP[0], 1.0);
    vec2 cid = floor(px / cell);
    vec2 jit = (hash22(cid) - 0.5) * uP[3];
    vec2 cc = (cid + 0.5 + jit) * cell;
    vec2 uvc = cc / uResolution;
    float l = srcL(uvc);
    float radius = mix(uP[1], uP[2], 1.0 - l);
    float dist = length(px - cc) / cell;
    ink = 1.0 - smoothstep(radius - 0.03, radius + 0.03, dist);
    col = src(uvc);

  } else if (uEffect == 5) {
    /* contour */
    float levels = max(uP[0], 2.0);
    float thickness = uP[1];
    float smoothAmt = uP[2];
    float l = srcL(vUv);
    if (smoothAmt > 0.001) {
      float acc = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(cos(float(i) * 1.5708), sin(float(i) * 1.5708)) * uTexel * (1.0 + smoothAmt * 3.0);
        acc += srcL(vUv + o);
      }
      l = mix(l, acc * 0.25, smoothAmt);
    }
    float scaled = l * levels;
    float band = abs(fract(scaled) - 0.5) * 2.0;
    float w = fwidth(scaled) * thickness * 2.0 + 0.001;
    ink = 1.0 - smoothstep(1.0 - w * 2.0, 1.0, band);
    if (uM[0] == 1) {
      col = vec3(floor(scaled) / levels);
      ink = 1.0;
    } else {
      col = src(vUv);
    }

  } else if (uEffect == 6) {
    /* edgeDetection */
    vec2 g = gradient(vUv, uM[0]);
    float mag = uM[0] == 3 ? abs(g.x) : length(g);
    mag = clamp(mag * uP[0], 0.0, 1.0);
    mag = smoothstep(uP[1], min(uP[1] + 0.35, 1.0), mag);
    if (uM[1] == 1) mag = 1.0 - mag;
    ink = mag;
    col = mix(src(vUv), vec3(1.0), 0.65);

  } else if (uEffect == 7) {
    /* crosshatch */
    float spacing = max(uP[0], 1.0);
    float baseAng = uP[1];
    float layers = max(uP[2], 1.0);
    float lw = uP[3];
    float l = srcL(vUv);
    float acc = 0.0;
    for (int i = 0; i < 6; i++) {
      if (float(i) >= layers) break;
      // Each layer only appears once the tone is dark enough for it.
      float need = 1.0 - (float(i) + 0.5) / layers;
      if (l > need) continue;
      float a = baseAng + float(i) * 0.9;
      float v = (rot(a) * px).y;
      float line = abs(fract(v / spacing) - 0.5) * spacing;
      acc = max(acc, 1.0 - smoothstep(lw * 0.5, lw, line));
    }
    ink = acc;
    col = mix(src(vUv), vec3(0.85, 1.0, 0.85), 0.25);

  } else if (uEffect == 8) {
    /* blockify */
    float block = max(uP[0], 1.0);
    vec2 cid = floor(px / block);
    vec2 cc = (cid + 0.5) * block;
    col = src(cc / uResolution);
    vec2 d = abs(px - cc) / (block * 0.5);
    float gap = uP[1];
    float r = uP[2];
    // Superellipse: r=0 is a square, r=1 is a circle.
    float shape = pow(pow(abs(d.x), mix(16.0, 2.0, r)) + pow(abs(d.y), mix(16.0, 2.0, r)), 1.0 / mix(16.0, 2.0, r));
    ink = 1.0 - smoothstep(1.0 - gap - 0.04, 1.0 - gap, shape);

  } else if (uEffect == 9) {
    /* threshold */
    float l = srcL(vUv);
    float t = smoothstep(uP[0] - uP[1] - 0.001, uP[0] + uP[1] + 0.001, l);
    if (uM[0] == 1) t = 1.0 - t;
    col = vec3(t);
    ink = 1.0;

  } else if (uEffect == 10) {
    /* noiseField */
    float scale = uP[0], speed = uP[1], strength = uP[2];
    float oct = max(uP[3], 1.0);
    vec2 p = vUv * scale;
    float amp = 0.5;
    vec2 disp = vec2(0.0);
    for (int i = 0; i < 6; i++) {
      if (float(i) >= oct) break;
      disp += (vec2(vnoise(p + uTime * speed), vnoise(p.yx - uTime * speed * 0.8)) - 0.5) * amp;
      p *= 2.03;
      amp *= 0.5;
    }
    col = src(vUv + disp * strength * 0.15 * (1.0 + uAudio));
    ink = 1.0;

  } else if (uEffect == 11) {
    /* matrixRain */
    float cols = max(uP[0], 1.0);
    float speed = uP[1];
    float trail = uP[2];
    float glow = uP[3];
    // Rows follow from the column count so glyph cells stay square.
    float rows = max(floor(cols * uResolution.y / uResolution.x), 1.0);
    float cx = floor(vUv.x * cols);
    float cy = floor(vUv.y * rows);
    float seed = hash11(cx * 17.13);
    float head = fract(seed + uTime * speed * (0.35 + seed * 0.65));
    float rowNorm = 1.0 - (cy + 0.5) / rows;
    float dist = fract(head - rowNorm);
    float tail = 1.0 - smoothstep(0.0, max(trail, 0.02), dist);
    float glyph = floor(hash12(vec2(cx, cy + floor(uTime * 8.0))) * uAtlasCount);
    vec2 atlasCell = vec2(mod(glyph, uAtlasGrid.x), floor(glyph / uAtlasGrid.x));
    atlasCell.y = uAtlasGrid.y - 1.0 - atlasCell.y;
    vec2 local = vec2(fract(vUv.x * cols), fract(vUv.y * rows));
    float a = texture(uAtlas, (atlasCell + local) / uAtlasGrid).a;
    float mask = 1.0 - srcL(vUv);
    ink = a * tail * mix(0.25, 1.0, 1.0 - mask);
    float headGlow = smoothstep(0.06, 0.0, dist) * glow;
    col = mix(src(vUv), vec3(0.6, 1.0, 0.6), 0.5) + headGlow;

  } else if (uEffect == 12) {
    /* vhs */
    float shift = uP[0] * 0.01;
    float scan = uP[1];
    float noiseAmt = uP[2];
    float jitter = uP[3];
    float tracking = uP[4];
    float line = floor(vUv.y * uResolution.y);
    float wob = (hash11(line + floor(uTime * 24.0)) - 0.5) * jitter * 0.02;
    // Tracking error: an occasional band that tears sideways.
    float bandSeed = floor(vUv.y * 12.0 - uTime * 1.3);
    float band = step(1.0 - tracking * 0.35, hash11(bandSeed));
    wob += band * (hash11(bandSeed * 3.1) - 0.5) * 0.08 * tracking;
    vec2 uv = vec2(vUv.x + wob, vUv.y);
    float r = src(uv + vec2(shift, 0.0)).r;
    float g = src(uv).g;
    float bch = src(uv - vec2(shift, 0.0)).b;
    col = vec3(r, g, bch);
    col *= 1.0 - scan * 0.5 * (0.5 + 0.5 * sin(vUv.y * uResolution.y * 3.14159));
    col += (hash12(px + uTime * 60.0) - 0.5) * noiseAmt * 0.6;
    col = clamp(col, 0.0, 1.0);
    ink = 1.0;

  } else if (uEffect == 13) {
    /* voronoi */
    float cells = max(uP[0], 4.0);
    float jitter = uP[1];
    float border = uP[2];
    float aspect = uResolution.x / uResolution.y;
    float gridX = max(floor(sqrt(cells * aspect)), 1.0);
    float gridY = max(floor(cells / gridX), 1.0);
    vec2 g = vec2(gridX, gridY);
    vec2 p = vUv * g;
    vec2 cid = floor(p);
    float best = 1e9, second = 1e9;
    vec2 bestCell = cid;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 nb = cid + vec2(float(x), float(y));
        vec2 site = nb + 0.5 + (hash22(nb) - 0.5) * jitter;
        float d = length(p - site);
        if (d < best) { second = best; best = d; bestCell = nb; }
        else if (d < second) { second = d; }
      }
    }
    vec2 siteUv = (bestCell + 0.5 + (hash22(bestCell) - 0.5) * jitter) / g;
    if (uM[0] == 1) {
      // Average a small kernel around the site for a calmer flat fill.
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(cos(float(i) * 1.5708), sin(float(i) * 1.5708)) / g * 0.25;
        acc += src(siteUv + o);
      }
      col = acc * 0.25;
    } else {
      col = src(siteUv);
    }
    float edge = second - best;
    ink = smoothstep(0.0, max(border, 0.001), edge);

  } else {
    col = base;
    ink = 1.0;
  }

  fragColor = vec4(mix(bg, col, clamp(ink, 0.0, 1.0)), 1.0);
}`;

/* ------------------------------------------------------------ post effects */

export const POST_FRAG = `#version 300 es
${COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform vec2 uResolution;
uniform float uBloomAmount;
uniform float uScanlines;
uniform float uVignette;
uniform float uChromatic;
uniform float uGrain;
uniform float uTime;

void main() {
  vec2 uv = vUv;
  vec3 col;

  if (uChromatic > 0.001) {
    vec2 dir = (uv - 0.5) * uChromatic * 0.02;
    col = vec3(
      texture(uSrc, uv + dir).r,
      texture(uSrc, uv).g,
      texture(uSrc, uv - dir).b);
  } else {
    col = texture(uSrc, uv).rgb;
  }

  if (uBloomAmount > 0.001) {
    col += texture(uBloom, uv).rgb * uBloomAmount;
  }

  if (uScanlines > 0.001) {
    float s = 0.5 + 0.5 * sin(uv.y * uResolution.y * 3.14159);
    col *= 1.0 - uScanlines * 0.45 * s;
  }

  if (uVignette > 0.001) {
    float d = distance(uv, vec2(0.5)) * 1.414;
    col *= 1.0 - uVignette * smoothstep(0.35, 1.0, d);
  }

  if (uGrain > 0.001) {
    col += (hash12(uv * uResolution + uTime * 97.0) - 0.5) * uGrain * 0.25;
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export const BRIGHT_FRAG = `#version 300 es
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform float uThreshold;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float l = luma(c);
  float k = smoothstep(uThreshold, min(uThreshold + 0.25, 1.0), l);
  fragColor = vec4(c * k, 1.0);
}`;

export const BLUR_FRAG = `#version 300 es
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uDir;   // texel-sized step along one axis
void main() {
  // 9-tap gaussian, separable.
  float w[5];
  w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216; w[3] = 0.054054; w[4] = 0.016216;
  vec3 acc = texture(uSrc, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    acc += texture(uSrc, vUv + uDir * float(i)).rgb * w[i];
    acc += texture(uSrc, vUv - uDir * float(i)).rgb * w[i];
  }
  fragColor = vec4(acc, 1.0);
}`;

export const BLIT_FRAG = `#version 300 es
${COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
void main() { fragColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

/** Numeric ids the shader switches on. Index 0 is ascii (handled separately). */
export const EFFECT_INDEX = {
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
  pixelSort: 14, // CPU-only; never reaches the switch
};
