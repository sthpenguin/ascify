/**
 * WGSL mirror of the WebGL2 pipeline.
 *
 * Two deliberate differences from the GL path:
 *  - Adjustments are a function (`adjusted`) called per tap instead of a
 *    separate pass, which trades a little redundant ALU for one fewer render
 *    target.
 *  - `textureSampleLevel` is used everywhere rather than `textureSample`,
 *    because the effect switch samples inside non-uniform control flow.
 */
export const WGSL = /* wgsl */ `
struct U {
  res:    vec4<f32>,   // resolution.xy, texel.xy
  grid:   vec4<f32>,   // gridCols, gridRows, atlasCols, atlasRows
  adj0:   vec4<f32>,   // brightness, contrast, saturation, hue
  adj1:   vec4<f32>,   // sharpness, gamma, colorMode, background
  gradA:  vec4<f32>,   // rgb, time
  gradB:  vec4<f32>,   // rgb, audio
  misc:   vec4<f32>,   // effect, spacing, threshold, tilt
  misc2:  vec4<f32>,   // spatialWeight, rampLen, atlasCount, _
  p0:     vec4<f32>,   // effect params 0..3
  p1:     vec4<f32>,   // effect params 4..7
  m:      vec4<f32>,   // effect mode ints
  post0:  vec4<f32>,   // bloom, bloomThreshold, scanlines, vignette
  post1:  vec4<f32>,   // chromatic, grain, _, _
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> ramp: array<u32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var sampN: sampler;
@group(0) @binding(4) var texSrc: texture_2d<f32>;
@group(0) @binding(5) var texCells: texture_2d<f32>;
@group(0) @binding(6) var texAtlas: texture_2d<f32>;
@group(0) @binding(7) var texFx: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> VSOut {
  var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let p = pts[idx];
  var out: VSOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  // Flip Y so uv (0,0) is the top-left of the uploaded frame.
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

fn luma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x = x * (x + 33.33);
  x = x * (x + x);
  return fract(x);
}

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + vec3<f32>(dot(p3, p3.yzx + 33.33));
  return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2<f32>) -> vec2<f32> {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 = p3 + vec3<f32>(dot(p3, p3.yzx + 33.33));
  return fract((p3.xx + p3.yz) * p3.zy);
}

fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  let a = hash12(i);
  let b = hash12(i + vec2<f32>(1.0, 0.0));
  let c = hash12(i + vec2<f32>(0.0, 1.0));
  let d = hash12(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn rot2(a: f32) -> mat2x2<f32> {
  let s = sin(a);
  let c = cos(a);
  return mat2x2<f32>(c, -s, s, c);
}

fn hueRotate(c: vec3<f32>, a: f32) -> vec3<f32> {
  let k = vec3<f32>(0.57735);
  let cs = cos(a);
  return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}

fn rawAt(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(texSrc, samp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
}

/** Source pixel with all global adjustments applied. */
fn adjusted(uv: vec2<f32>) -> vec3<f32> {
  var c = rawAt(uv);
  let texel = u.res.zw;

  if (u.adj1.x > 0.001) {
    let blur = (rawAt(uv + vec2<f32>(texel.x, 0.0)) + rawAt(uv - vec2<f32>(texel.x, 0.0)) +
                rawAt(uv + vec2<f32>(0.0, texel.y)) + rawAt(uv - vec2<f32>(0.0, texel.y))) * 0.25;
    c = clamp(c + (c - blur) * u.adj1.x * 2.0, vec3<f32>(0.0), vec3<f32>(1.0));
  }

  c = clamp(c + u.adj0.x, vec3<f32>(0.0), vec3<f32>(1.0));
  c = clamp((c - 0.5) * (1.0 + u.adj0.y * 1.6) + 0.5, vec3<f32>(0.0), vec3<f32>(1.0));

  if (abs(u.adj0.w) > 0.0001) {
    c = clamp(hueRotate(c, u.adj0.w), vec3<f32>(0.0), vec3<f32>(1.0));
  }

  let l0 = luma(c);
  c = clamp(mix(vec3<f32>(l0), c, 1.0 + u.adj0.z), vec3<f32>(0.0), vec3<f32>(1.0));
  c = pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / max(u.adj1.y, 0.001)));

  let mode = i32(u.adj1.z + 0.5);
  if (mode == 1) {
    c = vec3<f32>(luma(c));
  } else if (mode == 2) {
    c = mix(u.gradA.rgb, u.gradB.rgb, clamp(luma(c), 0.0, 1.0));
  }
  return c;
}

fn adjL(uv: vec2<f32>) -> f32 { return luma(adjusted(uv)); }

/* ------------------------------------------------------------- cells pass */

@fragment
fn fsCells(in: VSOut) -> @location(0) vec4<f32> {
  let grid = u.grid.xy;
  let cell = floor(in.uv * grid);
  let cellSize = 1.0 / grid;
  let origin = cell * cellSize;

  var sum = vec3<f32>(0.0);
  var lmin = 1.0;
  var lmax = 0.0;
  for (var y = 0; y < 4; y = y + 1) {
    for (var x = 0; x < 4; x = x + 1) {
      let o = (vec2<f32>(f32(x), f32(y)) + 0.5) * 0.25;
      let s = adjusted(origin + o * cellSize);
      sum = sum + s;
      let sl = luma(s);
      lmin = min(lmin, sl);
      lmax = max(lmax, sl);
    }
  }
  let avg = sum / 16.0;
  var l = luma(avg);
  let localContrast = lmax - lmin;
  l = mix(l, clamp(l * 0.55 + localContrast * 1.35, 0.0, 1.0), u.misc2.x);
  l = l + u.misc.w * ((in.uv.x + in.uv.y) * 0.5 - 0.5);
  l = clamp((l - u.misc.z) / max(1.0 - u.misc.z, 0.001), 0.0, 1.0);
  l = clamp(l * (1.0 + u.gradB.w), 0.0, 1.0);
  return vec4<f32>(avg, l);
}

/* ------------------------------------------------------------- main pass */

fn gradientAt(uv: vec2<f32>, op: i32) -> vec2<f32> {
  let t = u.res.zw;
  let tl = adjL(uv + t * vec2<f32>(-1.0, -1.0));
  let tt = adjL(uv + t * vec2<f32>( 0.0, -1.0));
  let tr = adjL(uv + t * vec2<f32>( 1.0, -1.0));
  let ll = adjL(uv + t * vec2<f32>(-1.0,  0.0));
  let cc = adjL(uv);
  let rr = adjL(uv + t * vec2<f32>( 1.0,  0.0));
  let bl = adjL(uv + t * vec2<f32>(-1.0,  1.0));
  let bb = adjL(uv + t * vec2<f32>( 0.0,  1.0));
  let br = adjL(uv + t * vec2<f32>( 1.0,  1.0));

  if (op == 3) {
    return vec2<f32>((tt + bb + ll + rr) - 4.0 * cc, 0.0);
  }
  var k = 2.0;
  if (op == 1) { k = 1.0; }
  if (op == 2) { k = 10.0; }
  let gx = (tr + k * rr + br) - (tl + k * ll + bl);
  let gy = (bl + k * bb + br) - (tl + k * tt + tr);
  return vec2<f32>(gx, gy);
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let effect = i32(u.misc.x + 0.5);
  let base = adjusted(uv);
  let bg = base * u.adj1.w;
  let px = uv * u.res.xy;
  var col = base;
  var ink = 1.0;

  if (effect == 0) {
    /* ascii */
    let grid = u.grid.xy;
    let cell = floor(uv * grid);
    let local = fract(uv * grid);
    let info = textureSampleLevel(texCells, sampN, (cell + 0.5) / grid, 0.0);
    let rampLen = i32(u.misc2.y);
    let slot = clamp(i32(info.a * f32(rampLen - 1) + 0.5), 0, max(rampLen - 1, 0));
    let glyph = f32(ramp[u32(slot)]);
    let inset = u.misc.y * 0.5;
    let g = (local - inset) / max(1.0 - u.misc.y, 0.001);
    let inside = step(0.0, g.x) * step(g.x, 1.0) * step(0.0, g.y) * step(g.y, 1.0);
    let ag = u.grid.zw;
    let acell = vec2<f32>(glyph % ag.x, floor(glyph / ag.x));
    let auv = (acell + clamp(g, vec2<f32>(0.0), vec2<f32>(1.0))) / ag;
    ink = textureSampleLevel(texAtlas, samp, auv, 0.0).a * inside;
    col = info.rgb;

  } else if (effect == 1) {
    /* waveLines */
    let rows = max(u.p0.x, 1.0);
    let row = floor(uv.y * rows);
    let rowCenter = (row + 0.5) / rows;
    let l = adjL(vec2<f32>(uv.x, rowCenter));
    let disp = sin(uv.x * u.p0.z * 20.0 + u.p1.x + u.gradA.w * 1.5) * u.p0.y * (0.5 - l) / rows;
    let d = abs(uv.y - (rowCenter + disp)) * rows;
    ink = (1.0 - smoothstep(u.p0.w * 0.25, u.p0.w * 0.5, d)) * mix(0.35, 1.0, 1.0 - l);
    col = adjusted(vec2<f32>(uv.x, rowCenter));

  } else if (effect == 2) {
    /* dithering (ordered) */
    let levels = max(u.p0.x, 2.0);
    let scale = max(u.p0.y, 1.0);
    let dp = floor(px / scale);
    let size = u.m.x;
    var thr = 0.0;
    let q2 = (dp % vec2<f32>(size)) / size;
    // Interleaved-gradient ordering: a close ordered-dither stand-in that needs
    // no matrix lookup and holds up at every matrix size.
    thr = fract(52.9829189 * fract(0.06711056 * (dp.x) + 0.00583715 * (dp.y)));
    thr = mix(thr, (q2.x + q2.y * 0.5), 0.35);
    let s = adjusted((floor(px / scale) * scale + scale * 0.5) / u.res.xy);
    col = clamp(floor(s * (levels - 1.0) + thr) / (levels - 1.0), vec3<f32>(0.0), vec3<f32>(1.0));

  } else if (effect == 3) {
    /* halftone */
    let cell = max(u.p0.x, 1.0);
    let ang = u.p0.y;
    let rp = rot2(ang) * px;
    let cid = floor(rp / cell);
    let cc = (cid + 0.5) * cell;
    let uvc = (rot2(-ang) * cc) / u.res.xy;
    let l = adjL(uvc);
    let radius = sqrt(clamp(1.0 - l, 0.0, 1.0)) * 0.72;
    let d = (rp - cc) / cell;
    let shape = i32(u.m.x + 0.5);
    var dist = length(d);
    if (shape == 1) { dist = max(abs(d.x), abs(d.y)); }
    if (shape == 2) { dist = abs(d.x) + abs(d.y); }
    if (shape == 3) { dist = abs(d.y); }
    let edge = mix(0.22, 0.01, u.p0.z);
    ink = 1.0 - smoothstep(radius - edge, radius + edge, dist);
    col = adjusted(uvc);

  } else if (effect == 4) {
    /* dots */
    let cell = max(u.p0.x, 1.0);
    let cid = floor(px / cell);
    let jit = (hash22(cid) - 0.5) * u.p0.w;
    let cc = (cid + 0.5 + jit) * cell;
    let uvc = cc / u.res.xy;
    let l = adjL(uvc);
    let radius = mix(u.p0.y, u.p0.z, 1.0 - l);
    ink = 1.0 - smoothstep(radius - 0.03, radius + 0.03, length(px - cc) / cell);
    col = adjusted(uvc);

  } else if (effect == 5) {
    /* contour */
    let levels = max(u.p0.x, 2.0);
    var l = adjL(uv);
    if (u.p0.z > 0.001) {
      var acc = 0.0;
      for (var i = 0; i < 4; i = i + 1) {
        let o = vec2<f32>(cos(f32(i) * 1.5708), sin(f32(i) * 1.5708)) * u.res.zw * (1.0 + u.p0.z * 3.0);
        acc = acc + adjL(uv + o);
      }
      l = mix(l, acc * 0.25, u.p0.z);
    }
    let scaled = l * levels;
    let band = abs(fract(scaled) - 0.5) * 2.0;
    let w = fwidth(scaled) * u.p0.y * 2.0 + 0.001;
    ink = 1.0 - smoothstep(1.0 - w * 2.0, 1.0, band);
    if (i32(u.m.x + 0.5) == 1) {
      col = vec3<f32>(floor(scaled) / levels);
      ink = 1.0;
    } else {
      col = adjusted(uv);
    }

  } else if (effect == 6) {
    /* edgeDetection */
    let op = i32(u.m.x + 0.5);
    let g = gradientAt(uv, op);
    var mag = length(g);
    if (op == 3) { mag = abs(g.x); }
    mag = clamp(mag * u.p0.x, 0.0, 1.0);
    mag = smoothstep(u.p0.y, min(u.p0.y + 0.35, 1.0), mag);
    if (i32(u.m.y + 0.5) == 1) { mag = 1.0 - mag; }
    ink = mag;
    col = mix(adjusted(uv), vec3<f32>(1.0), 0.65);

  } else if (effect == 7) {
    /* crosshatch */
    let spacing = max(u.p0.x, 1.0);
    let layers = max(u.p0.z, 1.0);
    let l = adjL(uv);
    var acc = 0.0;
    for (var i = 0; i < 6; i = i + 1) {
      if (f32(i) >= layers) { break; }
      let need = 1.0 - (f32(i) + 0.5) / layers;
      if (l <= need) {
        let a = u.p0.y + f32(i) * 0.9;
        let v = (rot2(a) * px).y;
        let line = abs(fract(v / spacing) - 0.5) * spacing;
        acc = max(acc, 1.0 - smoothstep(u.p0.w * 0.5, u.p0.w, line));
      }
    }
    ink = acc;
    col = mix(adjusted(uv), vec3<f32>(0.85, 1.0, 0.85), 0.25);

  } else if (effect == 8) {
    /* blockify */
    let block = max(u.p0.x, 1.0);
    let cid = floor(px / block);
    let cc = (cid + 0.5) * block;
    col = adjusted(cc / u.res.xy);
    let d = abs(px - cc) / (block * 0.5);
    let n = mix(16.0, 2.0, u.p0.z);
    let shape = pow(pow(abs(d.x), n) + pow(abs(d.y), n), 1.0 / n);
    ink = 1.0 - smoothstep(1.0 - u.p0.y - 0.04, 1.0 - u.p0.y, shape);

  } else if (effect == 9) {
    /* threshold */
    let l = adjL(uv);
    var t = smoothstep(u.p0.x - u.p0.y - 0.001, u.p0.x + u.p0.y + 0.001, l);
    if (i32(u.m.x + 0.5) == 1) { t = 1.0 - t; }
    col = vec3<f32>(t);

  } else if (effect == 10) {
    /* noiseField */
    var p = uv * u.p0.x;
    var amp = 0.5;
    var disp = vec2<f32>(0.0);
    let oct = max(u.p0.w, 1.0);
    for (var i = 0; i < 6; i = i + 1) {
      if (f32(i) >= oct) { break; }
      disp = disp + (vec2<f32>(vnoise(p + u.gradA.w * u.p0.y), vnoise(p.yx - u.gradA.w * u.p0.y * 0.8)) - 0.5) * amp;
      p = p * 2.03;
      amp = amp * 0.5;
    }
    col = adjusted(uv + disp * u.p0.z * 0.15 * (1.0 + u.gradB.w));

  } else if (effect == 11) {
    /* matrixRain */
    let cols = max(u.p0.x, 1.0);
    let rows = max(floor(cols * u.res.y / u.res.x), 1.0);
    let cx = floor(uv.x * cols);
    let cy = floor(uv.y * rows);
    let seed = hash11(cx * 17.13);
    let head = fract(seed + u.gradA.w * u.p0.y * (0.35 + seed * 0.65));
    let rowNorm = (cy + 0.5) / rows;
    let dist = fract(head - rowNorm);
    let tail = 1.0 - smoothstep(0.0, max(u.p0.z, 0.02), dist);
    let ag = u.grid.zw;
    let glyph = floor(hash12(vec2<f32>(cx, cy + floor(u.gradA.w * 8.0))) * u.misc2.z);
    let acell = vec2<f32>(glyph % ag.x, floor(glyph / ag.x));
    let local = vec2<f32>(fract(uv.x * cols), fract(uv.y * rows));
    let a = textureSampleLevel(texAtlas, samp, (acell + local) / ag, 0.0).a;
    let mask = 1.0 - adjL(uv);
    ink = a * tail * mix(0.25, 1.0, 1.0 - mask);
    col = mix(adjusted(uv), vec3<f32>(0.6, 1.0, 0.6), 0.5) + smoothstep(0.06, 0.0, dist) * u.p0.w;

  } else if (effect == 12) {
    /* vhs */
    let shift = u.p0.x * 0.01;
    let line = floor(uv.y * u.res.y);
    var wob = (hash11(line + floor(u.gradA.w * 24.0)) - 0.5) * u.p0.w * 0.02;
    let bandSeed = floor(uv.y * 12.0 - u.gradA.w * 1.3);
    let band = step(1.0 - u.p1.x * 0.35, hash11(bandSeed));
    wob = wob + band * (hash11(bandSeed * 3.1) - 0.5) * 0.08 * u.p1.x;
    let uv2 = vec2<f32>(uv.x + wob, uv.y);
    col = vec3<f32>(adjusted(uv2 + vec2<f32>(shift, 0.0)).r, adjusted(uv2).g, adjusted(uv2 - vec2<f32>(shift, 0.0)).b);
    col = col * (1.0 - u.p0.y * 0.5 * (0.5 + 0.5 * sin(uv.y * u.res.y * 3.14159)));
    col = clamp(col + (hash12(px + u.gradA.w * 60.0) - 0.5) * u.p0.z * 0.6, vec3<f32>(0.0), vec3<f32>(1.0));

  } else if (effect == 13) {
    /* voronoi */
    let cells = max(u.p0.x, 4.0);
    let aspect = u.res.x / u.res.y;
    let gridX = max(floor(sqrt(cells * aspect)), 1.0);
    let gridY = max(floor(cells / gridX), 1.0);
    let g = vec2<f32>(gridX, gridY);
    let p = uv * g;
    let cid = floor(p);
    var best = 1e9;
    var second = 1e9;
    var bestCell = cid;
    for (var y = -1; y <= 1; y = y + 1) {
      for (var x = -1; x <= 1; x = x + 1) {
        let nb = cid + vec2<f32>(f32(x), f32(y));
        let site = nb + 0.5 + (hash22(nb) - 0.5) * u.p0.y;
        let d = length(p - site);
        if (d < best) { second = best; best = d; bestCell = nb; }
        else if (d < second) { second = d; }
      }
    }
    let siteUv = (bestCell + 0.5 + (hash22(bestCell) - 0.5) * u.p0.y) / g;
    if (i32(u.m.x + 0.5) == 1) {
      var acc = vec3<f32>(0.0);
      for (var i = 0; i < 4; i = i + 1) {
        let o = vec2<f32>(cos(f32(i) * 1.5708), sin(f32(i) * 1.5708)) / g * 0.25;
        acc = acc + adjusted(siteUv + o);
      }
      col = acc * 0.25;
    } else {
      col = adjusted(siteUv);
    }
    ink = smoothstep(0.0, max(u.p0.z, 0.001), second - best);
  }

  return vec4<f32>(mix(bg, col, clamp(ink, 0.0, 1.0)), 1.0);
}

/* -------------------------------------------------------------- post pass */

@fragment
fn fsPost(in: VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  var col: vec3<f32>;

  if (u.post1.x > 0.001) {
    let dir = (uv - 0.5) * u.post1.x * 0.02;
    col = vec3<f32>(
      textureSampleLevel(texFx, samp, clamp(uv + dir, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r,
      textureSampleLevel(texFx, samp, uv, 0.0).g,
      textureSampleLevel(texFx, samp, clamp(uv - dir, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).b);
  } else {
    col = textureSampleLevel(texFx, samp, uv, 0.0).rgb;
  }

  if (u.post0.x > 0.001) {
    // 8-tap radial bright-pass in place of a separate blur chain.
    var acc = vec3<f32>(0.0);
    let r = u.res.zw * 6.0;
    for (var i = 0; i < 8; i = i + 1) {
      let a = f32(i) * 0.7854;
      let s = textureSampleLevel(texFx, samp, clamp(uv + vec2<f32>(cos(a), sin(a)) * r, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
      acc = acc + s * smoothstep(u.post0.y, min(u.post0.y + 0.25, 1.0), luma(s));
    }
    col = col + acc * 0.125 * u.post0.x;
  }

  if (u.post0.z > 0.001) {
    col = col * (1.0 - u.post0.z * 0.45 * (0.5 + 0.5 * sin(uv.y * u.res.y * 3.14159)));
  }

  if (u.post0.w > 0.001) {
    let d = distance(uv, vec2<f32>(0.5)) * 1.414;
    col = col * (1.0 - u.post0.w * smoothstep(0.35, 1.0, d));
  }

  if (u.post1.y > 0.001) {
    col = col + (hash12(uv * u.res.xy + u.gradA.w * 97.0) - 0.5) * u.post1.y * 0.25;
  }

  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;
