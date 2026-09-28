// Turns the data files into what the stage draws for a given year:
// zone splats, route ribbons, markers and label candidates.
import * as THREE from 'three';
import { project } from '../geo/projection';
import type { Stage } from '../engine/stage';
import { Ribbon, smoothPath } from '../engine/routes';
import { Markers, type MarkerState } from '../engine/markers';
import type { Splat } from '../engine/influence';
import { dataUrl } from '../engine/assets';
import type { Act, Chapter, EventItem, Hearth, Place, Religion, Route } from './types';

import religionsJson from '../data/religions.json';
import actsJson from '../data/acts.json';
import chaptersJson from '../data/chapters.json';
import ev1 from '../data/events-act1.json';
import ev2 from '../data/events-act2.json';
import ev3 from '../data/events-act3.json';
import placesJson from '../data/places.json';
import routesJson from '../data/routes.json';
import spreadJson from '../data/spread.json';

export const religions = religionsJson as Religion[];
export const acts = actsJson as Act[];
export const chapters = chaptersJson as Chapter[];
export const events = [...ev1, ...ev2, ...ev3] as EventItem[];
export const places = placesJson as Place[];
const routesData = routesJson as unknown as Route[];
const hearthsData = (spreadJson as unknown as { hearths: Hearth[] }).hearths;

export const relById = new Map(religions.map((r) => [r.id, r]));
export const eventById = new Map(events.map((e) => [e.id, e]));

export function relColor(id: string): string {
  return relById.get(id)?.color ?? '#cbbfa8';
}

interface ZoneEntry {
  x: number;
  y: number;
  r: number;
  cat: number;
  from: number;
  to: number | null;
  grow: number;
  w: number;
  first: boolean;
}

export interface EventView extends EventItem {
  x: number;
  y: number;
}
export interface PlaceView extends Place {
  x: number;
  y: number;
}

interface RouteView {
  data: Route;
  ribbons: Ribbon[];
  color: string;
}

const CROSS = 24; // years for a colour change at one hearth

