// Ribbons draped on the relief (or arcing above it): routes, roads, rivers.
// Width is constant in screen pixels; routes reveal progressively with a glowing head.
import * as THREE from 'three';
import { PROJ_GLSL, TERRAIN_GLSL, type TerrainUniforms } from './glsl';

const VERT = /* glsl */ `
${PROJ_GLSL}
${TERRAIN_GLSL}
in vec2 pos2;
in vec2 tan2;
in float side;
in float along;
in float rank;
uniform float uWidth;      // px
uniform float uLift;       // km above the surface (scaled by exaggeration)
uniform float uArc;        // arc height km (0 = draped)
uniform float uTotal;
uniform float uPxK;        // 2*tan(fov/2)/viewportHeight
uniform float uRankFade;   // for rivers: max rank shown
out float vSide;
out float vAlong;
out float vPx;             // km per pixel here
out float vRankA;
void main() {
  float t = uTotal > 0.0 ? along / uTotal : 0.0;
  vec3 base;
  vec2 p = pos2;
  vec4 mv0 = viewMatrix * vec4(p.x, 0.0, -p.y, 1.0);
  float px = uPxK * max(-mv0.z, 1.0);
  float y = uArc > 0.0 ? uArc * 4.0 * t * (1.0 - t) + 1.0 : max(surfaceY(p, px * 2.0), 0.0) + uLift * px;
  base = vec3(p.x, y, -p.y);
  vec3 tw = normalize(vec3(tan2.x, 0.0, -tan2.y));
  vec3 nrm;
  if (uArc > 0.0) {
    vec3 vd = normalize(cameraPosition - base);
    // arc tangent includes the vertical component
    vec3 ta = normalize(tw * uTotal + vec3(0.0, uArc * 4.0 * (1.0 - 2.0 * t), 0.0));
    nrm = normalize(cross(ta, vd));
  } else {
    nrm = vec3(-tw.z, 0.0, tw.x);
  }
  float wpx = uWidth * (rank > 0.0 ? clamp(1.6 - rank * 0.18, 0.5, 1.4) : 1.0);
  vec3 w = base + nrm * side * wpx * 0.5 * px;
  vSide = side;
  vAlong = along;
  vPx = px;
  vRankA = rank > 0.0 ? 1.0 - smoothstep(uRankFade - 0.5, uRankFade + 0.5, rank) : 1.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in float vSide;
in float vAlong;
in float vPx;
in float vRankA;
out vec4 fragColor;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uProgress;   // 0..1 of total
uniform float uTotal;
uniform float uDash;       // dash period in px (0 = solid)
uniform float uGlow;       // HDR boost
uniform float uTime;
uniform float uFlow;       // moving pulses
uniform float uHead;       // glowing head strength
void main() {
  float head = uProgress * uTotal;
  float fadeKm = max(vPx * 6.0, 1.0);
  float shown = 1.0 - smoothstep(head - fadeKm, head, vAlong);
  if (uProgress >= 0.999) shown = 1.0;
  float a = abs(vSide);
  float core = 1.0 - smoothstep(0.2, 1.0, a);
  float alpha = core * shown * uOpacity * vRankA;
  if (uDash > 0.0) {
    float d = fract(vAlong / (vPx * uDash));
    alpha *= smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.52, 0.6, d));
  }
  vec3 col = uColor * (1.0 + uGlow * (1.0 - smoothstep(0.0, 0.6, a)));
  if (uFlow > 0.0) {
    float f = fract((vAlong / vPx - uTime * 60.0) / 90.0);
    col *= 1.0 + uFlow * smoothstep(0.85, 1.0, f) * 2.0;
  }
  // glowing head while drawing
  float hd = exp(-pow((vAlong - head) / (vPx * 10.0), 2.0)) * step(uProgress, 0.999);
  col += uColor * hd * uHead * 4.0;
  alpha = max(alpha, hd * uHead * core * uOpacity);
  if (alpha < 0.003) discard;
  fragColor = vec4(col, alpha);
}
`;

export interface RibbonOptions {
  color?: string;
  width?: number;
  opacity?: number;
  dash?: number;
  glow?: number;
  flow?: number;
  arc?: number;
  lift?: number;
  head?: number;
}

/** Build ribbon geometry for one or several polylines (map km). */
function buildGeometry(lines: { pts: [number, number][]; rank?: number }[]) {
  let n = 0;
  for (const l of lines) n += l.pts.length * 2;
  const pos2 = new Float32Array(n * 2), tan2 = new Float32Array(n * 2);
  const side = new Float32Array(n), along = new Float32Array(n), rank = new Float32Array(n);
  const idx: number[] = [];
  let v = 0;
  let total = 0;
  for (const l of lines) {
    const pts = l.pts;
    let acc = 0;
    const start = v;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      for (const s of [-1, 1]) {
        pos2[v * 2] = pts[i][0];
        pos2[v * 2 + 1] = pts[i][1];
        tan2[v * 2] = tx;
        tan2[v * 2 + 1] = ty;
        side[v] = s;
        along[v] = acc;
        rank[v] = l.rank ?? 0;
        v++;
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = start + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    total = Math.max(total, acc);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('pos2', new THREE.BufferAttribute(pos2, 2));
  g.setAttribute('tan2', new THREE.BufferAttribute(tan2, 2));
  g.setAttribute('side', new THREE.BufferAttribute(side, 1));
  g.setAttribute('along', new THREE.BufferAttribute(along, 1));
  g.setAttribute('rank', new THREE.BufferAttribute(rank, 1));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setIndex(idx);
  return { g, total };
}

export class Ribbon {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  total: number;

  constructor(
    lines: { pts: [number, number][]; rank?: number }[],
    tu: TerrainUniforms,
    shared: Record<string, THREE.IUniform>,
    o: RibbonOptions = {},
  ) {
    const { g, total } = buildGeometry(lines);
    this.total = total;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...tu,
        ...shared,
        uColor: { value: new THREE.Color(o.color ?? '#e2b866').convertSRGBToLinear() },
        uWidth: { value: o.width ?? 3 },
        uOpacity: { value: o.opacity ?? 1 },
        uProgress: { value: 1 },
        uTotal: { value: total },
        uDash: { value: o.dash ?? 0 },
        uGlow: { value: o.glow ?? 1 },
        uFlow: { value: o.flow ?? 0 },
        uArc: { value: o.arc ?? 0 },
        uLift: { value: o.lift ?? 1.5 },
        uHead: { value: o.head ?? 1 },
        uRankFade: { value: 10 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  set progress(v: number) {
    this.material.uniforms.uProgress.value = v;
  }
  set opacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
    this.mesh.visible = v > 0.002;
  }
}

/** Catmull-Rom (centripetal) resampling of waypoints to roughly `stepKm` spacing */
export function smoothPath(pts: [number, number][], stepKm: number): [number, number][] {
  if (pts.length < 2) return pts;
  const out: [number, number][] = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(1, Math.ceil(seg / stepKm));
    const d = (a: number[], b: number[]) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-3, 0.5);
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let j = 0; j < n; j++) {
      const t = t1 + ((t2 - t1) * j) / n;
      const lerp = (a: number[], b: number[], ta: number, tb: number) => {
        const k = tb - ta < 1e-6 ? 0 : (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      };
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      const C = lerp(B1, B2, t1, t2);
      out.push([C[0], C[1]]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
