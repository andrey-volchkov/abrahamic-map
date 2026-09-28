// Shared GLSL: Equal Earth outline, multi-level terrain sampling, noise.
import * as THREE from 'three';
import { R, X_MAX, Y_MAX } from '../geo/projection';

export const PROJ_GLSL = /* glsl */ `
const float EE_R = ${R.toFixed(1)};
const float EE_YMAX = ${Y_MAX.toFixed(3)};
const float EE_XMAX = ${X_MAX.toFixed(3)};
const float EE_A1 = 1.340264, EE_A2 = -0.081106, EE_A3 = 0.000893, EE_A4 = 0.003796;
const float EE_M = 0.8660254037844386;

// returns vec2(signed distance to the outline in km (positive inside), latitude in degrees)
vec2 eeOutline(vec2 p) {
  float y = clamp(p.y / EE_R, -1.3173, 1.3173);
  float t = y;
  for (int i = 0; i < 4; i++) {
    float t2 = t * t; float t6 = t2 * t2 * t2;
    float fy = t * (EE_A1 + EE_A2 * t2 + t6 * (EE_A3 + EE_A4 * t2)) - y;
    float fpy = EE_A1 + 3.0 * EE_A2 * t2 + t6 * (7.0 * EE_A3 + 9.0 * EE_A4 * t2);
    t -= fy / fpy;
  }
  float t2 = t * t; float t6 = t2 * t2 * t2;
  float xmax = 3.14159265 * cos(t) / (EE_M * (EE_A1 + 3.0 * EE_A2 * t2 + t6 * (7.0 * EE_A3 + 9.0 * EE_A4 * t2))) * EE_R;
  float lat = degrees(asin(clamp(sin(t) / EE_M, -1.0, 1.0)));
  return vec2(min(xmax - abs(p.x), EE_YMAX - abs(p.y)), lat);
}
`;

export const TERRAIN_GLSL = /* glsl */ `
uniform sampler2D uH0; uniform sampler2D uH1; uniform sampler2D uH2; uniform sampler2D uH3;
uniform sampler2D uM0; uniform sampler2D uM1; uniform sampler2D uM2; uniform sampler2D uM3;
uniform sampler2D uL0; uniform sampler2D uL1; uniform sampler2D uL2; uniform sampler2D uL3;
uniform vec4 uR0; uniform vec4 uR1; uniform vec4 uR2; uniform vec4 uR3;   // x0, y0 (top), width km, height km
uniform vec3 uT0; uniform vec3 uT1; uniform vec3 uT2; uniform vec3 uT3;   // 1/W, 1/H, km per texel
uniform vec3 uHas;                                      // L1, L2, L3 availability (0..1)
uniform float uExag;                                    // vertical exaggeration

vec2 lvlUV(vec4 R, vec2 p) { return vec2((p.x - R.x) / R.z, (R.y - p.y) / R.w); }

float lvlEdge(vec2 uv, vec2 texel) {
  vec2 e = min(uv, 1.0 - uv) / (texel * 40.0);
  return clamp(min(e.x, e.y) - 0.25, 0.0, 1.0);
}

vec4 levelWeights(vec2 p) {
  float w3 = uHas.z * lvlEdge(lvlUV(uR3, p), uT3.xy);
  float rem = 1.0 - w3;
  float w2 = uHas.y * lvlEdge(lvlUV(uR2, p), uT2.xy) * rem;
  rem -= w2;
  float w1 = uHas.x * lvlEdge(lvlUV(uR1, p), uT1.xy) * rem;
  rem -= w1;
  return vec4(rem, w1, w2, w3);
}

float sdfKm(float v, float k) { return (v * 255.0 - 128.0) / 16.0 * k; }

// height (m) and coast distance (km, + = land) at p, filtered for a footprint of fpKm
vec2 heightCoast(vec2 p, float fpKm) {
  vec4 w = levelWeights(p);
  vec2 r = vec2(0.0);
  if (w.x > 0.0) {
    vec2 uv = lvlUV(uR0, p);
    float lod = log2(max(fpKm / uT0.z, 1.0));
    r += w.x * vec2(textureLod(uH0, uv, lod).r, sdfKm(textureLod(uM0, uv, lod).r, uT0.z));
  }
  if (w.y > 0.0) {
    vec2 uv = lvlUV(uR1, p);
    float lod = log2(max(fpKm / uT1.z, 1.0));
    r += w.y * vec2(textureLod(uH1, uv, lod).r, sdfKm(textureLod(uM1, uv, lod).r, uT1.z));
  }
  if (w.z > 0.0) {
    vec2 uv = lvlUV(uR2, p);
    float lod = log2(max(fpKm / uT2.z, 1.0));
    r += w.z * vec2(textureLod(uH2, uv, lod).r, sdfKm(textureLod(uM2, uv, lod).r, uT2.z));
  }
  if (w.w > 0.0) {
    vec2 uv = lvlUV(uR3, p);
    float lod = log2(max(fpKm / uT3.z, 1.0));
    r += w.w * vec2(textureLod(uH3, uv, lod).r, sdfKm(textureLod(uM3, uv, lod).r, uT3.z));
  }
  return r;
}

// world-space surface height (km) — the sea is flat at 0
float surfaceY(vec2 p, float fpKm) {
  vec2 hc = heightCoast(p, fpKm);
  float land = smoothstep(-0.25 * fpKm, 0.25 * fpKm + 0.01, hc.y);
  return land * max(hc.x, -500.0) * 0.001 * uExag;
}
`;

