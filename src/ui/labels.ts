// Map labels as DOM elements, projected from the 3D scene each frame with greedy
// priority-based collision avoidance. A label is shown only when it fits inside the map
// frame entirely; point labels try the right, left, top and bottom of their point.
import * as THREE from 'three';
import { el, esc } from './dom';

export interface LabelItem {
  key: string;
  x: number; // map km
  y: number;
  h: number; // world height km
  text: string;
  sub?: string;
  cls: string;
  prio: number;
  anchor: 'right' | 'center';
  angle?: number;
  alpha?: number;
}

interface Slot {
  el: HTMLElement;
  w: number;
  h: number;
  sx: number;
  sy: number;
  shown: boolean;
  seen: number;
  html: string;
  /** preferred side index for point labels (kept while it works, to avoid flicker) */
  side: number;
}

type Box = [number, number, number, number];
const v = new THREE.Vector3();
const EDGE = 6; // px kept free along the frame

export class LabelLayer {
  root = el('div', 'labels map-box');
  private slots = new Map<string, Slot>();
  private frame = 0;

  constructor(parent: HTMLElement) {
    parent.appendChild(this.root);
  }

  update(items: LabelItem[], camera: THREE.Camera, w: number, h: number, block: Box[] = []) {
    this.frame++;
    const placed: Box[] = block.slice();
    const sorted = items.slice().sort((a, b) => b.prio - a.prio);
    const hits = (b: Box) => {
      if (b[0] < EDGE || b[1] < EDGE || b[2] > w - EDGE || b[3] > h - EDGE) return true;
      for (const p of placed) if (b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]) return true;
      return false;
    };
    for (const it of sorted) {
      let s = this.slots.get(it.key);
      const html = it.sub ? `${esc(it.text)}<span>${esc(it.sub)}</span>` : esc(it.text);
      if (!s) {
        const e = el('div', `lb ${it.cls}`);
        e.innerHTML = html;
        e.style.opacity = '0';
        this.root.appendChild(e);
        s = { el: e, w: 0, h: 0, sx: -1e4, sy: -1e4, shown: false, seen: 0, html, side: 0 };
        this.slots.set(it.key, s);
      } else if (s.html !== html) {
        s.el.innerHTML = html;
        s.html = html;
        s.w = 0;
      }
      if (!s.w) {
        s.w = s.el.offsetWidth;
        s.h = s.el.offsetHeight;
      }
      s.seen = this.frame;
      v.set(it.x, it.h, -it.y).project(camera);
      if (v.z > 1 || v.z < -1) {
        this.hide(s);
        continue;
      }
      const px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
      const pad = 4;
      let bx = 0, by = 0, ok = false;
      if (it.anchor === 'right') {
        // candidate positions around the point: right, left, above, below
        const cands: [number, number][] = [
          [px + 11, py - s.h / 2],
          [px - 11 - s.w, py - s.h / 2],
          [px - s.w / 2, py - 12 - s.h],
          [px - s.w / 2, py + 12],
        ];
        for (let k = 0; k < cands.length && !ok; k++) {
          const i = (s.side + k) % cands.length;
          const [cx, cy] = cands[i];
          const box: Box = [cx - pad, cy - pad / 2, cx + s.w + pad, cy + s.h + pad / 2];
          if (!hits(box)) {
            bx = cx;
            by = cy;
            ok = true;
            s.side = i;
            placed.push(box);
          }
        }
      } else {
        bx = px - s.w / 2;
        by = py - s.h / 2;
        let box: Box = [bx - pad, by - pad / 2, bx + s.w + pad, by + s.h + pad / 2];
        if (it.angle) {
          // bounding box of the rotated label (rotation about its centre)
          const a = (it.angle * Math.PI) / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
          const hw = (s.w * c + s.h * sn) / 2 + pad, hh = (s.w * sn + s.h * c) / 2 + pad / 2;
          box = [px - hw, py - hh, px + hw, py + hh];
        }
        if (!hits(box)) {
          ok = true;
          placed.push(box);
        }
      }
      if (!ok) {
        this.hide(s);
        continue;
      }
      if (Math.abs(bx - s.sx) > 0.3 || Math.abs(by - s.sy) > 0.3) {
        s.el.style.transform = `translate3d(${bx.toFixed(1)}px, ${by.toFixed(1)}px, 0)${it.angle ? ` rotate(${it.angle}deg)` : ''}`;
        s.sx = bx;
        s.sy = by;
      }
      const op = String(Math.round((it.alpha ?? 1) * 100) / 100);
      if (!s.shown || s.el.style.opacity !== op) {
        s.el.style.opacity = op;
        s.shown = true;
      }
    }
    for (const [k, s] of this.slots) {
      if (s.seen !== this.frame) {
        this.hide(s);
        if (this.frame - s.seen > 120) {
          s.el.remove();
          this.slots.delete(k);
        }
      }
    }
  }

  private hide(s: Slot) {
    if (s.shown) {
      s.el.style.opacity = '0';
      s.shown = false;
    }
  }
}
