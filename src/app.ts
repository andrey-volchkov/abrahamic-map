// Orchestrates the stage, the story state and the interface: film mode (chapters with
// camera flights) and free mode (timeline + free camera).
import * as THREE from 'three';
import { Stage } from './engine/stage';
import { loadLevel, loadMeta, type Level } from './engine/assets';
import { fitView, viewFromSpec, type View } from './engine/camera';
import { project, projectRel } from './geo/projection';
import { World, acts, chapters, events, eventById, relById, relColor, religions } from './story/world';
import { MapControls } from './story/controls';
import type { MarkerState } from './engine/markers';
import { LabelLayer, type LabelItem } from './ui/labels';
import { About, ActTitle, Caption, Counter, FilmBar, FreeSheet, Header, Intro, Layout, Legend, Panel, Sheets, Timeline, YearDisplay } from './ui/components';
import { el, esc } from './ui/dom';
import { animCfg } from './ui/anim';
import { PAPER } from './ui/palette';
import counterJson from './data/counter.json';
import type { Act, Chapter, EventItem, ViewJson } from './story/types';

type Mode = 'intro' | 'film' | 'free';

const byYear = events.slice().sort((a, b) => a.year - b.year);
const REDUCED = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const zoneToRel = new Map(religions.map((r) => [r.zone, r.id]));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** screen margins (px) kept around a chapter's events when framing: left, top, right, bottom */
const FRAME_MARGIN: [number, number, number, number] = [56, 60, 56, 48];
/** chapter views at least this far away show the whole world */
const WORLD_DIST = 40000;
const WORLD_PTS: [number, number][] = [];
const RIPPLE_LIFE = 1.8;

export class App {
  stage: Stage;
  world!: World;
  ui = document.getElementById('ui') as HTMLElement;
  mode: Mode = 'intro';
  year = -1250;
  private yearTween: { from: number; to: number; t: number; dur: number } | null = null;
  film = { i: -1, playing: true, t: 0, phase: 'idle' as 'idle' | 'fly' | 'play' | 'hold', hold: 0, token: 0 };
  free = { playing: false };
  selected: string | null = null;
  hover: string | null = null;
  private wheelAcc = 0;
  private wheelCool = 0;
  private screenPts: { id: string; x: number; y: number }[] = [];
  private focusU = new THREE.Vector4(0, 0, 1, 0);
  private hearthA = [0, 0, 0];
  private chapterEvents = new Set<string>();
  private seenEvents = new Map<string, number>();
  private levelsReady = { L0: false, L1: false, L2: false, L3: false };
  private ripples: { x: number; y: number; c: THREE.Color; t0: number }[] = [];
  private lastZoneYear = NaN;
  private pointCache = new Map<string, [number, number][]>();
  private muted = new Map<string, THREE.Color>();
  controls: MapControls;

  layout: Layout;
  sheets: Sheets;
  header: Header;
  yearEl: YearDisplay;
  caption: Caption;
  actTitle: ActTitle;
  freeSheet: FreeSheet;
  filmBar: FilmBar;
  timeline: Timeline;
  panel: Panel;
  legend: Legend;
  counter: Counter;
  intro: Intro;
  about: About;
  labels: LabelLayer;
  tooltip = el('div', 'tooltip');

