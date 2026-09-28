// CDLOD terrain: a quadtree of identical grid patches rendered in one instanced draw,
// vertices morph between LODs by camera distance (Strugar, 2010). Land and sea share
// one surface and one shader: the sea is the flat part at y = 0.
import * as THREE from 'three';
import { PROJ_GLSL, TERRAIN_GLSL, type TerrainUniforms } from './glsl';
import { X_MAX, Y_MAX } from '../geo/projection';
import type { HeightField } from './assets';
import { ZONE_GLSL, type ZoneUniforms } from './influence';

const GRID_N = 32;
const LODS = 11;
const ROOT = 17300; // km, two roots cover the map
const MAX_INST = 2400;

const VERT = /* glsl */ `
${PROJ_GLSL}
${TERRAIN_GLSL}
in vec2 grid;
in vec4 inst;
uniform vec2 uMorph[${LODS}];
uniform float uGridN;
out vec2 vMap;
out vec3 vWorld;
out float vViewZ;

void main() {
  vec2 p = inst.xy + grid * inst.z;
  float spacing = inst.z / uGridN;
  float y0 = surfaceY(p, spacing);
  float d = distance(vec3(p.x, y0, -p.y), cameraPosition);
  vec2 mr = uMorph[int(inst.w)];
  float mk = clamp((d - mr.x) / (mr.y - mr.x), 0.0, 1.0);
  vec2 fr = fract(grid * uGridN * 0.5) * 2.0 / uGridN;
  p -= fr * inst.z * mk;
  float y = surfaceY(p, spacing * (1.0 + mk));
  vMap = p;
  vec4 world = vec4(p.x, y, -p.y, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
${PROJ_GLSL}
${TERRAIN_GLSL}
${ZONE_GLSL}
in vec2 vMap;
in vec3 vWorld;
in float vViewZ;
out vec4 fragColor;

uniform vec3 uSunDir;
uniform float uShadeExag;
uniform float uTime;
uniform float uCamDist;
uniform vec4 uHearth[4];      // x, y, radius km, intensity
uniform vec4 uFocus;          // x, y, radius km, strength
uniform float uGrat;          // graticule step in degrees (0 = off)
uniform int uDebug;

vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
vec3 hex(float r, float g, float b) { return srgb(vec3(r, g, b) / 255.0); }

struct S { float h; vec2 g; float coast; float arid; float green; float lake; float hb; float k; vec2 gb; };

void samp(sampler2D H, sampler2D M, sampler2D L, vec4 R, vec3 T, vec2 p, float fp, float w, inout S s) {
  vec2 uv = lvlUV(R, p);
  float k = T.z;
  float st = max(k, fp);
  float lod = log2(max(fp / k, 1.0));
  vec2 du = vec2(st / R.z, 0.0), dv = vec2(0.0, st / R.w);
  float hc = textureLod(H, uv, lod).r;
  float hx1 = textureLod(H, uv + du, lod).r;
  float hx0 = textureLod(H, uv - du, lod).r;
  float hn = textureLod(H, uv - dv, lod).r;
  float hs = textureLod(H, uv + dv, lod).r;
  vec3 m = textureLod(M, uv, lod).rgb;
  float lks = textureLod(L, uv, lod).r;
  float hb = textureLod(H, uv, lod + 3.5).r;
  s.h += w * hc;
  s.g += w * vec2(hx1 - hx0, hn - hs) / (2.0 * st);
  s.coast += w * sdfKm(m.r, k);
  s.arid += w * m.g;
  s.green += w * m.b;
  s.lake += w * sdfKm(lks, k);
  s.hb += w * hb;
  s.k += w * k;
}

// smoothed bathymetry gradient (only evaluated for water pixels)
vec2 bathyGrad(sampler2D H, vec4 R, vec3 T, vec2 p, float fp) {
  vec2 uv = lvlUV(R, p);
  float st = max(T.z, fp);
  float lb = log2(max(fp / T.z, 1.0)) + 1.5;
  vec2 du = vec2(st / R.z, 0.0), dv = vec2(0.0, st / R.w);
  return vec2(textureLod(H, uv + du * 2.0, lb).r - textureLod(H, uv - du * 2.0, lb).r,
              textureLod(H, uv - dv * 2.0, lb).r - textureLod(H, uv + dv * 2.0, lb).r) / (4.0 * st);
}

float noiseAt(vec2 p, float scaleKm, int ch) {
  vec4 n = texture(uNoise, p / scaleKm);
  return ch == 0 ? n.r : ch == 1 ? n.g : ch == 2 ? n.b : n.a;
}

// hypsometric tints in the Swiss manner: green lowlands, yellow and ochre uplands,
// pale high mountains; dry lands start from sand instead of green
vec3 hypsometric(float h, float arid, float alat) {
  vec3 w0 = mix(hex(150.0, 190.0, 132.0), hex(170.0, 196.0, 148.0), smoothstep(15.0, 32.0, alat));
  w0 = mix(w0, hex(176.0, 192.0, 160.0), smoothstep(50.0, 60.0, alat));
  w0 = mix(w0, hex(206.0, 210.0, 196.0), smoothstep(62.0, 70.0, alat));
  vec3 wet = w0;
  wet = mix(wet, hex(198.0, 213.0, 160.0), smoothstep(0.0, 250.0, h));
  wet = mix(wet, hex(226.0, 222.0, 170.0), smoothstep(250.0, 650.0, h));
  wet = mix(wet, hex(233.0, 213.0, 160.0), smoothstep(650.0, 1200.0, h));
  vec3 dry = hex(240.0, 228.0, 192.0);
  dry = mix(dry, hex(238.0, 219.0, 174.0), smoothstep(0.0, 500.0, h));
  dry = mix(dry, hex(230.0, 204.0, 152.0), smoothstep(500.0, 1200.0, h));
  vec3 c = mix(wet, dry, smoothstep(0.15, 0.7, arid));
  c = mix(c, hex(220.0, 189.0, 139.0), smoothstep(1200.0, 1900.0, h));
  c = mix(c, hex(204.0, 170.0, 130.0), smoothstep(1900.0, 2700.0, h));
  c = mix(c, hex(218.0, 204.0, 186.0), smoothstep(2700.0, 3600.0, h));
  c = mix(c, hex(242.0, 239.0, 232.0), smoothstep(3600.0, 4800.0, h));
  return c;
}

void main() {
  vec2 ol = eeOutline(vMap);
  if (ol.x < 0.0) discard;
  float lat = ol.y;

  vec2 dpx = dFdx(vMap), dpy = dFdy(vMap);
  float fp = max(length(dpx), length(dpy)); // km per pixel

  vec4 w = levelWeightsFp(vMap, fp);
  S s = S(0.0, vec2(0.0), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, vec2(0.0));
  if (w.x > 0.0) samp(uH0, uM0, uL0, uR0, uT0, vMap, fp, w.x, s);
  if (w.y > 0.0) samp(uH1, uM1, uL1, uR1, uT1, vMap, fp, w.y, s);
  if (w.z > 0.0) samp(uH2, uM2, uL2, uR2, uT2, vMap, fp, w.z, s);
  if (w.w > 0.0) samp(uH3, uM3, uL3, uR3, uT3, vMap, fp, w.w, s);
  if (s.coast < 3.0 * fp) {
    if (w.x > 0.0) s.gb += w.x * bathyGrad(uH0, uR0, uT0, vMap, fp);
    if (w.y > 0.0) s.gb += w.y * bathyGrad(uH1, uR1, uT1, vMap, fp);
    if (w.z > 0.0) s.gb += w.z * bathyGrad(uH2, uR2, uT2, vMap, fp);
    // the finest level's bathymetry comes from other tiles and does not match its
    // neighbours: the sea takes L2's depths there
    if (w.w > 0.0) s.gb += w.w * bathyGrad(uH2, uR2, uT2, vMap, fp);
  }
  float hSea = s.h;
  if (w.w > 0.0 && s.coast < 3.0 * fp) {
    float h2 = textureLod(uH2, lvlUV(uR2, vMap), log2(max(fp / uT2.z, 1.0))).r;
    float h3 = textureLod(uH3, lvlUV(uR3, vMap), log2(max(fp / uT3.z, 1.0))).r;
    hSea = s.h + w.w * (h2 - h3);
  }
  // SDFs are clamped to ±8 texels; beyond ~3 texels per pixel they lose meaning
  float fpc = min(fp, 3.0 * s.k);
  float sdfValid = 1.0 - smoothstep(1.5 * s.k, 3.0 * s.k, fp);

  vec3 L = normalize(uSunDir);
  vec3 ink = hex(52.0, 42.0, 32.0);

  // ---- land: albedo -------------------------------------------------------
  float es = uShadeExag;
  vec3 N = normalize(vec3(-s.g.x * 0.001 * es, 1.0, s.g.y * 0.001 * es));
  // fine grain, scale-adaptive so it never swims
  float gl = log2(fp * 90.0);
  float gf = floor(gl);
  float gt = gl - gf;
  vec2 gp1 = vMap / exp2(gf), gp2 = vMap / exp2(gf + 1.0);
  vec2 grain = mix(texture(uNoise, gp1 * 0.37).rg, texture(uNoise, gp2 * 0.37).rg, gt) - 0.5;
  N = normalize(N + vec3(grain.x, 0.0, grain.y) * 0.03);

  float h = s.h;
  float alat = abs(lat);
  float arid = clamp(s.arid, 0.0, 1.0);
  arid = clamp(arid + (noiseAt(vMap, 1400.0, 0) - 0.5) * 0.3 * arid, 0.0, 1.0);
  float irrig = s.green * arid;

  vec3 col = hypsometric(h, arid, alat);
  // irrigated river valleys in dry lands
  col = mix(col, hex(163.0, 196.0, 134.0), smoothstep(0.25, 0.8, irrig) * 0.9);
  // faint mottling, like pigment on paper
  float mott = noiseAt(vMap, 900.0, 1) * 0.6 + noiseAt(vMap, 260.0, 2) * 0.4;
  col *= 0.97 + 0.06 * mott;
  // snow & ice: snowline falls with latitude
  float snowline = mix(4800.0, 0.0, smoothstep(30.0, 72.0, alat));
  float slope = 1.0 - N.y;
  float snow = smoothstep(snowline, snowline + 700.0, h + noiseAt(vMap, 120.0, 3) * 500.0) * (1.0 - smoothstep(0.35, 0.8, slope));
  snow = max(snow, smoothstep(66.0, 72.0, alat) * step(lat, 0.0)); // Antarctica
  snow = max(snow, smoothstep(1300.0, 2200.0, h) * smoothstep(60.0, 70.0, alat) * 0.55);
  col = mix(col, hex(250.0, 250.0, 247.0), clamp(snow, 0.0, 1.0));

  float lakeCov = clamp(0.5 + s.lake / fpc, 0.0, 1.0);
  float cover = clamp(0.5 + s.coast / max(fpc, 1e-3), 0.0, 1.0);


  // ---- land: Swiss relief shading ----------------------------------------
  // flat ground keeps its tint; slopes facing the NW light warm up and lighten,
  // slopes turned away fall into a soft bluish shadow
  float ndl = dot(N, L);
  float rel = (ndl - L.y) * 0.95;
  float cav = clamp((h - s.hb) * 0.00035 * es / 12.0, -0.18, 0.08);
  float shadow = clamp(-rel - cav, 0.0, 0.7);
  float lit = clamp(rel, 0.0, 0.5);
  vec3 shadowTint = hex(122.0, 138.0, 178.0);
  vec3 shadeF = mix(vec3(1.0), shadowTint, smoothstep(0.0, 0.8, shadow));
  vec3 land = mix(col * shadeF, hex(255.0, 251.0, 236.0), lit * 0.4);
  // grey shading factor for the colour overlays: they keep their hue, the relief reads through
  float shadeL = dot(shadeF, vec3(0.2126, 0.7152, 0.0722)) + lit * 0.15;

  // ---- zones of influence: flat atlas tints laid over the shaded relief ---
  land = applyZones(land, vMap, fp, cover * (1.0 - lakeCov), mix(1.0, shadeL, 0.5));

  // ---- water --------------------------------------------------------------
  float depth = max(-hSea, 0.0);
  vec3 wc = hex(214.0, 232.0, 236.0);
  wc = mix(wc, hex(195.0, 222.0, 232.0), smoothstep(10.0, 180.0, depth));
  wc = mix(wc, hex(170.0, 204.0, 222.0), smoothstep(150.0, 2000.0, depth));
  wc = mix(wc, hex(150.0, 188.0, 212.0), smoothstep(2500.0, 5500.0, depth));
  // bathymetric relief, barely there
  vec3 Nb = normalize(vec3(-s.gb.x * 0.001 * es * 0.12, 1.0, s.gb.y * 0.001 * es * 0.12));
  wc *= 0.97 + 0.05 * clamp((dot(Nb, L) - L.y) * 4.0 + 0.5, 0.0, 1.0);
  float cd = -s.coast; // km offshore
  // coastal tint and engraved water lines (a nineteenth-century atlas habit)
  // the coast distance field is clamped at 8 texels: nothing offshore may depend on values
  // near that limit, or the edge of a finer data level shows up in the open sea
  float sdfMax = 8.0 * s.k;
  float sdfIn = 1.0 - smoothstep(0.55 * sdfMax, 0.8 * sdfMax, cd);
  vec3 lineCol = hex(92.0, 142.0, 176.0);
  float band = (1.0 - smoothstep(0.0, min(9.0 * fp, 0.7 * sdfMax), cd)) * sdfValid * sdfIn;
  wc = mix(wc, hex(160.0, 200.0, 222.0), band * 0.55);
  float spacing = max(fp * 5.0, 0.6);
  float line = abs(fract(cd / spacing - 0.5) - 0.5) * spacing / fp;
  float lines = (1.0 - smoothstep(0.3, 0.9, line)) * (1.0 - smoothstep(spacing * 0.8, spacing * 3.4, cd)) * step(spacing * 0.5, cd) * sdfIn;
  vec3 water = mix(wc, lineCol, lines * 0.35 * sdfValid);

  // lakes
  vec3 lakeCol = hex(190.0, 219.0, 231.0);
  land = mix(land, lakeCol, lakeCov);
  float lakeEdge = (1.0 - smoothstep(0.35 * fp, 1.1 * fp, abs(s.lake))) * sdfValid;
  land = mix(land, lineCol * 0.8, lakeEdge * 0.7);

  vec3 c = mix(water, land, cover);
  // coastline: a crisp ink line
  float coastLine = 1.0 - smoothstep(0.35 * fp, 1.05 * fp, abs(s.coast));
  c = mix(c, hex(58.0, 96.0, 128.0), coastLine * mix(0.45, 0.85, sdfValid));

  // ---- graticule ----------------------------------------------------------
  if (uGrat > 0.0) {
    float lon = eeLon(vMap);
    float gLat = abs(fract(lat / uGrat + 0.5) - 0.5) * uGrat / max(fwidth(lat), 1e-5);
    float gLon = abs(fract(lon / uGrat + 0.5) - 0.5) * uGrat / max(fwidth(lon), 1e-5);
    float g = 1.0 - smoothstep(0.35, 1.1, min(gLat, gLon));
    c = mix(c, mix(hex(110.0, 96.0, 78.0), lineCol, 1.0 - cover), g * mix(0.16, 0.3, 1.0 - cover));
  }

  // ---- earlier acts: a ruled circle, as on an inset map --------------------
  for (int i = 0; i < 4; i++) {
    vec4 hh = uHearth[i];
    if (hh.w <= 0.0) continue;
    float d = distance(vMap, hh.xy);
    float ringPx = abs(d - hh.z) / fp;
    float ring = 1.0 - smoothstep(0.8, 1.8, ringPx);
    float ring2 = 1.0 - smoothstep(0.4, 1.1, abs(d - hh.z - 4.0 * fp) / fp);
    c = mix(c, hex(150.0, 40.0, 28.0), (ring + ring2 * 0.7) * hh.w);
    c = mix(c, c * hex(255.0, 228.0, 205.0), (1.0 - smoothstep(hh.z * 0.95, hh.z, d)) * hh.w * 0.6);
  }

  // ---- focus: the rest of the map recedes towards the paper ---------------
  if (uFocus.w > 0.0) {
    float fd = distance(vMap, uFocus.xy) / uFocus.z;
    float out_ = smoothstep(1.0, 2.2, fd) * uFocus.w;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c, mix(vec3(lum), uPaper, 0.5), out_ * 0.38);
  }

  // ---- neatline of the projection and aerial perspective ------------------
  float edge = 1.0 - smoothstep(0.6 * fp, 1.8 * fp, ol.x);
  c = mix(c, ink, edge * 0.85);
  float haze = smoothstep(uCamDist * 0.9, uCamDist * 3.4, vViewZ);
  c = mix(c, uPaper, haze * 0.35);

  if (uDebug == 1) c = vec3(max(h, 0.0) / 3000.0, max(-h, 0.0) / 6000.0, 0.0);
  if (uDebug == 2) c = w.rgb + vec3(w.w);
  if (uDebug == 3) c = vec3(lakeCov, cover, s.arid);
  if (uDebug == 4) c = N * 0.5 + 0.5;
  fragColor = vec4(c, 1.0);
}
`;