function expandHearths(): ZoneEntry[] {
  const out: ZoneEntry[] = [];
  const push = (h: Hearth, phases: [number, string | null][], x: number, y: number) => {
    for (let i = 0; i < phases.length; i++) {
      const [from, id] = phases[i];
      if (!id) continue;
      const rel = relById.get(id);
      if (!rel) continue;
      const next = phases[i + 1];
      out.push({
        x,
        y,
        r: h.r,
        cat: rel.zone,
        from,
        to: next ? next[0] : null,
        grow: h.grow ?? 40,
        w: h.w ?? 1,
        first: i === 0 || phases[i - 1][1] === null,
      });
    }
  };
  for (const h of hearthsData) {
    const [x, y] = project(h.lon, h.lat);
    push(h, h.ph, x, y);
    if (h.rule) push(h, h.rule, x, y);
  }
  return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export class World {
  zones = expandHearths();
  evs: EventView[] = events.map((e) => {
    const [x, y] = project(e.lon, e.lat);
    return { ...e, x, y };
  });
  plc: PlaceView[] = places.map((p) => {
    const [x, y] = project(p.lon, p.lat);
    return { ...p, x, y };
  });
  routes = new Map<string, RouteView>();
  markers: Markers;
  splats: Splat[] = [];
  private colorCache = new Map<string, THREE.Color>();

  constructor(public stage: Stage) {
    const zoneColors: string[] = new Array(12).fill('#ffffff');
    const zoneStyles: number[] = new Array(12).fill(0);
    for (const r of religions) {
      zoneColors[r.zone] = r.color;
      zoneStyles[r.zone] = r.zone >= 8 ? 1 : 0;
    }
    stage.influence.setColors(zoneColors, zoneStyles);
    stage.splats = this.splats;

    const shared = {
      uTime: stage.light.uTime,
      uPxK: { value: 0.001 },
    };
    this.pxK = shared.uPxK;
    for (const r of routesData) {
      const color = r.color ?? relColor(r.rel);
      const lines = (r as Route & { lines?: [number, number][][] }).lines ?? [r.pts];
      const ribbons: Ribbon[] = [];
      for (const ln of lines) {
        const proj = ln.map(([lon, lat]) => project(lon, lat));
        // split where a line crosses the map's cut meridian
        const parts: [number, number][][] = [[]];
        for (let i = 0; i < proj.length; i++) {
          if (i > 0 && Math.abs(proj[i][0] - proj[i - 1][0]) > 17000) parts.push([]);
          parts[parts.length - 1].push(proj[i]);
        }
        for (const part of parts) {
          if (part.length < 2) continue;
          const len = part.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - part[i - 1][0], p[1] - part[i - 1][1]) : 0), 0);
          const step = r.arc ? Math.max(20, len / 80) : Math.max(2, Math.min(40, len / 300));
          const pts = r.arc ? arcSample(part, step) : smoothPath(part, step);
          const rb = new Ribbon([{ pts }], stage.tu, shared, {
            color,
            width: r.width ?? (r.kind === 'road' ? 1.6 : r.arc ? 2.2 : 2.6),
            dash: r.dash ? 9 : r.kind === 'road' ? 0 : 0,
            glow: r.kind === 'road' ? 0.2 : 1.1,
            flow: r.kind === 'flow' || r.kind === 'forced' ? 0.6 : 0,
            arc: r.arc ? Math.min(r.arc, len * 0.18) : 0,
            opacity: 0,
            head: r.kind === 'road' ? 0 : 1,
          });
          rb.mesh.visible = false;
          stage.scene.add(rb.mesh);
          ribbons.push(rb);
        }
      }
      this.routes.set(r.id, { data: r, ribbons, color });
    }

    this.markers = new Markers(stage.tu, { uTime: stage.light.uTime, uViewport: this.viewport, uPxK: this.pxK });
    stage.scene.add(this.markers.mesh);
    this.loadRivers(shared);
  }

  rivers: Ribbon | null = null;
  private async loadRivers(shared: Record<string, THREE.IUniform>) {
    const res = await fetch(dataUrl('rivers.json'));
    const list = (await res.json()) as { n: string; r: number; p: number[] }[];
    const lines = list.map((l) => {
      const pts: [number, number][] = [];
      for (let i = 0; i < l.p.length; i += 2) pts.push([l.p[i], l.p[i + 1]]);
      return { pts, rank: Math.max(1, l.r) };
    });
    this.rivers = new Ribbon(lines, this.stage.tu, shared, {
      color: '#8fb4bb',
      width: 1.5,
      glow: 0,
      opacity: 0.7,
      head: 0,
      lift: 1.0,
    });
    this.rivers.mesh.renderOrder = 3;
    this.stage.scene.add(this.rivers.mesh);
  }

  pxK: { value: number };
  viewport = { value: new THREE.Vector2(1, 1) };

  color(hex: string) {
    let c = this.colorCache.get(hex);
    if (!c) {
      c = new THREE.Color(hex).convertSRGBToLinear();
      this.colorCache.set(hex, c);
    }
    return c;
  }

  /** zone splats for a year */
  updateZones(year: number, fade = 1) {
    const s = this.splats;
    s.length = 0;
    for (const z of this.zones) {
      if (year < z.from - CROSS) continue;
      let a: number, rr: number;
      if (z.first) {
        const t = Math.max(0, (year - z.from) / z.grow);
        const g = 1 - Math.pow(1 - Math.min(1, t), 3);
        a = Math.min(1, t * 4) * z.w;
        rr = z.r * (0.3 + 0.7 * g);
        if (year < z.from) continue;
      } else {
        // colour change: ramp in over the crossfade window at full size
        const t = (year - (z.from - CROSS / 2)) / CROSS;
        if (t <= 0) continue;
        a = Math.min(1, t * 2) * z.w;
        rr = z.r;
      }
      if (z.to !== null && year > z.to - CROSS / 2) {
        const t = (year - (z.to - CROSS / 2)) / CROSS;
        const f = Math.max(0, Math.min(1, 2 - t * 2));
        if (f <= 0) continue;
        a *= f;
        rr *= 0.75 + 0.25 * f;
      }
      s.push({ x: z.x, y: z.y, r: rr, a: a * fade, cat: z.cat });
    }
  }

  /** set every route's visibility/progress. `focus` routes are drawn at full strength */
  updateRoutes(year: number, focus: Set<string>, mode: 'film' | 'free', dimOthers: Set<string>) {
    for (const [id, rv] of this.routes) {
      const r = rv.data;
      const p = Math.max(0, Math.min(1, (year - r.from) / Math.max(0.001, r.to - r.from)));
      let op = 0;
      const alive = year >= r.from && year <= (r.until ?? 1e9);
      if (mode === 'film') {
        if (focus.has(id)) op = year >= r.from - 0.5 ? (year > r.to + 1.5 && r.to - r.from < 40 ? 0.5 : 1) : 0;
        else if (dimOthers.has(id) && alive) op = 0.38;
      } else if (alive) op = 0.8;
      if (r.kind === 'road') op *= 0.55;
      for (const rb of rv.ribbons) {
        const cur = rb.material.uniforms.uOpacity.value as number;
        rb.opacity = cur + (op - cur) * 0.12;
        rb.progress = p;
        rb.material.uniforms.uHead.value = focus.has(id) && p < 1 ? 1 : 0;
      }
    }
  }

  setMarkers(list: MarkerState[]) {
    this.markers.set(list);
  }
}

function arcSample(pts: [number, number][], step: number): [number, number][] {
  const a = pts[0], b = pts[pts.length - 1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(8, Math.ceil(len / step));
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

export { smooth };