  constructor() {
    const canvas = document.getElementById('scene') as HTMLCanvasElement;
    this.layout = new Layout(this.ui);
    this.layout.setMode('intro');
    this.stage = new Stage(canvas);
    (window as unknown as { stage: Stage; app: App }).stage = this.stage;
    (window as unknown as { app: App }).app = this;

    const L = this.layout;
    this.labels = new LabelLayer(this.ui);
    this.yearEl = new YearDisplay(L.yearRow);
    this.counter = new Counter(L.yearRow, counterJson.label, counterJson.points, counterJson.note);
    this.sheets = new Sheets(L.body);
    this.intro = new Intro(this.sheets);
    this.actTitle = new ActTitle(this.sheets);
    this.caption = new Caption(this.sheets);
    this.freeSheet = new FreeSheet(this.sheets);
    this.panel = new Panel(L.body);
    this.legend = new Legend(L.legendRow);
    this.filmBar = new FilmBar(L.foot, chapters, acts);
    this.timeline = new Timeline(L.foot, acts, events);
    this.header = new Header(L.head, L.foot);
    this.about = new About(this.ui);
    this.ui.append(this.tooltip);

    this.filmBar.show(false);
    this.yearEl.show(false);
    this.header.show(false);

    this.header.onMode = (m) => (m === 'film' ? this.enterFilm() : this.enterFree());
    this.header.onAbout = () => this.about.show();
    this.filmBar.onNext = () => this.go(this.film.i + 1);
    this.filmBar.onPrev = () => this.go(this.film.i - 1);
    this.filmBar.onSeek = (i) => this.go(i);
    this.filmBar.onToggle = () => this.setPlaying(!this.film.playing);
    this.timeline.onScrub = (y) => {
      this.setYear(y);
      this.free.playing = false;
      this.timeline.setPlaying(false);
    };
    this.timeline.onToggle = () => {
      this.free.playing = !this.free.playing;
      if (this.free.playing && this.year >= 2024) this.setYear(-1250);
      this.timeline.setPlaying(this.free.playing);
    };
    this.timeline.onAct = (a) => {
      this.setYear(a.from + (a.id === 1 ? 0 : 1));
      this.stage.rig.flyTo(a.view.dist >= WORLD_DIST ? this.worldView(a.view) : viewFromSpec(a.view));
    };
    this.panel.onClose = () => this.select(null);
    this.panel.onNav = (id) => this.select(id, true);
    this.intro.onStart = (m) => {
      this.intro.hide();
      this.header.show(true);
      if (m === 'film') this.enterFilm(true);
      else this.enterFree();
    };

    this.controls = new MapControls(canvas, this.stage.rig);
    this.controls.onHover = (x, y) => this.hoverAt(x, y);
    this.controls.onTap = (x, y) => {
      this.hoverAt(x, y);
      if (this.hover) this.select(this.hover, this.mode === 'free');
      else if (this.panel.open) this.select(null);
    };
    this.controls.onWheelFilm = (dy) => {
      if (this.mode !== 'film') return;
      this.wheelAcc += dy;
      if (this.wheelCool > 0) return;
      if (Math.abs(this.wheelAcc) > 90) {
        this.go(this.film.i + (this.wheelAcc > 0 ? 1 : -1));
        this.wheelAcc = 0;
        this.wheelCool = 1.3;
      }
    };
    this.controls.onSwipe = (d) => {
      if (this.mode === 'film') this.go(this.film.i + d);
    };
    window.addEventListener('keydown', this.key);
    this.stage.onFrame(this.tick);
    this.stage.afterFrame(this.after);
  }

  async boot() {
    const s = this.stage;
    s.rig.set({ ...viewFromSpec({ lon: 36.8, lat: 31.4, dist: 3000, pitch: 40, heading: -12 }) });
    s.start();
    const meta = await loadMeta();
    this.intro.progress(0.08, 'Загрузка рельефа мира');
    const add = (slot: 0 | 1 | 2 | 3, L: Level) => {
      s.addLevel(slot, L);
      this.levelsReady[L.id as 'L0' | 'L1' | 'L2' | 'L3'] = true;
    };
    const l0 = loadLevel('L0', meta.levels.L0).then((L) => {
      add(0, L);
      this.intro.progress(0.5, 'Загрузка рельефа Ближнего Востока');
    });
    const l2 = loadLevel('L2', meta.levels.L2);
    const l3 = loadLevel('L3', meta.levels.L3);
    const l1 = loadLevel('L1', meta.levels.L1);
    await l0;
    add(2, await l2);
    add(3, await l3);
    this.world = new World(s);
    this.intro.progress(0.8, 'Загрузка рельефа Европы');
    this.intro.ready();
    (window as unknown as { __ready: boolean }).__ready = true;
    l1.then((L) => {
      add(1, L);
      this.intro.progress(1, 'Готово');
    });
    this.setYear(-1250);
  }

  // ------------------------------------------------------------------ modes
  enterFilm(fromIntro = false) {
    const prev = this.mode;
    this.mode = 'film';
    this.layout.setMode('film');
    this.header.setMode('film');
    this.controls.enabled = false;
    this.timeline.show(false);
    this.filmBar.show(true);
    this.yearEl.show(true);
    this.free.playing = false;
    if (fromIntro || prev === 'intro' || this.film.i < 0) this.go(0);
    else this.go(this.film.i);
  }

