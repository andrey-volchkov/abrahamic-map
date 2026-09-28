// Luminous particles travelling along routes: the "flows" of people, armies and missions.
import * as THREE from 'three';

const MAX = 1500;

const VERT = /* glsl */ `
in vec2 corner;
in vec4 ppos;   // world x, world y (height), map y, size px
in vec4 pcol;   // linear rgb, alpha
uniform vec2 uViewport;
out vec2 vC;
out vec4 vCol;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(ppos.x, ppos.y, -ppos.z, 1.0);
  clip.xy += corner * ppos.w / uViewport * clip.w;
  vC = corner;
  vCol = pcol;
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vC;
in vec4 vCol;
out vec4 fragColor;
void main() {
  float r2 = dot(vC, vC);
  if (r2 > 1.0) discard;
  float a = (exp(-r2 * 6.0) * 0.8 + exp(-r2 * 40.0)) * vCol.a;
  vec3 c = mix(vCol.rgb, vec3(1.0, 0.97, 0.9), exp(-r2 * 40.0) * 0.6) * 2.4;
  fragColor = vec4(c * a, a);
}
`;

export interface Particle {
  x: number;
  h: number;
  y: number;
  size: number;
  color: THREE.Color;
  alpha: number;
}

export class Particles {
  mesh: THREE.Mesh;
  private pos: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private geom: THREE.InstancedBufferGeometry;

  constructor(viewport: THREE.IUniform) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('ppos', this.pos);
    g.setAttribute('pcol', this.col);
    g.instanceCount = 0;
    this.geom = g;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uViewport: viewport },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
  }

  set(list: Particle[]) {
    const p = this.pos.array as Float32Array, c = this.col.array as Float32Array;
    const n = Math.min(MAX, list.length);
    for (let i = 0; i < n; i++) {
      const q = list[i];
      p[i * 4] = q.x;
      p[i * 4 + 1] = q.h;
      p[i * 4 + 2] = q.y;
      p[i * 4 + 3] = q.size;
      c[i * 4] = q.color.r;
      c[i * 4 + 1] = q.color.g;
      c[i * 4 + 2] = q.color.b;
      c[i * 4 + 3] = q.alpha;
    }
    this.pos.needsUpdate = this.col.needsUpdate = true;
    this.geom.instanceCount = n;
  }
}
