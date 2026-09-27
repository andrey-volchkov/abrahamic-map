// The model as an object: side walls of the Equal Earth slab and the table under it.
import * as THREE from 'three';
import { outline } from '../geo/projection';
import { PROJ_GLSL, TERRAIN_GLSL, type TerrainUniforms } from './glsl';

export const SLAB_DEPTH = 900; // km below sea level

const WALL_VERT = /* glsl */ `
${PROJ_GLSL}
${TERRAIN_GLSL}
in vec3 wall; // map x, map y, 1 = top / 0 = bottom
out float vTop;
out vec3 vN;
out vec3 vWorld;
out float vY;
in vec2 nrm;
void main() {
  vec2 p = wall.xy;
  float y = wall.z > 0.5 ? max(surfaceY(p, 60.0), 0.0) : -${SLAB_DEPTH.toFixed(1)};
  vTop = wall.z;
  vN = normalize(vec3(nrm.x, 0.0, -nrm.y));
  vec4 w = vec4(p.x, y, -p.y, 1.0);
  vWorld = w.xyz;
  vY = y;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const WALL_FRAG = /* glsl */ `
precision highp float;
in float vTop;
in vec3 vN;
in vec3 vWorld;
in float vY;
out vec4 fragColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform sampler2D uNoise;
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  vec3 base = srgb(vec3(0.34, 0.30, 0.26));
  // grain of the base board
  float g = texture(uNoise, vec2(vWorld.x / 9000.0, vY / 600.0)).r;
  base *= 0.85 + 0.3 * g;
  // resin sea layer and a thin ivory lip at the top edge
  float t = clamp((vY + ${SLAB_DEPTH.toFixed(1)}) / ${SLAB_DEPTH.toFixed(1)}, 0.0, 1.2);
  base = mix(base, srgb(vec3(0.16, 0.26, 0.30)), smoothstep(0.82, 0.9, t) * 0.8);
  float lip = smoothstep(0.965, 1.0, t);
  base = mix(base, srgb(vec3(0.85, 0.82, 0.74)), lip);
  float d = max(dot(normalize(vN), normalize(uSunDir)), 0.0);
  vec3 c = base * (uSkyColor * 1.1 + uSunColor * (0.25 + d * 0.8));
  fragColor = vec4(c, 1.0);
}
`;

const TABLE_FRAG = /* glsl */ `
precision highp float;
${PROJ_GLSL}
in vec2 vMap;
out vec4 fragColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform sampler2D uNoise;
uniform vec3 uTableColor;
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  // contact shadow: distance to the slab outline, shifted away from the light
  vec2 sp = vMap + normalize(vec2(uSunDir.x, -uSunDir.z)) * 1100.0;
  float od = -eeOutline(sp).x; // >0 outside
  float od0 = -eeOutline(vMap).x;
  float shadow = 1.0 - 0.75 * (1.0 - smoothstep(-200.0, 2600.0, od));
  shadow *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 420.0, od0));
  // walnut grain, stretched along x
  vec2 q = vMap / vec2(26000.0, 1600.0);
  float grain = texture(uNoise, q).r * 0.6 + texture(uNoise, q * vec2(3.0, 5.0)).g * 0.4;
  grain = 0.8 + 0.4 * smoothstep(0.2, 0.8, grain);
  vec3 c = uTableColor * grain;
  // pool of light around the model
  float r = length(vMap / vec2(30000.0, 19000.0));
  float pool = 0.18 + 1.1 * exp(-r * r * 1.1);
  c *= pool * shadow * (uSkyColor * 0.6 + uSunColor * 0.75);
  fragColor = vec4(c, 1.0);
}
`;

const TABLE_VERT = /* glsl */ `
out vec2 vMap;
void main() {
  vMap = vec2(position.x, -position.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

export function createSlab(tu: TerrainUniforms, light: Record<string, THREE.IUniform>): THREE.Group {
  const group = new THREE.Group();
  const pts = outline(220);
  const n = pts.length;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const nrm = new Float32Array((n + 1) * 2 * 2);
  for (let i = 0; i <= n; i++) {
    const p = pts[i % n];
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    // outward normal of a clockwise ring in map coordinates (x east, y north)
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    pos.set([p[0], p[1], 1, p[0], p[1], 0], i * 6);
    nrm.set([nx, ny, nx, ny], i * 4);
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, c, b, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('wall', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('nrm', new THREE.BufferAttribute(nrm, 2));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
  g.setIndex(idx);
  const wallMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: WALL_VERT,
    fragmentShader: WALL_FRAG,
    uniforms: { ...tu, ...light },
    side: THREE.DoubleSide,
  });
  const walls = new THREE.Mesh(g, wallMat);
  walls.frustumCulled = false;
  group.add(walls);

  const tg = new THREE.PlaneGeometry(400000, 400000, 1, 1);
  tg.rotateX(-Math.PI / 2);
  tg.translate(0, -SLAB_DEPTH, 0);
  const tableMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: TABLE_VERT,
    fragmentShader: TABLE_FRAG,
    uniforms: { ...light, uTableColor: { value: new THREE.Color('#6e5642').convertSRGBToLinear() } },
  });
  const table = new THREE.Mesh(tg, tableMat);
  table.frustumCulled = false;
  group.add(table);
  return group;
}
