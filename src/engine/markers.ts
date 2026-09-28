// Point markers (cities, events): instanced billboards sitting on the relief.
import * as THREE from 'three';
import { PROJ_GLSL, TERRAIN_GLSL, type TerrainUniforms } from './glsl';

const MAX = 1024;

const VERT = /* glsl */ `
${PROJ_GLSL}
${TERRAIN_GLSL}
in vec2 corner;
in vec4 mpos;   // map x, map y, size px, alpha
in vec4 mcol;   // rgb, kind (0 city, 1 event, 2 muted event, 3 ripple)
in float mhi;   // highlight 0..1 (ripple: progress 0..1)
uniform vec2 uViewport;
uniform float uPxK;
out vec2 vC;
out vec4 vCol;
out float vA;
out float vHi;
out float vHalf;
void main() {
  vec2 p = mpos.xy;
  vec4 mv0 = viewMatrix * vec4(p.x, 0.0, -p.y, 1.0);
  float px = uPxK * max(-mv0.z, 1.0);
  float y = max(surfaceY(p, px * 2.0), 0.0) + px * 3.0;
  vec4 clip = projectionMatrix * viewMatrix * vec4(p.x, y, -p.y, 1.0);
  float size = mpos.z;
  clip.xy += corner * size / uViewport * clip.w;
  vC = corner;
  vCol = mcol;
  vA = mpos.w;
  vHi = mhi;
  vHalf = size * 0.5;
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vC;
in vec4 vCol;
in float vA;
in float vHi;
in float vHalf;
out vec4 fragColor;
uniform float uTime;
const vec3 INK = vec3(0.034, 0.024, 0.015);
const vec3 PAPER = vec3(0.905, 0.855, 0.735);
float fill(float d) { return 1.0 - smoothstep(-0.6, 0.6, d); }
void main() {
  float r = length(vC) * vHalf;   // px from the centre
  if (r > vHalf) discard;
  vec3 c = vCol.rgb;
  float kind = vCol.a;
  vec3 col = PAPER;
  float a = 0.0;
  if (kind < 0.5) {
    // city: ink ring with a paper centre, capitals get a dot
    float R = vHalf - 2.2;
    float halo = fill(r - R - 1.6);
    float ring = fill(abs(r - R + 0.7) - 0.8);
    float dotc = fill(r - R * 0.42) * step(0.5, vHi);
    col = mix(PAPER, INK, max(ring, dotc));
    a = max(halo * 0.85, max(ring, dotc));
  } else if (kind < 2.5) {
    // event: a disc in the tradition's colour with an ink rim, a ring when highlighted
    float R = kind < 1.5 ? 6.5 : 4.2;
    float halo = fill(r - R - 2.2);
    float disc = fill(r - R);
    float rim = fill(abs(r - R + 0.6) - 0.75);
    float rr = R + 5.5 + 1.5 * sin(uTime * 2.4) * step(0.01, vHi);
    float ring = fill(abs(r - rr) - 1.1) * vHi;
    float ringHalo = fill(abs(r - rr) - 2.4) * vHi;
    col = mix(PAPER, c, disc);
    col = mix(col, INK, rim * (kind < 1.5 ? 0.9 : 0.55));
    col = mix(col, c, ring);
    a = max(max(halo * 0.9, disc), max(ring, ringHalo * 0.7));
  } else {
    // ripple: a ring spreading from a new community
    float R = vHalf - 2.0;
    float ring = fill(abs(r - R) - 1.3);
    col = c;
    a = ring * (1.0 - vHi);
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
