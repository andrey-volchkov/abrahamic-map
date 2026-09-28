// Orchestrates the stage, the story state and the interface: film mode (chapters with
// camera flights) and free mode (timeline + free camera).
import * as THREE from 'three';
import { Stage } from './engine/stage';
import { loadLevel, loadMeta, type Level } from './engine/assets';
import { viewFromSpec, type View } from './engine/camera';
import { project } from './geo/projection';
import { World, acts, chapters, events, eventById, places, relById, relColor, religions } from './story/world';
import { MapControls } from './story/controls';
import type { MarkerState } from './engine/markers';
import { LabelLayer, type LabelItem } from './ui/labels';
import { About, ActTitle, Caption, Counter, FilmBar, Header, Intro, Legend, Panel, Timeline, YearDisplay } from './ui/components';
import { el, esc } from './ui/dom';
import { animCfg } from './ui/anim';
import { fmtYear } from './story/format';
import counterJson from './data/counter.json';
import type { Act, Chapter, EventItem } from './story/types';

type Mode = 'intro' | 'film' | 'free';

const byYear = events.slice().sort((a, b) => a.year - b.year);
const REDUCED = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const zoneToRel = new Map(religions.map((r) => [r.zone, r.id]));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

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
  private titleOn = false;
  controls: MapControls;

  header: Header;
  yearEl: YearDisplay;
  caption: Caption;
  actTitle: ActTitle;
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
    this.stage = new Stage(canvas);
    (window as unknown as { stage: Stage; app: App }).stage = this.stage;
    (window as unknown as { app: App }).app = this;

    this.labels = new LabelLayer(this.ui);
    this.caption = new Caption(this.ui);
    this.header = new Header(this.ui);
    this.yearEl = new YearDisplay(this.ui);
    this.counter = new Counter(this.ui, counterJson.label, counterJson.points, counterJson.note);
    this.legend = new Legend(this.ui);
    this.filmBar = new FilmBar(this.ui, chapters, acts);
    this.timeline = new Timeline(this.ui, acts, events);
    this.actTitle = new ActTitle(this.ui);
    this.panel = new Panel(this.ui);
    this.about = new About(this.ui);
    this.ui.append(this.tooltip);
    this.intro = new Intro(this.ui);

    this.filmBar.show(false);
    this.yearEl.root.style.opacity = '0';
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
      this.stage.rig.flyTo(viewFromSpec(a.view));
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
    s.rig.set({ ...viewFromSpec({ lon: 36.8, lat: 30.2, dist: 3600, pitch: 44, heading: -18 }) });
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
    this.header.setMode('film');
    this.controls.enabled = false;
    this.timeline.show(false);
    this.filmBar.show(true);
    this.yearEl.show(true);
    this.stage.tilt.focusArea = 0.5;
    this.stage.tilt.feather = 0.3;
    this.free.playing = false;
    if (fromIntro || prev === 'intro' || this.film.i < 0) this.go(0);
    else this.go(this.film.i);
  }

  enterFree() {
    this.mode = 'free';
    this.film.token++;
    this.titleOn = false;
    this.header.setMode('free');
    this.controls.enabled = true;
    this.filmBar.show(false);
    this.timeline.show(true);
    this.caption.hide(true);
    this.actTitle.hideNow();
    this.yearEl.show(true);
    this.stage.rig.cancelFlight();
    this.stage.rig.shift = 0;
    this.stage.tilt.focusArea = 0.78;
    this.stage.tilt.feather = 0.3;
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
    if (!actChange) {
      this.titleOn = false;
      this.actTitle.hideNow();
    }
    this.caption.hide(actChange);
    if (actChange) {
      this.titleOn = true;
      const title = this.actTitle.show(act, prev ? 2.6 : 2.2).then(() => {
        if (token === this.film.token) this.titleOn = false;
      });
      if (prev && prev.act < ch.act) {
        // the grand pull-back: the previous act shrinks into a glowing point
        this.tweenYear(ch.years[0], 7);
        await rig.flyTo(viewFromSpec(act.view), { duration: 7.5 });
      } else {
        this.tweenYear(ch.years[0], 4);
        await rig.flyTo(viewFromSpec(ch.view), { duration: prev ? 5 : 6.5 });
      }
      await title;
      if (token !== this.film.token) return;
    }
    const target = viewFromSpec(ch.view);
    const p = rig.flyTo(target, { speed: 1.05 });
    if (!actChange) this.tweenYear(ch.years[0], 1.6);
    await p;
    if (token !== this.film.token) return;
    const idx = chapters.filter((c) => c.act === ch.act).indexOf(ch) + 1;
    const n = chapters.filter((c) => c.act === ch.act).length;
    this.caption.show(ch, `Акт ${act.roman} · глава ${idx} из ${n}${(ch.events ?? []).length ? ' · <b>точки на карте открывают подробности</b>' : ''}`);
    this.film.phase = 'play';
    if (ch.view2) rig.flyTo(viewFromSpec(ch.view2), { duration: (ch.dur ?? 16) + 4 });
  }

  /** jump straight into a chapter state (for screenshots and deep links) */
  snapTo(i: number, frac = 0.7) {
    const ch = chapters[i];
    if (!ch) return;
    this.mode = 'film';
    this.header.setMode('film');
    this.controls.enabled = false;
    this.timeline.show(false);
    this.filmBar.show(true);
    this.yearEl.show(true);
    this.film.token++;
    this.film.i = i;
    this.film.phase = 'play';
    this.film.t = (ch.dur ?? 16) * frac;
    this.year = ch.years[0] + (ch.years[1] - ch.years[0]) * ease(Math.min(1, frac / 0.82));
    this.setPlaying(false);
    this.chapterEvents = new Set(ch.events ?? []);
    for (const id of ch.events ?? []) this.seenEvents.set(id, -10);
    this.stage.rig.set(viewFromSpec(ch.view));
    this.stage.rig.shift = window.innerWidth > 820 ? 0.13 : 0;
    const act = acts[ch.act - 1];
    this.header.setAct(act);
    const idx = chapters.filter((c) => c.act === ch.act).indexOf(ch) + 1;
    const n = chapters.filter((c) => c.act === ch.act).length;
    this.caption.show(ch, `Акт ${act.roman} · глава ${idx} из ${n}`);
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
    this.panel.show(e, same[k - 1] ?? null, same[k + 1] ?? null);
    if (this.mode === 'film') {
      if (!this.panel.open || !this.resumeAfterPanel) this.resumeAfterPanel = this.resumeAfterPanel || this.film.playing;
      this.setPlaying(false);
    }
    if (fly && this.mode === 'free') {
      const [x, y] = project(e.lon, e.lat);
      const v = this.stage.rig.view;
      this.stage.rig.flyTo({ ...v, x, y, dist: Math.min(v.dist, e.act === 3 ? 9000 : e.act === 2 ? 2800 : 1400) });
      if (Math.abs(this.year - e.year) > 5) this.setYear(e.year + 1);
    }
  }

  private hoverAt(x: number, y: number) {
    let best: string | null = null, bd = 16;
    for (const p of this.screenPts) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = p.id;
      }
    }
    this.hover = best;
    this.stage.canvas.style.cursor = best ? 'pointer' : this.mode === 'free' ? 'grab' : 'default';
    if (best) {
      const e = eventById.get(best) as EventItem;
      this.tooltip.innerHTML = `<small>${esc(e.date)}</small>${esc(e.title)}`;
      this.tooltip.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
      this.tooltip.classList.add('on');
      return;
    }
    const zone = this.mode === 'free' ? this.zoneAt(x, y) : null;
    if (zone) {
      this.tooltip.innerHTML = zone;
      this.tooltip.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
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
      parts.push(`<small>зона влияния</small>${esc(q.name)}${q.note ? `<br><span style="color:var(--ink-3);font-size:12px">${esc(q.note)}</span>` : ''}`);
    }
    if (hi >= 0) {
      const q = name(hi)!;
      parts.push(`<small>${bi >= 0 ? 'и одновременно' : 'зона'}</small>${esc(q.name)}${q.note ? `<br><span style="color:var(--ink-3);font-size:12px">${esc(q.note)}</span>` : ''}`);
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
    // caption keeps the subject clear of the text column
    const worldK = Math.min(1, Math.max(0, (rig.view.dist - 12000) / 20000));
    const wantShift = this.mode === 'film' && !this.titleOn && window.innerWidth > 820 ? 0.13 - 0.06 * worldK : 0;
    rig.shift += (wantShift - rig.shift) * Math.min(1, dt * 1.5);
    if (REDUCED) {
      rig.drift.heading = 0;
      rig.drift.dist = 0;
    } else if (this.mode === 'film') {
      const d = Math.sin(this.stage.time * 0.11) * 0.8 + Math.sin(this.stage.time * 0.047) * 0.5;
      rig.drift.heading = d * 0.9;
    } else if (this.mode === 'intro') {
      rig.drift.heading = Math.sin(this.stage.time * 0.05) * 9;
      rig.drift.dist = Math.sin(this.stage.time * 0.037) * 0.06;
    } else {
      rig.drift.heading *= 0.95;
      rig.drift.dist *= 0.95;
    }

    this.world.updateZones(this.year);
    const ch: Chapter | null = this.mode === 'film' && this.film.i >= 0 ? chapters[this.film.i] : null;
    const focusRoutes = new Set(ch?.routes ?? []);
    const dim = new Set<string>();
    if (ch) for (const c of chapters) if (c.act === ch.act && chapters.indexOf(c) < this.film.i) for (const r of c.routes ?? []) dim.add(r);
    this.world.updateRoutes(this.year, focusRoutes, this.mode === 'free' ? 'free' : 'film', dim);

    // focus spotlight
    const fu = this.stage.light.uFocus.value as THREE.Vector4;
    if (ch?.focus && this.film.phase !== 'fly') {
      const [fx, fy] = project(ch.focus.lon, ch.focus.lat);
      this.focusU.set(fx, fy, ch.focus.r, 0.55);
    } else this.focusU.w = 0;
    fu.x = this.focusU.w > 0 ? this.focusU.x : fu.x;
    fu.y = this.focusU.w > 0 ? this.focusU.y : fu.y;
    fu.z = this.focusU.w > 0 ? this.focusU.z : fu.z;
    fu.w += (this.focusU.w - fu.w) * Math.min(1, dt * 1.2);

    // hearths: earlier acts glow as the camera pulls away from them
    const hu = this.stage.light.uHearth.value as THREE.Vector4[];
    for (let k = 0; k < 2; k++) {
      const a = acts[k];
      const [hx, hy] = project(a.hearth.lon, a.hearth.lat);
      const past = this.mode === "film" ? act.id > a.id : this.year > a.to + 60;
      const ratio = rig.view.dist / a.hearth.r;
      const want = past ? Math.min(1, Math.max(0, (ratio - 4) / 12)) * (k === 0 ? 0.6 : 0.22) : 0;
      this.hearthA[k] += (want - this.hearthA[k]) * Math.min(1, dt * 0.8);
      hu[k].set(hx, hy, a.hearth.r, this.hearthA[k]);
    }

    this.yearEl.set(this.year);
    const hideYear = this.mode === 'film' && !!ch?.noYear;
    this.yearEl.root.style.visibility = hideYear ? 'hidden' : 'visible';
    this.timeline.set(this.year, act.id);
    this.header.setAct(act);
    this.counter.update(this.year, act.id === 3 || (this.mode === 'free' && this.year >= 1900));
    this.legend.set(this.activeReligions());

    const v = rig.view;
    // zones step back at close range, where the relief itself tells the story
    this.stage.zu.uZoneOn.value = 0.6 + 0.4 * Math.min(1, Math.max(0, (v.dist - 500) / 1300));
    this.stage.zu.uZoneFillK.value = 0.2 + 0.8 * Math.min(1, Math.max(0, (v.dist - 450) / 1400));
    const wk = Math.min(1, Math.max(0, (v.dist - 9000) / 25000));
    this.stage.zu.uZoneFill.value = 0.36 + 0.2 * wk;
    this.stage.zu.uZoneSat.value = 0.5 + 0.3 * wk;
    if (this.world.rivers) {
      const u = this.world.rivers.material.uniforms;
      u.uRankFade.value = v.dist < 1400 ? 8.5 : v.dist < 4000 ? 6.5 : v.dist < 12000 ? 4.5 : 2.5;
      u.uOpacity.value = v.dist < 20000 ? 0.75 : 0.45;
    }
    const tilt = (this.mode === 'film' ? 0.5 : 0.78) + 0.2 * Math.min(1, Math.max(0, (v.dist - 15000) / 25000));
    this.stage.tilt.focusArea += (tilt - this.stage.tilt.focusArea) * Math.min(1, dt * 2);
    void v;
  };

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
      let alpha = 0, size = 0, hi = 0, label = false;
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
          size = (e.rank ?? 3) === 1 ? 34 : 28;
          hi = Math.max(0, 1 - age / 3.5);
          label = true;
        } else {
          const chOf = chapters.findIndex((c) => (c.events ?? []).includes(e.id));
          if (chOf < 0 || chOf >= chIdx) continue;
          alpha = 0.55;
          size = 17;
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
        alpha = Math.max(0.45, 1 - Math.max(0, age) / span);
        size = (e.rank ?? 3) === 1 ? 28 : 22;
      }
      if (e.id === this.selected || e.id === this.hover) {
        hi = 1;
        alpha = 1;
        label = true;
      }
      const h = ht(e.x, e.y);
      markers.push({ x: e.x, y: e.y, size, alpha, color: this.world.color(relColor(e.rel)), kind: 1, hi });
      const sp = toScreen(e.x, e.y, h);
      if (sp.ok && alpha > 0.3) this.screenPts.push({ id: e.id, x: sp.x, y: sp.y });
      if (label) labels.push({ key: 'e:' + e.id, x: e.x, y: e.y, h, text: e.title, sub: e.date, cls: 'ev', prio: 100 + (e.id === this.selected ? 50 : 0) - (e.rank ?? 3), anchor: 'right' });
    }

    // ---- places
    const y = this.year;
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
        markers.push({ x: p.x, y: p.y, size: (p.rank ?? 3) === 1 ? 11 : 9, alpha: a, color: this.world.color('#efe6d2'), kind: 0, hi: 0 });
        labels.push({ key: 'p:' + p.id, x: p.x, y: p.y, h, text: p.name, cls: `city r${p.rank ?? 3}`, prio: 60 - (p.rank ?? 3) * 5, anchor: 'right', alpha: a });
      } else {
        const cls = p.kind;
        const prio = p.kind === 'sea' ? 30 : p.kind === 'polity' ? 40 : 20;
        labels.push({ key: 'p:' + p.id, x: p.x, y: p.y, h: 0, text: p.name, cls, prio, anchor: 'center', angle: p.angle, alpha: a });
      }
    }
    // earlier acts, seen from afar, keep a quiet name next to their glow
    for (let k = 0; k < 2; k++) {
      const a = acts[k];
      if (this.hearthA[k] < 0.15) continue;
      const [hx, hy] = project(a.hearth.lon, a.hearth.lat);
      labels.push({ key: 'h:' + k, x: hx, y: hy - a.hearth.r * 0.9, h: 0, text: `Акт ${a.roman} · ${a.title}`, cls: 'hearth', prio: 90, anchor: 'center', alpha: Math.min(1, this.hearthA[k] * 2.2) });
    }
    this.world.setMarkers(markers);
    // keep labels clear of the interface
    const block: [number, number, number, number][] = [];
    const rect = (e: Element | null) => {
      if (!e) return;
      const r = (e as HTMLElement).getBoundingClientRect();
      if (r.width && getComputedStyle(e).opacity !== '0') block.push([r.left - 8, r.top - 8, r.right + 8, r.bottom + 8]);
    };
    rect(this.yearEl.root);
    if (this.mode === 'film') rect(this.caption.root);
    rect(this.filmBar.root.style.display === 'none' ? null : this.filmBar.root);
    if (this.mode === 'free') rect(this.timeline.root);
    rect(this.legend.root);
    rect(this.counter.root.classList.contains('on') ? this.counter.root : null);
    rect(document.querySelector('.brand'));
    if (this.panel.open) block.push([this.panel.root.getBoundingClientRect().left - 12, 0, W, H]);
    rect(document.querySelector('.modes'));
    this.labels.root.style.opacity = this.mode === 'intro' || this.titleOn ? '0' : '1';
    this.labels.update(labels, cam, W, H, block);
  };
}

export type { View };
void places;
void fmtYear;
