// Raster helpers for the data build: polygon/line rasterisation in the Equal Earth
// grid (with antimeridian handling), Euclidean distance transform, blur.
import { CM, projectRel } from './projection.mjs';

// ---------------------------------------------------------------------------
// Ring preparation: GeoJSON ring (lon/lat) -> list of projected rings, split at
// the map's cut meridian (CM ± 180°).

function unwrapRing(ring) {
  const out = [];
  let prev = null;
  for (const p of ring) {
    let l = p[0] - CM;
    if (prev !== null) {
      while (l - prev > 180) l -= 360;
      while (l - prev < -180) l += 360;
    }
    out.push([l, p[1]]);
    prev = l;
  }
  // polar ring (winds around a pole): close it along the pole
  const first = out[0], last = out[out.length - 1];
  const wind = last[0] - first[0];
  if (Math.abs(wind) > 180) {
    let meanLat = 0;
    for (const p of out) meanLat += p[1];
    const pole = meanLat < 0 ? -90 : 90;
    out.push([last[0], pole], [first[0], pole]);
  }
  return out;
}

function clipHalf(ring, keep, intersect) {
  const out = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ka = keep(a), kb = keep(b);
    if (ka) out.push(a);
    if (ka !== kb) out.push(intersect(a, b));
  }
  return out;
}

function clipLon(ring, lo, hi) {
  const ix = (x) => (a, b) => {
    const t = (x - a[0]) / (b[0] - a[0]);
    return [x, a[1] + t * (b[1] - a[1])];
  };
  let r = clipHalf(ring, (p) => p[0] >= lo, ix(lo));
  if (r.length < 3) return r;
  r = clipHalf(r, (p) => p[0] <= hi, ix(hi));
  return r;
}

function densify(ring, step = 0.5) {
  const out = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    out.push(a);
    const d = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    if (d > step) {
      const k = Math.ceil(d / step);
      for (let j = 1; j < k; j++) {
        const t = j / k;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return out;
}

// polygon: array of rings (lon/lat). Returns array of "copies", each an array of
// projected rings [[x,y]...] in km.
export function projectPolygon(polygon) {
  const rings = polygon.map(unwrapRing);
  let min = Infinity, max = -Infinity;
  for (const r of rings) for (const p of r) { if (p[0] < min) min = p[0]; if (p[0] > max) max = p[0]; }
  const copies = [];
  for (const shift of [-360, 0, 360]) {
    if (max + shift < -180 || min + shift > 180) continue;
    const out = [];
    for (const r of rings) {
      const shifted = r.map((p) => [p[0] + shift, p[1]]);
      const c = clipLon(shifted, -180, 180);
      if (c.length < 3) continue;
      out.push(densify(c).map((p) => projectRel(p[0], Math.max(-90, Math.min(90, p[1])))));
    }
    if (out.length) copies.push(out);
  }
  return copies;
}

export function geojsonPolygons(fc, filter = () => true) {
  const polys = [];
  for (const f of fc.features) {
    if (!f.geometry || !filter(f)) continue;
    const g = f.geometry;
    if (g.type === 'Polygon') polys.push({ rings: g.coordinates, props: f.properties });
    else if (g.type === 'MultiPolygon') for (const c of g.coordinates) polys.push({ rings: c, props: f.properties });
  }
  return polys;
}

// ---------------------------------------------------------------------------
// Grid description: { x0, y0 (top), kmPerPx, W, H }. Pixel (i,j) centre =
// (x0 + (i+0.5)*k, y0 - (j+0.5)*k).

export function toPx(grid, p) {
  return [(p[0] - grid.x0) / grid.k, (grid.y0 - p[1]) / grid.k];
}

// Even-odd fill of a set of projected rings into mask (Uint8Array), OR-ing value.
export function fillRings(mask, grid, rings, value = 1) {
  const edges = [];
  let rmin = Infinity, rmax = -Infinity;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = toPx(grid, ring[i]), b = toPx(grid, ring[(i + 1) % n]);
      if (a[1] === b[1]) continue;
      const top = a[1] < b[1] ? a : b, bot = a[1] < b[1] ? b : a;
      const y0 = Math.ceil(top[1] - 0.5), y1 = Math.ceil(bot[1] - 0.5) - 1;
      if (y1 < y0) continue;
      const slope = (bot[0] - top[0]) / (bot[1] - top[1]);
      edges.push({ y0, y1, x: top[0] + (y0 + 0.5 - top[1]) * slope, slope });
      if (y0 < rmin) rmin = y0;
      if (y1 > rmax) rmax = y1;
    }
  }
  if (!edges.length) return;
  edges.sort((a, b) => a.y0 - b.y0);
  const W = grid.W, H = grid.H;
  let active = [];
  let ei = 0;
  const ys = Math.max(0, rmin), ye = Math.min(H - 1, rmax);
  // advance edges that start above the grid
  for (let y = rmin; y <= ye; y++) {
    while (ei < edges.length && edges[ei].y0 <= y) {
      const e = edges[ei++];
      active.push({ y1: e.y1, x: e.x + (y - e.y0) * e.slope, slope: e.slope });
    }
    active = active.filter((e) => e.y1 >= y);
    if (y >= ys) {
      const xs = active.map((e) => e.x).sort((a, b) => a - b);
      const row = y * W;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        const xb = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
        for (let x = xa; x <= xb; x++) mask[row + x] = value;
      }
    }
    for (const e of active) e.x += e.slope;
  }
}

