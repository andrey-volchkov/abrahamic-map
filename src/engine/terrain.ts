// CDLOD terrain: a quadtree of identical grid patches rendered in one instanced draw,
// vertices morph between LODs by camera distance (Strugar, 2010). Land and sea share
// one surface and one shader: the sea is the flat part at y = 0.
import * as THREE from 'three';
import { PROJ_GLSL, TERRAIN_GLSL, type TerrainUniforms } from './glsl';
import { X_MAX, Y_MAX } from '../geo/projection';
import type { HeightField } from './assets';
import { ZONE_GLSL, type ZoneUniforms } from './influence';

const GRID_N = 32;
const LODS = 10;
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
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uShadeExag;
uniform float uTime;
uniform float uCamDist;
uniform vec3 uHaze;
uniform sampler2D uNoise;
uniform vec4 uHearth[4];      // x, y, radius km, intensity
uniform vec4 uFocus;          // x, y, radius km, strength
uniform float uRivers;
uniform int uDebug;

vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

struct S { float h; vec2 g; float coast; float arid; float green; float lake; float hb; float k; float shade; vec2 gb; };

void samp(sampler2D H, sampler2D M, sampler2D L, vec4 R, vec3 T, vec2 p, float fp, float w, vec2 sunOff, inout S s) {
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
  float lk = textureLod(L, uv, lod).r;
  float hb = textureLod(H, uv, lod + 3.5).r;
  // coast distance at a point offset towards the sun: land there shades the water here
  float sh = textureLod(M, lvlUV(R, p + sunOff), lod).r;
  // smoothed bathymetry gradient
  float lb = lod + 1.5;
  vec2 gb = vec2(textureLod(H, uv + du * 2.0, lb).r - textureLod(H, uv - du * 2.0, lb).r,
                 textureLod(H, uv - dv * 2.0, lb).r - textureLod(H, uv + dv * 2.0, lb).r) / (4.0 * st);
  s.h += w * hc;
  s.g += w * vec2(hx1 - hx0, hn - hs) / (2.0 * st);
  s.coast += w * sdfKm(m.r, k);
  s.arid += w * m.g;
  s.green += w * m.b;
  s.lake += w * sdfKm(lk, k);
  s.hb += w * hb;
  s.k += w * k;
  s.shade += w * sdfKm(sh, k);
  s.gb += w * gb;
}

float noiseAt(vec2 p, float scaleKm, int ch) {
  vec4 n = texture(uNoise, p / scaleKm);
  return ch == 0 ? n.r : ch == 1 ? n.g : ch == 2 ? n.b : n.a;
}