  enterFree() {
    this.mode = 'free';
    this.layout.setMode('free');
    this.film.token++;
    this.header.setMode('free');
    this.controls.enabled = true;
    this.filmBar.show(false);
    this.timeline.show(true);
    this.freeSheet.show();
    this.yearEl.show(true);
    this.stage.rig.cancelFlight();
    this.yearTween = null;
    if (this.film.i < 0) this.stage.rig.flyTo(viewFromSpec(acts[0].view));
  }

  setPlaying(p: boolean) {
    this.film.playing = p;
    this.filmBar.setPlaying(p);
  }

  setYear(y: number) {
    this.yearTween = null;
    this.year = Math.max(-1800, Math.min(2025, y));
  }

  private tweenYear(to: number, dur: number) {
    this.yearTween = { from: this.year, to, t: 0, dur: Math.max(0.01, dur * animCfg.scale) };
  }

  // ------------------------------------------------------------------ framing
  /** map points that must stay in the picture during a chapter */
  private chapterPoints(ch: Chapter): [number, number][] {
    let pts = this.pointCache.get(ch.id);
    if (pts) return pts;
    pts = [];
    for (const id of ch.events ?? []) {
      const e = eventById.get(id);
      if (e) pts.push(project(e.lon, e.lat));
    }
    for (const rid of ch.routes ?? []) {
      const rv = this.world.routes.get(rid);
      if (!rv || rv.data.kind === 'road') continue;
      for (const path of rv.paths) {
        const step = Math.max(1, Math.floor(path.pts.length / 24));
        for (let i = 0; i < path.pts.length; i += step) pts.push(path.pts[i]);
        pts.push(path.pts[path.pts.length - 1]);
      }
    }
    if (ch.focus) {
      const [fx, fy] = project(ch.focus.lon, ch.focus.lat);
      const r = ch.focus.r * 0.8;
      pts.push([fx - r, fy], [fx + r, fy], [fx, fy - r], [fx, fy + r]);
    }
    this.pointCache.set(ch.id, pts);
    return pts;
  }

  /** the chapter's view, pulled back or panned so all its events sit inside the map frame */
  private chapterView(ch: Chapter, second = false): View | null {
    const spec = second ? ch.view2 : ch.view;
    if (!spec) return null;
    if (spec.dist >= WORLD_DIST) return this.worldView(spec);
    const s = this.stage;
    return fitView(viewFromSpec(spec), this.chapterPoints(ch), s.width, s.height, s.rig.camera.fov, FRAME_MARGIN);
  }

  /** a whole-world view: the inhabited map (without Antarctica) fills the frame */
  private worldView(spec: ViewJson): View {
    const s = this.stage;
    const base = viewFromSpec(spec);
    if (!WORLD_PTS.length) {
      for (let lat = -56; lat <= 84; lat += 10) WORLD_PTS.push(projectRel(-180, lat), projectRel(180, lat));
      for (let l = -180; l <= 180; l += 20) WORLD_PTS.push(projectRel(l, 84), projectRel(l, -56));
    }
    // start from far away and let the solver bring the map in as close as it fits
    const far = fitView({ ...base, dist: base.dist * 2 }, WORLD_PTS, s.width, s.height, s.rig.camera.fov, [28, 28, 28, 28]);
    return fitView(far, WORLD_PTS, s.width, s.height, s.rig.camera.fov, [28, 28, 28, 28], true);
  }

  // ------------------------------------------------------------------ film
  async go(i: number) {
    if (i < 0 || i >= chapters.length) return;
    if (this.mode !== 'film') return;
    const token = ++this.film.token;
    const prev = this.film.i >= 0 ? chapters[this.film.i] : null;
    const ch = chapters[i];
    const act = acts[ch.act - 1];
    this.film.i = i;
    this.film.t = 0;
    this.film.phase = 'fly';
    this.resumeAfterPanel = false;
    this.select(null);
    this.header.setAct(act);
    this.chapterEvents = new Set(ch.events ?? []);
    const rig = this.stage.rig;
    const actChange = !prev || prev.act !== ch.act;
    if (actChange) {
      // the old text leaves, the act title takes the column while the camera travels
      const title = this.actTitle.show(act, prev ? 2.6 : 2.2);
      if (prev && prev.act < ch.act) {
        // the grand pull-back: the previous act shrinks into a ringed inset
        this.tweenYear(ch.years[0], 7);
        await rig.flyTo(act.view.dist >= WORLD_DIST ? this.worldView(act.view) : viewFromSpec(act.view), { duration: 7.5 });
      } else {
        this.tweenYear(ch.years[0], 4);
        await rig.flyTo(this.chapterView(ch) as View, { duration: prev ? 5 : 6.5 });
      }
      await title;
      if (token !== this.film.token) return;
    } else {
      this.sheets.show(null);
    }
    const p = rig.flyTo(this.chapterView(ch) as View, { speed: 1.05 });
    if (!actChange) this.tweenYear(ch.years[0], 1.6);
    await p;
    if (token !== this.film.token) return;
    this.showCaption(ch);
    this.film.phase = 'play';
    const v2 = this.chapterView(ch, true);
    if (v2) rig.flyTo(v2, { duration: (ch.dur ?? 16) + 4 });
  }