// Draw a polyline (projected km) into mask with 1px-ish width (DDA).
export function drawLine(mask, grid, pts, value = 1) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = toPx(grid, pts[i]), b = toPx(grid, pts[i + 1]);
    const d = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    if (d > grid.W / 2) continue; // wrapped segment
    const n = Math.max(1, Math.ceil(d * 2));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      const x = Math.floor(a[0] + (b[0] - a[0]) * t), y = Math.floor(a[1] + (b[1] - a[1]) * t);
      if (x >= 0 && y >= 0 && x < grid.W && y < grid.H) mask[y * grid.W + x] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Felzenszwalb & Huttenlocher squared Euclidean distance transform.
const INF = 1e20;
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const r = v[k];
      s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r);
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    d[q] = (q - r) * (q - r) + f[r];
  }
}

// grid: Float64Array/Float32Array with 0 at features and INF elsewhere (in-place).
export function edt2d(grid, W, H) {
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = grid[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) grid[y * W + x] = d[x];
  }
  return grid;
}

// distance (px) from every pixel to the nearest pixel where mask != 0
export function distanceTo(mask, W, H) {
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = mask[i] ? 0 : INF;
  edt2d(g, W, H);
  for (let i = 0; i < g.length; i++) g[i] = Math.sqrt(g[i]);
  return g;
}

// signed distance in px: positive inside mask
export function signedDistance(mask, W, H) {
  const inside = new Float32Array(W * H), outside = new Float32Array(W * H);
  for (let i = 0; i < mask.length; i++) {
    inside[i] = mask[i] ? INF : 0; // distance for inside pixels to nearest outside
    outside[i] = mask[i] ? 0 : INF;
  }
  edt2d(inside, W, H);
  edt2d(outside, W, H);
  const s = new Float32Array(W * H);
  for (let i = 0; i < s.length; i++) {
    s[i] = mask[i] ? Math.sqrt(inside[i]) - 0.5 : -(Math.sqrt(outside[i]) - 0.5);
  }
  return s;
}

// 2x2 box downsample
export function downsample2(src, W, H) {
  const w = W >> 1, h = H >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = 2 * y * W + 2 * x;
      out[y * w + x] = (src[i] + src[i + 1] + src[i + W] + src[i + W + 1]) * 0.25;
    }
  return out;
}

// separable box blur repeated 3x (≈ gaussian), radius in px
export function blur(src, W, H, r) {
  let a = Float32Array.from(src), b = new Float32Array(W * H);
  const pass = (from, to, horiz) => {
    const len = horiz ? W : H, lines = horiz ? H : W;
    const stride = horiz ? 1 : W, lstride = horiz ? W : 1;
    for (let l = 0; l < lines; l++) {
      const base = l * lstride;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += from[base + Math.min(len - 1, Math.max(0, k)) * stride];
      for (let i = 0; i < len; i++) {
        to[base + i * stride] = acc / (2 * r + 1);
        const add = Math.min(len - 1, i + r + 1), rem = Math.max(0, i - r);
        acc += from[base + add * stride] - from[base + rem * stride];
      }
    }
  };
  for (let it = 0; it < 3; it++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}
