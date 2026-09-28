// Zones of influence. Each "hearth" (a city or area with a date) is splatted as a soft
// kernel into one of 12 category channels (3 MRT targets) in a window that follows the
// camera. The terrain shader thresholds the summed field, so neighbouring hearths merge
// into organic zones that spread as their radii grow — no invented borders.
import * as THREE from 'three';

export const ZONE_CATS = 12;
const MAX_SPLATS = 4096;

export const ZONE_GLSL = /* glsl */ `
uniform sampler2D uZ0; uniform sampler2D uZ1; uniform sampler2D uZ2;
uniform vec4 uZoneWin;              // x0, y0 (south-west), size km, 1/size
uniform vec3 uZoneCol[${ZONE_CATS}];
uniform float uZoneStyle[${ZONE_CATS}]; // 0 solid, 1 hatched
uniform float uZoneOn;
uniform float uZoneFill;
uniform float uZoneFillK;
uniform sampler2D uNoise;

vec3 applyZones(vec3 c, vec2 p, float fp, float landCover, float time) {
  if (uZoneOn <= 0.0 || landCover <= 0.0) return c;
  vec2 uv = (p - uZoneWin.xy) * uZoneWin.w;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return c;
  vec4 a = texture(uZ0, uv), b = texture(uZ1, uv), d = texture(uZ2, uv);
  float v[8] = float[](a.r, a.g, a.b, a.a, b.r, b.g, b.b, b.a);
  // domain-warped noise keeps the contours organic at every scale
  vec2 wp = p + (texture(uNoise, p / 2600.0).rg - 0.5) * 900.0;
  float n = texture(uNoise, wp / 900.0).r * 0.55 + texture(uNoise, wp / 240.0).g * 0.3 + texture(uNoise, wp / 70.0).b * 0.15;
  float T = 0.46 + (n - 0.5) * 0.42;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // solid layer: the dominant tradition
  int im = 0; float m1 = 0.0; float m2 = 0.0; int i2 = 0;
  for (int i = 0; i < 8; i++) {
    if (v[i] > m1) { m2 = m1; i2 = im; m1 = v[i]; im = i; }
    else if (v[i] > m2) { m2 = v[i]; i2 = i; }
  }
  if (m1 > 0.1) {
    float aa = max(fwidth(m1) * 1.1, 0.004);
    float pres = smoothstep(T - aa, T + aa, m1);
    vec3 zc = uZoneCol[im];
    float share = 1.0 - smoothstep(0.0, 0.3, (m1 - m2) / max(m1, 1e-3));
    zc = mix(zc, uZoneCol[i2], share * 0.5 * step(T, m2));
    // tint that keeps the relief: hue from the zone colour, luminance from the model
    float zl = max(dot(zc, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
    vec3 wash = c * mix(vec3(1.0), zc / zl, 0.62) * 1.03;
    // watercolour: pigment pools towards the edge, the interior stays light
    float inner = smoothstep(T, T + 0.5, m1);
    float fill = mix(0.72, uZoneFill, inner);
    c = mix(c, wash, pres * fill * uZoneFillK * landCover * uZoneOn);
    float rim = 1.0 - smoothstep(0.0, aa * 2.6, abs(m1 - T));
    c += zc * rim * 0.5 * landCover * uZoneOn;
  }

  // hatched layer: political control (e.g. the caliphate) over whatever lies beneath
  float h1 = d.r; int hi = 8;
  if (d.g > h1) { h1 = d.g; hi = 9; }
  if (d.b > h1) { h1 = d.b; hi = 10; }
  if (d.a > h1) { h1 = d.a; hi = 11; }
  if (h1 > 0.1) {
    float aa = max(fwidth(h1) * 1.1, 0.004);
    float hp = smoothstep(T - aa, T + aa, h1);
    vec3 hc = uZoneCol[hi];
    float sl = log2(fp * 10.0);
    float sf = floor(sl);
    float st = sl - sf;
    float s1 = exp2(sf), s2 = exp2(sf + 1.0);
    float q = (p.x + p.y) * 0.7071;
    float l1 = 1.0 - smoothstep(0.9, 1.7, abs(fract(q / s1) - 0.5) * s1 / fp);
    float l2 = 1.0 - smoothstep(0.9, 1.7, abs(fract(q / s2) - 0.5) * s2 / fp);
    float stripe = mix(l1, l2, st);
    c = mix(c, hc * (lum * 2.1 + 0.02), hp * (0.12 + 0.55 * stripe) * landCover * uZoneOn);
    float rim = 1.0 - smoothstep(0.0, aa * 2.5, abs(h1 - T));
    c += hc * rim * 0.35 * landCover * uZoneOn;
  }
  return c;
}
`;

