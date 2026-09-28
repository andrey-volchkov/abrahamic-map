// Camera rig: the view is described by a map target, distance, pitch and heading.
// Flights use van Wijk & Nuij's optimal zoom-and-pan path (as in d3.interpolateZoom),
// so long moves pull back first and settle in.
import * as THREE from 'three';
import { project } from '../geo/projection';

export interface View {
  x: number;
  y: number;
  dist: number;
  pitch: number; // degrees from straight down
  heading: number; // degrees, 0 = north up
}

export interface ViewSpec {
  lon: number;
  lat: number;
  dist: number;
  pitch?: number;
  heading?: number;
}

export function viewFromSpec(s: ViewSpec): View {
  const [x, y] = project(s.lon, s.lat);
  return { x, y, dist: s.dist, pitch: s.pitch ?? 38, heading: s.heading ?? 0 };
}

const D2R = Math.PI / 180;
const REDUCED_MOTION = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const RHO = 1.35;

function zoomPath(c0: [number, number], w0: number, c1: [number, number], w1: number) {
  const ux0 = c0[0], uy0 = c0[1], ux1 = c1[0], uy1 = c1[1];
  const dx = ux1 - ux0, dy = uy1 - uy0;
  const d2 = dx * dx + dy * dy;
  const rho2 = RHO * RHO, rho4 = rho2 * rho2;
  if (d2 < 1e-6) {
    const S = Math.log(w1 / w0) / RHO;
    return {
      S: Math.abs(S),
      at: (t: number) => ({ x: ux0, y: uy0, w: w0 * Math.exp(RHO * t * S) }),
    };
  }
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;
  const cosh = Math.cosh, sinh = Math.sinh, tanh = Math.tanh;
  return {
    S,
    at: (t: number) => {
      const s = t * S;
      const coshr0 = cosh(r0);
      const u = (w0 / (rho2 * d1)) * (coshr0 * tanh(RHO * s + r0) - sinh(r0));
      return { x: ux0 + u * dx, y: uy0 + u * dy, w: (w0 * coshr0) / cosh(RHO * s + r0) };
    },
  };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

interface Flight {
  from: View;
  to: View;
  path: ReturnType<typeof zoomPath>;
  t: number;
  dur: number;
  resolve: () => void;
}

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  view: View = { x: 0, y: 0, dist: 30000, pitch: 30, heading: 0 };
  /** additive drift applied on top of the view (film mode "breathing") */
  drift = { heading: 0, dist: 0, pitch: 0 };
  private flight: Flight | null = null;
  target = new THREE.Vector3();
  /** horizontal screen shift of the subject, as a fraction of the view width (+ = right) */
  shift = 0;

  constructor(fov = 30) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 1, 1e6);
  }

  get flying() {
    return !!this.flight;
  }

  set(v: View) {
    this.flight?.resolve();
    this.flight = null;
    this.view = { ...v };
    this.apply();
  }

  flyTo(to: View, opts: { duration?: number; speed?: number } = {}): Promise<void> {
    this.flight?.resolve();
    const from = { ...this.view };
    // shortest heading turn
    let dh = to.heading - from.heading;
    while (dh > 180) dh -= 360;
    while (dh < -180) dh += 360;
    const target = { ...to, heading: from.heading + dh };
    const path = zoomPath([from.x, from.y], from.dist, [to.x, to.y], to.dist);
    let dur = opts.duration ?? Math.min(7, Math.max(1.6, path.S * (opts.speed ?? 1.25)));
    if (REDUCED_MOTION) dur = Math.min(dur, 0.8);
    return new Promise((resolve) => {
      this.flight = { from, to: target, path, t: 0, dur, resolve };
    });
  }

  cancelFlight() {
    this.flight?.resolve();
    this.flight = null;
  }

  update(dt: number) {
    const f = this.flight;
    if (f) {
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = ease(f.t);
      const p = f.path.at(e);
      const es = easeSine(f.t);
      this.view = {
        x: p.x,
        y: p.y,
        dist: p.w,
        pitch: f.from.pitch + (f.to.pitch - f.from.pitch) * es,
        heading: f.from.heading + (f.to.heading - f.from.heading) * es,
      };
      if (f.t >= 1) {
        this.view = { ...f.to };
        this.flight = null;
        f.resolve();
      }
    }
    this.apply();
  }

  apply() {
    const v = this.view;
    // portrait screens see less of the map horizontally: pull back to compensate
    const aspectK = Math.max(1, Math.pow(1.5 / Math.max(0.3, this.camera.aspect), 0.75));
    const dist = v.dist * (1 + this.drift.dist) * aspectK;
    const p = Math.max(0.01, Math.min(80, v.pitch + this.drift.pitch)) * D2R;
    const h = (v.heading + this.drift.heading) * D2R;
    this.target.set(v.x, 0, -v.y);
    if (this.shift) {
      const w = 2 * dist * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect;
      this.target.x -= Math.cos(h) * this.shift * w;
      this.target.z -= Math.sin(h) * this.shift * w;
    }
    const dir = new THREE.Vector3(-Math.sin(p) * Math.sin(h), Math.cos(p), Math.sin(p) * Math.cos(h));
    this.camera.position.copy(this.target).addScaledVector(dir, dist);
    this.camera.up.set(Math.sin(h), 0, -Math.cos(h));
    this.camera.lookAt(this.target);
    this.camera.near = Math.max(0.5, dist * 0.03);
    this.camera.far = dist * 12 + 60000;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** point on the map plane (y=0) under a screen position, in map km */
  pick(ndcX: number, ndcY: number): [number, number] | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const t = -ray.ray.origin.y / ray.ray.direction.y;
    if (!(t > 0)) return null;
    const p = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
    return [p.x, -p.z];
  }
}
