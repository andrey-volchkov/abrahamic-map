// Builds map textures and vector layers into public/data.
//   node scripts/build-data.mjs [L0|L1|L2|rivers ...]
// Sources (downloaded into scripts/.cache, not committed):
//   • AWS Terrain Tiles, Terrarium encoding (SRTM, GMTED, ETOPO1 …)
//   • Natural Earth 10m land, minor islands, lakes, rivers, geography regions (public domain)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import { CM, X_MAX, Y_MAX, invertRel, project, projectRel } from './lib/projection.mjs';
import { TileSampler } from './lib/tiles.mjs';
import {
  blur, distanceTo, downsample2, drawLine, fillRings, geojsonPolygons, projectPolygon, signedDistance,
} from './lib/raster.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, 'scripts/.cache');
const NE = path.join(CACHE, 'ne');
const OUT = path.join(ROOT, 'public/data');
fs.mkdirSync(OUT, { recursive: true });

const NE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
function ne(name) {
  const f = path.join(NE, name + '.geojson');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(NE, { recursive: true });
    console.log('  fetching', name);
    execSync(`curl -sS --retry 4 -o "${f}" "${NE_URL}${name}.geojson"`, { stdio: 'inherit' });
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ---------------------------------------------------------------------------
// Level definitions
const LEVELS = [
  { id: 'L0', world: true, W: 4096, zoom: 5, ss: 2, q: 8, qSea: 80 },
  { id: 'L1', bbox: [-26, 22, 66, 72], k: 3.0, zoom: 6, ss: 2, q: 4, qSea: 40 },
  { id: 'L2', bbox: [24, 19, 52, 42], k: 1.2, zoom: 7, ss: 1, q: 2, qSea: 20 },
];

function levelGrid(L) {
  if (L.world) {
    const margin = 40;
    const x0 = -X_MAX - margin;
    const k = (2 * (X_MAX + margin)) / L.W;
    const H = Math.ceil((2 * (Y_MAX + margin)) / k);
    return { x0, y0: (H * k) / 2, k, W: L.W, H };
  }
  const [lo0, la0, lo1, la1] = L.bbox;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    for (const [lon, lat] of [
      [lo0 + (lo1 - lo0) * t, la0], [lo0 + (lo1 - lo0) * t, la1], [lo0, la0 + (la1 - la0) * t], [lo1, la0 + (la1 - la0) * t],
    ]) {
      const [x, y] = project(lon, lat);
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }
  }
  const k = L.k;
  const x0 = Math.floor(xmin / k) * k, y0 = Math.ceil(ymax / k) * k;
  const W = Math.ceil((xmax - x0) / k), H = Math.ceil((y0 - ymin) / k);
  // even sizes help the 2x supersampled rasters
  return { x0, y0, k, W: W + (W & 1), H: H + (H & 1) };
}

function lonOf(lrel) {
  let lon = lrel + CM;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return lon;
}

// ---------------------------------------------------------------------------
// Natural Earth derived masks
let landPolys, lakePolys, desertPolys, riverLines;
function loadVectors() {
  if (landPolys) return;
  console.log('loading Natural Earth…');
  landPolys = [
    ...geojsonPolygons(ne('ne_10m_land')),
    ...geojsonPolygons(ne('ne_10m_minor_islands')),
  ].flatMap((p) => projectPolygon(p.rings));
  lakePolys = geojsonPolygons(ne('ne_10m_lakes'), (f) => (f.properties.scalerank ?? 10) <= 8).flatMap((p) =>
    projectPolygon(p.rings),
  );
  const EXCLUDE = new Set(['PUNJAB', 'Big Bend']);
  desertPolys = geojsonPolygons(
    ne('ne_10m_geography_regions_polys'),
    (f) => (f.properties.FEATURECLA || f.properties.featurecla) === 'Desert' && !EXCLUDE.has(f.properties.NAME || f.properties.name),
  ).flatMap((p) => projectPolygon(p.rings));
  const rv = ne('ne_10m_rivers_lake_centerlines');
  riverLines = [];
  for (const f of rv.features) {
    if (!f.geometry) continue;
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const l of lines) riverLines.push({ rank: f.properties.scalerank ?? 10, name: f.properties.name, pts: l });
  }
}

