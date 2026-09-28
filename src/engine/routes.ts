// Ribbons draped on the relief (or arcing above it): routes, roads, rivers.
// Width is constant in screen pixels. Routes are drawn like atlas campaign lines: an ink
// line with a paper casing, an arrowhead at the drawing front and small arrows along the
// way that slowly travel in the direction of movement.
import * as THREE from 'three';
import { PROJ_GLSL, TERRAIN_GLSL, type TerrainUniforms } from './glsl';
import { PAPER } from '../ui/palette';

const VERT = /* glsl */ `
${PROJ_GLSL}
${TERRAIN_GLSL}
in vec2 pos2;
in vec2 tan2;
in float side;
in float along;
in float rank;
uniform float uWidth;      // ink line width, px
uniform float uCase;       // paper casing each side, px
uniform float uArrow;      // arrowhead half-width, px (0 = none)
uniform float uLift;       // px above the surface
uniform float uArc;        // arc height km (0 = draped)
uniform float uTotal;
uniform float uPxK;        // 2*tan(fov/2)/viewportHeight
uniform float uRankFade;   // for rivers: max rank shown
out float vSide;
out float vAlong;
out float vPx;             // km per pixel here
out float vRankA;
out float vHalf;           // half-width of the ribbon geometry, px
out float vLine;           // half-width of the ink line, px
void main() {
  float t = uTotal > 0.0 ? along / uTotal : 0.0;
  vec2 p = pos2;
  vec4 mv0 = viewMatrix * vec4(p.x, 0.0, -p.y, 1.0);
  float px = uPxK * max(-mv0.z, 1.0);
  float y = uArc > 0.0 ? uArc * 4.0 * t * (1.0 - t) + 1.0 : max(surfaceY(p, px * 2.0), 0.0) + uLift * px;
  vec3 base = vec3(p.x, y, -p.y);
  vec3 tw = normalize(vec3(tan2.x, 0.0, -tan2.y));
  vec3 nrm;
  if (uArc > 0.0) {
    vec3 vd = normalize(cameraPosition - base);
    vec3 ta = normalize(tw * uTotal + vec3(0.0, uArc * 4.0 * (1.0 - 2.0 * t), 0.0));
    nrm = normalize(cross(ta, vd));
  } else {
    nrm = vec3(-tw.z, 0.0, tw.x);
  }
  float line = 0.5 * uWidth * (rank > 0.0 ? clamp(1.6 - rank * 0.18, 0.5, 1.4) : 1.0);
  float half_ = max(line, uArrow) + uCase + 1.0;
  vec3 w = base + nrm * side * half_ * px;
  vSide = side;
  vAlong = along;
  vPx = px;
  vHalf = half_;
  vLine = line;
  vRankA = rank > 0.0 ? 1.0 - smoothstep(uRankFade - 0.5, uRankFade + 0.5, rank) : 1.0;
  // pull towards the camera so valleys (where the mesh interpolates above the true
  // surface) never swallow the line
  vec4 mv = viewMatrix * vec4(w, 1.0);
  mv.xyz *= 0.993;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in float vSide;
in float vAlong;
in float vPx;
in float vRankA;
in float vHalf;
in float vLine;
out vec4 fragColor;
uniform vec3 uColor;
uniform vec3 uCaseColor;
uniform float uCase;
uniform float uOpacity;
uniform float uProgress;   // 0..1 of total
uniform float uTotal;
uniform float uDash;       // dash period in px (0 = solid)
uniform float uTime;
uniform float uArrow;      // arrowhead half-width px
uniform float uChev;       // spacing of travelling arrows px (0 = none)

// signed distance (px) to an arrowhead whose tip is at dh = 0 and base at dh = len
float arrowSD(float o, float dh, float half_, float len) {
  float s = half_ / len;
  return max(max((o - s * dh) / sqrt(1.0 + s * s), dh - len), -dh);
}

void main() {
  float o = abs(vSide) * vHalf;               // px from the centre line
  float headKm = uProgress * uTotal;
  float dh = (headKm - vAlong) / vPx;         // px behind the drawing front
  float along = vAlong / vPx;
  float aLen = uArrow * 1.7;
  // line body, ending inside the arrowhead
  float sd = max(o - vLine, -(dh - (uArrow > 0.0 ? aLen * 0.55 : 0.0)));
  if (uDash > 0.0) {
    float u = fract(along / uDash) * uDash;
    sd = max(sd, abs(u - uDash * 0.3) - uDash * 0.3);
  }
  if (uArrow > 0.0) {
    sd = min(sd, arrowSD(o, dh, uArrow, aLen));
    if (uChev > 0.0) {
      // small arrows travelling along the drawn part
      float cl = uArrow * 1.25;
      float u = mod(along - uTime * 22.0, uChev);
      float dc = cl - u;
      float ok = step(aLen * 1.8, dh) * step(cl * 2.0, along);
      sd = min(sd, mix(1e3, arrowSD(o, dc, uArrow * 0.78, cl), ok));
    }
  }
  float ink = 1.0 - smoothstep(-0.6, 0.6, sd);
  float cas = uCase > 0.0 ? 1.0 - smoothstep(uCase - 0.6, uCase + 0.6, sd) : 0.0;
  float alpha = max(ink, cas * 0.9) * uOpacity * vRankA;
  if (alpha < 0.004) discard;
  fragColor = vec4(mix(uCaseColor, uColor, ink), alpha);
}
`;

export interface RibbonOptions {
  color?: string;
  width?: number;
  opacity?: number;
  dash?: number;
  arc?: number;
  lift?: number;
  arrow?: number;
  chev?: number;
  casing?: number;
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
        uColor: { value: new THREE.Color(o.color ?? '#cc3a22').convertSRGBToLinear() },
        uCaseColor: { value: new THREE.Color(PAPER).convertSRGBToLinear() },
        uWidth: { value: o.width ?? 3 },
        uCase: { value: o.casing ?? 0 },
        uArrow: { value: o.arrow ?? 0 },
        uChev: { value: o.chev ?? 0 },
        uOpacity: { value: o.opacity ?? 1 },
        uProgress: { value: 1 },
        uTotal: { value: total },
        uDash: { value: o.dash ?? 0 },
        uArc: { value: o.arc ?? 0 },
        uLift: { value: o.lift ?? 1.5 },
        uRankFade: { value: 10 },
      },
      transparent: true,
      depthWrite: false,
      // drawn over the relief: coarse far-away terrain would otherwise swallow the lines
      depthTest: false,
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