void main() {
  vec2 ol = eeOutline(vMap);
  if (ol.x < 0.0) discard;
  float lat = ol.y;

  vec2 dpx = dFdx(vMap), dpy = dFdy(vMap);
  float fp = max(length(dpx), length(dpy)); // km per pixel

  vec3 w = levelWeights(vMap);
  S s = S(0.0, vec2(0.0), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, vec2(0.0));
  vec2 sun2 = normalize(vec2(uSunDir.x, -uSunDir.z));
  vec2 sunOff = sun2 * fp * 2.6;
  if (w.x > 0.0) samp(uH0, uM0, uL0, uR0, uT0, vMap, fp, w.x, sunOff, s);
  if (w.y > 0.0) samp(uH1, uM1, uL1, uR1, uT1, vMap, fp, w.y, sunOff, s);
  if (w.z > 0.0) samp(uH2, uM2, uL2, uR2, uT2, vMap, fp, w.z, sunOff, s);
  // SDFs are clamped to ±8 texels; beyond ~3 texels per pixel they lose meaning
  float fpc = min(fp, 3.0 * s.k);
  float sdfValid = 1.0 - smoothstep(1.5 * s.k, 3.0 * s.k, fp);

  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDir);

  // ---- land ---------------------------------------------------------------
  float es = uShadeExag;
  vec3 N = normalize(vec3(-s.g.x * 0.001 * es, 1.0, s.g.y * 0.001 * es));
  // fine "plaster" grain, scale-adaptive so it never swims
  float gl = log2(fp * 90.0);
  float gf = floor(gl);
  float gt = gl - gf;
  vec2 gp1 = vMap / exp2(gf), gp2 = vMap / exp2(gf + 1.0);
  vec2 grain = mix(texture(uNoise, gp1 * 0.37).rg, texture(uNoise, gp2 * 0.37).rg, gt) - 0.5;
  N = normalize(N + vec3(grain.x, 0.0, grain.y) * 0.05);

  float h = s.h;
  float alat = abs(lat);
  float arid = clamp(s.arid, 0.0, 1.0);
  arid = clamp(arid + (noiseAt(vMap, 1400.0, 0) - 0.5) * 0.35 * arid, 0.0, 1.0);
  float irrig = s.green * arid;

  vec3 cTemperate = srgb(vec3(0.55, 0.58, 0.44));
  vec3 cTropic = srgb(vec3(0.40, 0.48, 0.33));
  vec3 cBoreal = srgb(vec3(0.45, 0.49, 0.41));
  vec3 cTundra = srgb(vec3(0.62, 0.61, 0.55));
  vec3 cSteppe = srgb(vec3(0.69, 0.65, 0.50));
  vec3 cDesert = srgb(vec3(0.79, 0.70, 0.54));
  vec3 cHigh = srgb(vec3(0.62, 0.55, 0.45));
  vec3 cRock = srgb(vec3(0.55, 0.51, 0.47));
  vec3 cSnow = srgb(vec3(0.95, 0.94, 0.91));
  vec3 cIrrig = srgb(vec3(0.44, 0.52, 0.30));

  vec3 wet = mix(cTropic, cTemperate, smoothstep(12.0, 30.0, alat));
  wet = mix(wet, cBoreal, smoothstep(48.0, 58.0, alat));
  wet = mix(wet, cTundra, smoothstep(62.0, 70.0, alat));
  vec3 col = mix(wet, cSteppe, smoothstep(0.0, 0.6, arid));
  col = mix(col, cDesert, smoothstep(0.4, 1.0, arid));
  // elevation tint
  float hi = smoothstep(700.0, 2600.0, h);
  col = mix(col, mix(cHigh, cRock, smoothstep(2500.0, 4200.0, h)), hi * 0.85);
  // irrigated river valleys in dry lands
  col = mix(col, cIrrig, smoothstep(0.25, 0.8, irrig) * 0.85);
  // noise mottling
  float mott = noiseAt(vMap, 900.0, 1) * 0.6 + noiseAt(vMap, 260.0, 2) * 0.4;
  col *= 0.92 + 0.16 * mott;
  // snow & ice: snowline falls with latitude
  float snowline = mix(4800.0, 0.0, smoothstep(30.0, 72.0, alat));
  float slope = 1.0 - N.y;
  float snow = smoothstep(snowline, snowline + 700.0, h + noiseAt(vMap, 120.0, 3) * 500.0) * (1.0 - smoothstep(0.35, 0.8, slope));
  snow = max(snow, smoothstep(66.0, 72.0, alat) * step(lat, 0.0)); // Antarctica
  snow = max(snow, smoothstep(1100.0, 2000.0, h) * smoothstep(58.0, 68.0, alat) * 0.8);
  col = mix(col, cSnow, clamp(snow, 0.0, 1.0));

  // lighting
  float ndl = dot(N, L);
  float diff = clamp((ndl + 0.18) / 1.18, 0.0, 1.0);
  float cav = clamp(1.0 + (h - s.hb) * 0.00045 * es / 12.0, 0.72, 1.12);
  vec3 amb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
  vec3 land = col * (amb * cav + uSunColor * diff * mix(1.0, cav, 0.5));
  // soft sheen on snow
  vec3 Hh = normalize(L + V);
  land += uSunColor * pow(max(dot(N, Hh), 0.0), 24.0) * 0.05 * (0.3 + snow);

  // lakes
  float lakeCov = clamp(0.5 + s.lake / fpc, 0.0, 1.0);

  // ---- water --------------------------------------------------------------
  float depth = max(-h, 0.0);
  vec3 cShelf = srgb(vec3(0.50, 0.65, 0.64));
  vec3 cShallow = srgb(vec3(0.33, 0.50, 0.53));
  vec3 cDeep = srgb(vec3(0.17, 0.29, 0.35));
  vec3 cAbyss = srgb(vec3(0.12, 0.21, 0.27));
  vec3 wc = mix(cShelf, cShallow, smoothstep(0.0, 320.0, depth));
  wc = mix(wc, cDeep, smoothstep(150.0, 2600.0, depth));
  wc = mix(wc, cAbyss, smoothstep(3000.0, 6000.0, depth));
  // bathymetric relief faintly visible through the resin
  vec3 Nb = normalize(vec3(-s.gb.x * 0.001 * es * 0.12, 1.0, s.gb.y * 0.001 * es * 0.12));
  wc *= 0.93 + 0.12 * clamp(dot(Nb, L), 0.0, 1.0);
  // ripples (scale-adaptive, two octaves cross-faded)
  float rl = log2(fp * 70.0);
  float rf = floor(rl);
  float rt = rl - rf;
  vec2 q1 = vMap / exp2(rf), q2 = vMap / exp2(rf + 1.0);
  vec2 drift = vec2(uTime * 0.013, uTime * 0.008);
  vec2 rn1 = texture(uNoise, q1 * 0.21 + drift).ba - texture(uNoise, q1 * 0.13 - drift * 0.7).ba;
  vec2 rn2 = texture(uNoise, q2 * 0.21 + drift).ba - texture(uNoise, q2 * 0.13 - drift * 0.7).ba;
  vec2 rn = mix(rn1, rn2, rt);
  float ramp = mix(0.03, 0.006, smoothstep(1.0, 20.0, fp));
  vec3 Nw = normalize(vec3(rn.x * ramp, 1.0, rn.y * ramp));
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(Nw, V), 0.0), 5.0);
  vec3 Hw = normalize(L + V);
  float nh = max(dot(Nw, Hw), 0.0);
  float spec = pow(nh, 320.0) * 2.2 + pow(nh, 60.0) * 0.07 + pow(nh, 12.0) * 0.012;
  vec3 water = wc * (uSkyColor * 0.55 + uSunColor * 0.42 * max(dot(vec3(0,1,0), L), 0.0));
  water = mix(water, uSkyColor * 1.05, fres * 0.4);
  water += uSunColor * spec;

  // coastline: a thin pale lip, and faint engraved lines offshore
  float cd = -s.coast; // km offshore
  // the land plate casts a narrow shadow onto the resin sea
  float shadowed = smoothstep(-0.6 * fpc, 0.6 * fpc, s.shade) * sdfValid;
  water *= 1.0 - 0.32 * shadowed;
  float lip = (1.0 - smoothstep(0.0, 1.3 * fp, cd)) * sdfValid;
  water = mix(water, srgb(vec3(0.80, 0.82, 0.76)) * (uSkyColor + uSunColor * 0.5), lip * 0.45);
  float spacing = max(fp * 7.0, 0.8);
  float line = abs(fract(cd / spacing - 0.5) - 0.5) * spacing / fp;
  float lines = (1.0 - smoothstep(0.35, 1.1, line)) * (1.0 - smoothstep(spacing * 0.6, spacing * 3.2, cd)) * step(spacing * 0.5, cd);
  water = mix(water, water * 1.16 + 0.008, lines * 0.3 * sdfValid);

  // lakes use the water shading at their own level
  vec3 lakeCol = mix(cShallow, cShelf, 0.35) * (uSkyColor * 0.6 + uSunColor * 0.4) + uSunColor * spec * 0.6;
  land = mix(land, lakeCol, lakeCov);

  // rivers are drawn as vector lines; here only a hint at far zoom
  float cover = clamp(0.5 + s.coast / max(fpc, 1e-3), 0.0, 1.0);
  vec3 c = mix(water, land, cover);

  // ---- zones of influence -------------------------------------------------
  c = applyZones(c, vMap, fp, cover * (1.0 - lakeCov), uTime);

  // ---- hearths (glowing memory of earlier acts) ---------------------------
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 hh = uHearth[i];
    if (hh.w <= 0.0) continue;
    float d = distance(vMap, hh.xy) / hh.z;
    glow += srgb(vec3(1.0, 0.78, 0.45)) * hh.w * (exp(-d * d * 2.2) * 0.9 + exp(-d * d * 12.0) * 1.6);
  }
  c += glow;

  // ---- focus (soft spotlight on the table) --------------------------------
  if (uFocus.w > 0.0) {
    float fd = distance(vMap, uFocus.xy) / uFocus.z;
    c *= mix(1.0, 0.55 + 0.45 * (1.0 - smoothstep(0.7, 1.9, fd)), uFocus.w);
  }

  // ---- slab edge bevel & aerial haze -------------------------------------
  float edge = 1.0 - smoothstep(0.0, 2.2 * fp, ol.x);
  c = mix(c, c * 1.35 + 0.02, edge * 0.8);
  float haze = smoothstep(uCamDist * 0.8, uCamDist * 3.2, vViewZ);
  c = mix(c, uHaze, haze * 0.32);

  if (uDebug == 1) c = vec3(max(h, 0.0) / 3000.0, max(-h, 0.0) / 6000.0, 0.0);
  if (uDebug == 2) c = w;
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
  detail = 7.5; // range factor: larger → more triangles
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
