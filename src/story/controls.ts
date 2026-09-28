// Free-mode camera controls: drag to pan, wheel/pinch to zoom around the cursor,
// right-drag (or two fingers) to rotate and tilt.
import type { CameraRig } from '../engine/camera';
import { X_MAX, Y_MAX } from '../geo/projection';

export class MapControls {
  enabled = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private mode: 'pan' | 'rotate' | null = null;
  private anchor: [number, number] | null = null;
  private moved = 0;
  private last = { x: 0, y: 0 };
  private pinch = { d: 0, a: 0 };
  onTap: (x: number, y: number) => void = () => {};
  onHover: (x: number, y: number) => void = () => {};
  onWheelFilm: (dy: number) => void = () => {};
  onSwipe: (dir: 1 | -1) => void = () => {};
  private start = { x: 0, y: 0 };
  onInteract = () => {};

  constructor(private el: HTMLElement, private rig: CameraRig) {
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    el.addEventListener('wheel', this.wheel, { passive: false });
  }

  private ndc(x: number, y: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1];
  }

  private clampView() {
    const v = this.rig.view;
    v.x = Math.max(-X_MAX, Math.min(X_MAX, v.x));
    v.y = Math.max(-Y_MAX, Math.min(Y_MAX, v.y));
    v.dist = Math.max(220, Math.min(62000, v.dist));
    v.pitch = Math.max(0, Math.min(64, v.pitch));
  }

  private down = (e: PointerEvent) => {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = 0;
    this.last = { x: e.clientX, y: e.clientY };
    this.start = { x: e.clientX, y: e.clientY };
    if (!this.enabled) return;
    this.rig.cancelFlight();
    this.onInteract();
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
      this.mode = null;
      return;
    }
    this.mode = e.button === 2 || e.ctrlKey || e.shiftKey ? 'rotate' : 'pan';
    this.anchor = this.rig.pick(...this.ndc(e.clientX, e.clientY));
  };

  private move = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      this.onHover(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.last = { x: e.clientX, y: e.clientY };
    p.x = e.clientX;
    p.y = e.clientY;
    if (!this.enabled) return;
    const v = this.rig.view;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (this.pinch.d > 0) v.dist *= this.pinch.d / d;
      v.heading -= ((ang - this.pinch.a) * 180) / Math.PI;
      this.pinch = { d, a: ang };
      this.clampView();
      this.rig.apply();
      return;
    }
    if (this.mode === 'rotate') {
      v.heading += dx * 0.25;
      v.pitch += dy * 0.18;
      this.clampView();
      this.rig.apply();
    } else if (this.mode === 'pan' && this.anchor) {
      const cur = this.rig.pick(...this.ndc(e.clientX, e.clientY));
      if (cur) {
        v.x += this.anchor[0] - cur[0];
        v.y += this.anchor[1] - cur[1];
        this.clampView();
        this.rig.apply();
      }
    }
  };

  private up = (e: PointerEvent) => {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (had && this.moved < 6 && this.pointers.size === 0) this.onTap(e.clientX, e.clientY);
    else if (had && !this.enabled && this.pointers.size === 0) {
      // film mode: a swipe turns the page
      const dx = e.clientX - this.start.x, dy = e.clientY - this.start.y;
      const d = Math.abs(dx) > Math.abs(dy) ? -dx : -dy;
      if (Math.abs(d) > 60) this.onSwipe(d > 0 ? 1 : -1);
    }
    if (this.pointers.size === 0) this.mode = null;
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.enabled) {
      this.onWheelFilm(e.deltaY);
      return;
    }
    this.rig.cancelFlight();
    this.onInteract();
    const n = this.ndc(e.clientX, e.clientY);
    const before = this.rig.pick(...n);
    const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    this.rig.view.dist *= Math.exp(Math.max(-0.5, Math.min(0.5, dy * 0.0014)));
    this.clampView();
    this.rig.apply();
    const after = this.rig.pick(...n);
    if (before && after) {
      this.rig.view.x += before[0] - after[0];
      this.rig.view.y += before[1] - after[1];
      this.clampView();
      this.rig.apply();
    }
  };
}