interface Node {
  x: number;
  y: number;
  size: number;
  lod: number;
}

export class Terrain {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private instAttr: THREE.InstancedBufferAttribute;
  private geom: THREE.InstancedBufferGeometry;
  private ranges: number[] = [];
  private morph: THREE.Vector2[] = [];
  private frustum = new THREE.Frustum();
  private box = new THREE.Box3();
  private projScreen = new THREE.Matrix4();
  private maxGrid: Float32Array | null = null;
  private maxGridDims = { w: 0, h: 0, cell: 0 };
  detail = 11; // range factor: larger → more triangles
  lastCount = 0;

  constructor(
    public tu: TerrainUniforms,
    zu: ZoneUniforms,
    extra: Record<string, THREE.IUniform>,
  ) {
    const g = new THREE.InstancedBufferGeometry();
    const n = GRID_N;
    const gridPos = new Float32Array((n + 1) * (n + 1) * 2);
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        gridPos[(j * (n + 1) + i) * 2] = i / n;
        gridPos[(j * (n + 1) + i) * 2 + 1] = j / n;
      }
    const idx: number[] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        // grid y goes north; keep CCW when seen from +Y (world z = -y)
        if ((i + j) & 1) idx.push(a, b, d, a, d, c);
        else idx.push(a, b, c, b, d, c);
      }
    g.setIndex(idx);
    g.setAttribute('grid', new THREE.BufferAttribute(gridPos, 2));
    // dummy position attribute for three.js bookkeeping
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * (n + 1) * 3), 3));
    this.instAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INST * 4), 4);
    this.instAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('inst', this.instAttr);
    g.instanceCount = 0;
    this.geom = g;

    for (let i = 0; i < LODS; i++) this.morph.push(new THREE.Vector2());
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...tu,
        ...zu,
        ...extra,
        uMorph: { value: this.morph },
        uGridN: { value: GRID_N },
        uDebug: { value: 0 },
      },
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.setDetail(this.detail);
  }

  setDetail(f: number) {
    this.detail = f;
    const leaf = ROOT / 2 ** (LODS - 1);
    this.ranges = [];
    for (let i = 0; i < LODS; i++) this.ranges.push(leaf * 2 ** i * f);
    for (let i = 0; i < LODS; i++) {
      const prev = i === 0 ? 0 : this.ranges[i - 1];
      const end = this.ranges[i];
      this.morph[i].set(prev + (end - prev) * 0.62, end * 0.98);
    }
  }

  /** coarse grid of max heights from the heightfield (for node bounds) */
  buildBounds(hf: HeightField) {
    const cell = 135;
    const w = Math.ceil((2 * ROOT) / cell), h = Math.ceil(ROOT / cell);
    const g = new Float32Array(w * h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const x0 = -ROOT + i * cell, y0 = -ROOT / 2 + j * cell;
        g[j * w + i] = hf.maxIn(x0, y0, x0 + cell, y0 + cell);
      }
    this.maxGrid = g;
    this.maxGridDims = { w, h, cell };
  }

  private maxHeight(x0: number, y0: number, s: number): number {
    if (!this.maxGrid) return 9000;
    const { w, h, cell } = this.maxGridDims;
    const i0 = Math.max(0, Math.floor((x0 + ROOT) / cell)), i1 = Math.min(w - 1, Math.floor((x0 + s + ROOT) / cell));
    const j0 = Math.max(0, Math.floor((y0 + ROOT / 2) / cell)), j1 = Math.min(h - 1, Math.floor((y0 + s + ROOT / 2) / cell));
    let m = 0;
    const step = Math.max(1, Math.floor((i1 - i0) / 8));
    for (let j = j0; j <= j1; j += step) for (let i = i0; i <= i1; i += step) m = Math.max(m, this.maxGrid[j * w + i]);
    return m;
  }

  update(camera: THREE.PerspectiveCamera) {
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const cam = camera.position;
    const exag = this.tu.uExag.value;
    const out: Node[] = [];
    const roots: Node[] = [
      { x: -ROOT, y: -ROOT / 2, size: ROOT, lod: LODS - 1 },
      { x: 0, y: -ROOT / 2, size: ROOT, lod: LODS - 1 },
    ];
    const boxOf = (nd: Node) => {
      const top = (this.maxHeight(nd.x, nd.y, nd.size) * 0.001 * exag) + 1;
      this.box.min.set(nd.x, -1, -(nd.y + nd.size));
      this.box.max.set(nd.x + nd.size, top, -nd.y);
      return this.box;
    };
    const inMap = (nd: Node) => !(nd.x > X_MAX || nd.x + nd.size < -X_MAX || nd.y > Y_MAX || nd.y + nd.size < -Y_MAX);
    const sphere = new THREE.Sphere(cam.clone(), 0);
    const select = (nd: Node): boolean => {
      sphere.radius = this.ranges[nd.lod];
      const b = boxOf(nd);
      if (!b.intersectsSphere(sphere)) return false;
      if (!inMap(nd)) return true;
      if (!this.frustum.intersectsBox(b)) return true;
      if (nd.lod === 0) {
        out.push(nd);
        return true;
      }
      sphere.radius = this.ranges[nd.lod - 1];
      if (!boxOf(nd).intersectsSphere(sphere)) {
        out.push(nd);
        return true;
      }
      const hs = nd.size / 2;
      const kids: Node[] = [
        { x: nd.x, y: nd.y, size: hs, lod: nd.lod - 1 },
        { x: nd.x + hs, y: nd.y, size: hs, lod: nd.lod - 1 },
        { x: nd.x, y: nd.y + hs, size: hs, lod: nd.lod - 1 },
        { x: nd.x + hs, y: nd.y + hs, size: hs, lod: nd.lod - 1 },
      ];
      for (const k of kids) {
        if (!select(k)) {
          // child outside its own range: still drawn at its LOD — its vertices are
          // fully morphed there, so it matches the coarser neighbours exactly
          if (inMap(k) && this.frustum.intersectsBox(boxOf(k))) out.push(k);
        }
      }
      return true;
    };
    for (const r of roots) {
      if (!select(r)) {
        if (this.frustum.intersectsBox(boxOf(r))) out.push(r);
      }
    }
    const arr = this.instAttr.array as Float32Array;
    const count = Math.min(out.length, MAX_INST);
    for (let i = 0; i < count; i++) {
      const nd = out[i];
      arr[i * 4] = nd.x;
      arr[i * 4 + 1] = nd.y;
      arr[i * 4 + 2] = nd.size;
      arr[i * 4 + 3] = nd.lod;
    }
    this.instAttr.needsUpdate = true;
    this.instAttr.clearUpdateRanges();
    this.instAttr.addUpdateRange(0, count * 4);
    this.geom.instanceCount = count;
    this.lastCount = count;
  }
}