const SPLAT_VERT = /* glsl */ `
in vec2 corner;
in vec4 splat;      // x, y, radius km, intensity
in float cat;
uniform vec4 uWin;  // x0, y0, size, 1/size
flat out int vCat;
out vec2 vLocal;
out float vInt;
void main() {
  float ext = 2.6;
  vec2 p = splat.xy + corner * splat.z * ext;
  vec2 uv = (p - uWin.xy) * uWin.w;
  vLocal = corner * ext;
  vInt = splat.w;
  vCat = int(cat + 0.5);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SPLAT_FRAG = /* glsl */ `
precision highp float;
flat in int vCat;
in vec2 vLocal;
in float vInt;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  float d2 = dot(vLocal, vLocal);
  float w = vInt * exp(-0.693 * d2);
  int ch = vCat & 3;
  vec4 v = vec4(ch == 0 ? w : 0.0, ch == 1 ? w : 0.0, ch == 2 ? w : 0.0, ch == 3 ? w : 0.0);
  int t = vCat >> 2;
  o0 = t == 0 ? v : vec4(0.0);
  o1 = t == 1 ? v : vec4(0.0);
  o2 = t == 2 ? v : vec4(0.0);
}
`;

export interface Splat {
  x: number;
  y: number;
  r: number;
  a: number;
  cat: number;
}

export function createZoneUniforms() {
  const cols: THREE.Color[] = [];
  const style: number[] = [];
  for (let i = 0; i < ZONE_CATS; i++) {
    cols.push(new THREE.Color(1, 1, 1));
    style.push(0);
  }
  return {
    uZ0: { value: null as THREE.Texture | null },
    uZ1: { value: null as THREE.Texture | null },
    uZ2: { value: null as THREE.Texture | null },
    uZoneWin: { value: new THREE.Vector4(0, 0, 1, 1) },
    uZoneCol: { value: cols },
    uZoneStyle: { value: style },
    uZoneOn: { value: 1 },
    uZoneFill: { value: 0.36 },
    uZoneFillK: { value: 1 },
  };
}
export type ZoneUniforms = ReturnType<typeof createZoneUniforms>;

export class Influence {
  rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.Camera();
  private splatAttr: THREE.InstancedBufferAttribute;
  private catAttr: THREE.InstancedBufferAttribute;
  private geom: THREE.InstancedBufferGeometry;
  private mat: THREE.RawShaderMaterial;
  size: number;

  constructor(public zu: ZoneUniforms, size = 768) {
    this.size = size;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      count: 3,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    zu.uZ0.value = this.rt.textures[0];
    zu.uZ1.value = this.rt.textures[1];
    zu.uZ2.value = this.rt.textures[2];
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.splatAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4);
    this.catAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS), 1);
    this.splatAttr.setUsage(THREE.DynamicDrawUsage);
    this.catAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('splat', this.splatAttr);
    g.setAttribute('cat', this.catAttr);
    g.instanceCount = 0;
    this.geom = g;
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SPLAT_VERT,
      fragmentShader: SPLAT_FRAG,
      uniforms: { uWin: zu.uZoneWin },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  setColors(colors: string[], styles: number[]) {
    colors.forEach((c, i) => this.zu.uZoneCol.value[i].set(c).convertSRGBToLinear());
    styles.forEach((s, i) => (this.zu.uZoneStyle.value[i] = s));
  }

  /** place the field window around the view; cx, cy = map point, size = window size in km */
  setWindow(cx: number, cy: number, size: number) {
    const texel = size / this.size;
    const x0 = Math.floor((cx - size / 2) / texel) * texel;
    const y0 = Math.floor((cy - size / 2) / texel) * texel;
    this.zu.uZoneWin.value.set(x0, y0, size, 1 / size);
  }

  render(renderer: THREE.WebGLRenderer, splats: Splat[]) {
    const n = Math.min(splats.length, MAX_SPLATS);
    const a = this.splatAttr.array as Float32Array;
    const c = this.catAttr.array as Float32Array;
    const texel = this.zu.uZoneWin.value.z / this.size;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const s = splats[i];
      if (s.a <= 0.001 || s.r <= 0) continue;
      a[k * 4] = s.x;
      a[k * 4 + 1] = s.y;
      a[k * 4 + 2] = Math.max(s.r, texel * 1.8);
      a[k * 4 + 3] = s.a;
      c[k] = s.cat;
      k++;
    }
    this.splatAttr.needsUpdate = true;
    this.catAttr.needsUpdate = true;
    this.geom.instanceCount = k;
    const prev = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    if (k) renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
  }
}