// Stylistic climate hints (semi-arid regions that the Natural Earth desert layer
// omits). Not historical data — only affects terrain colouring.
const ARID_HINTS = [
  { lon: 44, lat: 24, rx: 700, ry: 520, w: 0.85 }, // Najd, central Arabia
  { lon: 33.8, lat: 29.4, rx: 170, ry: 200, w: 0.9 }, // Sinai
  { lon: 35.35, lat: 31.4, rx: 30, ry: 55, w: 0.55 }, // Judaean desert
  { lon: 56, lat: 32, rx: 700, ry: 420, w: 0.65 }, // Iranian plateau
  { lon: 44.5, lat: 32, rx: 280, ry: 240, w: 0.5 }, // southern Mesopotamia
  { lon: 57, lat: 21, rx: 320, ry: 320, w: 0.55 }, // Oman interior
  { lon: 29.5, lat: 26, rx: 520, ry: 720, w: 0.8 }, // Egyptian deserts core
];

let aridWorld; // { grid, data }
function buildAridity(L0grid) {
  if (aridWorld) return aridWorld;
  console.log('aridity field…');
  const g = { x0: L0grid.x0, y0: L0grid.y0, k: L0grid.k * 4, W: L0grid.W / 4, H: Math.ceil(L0grid.H / 4) };
  const mask = new Uint8Array(g.W * g.H);
  for (const copy of desertPolys) fillRings(mask, g, copy, 1);
  const f = new Float32Array(g.W * g.H);
  for (let i = 0; i < f.length; i++) f[i] = mask[i];
  for (let j = 0; j < g.H; j++)
    for (let i = 0; i < g.W; i++) {
      const x = g.x0 + (i + 0.5) * g.k, y = g.y0 - (j + 0.5) * g.k;
      for (const h of ARID_HINTS) {
        const [cx, cy] = project(h.lon, h.lat);
        const d = ((x - cx) / h.rx) ** 2 + ((y - cy) / h.ry) ** 2;
        if (d < 1) f[j * g.W + i] = Math.max(f[j * g.W + i], h.w * (1 - d) * (1 - d));
      }
    }
  // two scales: the desert cores, and a wide climatic gradient around them
  const b = blur(f, g.W, g.H, 4);
  const b2 = blur(f, g.W, g.H, 13);
  for (let i = 0; i < b.length; i++) b[i] = Math.min(1, 0.55 * Math.min(1, b[i] * 1.4) + 0.6 * Math.min(1, b2[i] * 1.7));
  aridWorld = { grid: g, data: b };
  return aridWorld;
}
function sampleArid(x, y) {
  const { grid: g, data } = aridWorld;
  const fx = (x - g.x0) / g.k - 0.5, fy = (g.y0 - y) / g.k - 0.5;
  const x0 = Math.max(0, Math.min(g.W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(g.H - 2, Math.floor(fy)));
  const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
  const i = y0 * g.W + x0;
  return (data[i] * (1 - tx) + data[i + 1] * tx) * (1 - ty) + (data[i + g.W] * (1 - tx) + data[i + g.W + 1] * tx) * ty;
}

function projectLine(pts) {
  // split where the projected line jumps across the cut
  const out = [[]];
  let prev = null;
  for (const [lon, lat] of pts) {
    const p = project(lon, lat);
    if (prev && Math.abs(p[0] - prev[0]) > X_MAX) out.push([]);
    out[out.length - 1].push(p);
    prev = p;
  }
  return out.filter((l) => l.length > 1);
}

function encodeSdf(v) {
  return Math.max(0, Math.min(255, Math.round(128 + v * 16)));
}

function writePng(file, W, H, rgb) {
  const png = new PNG({ width: W, height: H, colorType: 2, inputColorType: 2, inputHasAlpha: false });
  png.data = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength);
  const buf = PNG.sync.write(png, { colorType: 2, inputColorType: 2, inputHasAlpha: false, deflateLevel: 9 });
  fs.writeFileSync(file, buf);
  return buf.length;
}

