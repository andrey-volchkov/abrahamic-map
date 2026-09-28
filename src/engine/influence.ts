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
uniform float uZoneEmph[${ZONE_CATS}]; // 1 = the chapter's subject, 0 = background
uniform float uZoneOn;
uniform float uZoneFill;            // interior tint strength
uniform float uZoneFillK;           // close-range reduction
uniform float uZoneBand;            // width of the edge ribbon, px
uniform vec3 uPaper;                // page colour (linear)
uniform float uZoneRes;             // field texture size, texels
uniform sampler2D uNoise;

float solidAt(int i, vec2 uv) { return i < 4 ? textureLod(uZ0, uv, 0.0)[i] : textureLod(uZ1, uv, 0.0)[i - 4]; }
float hatchAt(int i, vec2 uv) { return textureLod(uZ2, uv, 0.0)[i - 8]; }

// a printer's tint: ink laid over paper at a given strength, mixed in display space
vec3 inkTint(vec3 ink, float k) {
  vec3 a = pow(uPaper, vec3(1.0 / 2.2)), b = pow(ink, vec3(1.0 / 2.2));
  return pow(mix(a, b, k), vec3(2.2));
}

// Atlas-style zones: a flat tint, a stronger ribbon along the inside of the edge and a
// crisp contour. \`shade\` is a grey relief factor, so the relief reads through the tint.
vec3 applyZones(vec3 col, vec2 p, float fp, float landCover, float shade) {
  vec2 uv = (p - uZoneWin.xy) * uZoneWin.w;
  vec4 a = texture(uZ0, uv), b = texture(uZ1, uv), d = texture(uZ2, uv);
  float v[8] = float[](a.r, a.g, a.b, a.a, b.r, b.g, b.b, b.a);
  // domain-warped noise keeps the contours organic at every scale
  vec2 wp = p + (texture(uNoise, p / 2600.0).rg - 0.5) * 700.0;
  float n = texture(uNoise, wp / 900.0).r * 0.6 + texture(uNoise, wp / 240.0).g * 0.3 + texture(uNoise, wp / 70.0).b * 0.1;
  float T = 0.46 + (n - 0.5) * 0.3;
  int im = 0; float m1 = 0.0; float m2 = 0.0; int i2 = 0;
  for (int i = 0; i < 8; i++) {
    if (v[i] > m1) { m2 = m1; i2 = im; m1 = v[i]; im = i; }
    else if (v[i] > m2) { m2 = v[i]; i2 = i; }
  }
  float h1 = d.r; int hi = 8;
  if (d.g > h1) { h1 = d.g; hi = 9; }
  if (d.b > h1) { h1 = d.b; hi = 10; }
  if (d.a > h1) { h1 = d.a; hi = 11; }
  if (uZoneOn <= 0.0 || landCover <= 0.0) return col;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return col;
  float k = uZoneOn * landCover;
  // field gradients by central differences (smooth, unlike screen-space derivatives);
  // distance to the contour in pixels = (value - threshold) / (change per pixel)
  float du = 1.0 / uZoneRes;
  float perPx = fp / (2.0 * du * uZoneWin.z);
  vec2 ex = vec2(du, 0.0), ey = vec2(0.0, du);

  // solid layer: the dominant tradition
  if (m1 > 0.05) {
    float f = m1 - T;
    vec2 g = vec2(solidAt(im, uv + ex) - solidAt(im, uv - ex), solidAt(im, uv + ey) - solidAt(im, uv - ey));
    // distance to the outer contour, px (positive inside)
    float dOut = f / max(length(g) * perPx, 1e-5);
    float dpx = dOut;
    // where a second tradition is present too, the border between them counts as an edge:
    // each side keeps its own colour and ribbon, no mixing of inks
    if (m2 > T - 0.05) {
      vec2 g2 = vec2(solidAt(i2, uv + ex) - solidAt(i2, uv - ex), solidAt(i2, uv + ey) - solidAt(i2, uv - ey));
      float dShare = (m1 - m2) / max(length(g - g2) * perPx, 1e-5);
      dpx = mix(dpx, min(dpx, dShare), smoothstep(T - 0.05, T + 0.02, m2) * smoothstep(T, T + 0.02, m1));
    }
    float inside = clamp(dOut + 0.5, 0.0, 1.0);
    float emph = uZoneEmph[im];
    vec3 zc = uZoneCol[im];
    // background traditions: a paler tint of their own hue, partly transparent
    float bandW = uZoneBand * mix(0.5, 1.0, emph);
    float band = 1.0 - smoothstep(bandW * 0.45, bandW, dpx);
    // flat light tint inside, a strong ribbon along the edge, relief shading on top
    vec3 tint = inkTint(zc, mix(uZoneFill * mix(0.6, 1.0, emph), mix(0.45, 0.72, emph), band)) * shade;
    float cover = mix(mix(0.55, 0.92, emph) * uZoneFillK, mix(0.6, 0.96, emph), band);
    col = mix(col, tint, inside * cover * k);
    // the contour itself
    float edge = 1.0 - smoothstep(0.45, 1.25, abs(dpx + 0.2));
    col = mix(col, mix(zc, zc * 0.55, emph), edge * mix(0.5, 0.95, emph) * k);
  }

  // hatched layer: political control (e.g. the caliphate) over whatever lies beneath
  if (h1 > 0.05) {
    float fh = h1 - T;
    vec2 g = vec2(hatchAt(hi, uv + ex) - hatchAt(hi, uv - ex), hatchAt(hi, uv + ey) - hatchAt(hi, uv - ey));
    float dpx = fh / max(length(g) * perPx, 1e-5);
    float inside = clamp(dpx + 0.5, 0.0, 1.0);
    float emph = uZoneEmph[hi];
    vec3 hc = uZoneCol[hi];
    // diagonal hatching with a constant on-screen period
    float sl = log2(fp * 9.0);
    float sf = floor(sl);
    float st = sl - sf;
    float s1 = exp2(sf), s2 = exp2(sf + 1.0);
    float q = (p.x + p.y) * 0.7071;
    float l1 = 1.0 - smoothstep(0.9, 1.7, abs(fract(q / s1) - 0.5) * s1 / fp);
    float l2 = 1.0 - smoothstep(0.9, 1.7, abs(fract(q / s2) - 0.5) * s2 / fp);
    float stripe = mix(l1, l2, st);
    col = mix(col, inkTint(hc, 0.85) * shade, inside * (0.08 + stripe * mix(0.45, 0.85, emph)) * k);
    float edge = 1.0 - smoothstep(0.45, 1.25, abs(dpx + 0.2));
    col = mix(col, hc * 0.55, edge * mix(0.3, 0.85, emph) * k);
  }
  return col;
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
  const emph: number[] = [];
  for (let i = 0; i < ZONE_CATS; i++) {
    cols.push(new THREE.Color(1, 1, 1));
    emph.push(1);
  }
  return {
    uZ0: { value: null as THREE.Texture | null },
    uZ1: { value: null as THREE.Texture | null },
    uZ2: { value: null as THREE.Texture | null },
    uZoneWin: { value: new THREE.Vector4(0, 0, 1, 1) },
    uZoneCol: { value: cols },
    uZoneEmph: { value: emph },
    uZoneOn: { value: 1 },
    uZoneFill: { value: 0.4 },
    uZoneFillK: { value: 1 },
    uZoneBand: { value: 11 },
    uZoneRes: { value: 768 },
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
    zu.uZoneRes.value = size;
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

  setColors(colors: string[]) {
    colors.forEach((c, i) => this.zu.uZoneCol.value[i].set(c));
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