  private showCaption(ch: Chapter) {
    const act = acts[ch.act - 1];
    const list = chapters.filter((c) => c.act === ch.act);
    const meta = `Акт ${act.roman} · глава ${list.indexOf(ch) + 1} из ${list.length}`;
    this.caption.show(ch, meta, (ch.events ?? []).length ? 'Точки на карте открывают подробности' : '');
  }

  /** jump straight into a chapter state (for screenshots and deep links) */
  snapTo(i: number, frac = 0.7) {
    const ch = chapters[i];
    if (!ch) return;
    this.mode = 'film';
    this.layout.setMode('film');
    this.header.setMode('film');
    this.header.show(true);
    this.controls.enabled = false;
    this.timeline.show(false);
    this.filmBar.show(true);
    this.yearEl.show(true);
    this.film.token++;
    this.film.i = i;
    this.film.phase = 'play';
    this.film.t = (ch.dur ?? 16) * frac;
    this.year = ch.years[0] + (ch.years[1] - ch.years[0]) * ease(Math.min(1, frac / 0.82));
    this.lastZoneYear = NaN;
    this.setPlaying(false);
    this.chapterEvents = new Set(ch.events ?? []);
    for (const id of ch.events ?? []) this.seenEvents.set(id, -10);
    this.stage.rig.set(this.chapterView(ch) as View);
    this.header.setAct(acts[ch.act - 1]);
    this.showCaption(ch);
  }

  private filmTick(dt: number) {
    const f = this.film;
    if (f.i < 0) return;
    const ch = chapters[f.i];
    const dur = ch.dur ?? 16;
    if (f.phase === 'play') {
      if (f.playing && !this.panel.open) f.t += dt;
      const k = Math.min(1, f.t / (dur * 0.82));
      this.year = ch.years[0] + (ch.years[1] - ch.years[0]) * ease(k);
      if (f.t >= dur) {
        f.phase = 'hold';
        f.hold = 0;
      }
    } else if (f.phase === 'hold') {
      if (f.playing && !this.panel.open) f.hold += dt;
      if (f.hold > 1.2 && f.i < chapters.length - 1) this.go(f.i + 1);
    }
    this.filmBar.set(f.i, f.phase === 'play' ? Math.min(1, f.t / dur) : f.phase === 'hold' ? 1 : 0, ch.act);
  }

  // ------------------------------------------------------------------ selection
  private resumeAfterPanel = false;

  select(id: string | null, fly = false) {
    this.selected = id;
    if (!id) {
      if (this.panel.open && this.resumeAfterPanel && this.mode === 'film') this.setPlaying(true);
      this.resumeAfterPanel = false;
      this.panel.hide();
      return;
    }
    const e = eventById.get(id);
    if (!e) return;
    const same = byYear.filter((x) => x.act === e.act);
    const k = same.indexOf(e);
    if (this.mode === 'film') {
      if (!this.panel.open || !this.resumeAfterPanel) this.resumeAfterPanel = this.resumeAfterPanel || this.film.playing;
      this.setPlaying(false);
    }
    this.panel.show(e, same[k - 1] ?? null, same[k + 1] ?? null);
    if (fly && this.mode === 'free') {
      const [x, y] = project(e.lon, e.lat);
      const v = this.stage.rig.view;
      this.stage.rig.flyTo({ ...v, x, y, dist: Math.min(v.dist, e.act === 3 ? 9000 : e.act === 2 ? 2800 : 1400) });
      if (Math.abs(this.year - e.year) > 5) this.setYear(e.year + 1);
    }
  }