// ---------------------------------------------------------------------------
function buildLevel(L, meta) {
  const grid = levelGrid(L);
  const { W, H, k, x0, y0 } = grid;
  console.log(`\n${L.id}: ${W}x${H} @ ${k.toFixed(3)} km/px, x0=${x0.toFixed(1)} y0=${y0.toFixed(1)}`);
  loadVectors();
  if (!aridWorld) buildAridity(levelGrid(LEVELS[0]));

  // --- heights
  const sampler = new TileSampler(path.join(CACHE, 'tiles'), L.zoom);
  const ss = L.ss;
  const keys = new Set();
  const step = L.world ? 3 : 2;
  for (let j = 0; j < H; j += step)
    for (let i = 0; i < W; i += step) {
      const ll = invertRel(x0 + (i + 0.5) * k, y0 - (j + 0.5) * k);
      if (!ll) continue;
      for (const key of sampler.tileKey(lonOf(ll[0]), ll[1])) keys.add(key);
    }
  sampler.fetchAll(keys);
  console.log('  sampling heights…');
  const hts = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let acc = 0, n = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = x0 + (i + (sx + 0.5) / ss) * k, y = y0 - (j + (sy + 0.5) / ss) * k;
          const ll = invertRel(x, y);
          if (!ll) continue;
          acc += sampler.sample(lonOf(ll[0]), ll[1]);
          n++;
        }
      hts[j * W + i] = n ? acc / n : -3000;
    }
    if (j % 200 === 0) process.stdout.write(`\r  row ${j}/${H}`);
  }
  process.stdout.write('\n');
  sampler.cache.clear();

  // --- ocean/land signed distance (2x supersampled)
  console.log('  coast SDF…');
  const g2 = { x0, y0, k: k / 2, W: W * 2, H: H * 2 };
  let m2 = new Uint8Array(g2.W * g2.H);
  for (const copy of landPolys) fillRings(m2, g2, copy, 1);
  let s2 = signedDistance(m2, g2.W, g2.H);
  const coast = downsample2(s2, g2.W, g2.H).map((v) => v / 2);
  // --- lakes
  console.log('  lake SDF…');
  m2.fill(0);
  for (const copy of lakePolys) fillRings(m2, g2, copy, 1);
  s2 = signedDistance(m2, g2.W, g2.H);
  const lakes = downsample2(s2, g2.W, g2.H).map((v) => v / 2);
  m2 = null; s2 = null;

  // --- river greening
  console.log('  river greening…');
  const rmask = new Uint8Array(W * H);
  const rmask2 = new Uint8Array(W * H);
  for (const r of riverLines) {
    if (r.rank > 7) continue;
    for (const line of projectLine(r.pts)) drawLine(r.rank <= 4 ? rmask : rmask2, grid, line, 1);
  }
  const d1 = distanceTo(rmask, W, H), d2 = distanceTo(rmask2, W, H);

  // --- pack
  const n = W * H;
  const hv = new Int32Array(n);
  const rgb = new Uint8Array(n * 3), lake = new Uint8Array(n);
  const q = L.q;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const idx = j * W + i;
      const x = x0 + (i + 0.5) * k, y = y0 - (j + 0.5) * k;
      let h = hts[idx];
      const c = coast[idx];
      if (c > 0) {
        if (c < 3 && h < 1) h = 1; // keep coastal plains above the water plane
        h = Math.round(h / q) * q;
      } else {
        if (h > -2) h = -2 - Math.max(0, -c) * 2;
        h = Math.round(h / L.qSea) * L.qSea;
      }
      hv[idx] = Math.round(h / q);
      const km1 = d1[idx] * k, km2 = d2[idx] * k;
      const green = Math.max(Math.exp(-((km1 / 7) ** 2)), 0.6 * Math.exp(-((km2 / 4.5) ** 2)));
      rgb[idx * 3] = encodeSdf(c);
      rgb[idx * 3 + 1] = Math.round(sampleArid(x, y) * 63) * 4;
      rgb[idx * 3 + 2] = Math.round(green * 31) * 8;
      lake[idx] = encodeSdf(lakes[idx]);
    }
  const sh = writeHeights(path.join(OUT, `${L.id}_h.bin`), W, H, q, hv);
  const sm = writePng(path.join(OUT, `${L.id}_m.png`), W, H, rgb);
  const sl = writePngGray(path.join(OUT, `${L.id}_l.png`), W, H, lake);
  console.log(`  wrote ${L.id}: heights ${(sh / 1e6).toFixed(2)} MB, masks ${(sm / 1e6).toFixed(2)} MB, lakes ${(sl / 1e6).toFixed(2)} MB`);
  meta.levels[L.id] = { x0, y0, k, W, H, q };
}

