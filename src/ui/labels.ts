// Map labels as DOM elements, projected from the 3D scene each frame with greedy
// priority-based collision avoidance.
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
}

const v = new THREE.Vector3();

export class LabelLayer {
  root = el('div', 'labels');
  private slots = new Map<string, Slot>();
  private frame = 0;

  constructor(parent: HTMLElement) {
    parent.appendChild(this.root);
  }

  update(items: LabelItem[], camera: THREE.Camera, w: number, h: number, block: [number, number, number, number][] = []) {
    this.frame++;
    const placed: [number, number, number, number][] = block.slice();
    const sorted = items.slice().sort((a, b) => b.prio - a.prio);
    for (const it of sorted) {
      let s = this.slots.get(it.key);
      const html = it.sub ? `${esc(it.text)}<span>${esc(it.sub)}</span>` : esc(it.text);
      if (!s) {
        const e = el('div', `lb ${it.cls}`);
        e.innerHTML = html;
        e.style.opacity = '0';
        this.root.appendChild(e);
        s = { el: e, w: 0, h: 0, sx: -1e4, sy: -1e4, shown: false, seen: 0, html };
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
      let bx: number, by: number;
      if (it.anchor === 'right') {
        bx = px + 9;
        by = py - s.h / 2;
      } else {
        bx = px - s.w / 2;
        by = py - s.h / 2;
      }
      const pad = 6;
      let box: [number, number, number, number] = [bx - pad, by - pad / 2, bx + s.w + pad, by + s.h + pad / 2];
      if (it.angle) {
        // bounding box of the rotated label (rotation about its centre)
        const a = (it.angle * Math.PI) / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
        const hw = (s.w * c + s.h * sn) / 2 + pad, hh = (s.w * sn + s.h * c) / 2 + pad / 2;
        const cx = bx + s.w / 2, cy = by + s.h / 2;
        box = [cx - hw, cy - hh, cx + hw, cy + hh];
      }
      if (box[2] < 0 || box[0] > w || box[3] < 0 || box[1] > h) {
        this.hide(s);
        continue;
      }
      let hit = false;
      {
        for (const b of placed) {
          if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        this.hide(s);
        continue;
      }
      placed.push(box);
      if (Math.abs(bx - s.sx) > 0.3 || Math.abs(by - s.sy) > 0.3) {
        s.el.style.transform = `translate3d(${bx.toFixed(1)}px, ${by.toFixed(1)}px, 0)${it.angle ? ` rotate(${it.angle}deg)` : ''}`;
        s.sx = bx;
        s.sy = by;
      }
      const a = it.alpha ?? 1;
      const op = String(Math.round(a * 100) / 100);
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