  private hoverAt(x: number, y: number) {
    const r = this.stage.canvas.getBoundingClientRect();
    const lx = x - r.left, ly = y - r.top;
    let best: string | null = null, bd = 16;
    for (const p of this.screenPts) {
      const d = Math.hypot(p.x - lx, p.y - ly);
      if (d < bd) {
        bd = d;
        best = p.id;
      }
    }
    this.hover = best;
    this.stage.canvas.style.cursor = best ? 'pointer' : this.mode === 'free' ? 'grab' : 'default';
    const place = () => {
      const w = this.tooltip.offsetWidth;
      const tx = x + 16 + w > window.innerWidth - 8 ? x - 16 - w : x + 16;
      this.tooltip.style.transform = `translate(${tx}px, ${y + 14}px)`;
    };
    if (best) {
      const e = eventById.get(best) as EventItem;
      this.tooltip.innerHTML = `<small>${esc(e.date)}</small>${esc(e.title)}`;
      place();
      this.tooltip.classList.add('on');
      return;
    }
    const zone = this.mode === 'free' ? this.zoneAt(x, y) : null;
    if (zone) {
      this.tooltip.innerHTML = zone;
      place();
      this.tooltip.classList.add('on');
    } else this.tooltip.classList.remove('on');
  }

  /** which tradition's zone lies under a screen point (same kernel as the GPU field) */
  private zoneAt(x: number, y: number): string | null {
    const r = this.stage.canvas.getBoundingClientRect();
    const p = this.stage.rig.pick(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    if (!p || this.stage.heights.sample(p[0], p[1]) <= 0) return null;
    const f = new Float32Array(12);
    for (const s of this.stage.splats) {
      const d2 = ((p[0] - s.x) ** 2 + (p[1] - s.y) ** 2) / (s.r * s.r);
      if (d2 < 9) f[s.cat] += s.a * Math.exp(-0.693 * d2);
    }
    let bi = -1, bv = 0.5, hi = -1, hv = 0.5;
    for (let i = 0; i < 8; i++) if (f[i] > bv) { bv = f[i]; bi = i; }
    for (let i = 8; i < 12; i++) if (f[i] > hv) { hv = f[i]; hi = i; }
    const name = (z: number) => religions.find((q) => q.zone === z);
    const parts: string[] = [];
    if (bi >= 0) {
      const q = name(bi)!;
      parts.push(`<small>зона влияния</small>${esc(q.name)}${q.note ? `<div class="note">${esc(q.note)}</div>` : ''}`);
    }
    if (hi >= 0) {
      const q = name(hi)!;
      parts.push(`<small>${bi >= 0 ? 'и одновременно' : 'зона'}</small>${esc(q.name)}${q.note ? `<div class="note">${esc(q.note)}</div>` : ''}`);
    }
    return parts.length ? parts.join('<div style="height:8px"></div>') : null;
  }

  private key = (e: KeyboardEvent) => {
    if (this.mode === 'intro') return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === ' ' || e.key === 'Enter') return;
    }
    if (e.key === 'Escape') {
      this.select(null);
      return;
    }
    if (this.mode === 'film') {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') this.go(this.film.i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.go(this.film.i - 1);
      else if (e.key === ' ') {
        e.preventDefault();
        this.setPlaying(!this.film.playing);
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      this.timeline.onToggle();
    }
  };

  // ------------------------------------------------------------------ per-frame
  private currentAct(): Act {
    if (this.mode === 'film' && this.film.i >= 0) return acts[chapters[this.film.i].act - 1];
    const y = this.year;
    return y < 400 ? acts[0] : y < 1492 ? (this.stage.rig.view.dist > 3600 || y > 751 ? acts[1] : acts[0]) : acts[2];
  }

  /** zone categories that are the subject of a chapter (from its events); null = all */
  private subjectZones(ch: Chapter | null): Set<number> | null {
    if (!ch) return null;
    const cats = new Set<number>();
    for (const id of ch.events ?? []) {
      const rel = eventById.get(id)?.rel ?? '';
      const r = relById.get(rel);
      if (r) cats.add(r.zone);
      // "Christianity" as a whole: every Christian tradition on the map is the subject
      if (rel === 'christianity') for (const q of religions) if (q.zone >= 1 && q.zone <= 6) cats.add(q.zone);
    }
    // Islam and the caliphate's rule are one story
    if (cats.has(7)) cats.add(8);
    if (cats.has(8)) cats.add(7);
    return cats.size ? cats : null;
  }