// Heights: MED (LOCO-I) prediction, zigzag varint residuals, raw deflate.
// Header: 'HGT1', uint32 W, uint32 H, float32 quantum (metres per unit).
function writeHeights(file, W, H, q, v) {
  const out = Buffer.alloc(W * H * 3);
  let o = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = x ? v[i - 1] : y ? v[i - W] : 0;
      const b = y ? v[i - W] : a;
      const c = x && y ? v[i - W - 1] : a;
      let p;
      if (c >= Math.max(a, b)) p = Math.min(a, b);
      else if (c <= Math.min(a, b)) p = Math.max(a, b);
      else p = a + b - c;
      let e = v[i] - p;
      e = e >= 0 ? 2 * e : -2 * e - 1;
      while (e >= 128) { out[o++] = (e & 127) | 128; e >>>= 7; }
      out[o++] = e;
    }
  const body = zlib.deflateRawSync(out.subarray(0, o), { level: 9 });
  const head = Buffer.alloc(16);
  head.write('HGT1', 0, 'ascii');
  head.writeUInt32LE(W, 4);
  head.writeUInt32LE(H, 8);
  head.writeFloatLE(q, 12);
  const buf = Buffer.concat([head, body]);
  fs.writeFileSync(file, buf);
  return buf.length;
}

function writePngGray(file, W, H, data) {
  const png = new PNG({ width: W, height: H, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const buf = PNG.sync.write(png, { colorType: 0, inputColorType: 0, inputHasAlpha: false, deflateLevel: 9 });
  fs.writeFileSync(file, buf);
  return buf.length;
}

function buildRivers() {
  loadVectors();
  console.log('\nrivers…');
  const L1 = LEVELS[1].bbox;
  const out = [];
  for (const r of riverLines) {
    const inL1 = r.pts.some(([lon, lat]) => lon >= L1[0] && lon <= L1[2] && lat >= L1[1] && lat <= L1[3]);
    if (!(r.rank <= 4 || (inL1 && r.rank <= 7))) continue;
    const L2 = LEVELS[2].bbox;
    const inL2 = r.pts.some(([lon, lat]) => lon >= L2[0] && lon <= L2[2] && lat >= L2[1] && lat <= L2[3]);
    const tol = inL2 ? 0.8 : inL1 ? 2.5 : 6;
    for (const line of projectLine(r.pts)) {
      // distance-based thinning
      const pts = [line[0]];
      for (let i = 1; i < line.length; i++) {
        const p = pts[pts.length - 1];
        if (Math.hypot(line[i][0] - p[0], line[i][1] - p[1]) > tol || i === line.length - 1) pts.push(line[i]);
      }
      out.push({ n: r.name || '', r: r.rank, p: pts.flatMap((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) });
    }
  }
  fs.writeFileSync(path.join(OUT, 'rivers.json'), JSON.stringify(out));
  console.log(`  ${out.length} river lines, ${(fs.statSync(path.join(OUT, 'rivers.json')).size / 1e6).toFixed(2)} MB`);
}

// ---------------------------------------------------------------------------
const which = process.argv.slice(2);
const metaFile = path.join(OUT, 'meta.json');
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { levels: {} };
meta.projection = { name: 'Equal Earth', centralMeridian: CM, radiusKm: 6371, xMax: X_MAX, yMax: Y_MAX };
meta.encoding = { height: 'Lk_h.bin: HGT1 header + raw-deflated zigzag-varint MED residuals; metres = value * q', masks: 'Lk_m.png RGB = coast SDF, aridity, river greening; Lk_l.png = lake SDF; SDF px = (v-128)/16, positive = land/lake' };
for (const L of LEVELS) if (!which.length || which.includes(L.id)) buildLevel(L, meta);
if (!which.length || which.includes('rivers')) buildRivers();
fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
console.log('\ndone');
void projectRel;
