// Point markers (cities, events): instanced billboards sitting on the relief.
import * as THREE from 'three';
import { PROJ_GLSL, TERRAIN_GLSL, type TerrainUniforms } from './glsl';

const MAX = 1024;

const VERT = /* glsl */ `
${PROJ_GLSL}
${TERRAIN_GLSL}
in vec2 corner;
in vec4 mpos;   // map x, map y, size px, alpha
in vec4 mcol;   // rgb, kind (0 dot, 1 event, 2 hollow)
in float mhi;   // highlight 0..1
uniform vec2 uViewport;
uniform float uPxK;
out vec2 vC;
out vec4 vCol;
out float vA;
out float vHi;
void main() {
  vec2 p = mpos.xy;
  vec4 mv0 = viewMatrix * vec4(p.x, 0.0, -p.y, 1.0);
  float px = uPxK * max(-mv0.z, 1.0);
  float y = max(surfaceY(p, px * 2.0), 0.0) + px * 3.0;
  vec4 clip = projectionMatrix * viewMatrix * vec4(p.x, y, -p.y, 1.0);
  float size = mpos.z * (1.0 + mhi * 0.35);
  clip.xy += corner * size / uViewport * clip.w;
  vC = corner;
  vCol = mcol;
  vA = mpos.w;
  vHi = mhi;
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vC;
in vec4 vCol;
in float vA;
in float vHi;
out vec4 fragColor;
uniform float uTime;
void main() {
  float r = length(vC);
  if (r > 1.0) discard;
  vec3 c = vCol.rgb;
  float kind = vCol.a;
  float aa = fwidth(r) * 1.2;
  float core = 1.0 - smoothstep(0.26 - aa, 0.26 + aa, r);
  float rim = (1.0 - smoothstep(0.26, 0.26 + aa * 2.0, r)) - core;
  float halo = exp(-r * r * 9.0) * 0.55;
  float a = 0.0;
  vec3 col = vec3(0.0);
  if (kind < 0.5) {
    // city: ivory dot with dark rim
    col = mix(vec3(0.04, 0.035, 0.03), c * 1.6, core);
    a = max(core, rim * 0.9) + halo * 0.35;
    col += c * halo * 0.6;
  } else {
    // event: luminous dot, pulsing ring when highlighted
    float ring = 1.0 - smoothstep(aa, aa * 2.5, abs(r - 0.58 - 0.12 * sin(uTime * 3.0)));
    float ring2 = 1.0 - smoothstep(aa, aa * 2.0, abs(r - 0.4));
    float dotc = 1.0 - smoothstep(0.17 - aa, 0.17 + aa, r);
    col = c * (core * 1.4 + halo * 2.2) + vec3(1.0, 0.96, 0.88) * dotc * 2.2 + c * ring * vHi * 2.4 + c * ring2 * 1.2;
    a = max(max(core, ring2 * 0.9), halo + ring * vHi);
    if (kind > 1.5) { col = c * (rim * 2.0 + halo); a = max(rim, halo * 0.6); }
  }
  a *= vA;
  if (a < 0.004) discard;
  fragColor = vec4(col, a);
}
`;

export interface MarkerState {
  x: number;
  y: number;
  size: number;
  alpha: number;
  color: THREE.Color;
  kind: number;
  hi: number;
}

export class Markers {
  mesh: THREE.Mesh;
  private posA: THREE.InstancedBufferAttribute;
  private colA: THREE.InstancedBufferAttribute;
  private hiA: THREE.InstancedBufferAttribute;
  private geom: THREE.InstancedBufferGeometry;

  constructor(tu: TerrainUniforms, shared: Record<string, THREE.IUniform>) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.posA = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.colA = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.hiA = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    for (const a of [this.posA, this.colA, this.hiA]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('mpos', this.posA);
    g.setAttribute('mcol', this.colA);
    g.setAttribute('mhi', this.hiA);
    g.instanceCount = 0;
    this.geom = g;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...tu, ...shared },
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  set(list: MarkerState[]) {
    const p = this.posA.array as Float32Array, c = this.colA.array as Float32Array, h = this.hiA.array as Float32Array;
    let n = 0;
    for (const m of list) {
      if (m.alpha <= 0.003 || n >= MAX) continue;
      p.set([m.x, m.y, m.size, m.alpha], n * 4);
      c.set([m.color.r, m.color.g, m.color.b, m.kind], n * 4);
      h[n] = m.hi;
      n++;
    }
    this.posA.needsUpdate = this.colA.needsUpdate = this.hiA.needsUpdate = true;
    this.geom.instanceCount = n;
  }
}