  private tick = (dt: number) => {
    if (!this.world) return;
    this.wheelCool = Math.max(0, this.wheelCool - dt);
    const yt = this.yearTween;
    if (yt) {
      yt.t = Math.min(1, yt.t + dt / yt.dur);
      this.year = yt.from + (yt.to - yt.from) * ease(yt.t);
      if (yt.t >= 1) this.yearTween = null;
    }
    if (this.mode === 'film') this.filmTick(dt);
    if (this.mode === 'free' && this.free.playing) {
      const rate = this.year < 750 ? 38 : this.year < 1500 ? 26 : 12;
      this.year = Math.min(2025, this.year + rate * dt);
      if (this.year >= 2025) {
        this.free.playing = false;
        this.timeline.setPlaying(false);
      }
    }
    const rig = this.stage.rig;
    const act = this.currentAct();
    if (REDUCED) {
      rig.drift.heading = 0;
      rig.drift.dist = 0;
    } else if (this.mode === 'film') {
      const d = Math.sin(this.stage.time * 0.11) * 0.8 + Math.sin(this.stage.time * 0.047) * 0.5;
      rig.drift.heading = d * 0.7;
    } else if (this.mode === 'intro') {
      rig.drift.heading = Math.sin(this.stage.time * 0.05) * 9;
      rig.drift.dist = Math.sin(this.stage.time * 0.037) * 0.06;
    } else {
      rig.drift.heading *= 0.95;
      rig.drift.dist *= 0.95;
    }

    this.world.updateZones(this.year);
    this.spawnRipples();
    const ch: Chapter | null = this.mode === 'film' && this.film.i >= 0 ? chapters[this.film.i] : null;
    const focusRoutes = new Set(ch?.routes ?? []);
    const dim = new Set<string>();
    if (ch) for (const c of chapters) if (c.act === ch.act && chapters.indexOf(c) < this.film.i) for (const r of c.routes ?? []) dim.add(r);
    this.world.updateRoutes(this.year, focusRoutes, this.mode === 'free' ? 'free' : 'film', dim);

    // focus: the rest of the map recedes towards the paper
    const fu = this.stage.light.uFocus.value as THREE.Vector4;
    if (ch?.focus && this.film.phase !== 'fly') {
      const [fx, fy] = project(ch.focus.lon, ch.focus.lat);
      this.focusU.set(fx, fy, ch.focus.r, 1);
    } else this.focusU.w = 0;
    fu.x = this.focusU.w > 0 ? this.focusU.x : fu.x;
    fu.y = this.focusU.w > 0 ? this.focusU.y : fu.y;
    fu.z = this.focusU.w > 0 ? this.focusU.z : fu.z;
    fu.w += (this.focusU.w - fu.w) * Math.min(1, dt * 1.2);

    // earlier acts are ringed like an inset as the camera pulls away from them
    const hu = this.stage.light.uHearth.value as THREE.Vector4[];
    for (let k = 0; k < 2; k++) {
      const a = acts[k];
      const [hx, hy] = project(a.hearth.lon, a.hearth.lat);
      const past = this.mode === 'film' ? act.id > a.id : this.year > a.to + 60;
      const ratio = rig.view.dist / a.hearth.r;
      const want = past ? Math.min(1, Math.max(0, (ratio - 4) / 10)) : 0;
      this.hearthA[k] += (want - this.hearthA[k]) * Math.min(1, dt * 0.8);
      hu[k].set(hx, hy, a.hearth.r, this.hearthA[k]);
    }

    this.yearEl.set(this.year);
    this.yearEl.show(this.mode !== 'intro' && !(this.mode === 'film' && !!ch?.noYear));
    this.timeline.set(this.year, act.id);
    if (this.mode !== 'intro') this.header.setAct(act);
    this.counter.update(this.year, act.id === 3 || (this.mode === 'free' && this.year >= 1900));

    // the chapter's subject is saturated, the rest steps back
    const subj = this.subjectZones(ch);
    const emph = this.stage.zu.uZoneEmph.value as number[];
    for (let i = 0; i < emph.length; i++) {
      const want = !subj || subj.has(i) ? 1 : 0;
      emph[i] += (want - emph[i]) * Math.min(1, dt * 2);
    }
    const onMap = this.activeReligions();
    this.legend.set(onMap, new Set(subj ? onMap.filter((id) => !subj.has(relById.get(id)!.zone)) : []));

    const v = rig.view;
    const zu = this.stage.zu;
    zu.uZoneOn.value = 1;
    // at close range the tint thins out so the relief itself tells the story
    zu.uZoneFillK.value = 0.6 + 0.4 * Math.min(1, Math.max(0, (v.dist - 450) / 1400));
    zu.uZoneFill.value = 0.4 + 0.1 * Math.min(1, Math.max(0, (v.dist - 9000) / 25000));
    if (this.world.rivers) {
      const u = this.world.rivers.material.uniforms;
      u.uRankFade.value = v.dist < 1400 ? 8.5 : v.dist < 4000 ? 6.5 : v.dist < 12000 ? 4.5 : 2.5;
      u.uOpacity.value = v.dist < 20000 ? 0.85 : 0.55;
    }
    this.stage.light.uGrat.value = v.dist < 1100 ? 1 : v.dist < 5500 ? 5 : v.dist < 16000 ? 10 : v.dist < 30000 ? 15 : 30;
  };