export function createTerrainUniforms() {
  const blank = new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  const blankH = new THREE.DataTexture(new Uint16Array([0]), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
  blankH.needsUpdate = true;
  return {
    uH0: { value: blankH as THREE.Texture },
    uH1: { value: blankH as THREE.Texture },
    uH2: { value: blankH as THREE.Texture },
    uH3: { value: blankH as THREE.Texture },
    uM0: { value: blank as THREE.Texture },
    uM1: { value: blank as THREE.Texture },
    uM2: { value: blank as THREE.Texture },
    uM3: { value: blank as THREE.Texture },
    uL0: { value: blank as THREE.Texture },
    uL1: { value: blank as THREE.Texture },
    uL2: { value: blank as THREE.Texture },
    uL3: { value: blank as THREE.Texture },
    uR0: { value: new THREE.Vector4(-1e5, 1e5, 2e5, 2e5) },
    uR1: { value: new THREE.Vector4(0, 0, 1, 1) },
    uR2: { value: new THREE.Vector4(0, 0, 1, 1) },
    uR3: { value: new THREE.Vector4(0, 0, 1, 1) },
    uT0: { value: new THREE.Vector3(1, 1, 1) },
    uT1: { value: new THREE.Vector3(1, 1, 1) },
    uT2: { value: new THREE.Vector3(1, 1, 1) },
    uT3: { value: new THREE.Vector3(1, 1, 1) },
    uHas: { value: new THREE.Vector3(0, 0, 0) },
    uExag: { value: 12 },
  };
}
export type TerrainUniforms = ReturnType<typeof createTerrainUniforms>;

/** Tileable gradient-noise texture (4 octaves in RGBA). */
export function createNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const rand = mulberry32(1234);
  const freqs = [4, 8, 16, 32];
  freqs.forEach((f, ch) => {
    const grads: [number, number][] = [];
    for (let i = 0; i < f * f; i++) {
      const a = rand() * Math.PI * 2;
      grads.push([Math.cos(a), Math.sin(a)]);
    }
    const g = (ix: number, iy: number) => grads[((iy + f) % f) * f + ((ix + f) % f)];
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const px = (x / size) * f, py = (y / size) * f;
        const ix = Math.floor(px), iy = Math.floor(py);
        const fx = px - ix, fy = py - iy;
        const d = (gx: number, gy: number, ox: number, oy: number) => {
          const gr = g(gx, gy);
          return gr[0] * ox + gr[1] * oy;
        };
        const n00 = d(ix, iy, fx, fy), n10 = d(ix + 1, iy, fx - 1, fy);
        const n01 = d(ix, iy + 1, fx, fy - 1), n11 = d(ix + 1, iy + 1, fx - 1, fy - 1);
        const u = fade(fx), v = fade(fy);
        const n = (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
        data[(y * size + x) * 4 + ch] = Math.max(0, Math.min(255, Math.round((n * 0.7071 + 0.5) * 255)));
      }
  });
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToLinear(hex: string): THREE.Color {
  return new THREE.Color(hex).convertSRGBToLinear();
}