  /** a ring spreads from every community that appears while time runs forward */
  private spawnRipples() {
    const y0 = this.lastZoneYear, y1 = this.year;
    this.lastZoneYear = y1;
    if (this.mode === 'intro' || !Number.isFinite(y0) || !(y1 > y0) || y1 - y0 > 40 || REDUCED) return;
    for (const z of this.world.zones) {
      if (!z.first || z.from <= y0 || z.from > y1) continue;
      const rel = religions.find((r) => r.zone === z.cat);
      if (!rel) continue;
      this.ripples.push({ x: z.x, y: z.y, c: this.world.color(relColor(rel.id)), t0: this.stage.time });
    }
    if (this.ripples.length > 60) this.ripples.splice(0, this.ripples.length - 60);
  }

  private activeReligions(): string[] {
    const w = new Map<number, number>();
    const cam = this.stage.rig.camera;
    const p = new THREE.Vector3();
    for (const s of this.stage.splats) {
      if (s.a < 0.35) continue;
      p.set(s.x, 0, -s.y).project(cam);
      if (Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.95 || p.z > 1) continue;
      w.set(s.cat, Math.max(w.get(s.cat) ?? 0, s.a));
    }
    const ids: string[] = [];
    for (const r of religions) if ((w.get(r.zone) ?? 0) > 0.35) ids.push(r.id);
    return ids.filter((id) => zoneToRel.get(relById.get(id)!.zone) === id);
  }

  private mutedColor(hex: string) {
    let c = this.muted.get(hex);
    if (!c) {
      c = this.world.color(hex).clone().lerp(this.world.color(PAPER), 0.45);
      this.muted.set(hex, c);
    }
    return c;
  }

  private after = () => {
    if (!this.world) return;
    const s = this.stage, cam = s.rig.camera, v = s.rig.view;
    const W = s.width, H = s.height;
    // shared uniforms for screen-constant sizes
    this.world.pxK.value = (2 * Math.tan((cam.fov * Math.PI) / 360)) / H;
    this.world.viewport.value.set(W, H);
    const exag = s.tu.uExag.value * 0.001;
    const ht = (x: number, y: number) => Math.max(0, s.heights.sample(x, y)) * exag;
    const act = this.currentAct();

    // ---- markers
    const markers: MarkerState[] = [];
    const labels: LabelItem[] = [];
    this.screenPts = [];
    const proj = new THREE.Vector3();
    const toScreen = (x: number, y: number, h: number) => {
      proj.set(x, h, -y).project(cam);
      return { x: (proj.x * 0.5 + 0.5) * W, y: (-proj.y * 0.5 + 0.5) * H, ok: proj.z < 1 && proj.z > -1 };
    };
    const film = this.mode === 'film';
    const chIdx = this.film.i;
    for (const e of this.world.evs) {
      let alpha = 0, size = 0, hi = 0, label = false, kind = 1;
      let color = this.world.color(relColor(e.rel));
      if (film) {
        if (e.act !== act.id) continue;
        const inCh = this.chapterEvents.has(e.id);
        if (inCh) {
          if (this.film.phase === 'fly' && e.id !== this.selected) continue;
          if (this.year < e.year - 0.5 && e.id !== this.selected) continue;
          const first = this.seenEvents.get(e.id) ?? s.time;
          if (!this.seenEvents.has(e.id)) this.seenEvents.set(e.id, s.time);
          const age = s.time - first;
          alpha = Math.min(1, age * 1.5);
          size = 38;
          hi = Math.max(0, 1 - age / 3.5);
          label = true;
        } else {
          const chOf = chapters.findIndex((c) => (c.events ?? []).includes(e.id));
          if (chOf < 0 || chOf >= chIdx) continue;
          alpha = 0.75;
          size = 14;
          kind = 2;
          color = this.mutedColor(relColor(e.rel));
        }
      } else {
        const span = e.year < 750 ? 260 : e.year < 1500 ? 220 : 140;
        const age = this.year - e.year;
        if (age < 0 || age > span) {
          if (e.id !== this.selected) continue;
        }
        const minD = e.act === 3 ? 9000 : e.act === 2 ? 1800 : 300;
        const maxD = e.act === 3 ? 70000 : e.act === 2 ? 22000 : (e.rank ?? 3) === 1 ? 12000 : 7000;
        if (v.dist > maxD || v.dist < minD * 0.2) continue;
        alpha = Math.max(0.55, 1 - Math.max(0, age) / span);
        size = 36;
      }
      if (e.id === this.selected || e.id === this.hover) {
        hi = 1;
        alpha = 1;
        label = true;
        kind = 1;
        size = 38;
        color = this.world.color(relColor(e.rel));
      }
      const h = ht(e.x, e.y);
      markers.push({ x: e.x, y: e.y, size, alpha, color, kind, hi });
      const sp = toScreen(e.x, e.y, h);
      if (sp.ok && alpha > 0.3) this.screenPts.push({ id: e.id, x: sp.x, y: sp.y });
      if (label) labels.push({ key: 'e:' + e.id, x: e.x, y: e.y, h, text: e.title, sub: e.date, cls: 'ev', prio: 100 + (e.id === this.selected ? 50 : 0) - (e.rank ?? 3), anchor: 'right' });
    }

    // ---- ripples of newly founded communities
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      const age = (s.time - r.t0) / RIPPLE_LIFE;
      if (age >= 1) {
        this.ripples.splice(i, 1);
        continue;
      }
      const e = 1 - (1 - age) * (1 - age);
      markers.push({ x: r.x, y: r.y, size: 2 * (6 + 30 * e) + 4, alpha: 0.95, color: r.c, kind: 3, hi: age });
    }

    // ---- places
    const y = this.year;
    const ink = this.world.color('#2a2219');
    for (const p of this.world.plc) {
      if (p.from !== undefined && y < p.from) continue;
      if (p.to !== undefined && y > p.to) continue;
      const max = p.max ?? (p.kind === 'city' ? ((p.rank ?? 3) === 1 ? 6500 : (p.rank ?? 3) === 2 ? 3600 : 1700) : 9000);
      const min = p.min ?? 0;
      if (v.dist > max || v.dist < min) continue;
      const fadeFar = Math.min(1, (max - v.dist) / (max * 0.25));
      const fadeNear = min > 0 ? Math.min(1, (v.dist - min) / (min * 0.3)) : 1;
      const a = Math.max(0, Math.min(fadeFar, fadeNear));
      if (a <= 0.02) continue;
      if (p.kind === 'city') {
        const h = ht(p.x, p.y);
        markers.push({ x: p.x, y: p.y, size: 14, alpha: a, color: ink, kind: 0, hi: (p.rank ?? 3) === 1 ? 1 : 0 });
        labels.push({ key: 'p:' + p.id, x: p.x, y: p.y, h, text: p.name, cls: `city r${p.rank ?? 3}`, prio: 60 - (p.rank ?? 3) * 5, anchor: 'right', alpha: a });
      } else {
        const cls = p.kind;
        const prio = p.kind === 'sea' ? 30 : p.kind === 'polity' ? 40 : 20;
        labels.push({ key: 'p:' + p.id, x: p.x, y: p.y, h: 0, text: p.name, cls, prio, anchor: 'center', angle: p.angle, alpha: a });
      }
    }
    // earlier acts, seen from afar, keep a quiet name next to their ring
    for (let k = 0; k < 2; k++) {
      const a = acts[k];
      if (this.hearthA[k] < 0.15) continue;
      const [hx, hy] = project(a.hearth.lon, a.hearth.lat);
      labels.push({ key: 'h:' + k, x: hx, y: hy + a.hearth.r * 1.3, h: 0, text: `Акт ${a.roman} · ${a.title}`, cls: 'hearth', prio: 90, anchor: 'center', alpha: Math.min(1, this.hearthA[k] * 2) });
    }
    this.world.setMarkers(markers);
    this.labels.root.style.opacity = this.mode === 'intro' ? '0' : '1';
    this.labels.update(labels, cam, W, H);
  };
}

export type { View };
