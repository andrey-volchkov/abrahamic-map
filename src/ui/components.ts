import gsap from 'gsap';
import { el, esc, ICON } from './dom';
import { CERT_HINT, CERT_LABEL, yearParts } from '../story/format';
import type { Act, Chapter, EventItem } from '../story/types';
import { relById, relColor } from '../story/world';

// ---------------------------------------------------------------------------
export class Header {
  root = el('div');
  brand!: HTMLElement;
  actEl: HTMLElement;
  modes: HTMLElement;
  onMode: (m: 'film' | 'free') => void = () => {};
  onAbout: () => void = () => {};
  constructor(parent: HTMLElement) {
    const brand = el('div', 'brand');
    brand.append(el('div', 'name', 'От колыбели к миру'), el('div', 'rule'));
    this.actEl = el('div', 'caps act', '');
    brand.append(this.actEl);
    this.modes = el('div', 'modes caps');
    const film = el('button', 'on', 'Фильм');
    const free = el('button', '', 'Свободный режим');
    const about = el('button', '', 'О проекте');
    film.onclick = () => this.onMode('film');
    free.onclick = () => this.onMode('free');
    about.onclick = () => this.onAbout();
    this.modes.append(film, free, about);
    this.brand = brand;
    parent.append(el('div', 'scrim-top'), brand, this.modes);
  }
  show(on: boolean) {
    gsap.to([this.brand, this.modes], { opacity: on ? 1 : 0, duration: 0.8 });
  }
  setMode(m: 'film' | 'free') {
    const [film, free] = Array.from(this.modes.children) as HTMLElement[];
    film.classList.toggle('on', m === 'film');
    free.classList.toggle('on', m === 'free');
  }
  setAct(a: Act | null) {
    this.actEl.textContent = a ? `Акт ${a.roman} · ${a.title}` : '';
  }
}

// ---------------------------------------------------------------------------
export class YearDisplay {
  root = el('div', 'year');
  private num = el('div', 'num');
  private era = el('div', 'era');
  private last = '';
  constructor(parent: HTMLElement) {
    this.root.append(this.num, this.era);
    parent.append(this.root);
  }
  set(y: number) {
    const p = yearParts(y);
    const key = p.num + p.era;
    if (key === this.last) return;
    this.last = key;
    this.num.textContent = p.num;
    this.era.textContent = p.era;
  }
  show(on: boolean) {
    gsap.to(this.root, { opacity: on ? 1 : 0, duration: 0.6 });
  }
}

// ---------------------------------------------------------------------------
export class Caption {
  root = el('div', 'caption');
  scrim = el('div', 'scrim-left');
  constructor(parent: HTMLElement) {
    this.root.style.opacity = '0';
    parent.append(this.scrim, this.root);
  }
  show(ch: Chapter, extra: string) {
    this.root.innerHTML = '';
    const k = el('div', 'caps kicker', esc(ch.dates));
    const h = el('h2', '', esc(ch.title));
    this.root.append(k, h);
    for (const t of ch.text) this.root.append(el('p', '', esc(t)));
    if (extra) this.root.append(el('div', 'caps more', extra));
    this.scrim.classList.add('on');
    const kids = Array.from(this.root.children);
    gsap.killTweensOf([this.root, ...kids]);
    gsap.set(this.root, { opacity: 1 });
    gsap.fromTo(kids, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 1.1, stagger: 0.12, ease: 'power3.out' });
  }
  hide(scrim = true) {
    gsap.killTweensOf(this.root);
    gsap.to(this.root, { opacity: 0, duration: 0.45, ease: 'power2.in' });
    if (scrim) this.scrim.classList.remove('on');
  }
}

// ---------------------------------------------------------------------------
export class ActTitle {
  root = el('div', 'act-title');
  constructor(parent: HTMLElement) {
    parent.append(this.root);
  }
  show(a: Act, hold = 3.2): Promise<void> {
    this.root.innerHTML = '';
    const kick = el('div', 'caps kick', `Акт ${a.roman}`);
    const h = el('h1', '', esc(a.title));
    const sub = el('div', 'sub', esc(a.subtitle));
    const range = el('div', 'caps range', esc(a.range));
    const rule = el('div', 'rule');
    this.root.append(kick, h, sub, range, rule);
    return new Promise((resolve) => {
      const tl = gsap.timeline({ onComplete: () => resolve() });
      tl.set(this.root, { opacity: 1 });
      tl.fromTo(kick, { opacity: 0, letterSpacing: '1.1em' }, { opacity: 1, letterSpacing: '0.5em', duration: 1.6, ease: 'power3.out' }, 0);
      tl.fromTo(h, { opacity: 0, y: 24, filter: 'blur(8px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 1.6, ease: 'power3.out' }, 0.25);
      tl.fromTo([sub, range], { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 1.2, stagger: 0.15, ease: 'power2.out' }, 0.8);
      tl.fromTo(rule, { scaleY: 0, transformOrigin: 'top' }, { scaleY: 1, duration: 1.2, ease: 'power2.inOut' }, 1.2);
      tl.to(this.root, { opacity: 0, duration: 1.1, ease: 'power2.in' }, 1.2 + hold);
    });
  }
  hideNow() {
    gsap.killTweensOf(this.root);
    gsap.to(this.root, { opacity: 0, duration: 0.3 });
  }
}

// ---------------------------------------------------------------------------
export class FilmBar {
  root = el('div', 'film-bar');
  private play: HTMLButtonElement;
  private segs: HTMLElement[] = [];
  private groups: HTMLElement[] = [];
  private fill: HTMLElement[] = [];
  onPrev = () => {};
  onNext = () => {};
  onToggle = () => {};
  onSeek: (i: number) => void = () => {};
  constructor(parent: HTMLElement, chapters: Chapter[], acts: Act[]) {
    const btns = el('div', 'btns');
    const prev = el('button', 'btn', ICON.prev);
    prev.setAttribute('aria-label', 'Предыдущая глава');
    this.play = el('button', 'btn play', ICON.pause);
    this.play.setAttribute('aria-label', 'Пауза');
    const next = el('button', 'btn', ICON.next);
    next.setAttribute('aria-label', 'Следующая глава');
    prev.onclick = () => this.onPrev();
    next.onclick = () => this.onNext();
    this.play.onclick = () => this.onToggle();
    btns.append(prev, this.play, next);
    const chs = el('div', 'chapters');
    for (const a of acts) {
      const g = el('div', 'act-group');
      const list = chapters.map((c, i) => [c, i] as const).filter(([c]) => c.act === a.id);
      g.style.flex = String(list.length);
      g.append(el('div', 'caps lbl', `${a.roman} · ${esc(a.title)}`));
      const segs = el('div', 'segs');
      for (const [c, i] of list) {
        const s = el('div', 'seg');
        const bar = el('i');
        const b = el('b');
        bar.append(b);
        s.append(bar, el('span', 'tip', esc(c.title)));
        s.onclick = () => this.onSeek(i);
        segs.append(s);
        this.segs[i] = s;
        this.fill[i] = b;
      }
      g.append(segs);
      chs.append(g);
      this.groups[a.id] = g;
    }
    const hint = el('div', 'caps hint', 'Колесо или ← → — главы');
    this.root.append(btns, chs, hint);
    parent.append(el('div', 'scrim-bottom'), this.root);
  }
  set(i: number, progress: number, act: number) {
    this.segs.forEach((s, k) => {
      s.classList.toggle('done', k < i);
      s.classList.toggle('on', k === i);
    });
    this.fill.forEach((f, k) => (f.style.width = k === i ? `${Math.round(progress * 1000) / 10}%` : '0'));
    this.groups.forEach((g, k) => g && g.classList.toggle('on', k === act));
  }
  setPlaying(p: boolean) {
    this.play.innerHTML = p ? ICON.pause : ICON.play;
    this.play.setAttribute('aria-label', p ? 'Пауза' : 'Смотреть');
  }
  show(on: boolean) {
    this.root.style.display = on ? '' : 'none';
  }
}

// ---------------------------------------------------------------------------
// Piecewise-linear time scale for the free-mode timeline
const SCALE: [number, number][] = [
  [-1800, 0],
  [-1250, 0.06],
  [750, 0.5],
  [1500, 0.76],
  [2025, 1],
];
export function yearToT(y: number): number {
  for (let i = 1; i < SCALE.length; i++) {
    if (y <= SCALE[i][0] || i === SCALE.length - 1) {
      const [y0, t0] = SCALE[i - 1], [y1, t1] = SCALE[i];
      return Math.max(0, Math.min(1, t0 + ((y - y0) / (y1 - y0)) * (t1 - t0)));
    }
  }
  return 1;
}
export function tToYear(t: number): number {
  for (let i = 1; i < SCALE.length; i++) {
    if (t <= SCALE[i][1] || i === SCALE.length - 1) {
      const [y0, t0] = SCALE[i - 1], [y1, t1] = SCALE[i];
      return y0 + ((t - t0) / (t1 - t0)) * (y1 - y0);
    }
  }
  return 2025;
}

export class Timeline {
  root = el('div', 'timeline');
  private track = el('div', 'track');
  private handle = el('div', 'handle');
  private playBtn: HTMLButtonElement;
  private bands: HTMLElement[] = [];
  onScrub: (y: number) => void = () => {};
  onToggle = () => {};
  onAct: (a: Act) => void = () => {};
  onEvent: (id: string) => void = () => {};
  constructor(parent: HTMLElement, acts: Act[], events: EventItem[]) {
    this.playBtn = el('button', 'tplay', ICON.play);
    this.playBtn.setAttribute('aria-label', 'Запустить время');
    this.playBtn.onclick = () => this.onToggle();
    const bandStarts: [number, Act][] = [
      [-1250, acts[0]],
      [750, acts[1]],
      [1500, acts[2]],
    ];
    bandStarts.forEach(([y, a], i) => {
      const b = el('div', 'band');
      const t0 = yearToT(y), t1 = i < 2 ? yearToT(bandStarts[i + 1][0]) : 1;
      b.style.left = `${t0 * 100}%`;
      b.style.width = `${(t1 - t0) * 100}%`;
      const l = el('button', 'caps lbl', `${a.roman} · ${esc(a.title)}`);
      l.onclick = (e) => {
        e.stopPropagation();
        this.onAct(a);
      };
      b.append(l);
      this.track.append(b);
      this.bands.push(b);
    });
    this.track.append(el('div', 'axis'));
    for (const y of [-1000, -500, 1, 500, 1000, 1500, 1800, 2000]) {
      const lb = el('div', 'yr', y < 0 ? `${-y} до н. э.` : String(y));
      lb.style.left = `${yearToT(y) * 100}%`;
      this.track.append(lb);
    }
    for (const e of events) {
      const t = el('div', `tick${(e.rank ?? 3) === 1 ? ' big' : ''}`);
      t.style.left = `${yearToT(e.year) * 100}%`;
      t.style.background = relColor(e.rel);
      t.style.bottom = `${5 + ((e.rank ?? 3) === 1 ? 0 : (hash(e.id) % 3) * 6)}px`;
      t.title = e.title;
      this.track.append(t);
    }
    this.track.append(this.handle);
    let drag = false;
    const at = (ev: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      this.onScrub(tToYear(t));
    };
    this.track.addEventListener('pointerdown', (ev) => {
      drag = true;
      this.track.setPointerCapture(ev.pointerId);
      at(ev);
    });
    this.track.addEventListener('pointermove', (ev) => drag && at(ev));
    this.track.addEventListener('pointerup', () => (drag = false));
    this.root.append(this.playBtn, this.track);
    parent.append(this.root);
  }
  set(y: number, actId: number) {
    this.handle.style.left = `${yearToT(y) * 100}%`;
    this.bands.forEach((b, i) => b.classList.toggle('on', i + 1 === actId));
  }
  setPlaying(p: boolean) {
    this.playBtn.innerHTML = p ? ICON.pause : ICON.play;
  }
  show(on: boolean) {
    this.root.classList.toggle('on', on);
  }
}
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
export class Panel {
  root = el('div', 'panel');
  onClose = () => {};
  onNav: (id: string) => void = () => {};
  current: string | null = null;
  constructor(parent: HTMLElement) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Событие');
    parent.append(this.root);
  }
  show(e: EventItem, prev: EventItem | null, next: EventItem | null) {
    this.current = e.id;
    const rel = relById.get(e.rel);
    this.root.innerHTML = '';
    const close = el('button', 'close', ICON.close);
    close.setAttribute('aria-label', 'Закрыть');
    close.onclick = () => this.onClose();
    const kick = el('div', 'caps kicker', `<i style="background:${relColor(e.rel)}"></i>${esc(rel?.name ?? 'Контекст')}`);
    const h = el('h3', '', esc(e.title));
    const meta = el('dl', 'meta');
    meta.innerHTML = `<dt class="caps">Дата</dt><dd>${esc(e.date)}</dd><dt class="caps">Место</dt><dd>${esc(e.place)}</dd>`;
    const badges = el('div', 'badges');
    for (const c of e.cert ?? []) {
      const b = el('span', 'badge', esc(CERT_LABEL[c]));
      b.title = CERT_HINT[c];
      badges.append(b);
    }
    const text = el('div', 'text', esc(e.text));
    const nav = el('div', 'nav');
    const mk = (x: EventItem | null, lbl: string) => {
      const b = el('button');
      if (x) {
        b.innerHTML = `<small>${lbl}</small>${esc(x.title)}`;
        b.onclick = () => this.onNav(x.id);
      }
      return b;
    };
    nav.append(mk(prev, 'Раньше'), mk(next, 'Позже'));
    this.root.append(close, kick, h, meta);
    if ((e.cert ?? []).length) this.root.append(badges);
    this.root.append(text, nav);
    this.root.classList.add('on');
    gsap.fromTo(Array.from(this.root.children).slice(1), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.05, ease: 'power2.out', delay: 0.15 });
  }
  hide() {
    this.current = null;
    this.root.classList.remove('on');
  }
  get open() {
    return this.root.classList.contains('on');
  }
}

// ---------------------------------------------------------------------------
export class Legend {
  root = el('div', 'legend');
  private items = new Map<string, HTMLElement>();
  constructor(parent: HTMLElement) {
    parent.append(this.root);
  }
  set(ids: string[]) {
    const want = new Set(ids);
    for (const [id, it] of this.items) {
      if (!want.has(id)) {
        it.remove();
        this.items.delete(id);
      }
    }
    for (const id of ids) {
      if (this.items.has(id)) continue;
      const r = relById.get(id);
      if (!r) continue;
      const it = el('div', 'it');
      const sw = el('i', r.zone >= 8 ? 'hatch' : '');
      sw.style.background = r.color;
      sw.style.color = r.color;
      it.append(el('span', '', esc(r.name)), sw);
      this.root.append(it);
      this.items.set(id, it);
    }
    // keep a stable order
    for (const id of ids) {
      const it = this.items.get(id);
      if (it) this.root.append(it);
    }
  }
}

// ---------------------------------------------------------------------------
export class Counter {
  root = el('div', 'counter');
  private val = el('div', 'val');
  private yr = el('div', 'yr');
  private src = el('div', 'src');
  private key = '';
  constructor(parent: HTMLElement, label: string, private points: { year: number; value: string; source: string }[], note: string) {
    this.root.append(el('div', 'caps lbl', esc(label)), this.val, this.yr, this.src);
    this.root.title = note;
    parent.append(this.root);
  }
  update(year: number, visible: boolean) {
    let p: { year: number; value: string; source: string } | null = null;
    for (const q of this.points) if (year >= q.year) p = q;
    const on = visible && !!p;
    this.root.classList.toggle('on', on);
    if (!p) return;
    const key = String(p.year);
    if (key === this.key) return;
    this.key = key;
    this.val.textContent = p.value;
    this.yr.textContent = `оценка на ${p.year} г.`;
    this.src.textContent = p.source;
    gsap.fromTo(this.val, { opacity: 0 }, { opacity: 1, duration: 0.8 });
  }
}

// ---------------------------------------------------------------------------
export class Intro {
  root = el('div', 'intro');
  private bar = el('b');
  private status = el('div', 'caps status', 'Загрузка рельефа');
  private go: HTMLButtonElement;
  private alt: HTMLButtonElement;
  onStart: (mode: 'film' | 'free') => void = () => {};
  constructor(parent: HTMLElement) {
    const load = el('div', 'load');
    load.append(this.bar);
    this.go = el('button', 'go caps', 'Смотреть фильм');
    this.alt = el('button', 'alt caps', 'Исследовать карту');
    this.go.disabled = this.alt.disabled = true;
    this.go.onclick = () => this.onStart('film');
    this.alt.onclick = () => this.onStart('free');
    const actions = el('div', 'actions');
    actions.append(this.go, this.alt);
    this.root.append(
      el('div', 'caps kick', 'Интерактивная карта в трёх актах'),
      el('h1', '', 'От колыбели<br>к миру'),
      el('div', 'sub', 'Как на узкой полосе земли между Средиземным морем и Месопотамией возникли иудаизм, христианство и ислам — и как христианство выросло в мировую религию'),
      actions,
      load,
      this.status,
      el('div', 'foot', 'Рельеф: AWS Terrain Tiles (SRTM, ETOPO1 и др.) · Контуры: Natural Earth · Проекция Equal Earth. Зоны влияния приблизительны и не являются границами.'),
    );
    parent.append(this.root);
  }
  progress(p: number, text: string) {
    this.bar.style.width = `${Math.round(p * 100)}%`;
    this.status.textContent = text;
  }
  ready() {
    this.go.disabled = this.alt.disabled = false;
    this.status.textContent = 'Готово';
    this.go.focus();
  }
  hide() {
    this.root.classList.add('gone');
  }
}

// ---------------------------------------------------------------------------
export class About {
  root = el('div', 'about');
  constructor(parent: HTMLElement) {
    const close = el('button', 'close', ICON.close);
    close.setAttribute('aria-label', 'Закрыть');
    close.onclick = () => this.root.classList.remove('on');
    const inner = el('div', 'inner');
    inner.innerHTML = `
      <div class="caps" style="color:var(--gold);margin-bottom:18px">О проекте</div>
      <h2>Как устроена эта карта</h2>
      <p>Визуализация показывает возникновение иудаизма, христианства и ислама и распространение христианства от одного региона до всего мира. Масштаб растёт вместе с религией: Акт I — Восточное Средиземноморье, Акт II — Европа, Акт III — весь мир.</p>
      <h4 class="caps">Как читать зоны</h4>
      <p>Цветные области — не границы государств, а приблизительные зоны влияния, которые вырастают из «очагов»: городов и областей с датами появления общин. Штриховкой показана политическая власть халифата там, где большинство населения ещё не было мусульманским. Даты и контуры зон упрощены.</p>
      <h4 class="caps">Пометки достоверности</h4>
      <ul>
        <li><b>по преданию</b> — сведения религиозной традиции, исторически не подтверждённые или подтверждённые частично;</li>
        <li><b>по священному тексту</b> — событие описано в Библии или другом священном тексте, его масштаб обсуждается;</li>
        <li><b>дата приблизительна</b> и <b>датировка спорна</b> — точная дата неизвестна или историки называют разные;</li>
        <li><b>предмет веры</b> — утверждение, которое нельзя проверить методами истории.</li>
      </ul>
      <h4 class="caps">Числа</h4>
      <p>Доля христиан в мире показывается только там, где есть опубликованные оценки: 1910 г. — около 35% (Pew Research Center, 2011, по Atlas of Global Christianity), 2010 г. — 30,6% и 2020 г. — 28,8% (Pew Research Center, 2025). Для более ранних эпох сопоставимых надёжных данных нет, поэтому цифры не приводятся.</p>
      <h4 class="caps">Данные карты</h4>
      <ul>
        <li>Рельеф и глубины: AWS Terrain Tiles / Mapzen (SRTM, GMTED2010, ETOPO1 и др.), перепроецировано в Equal Earth.</li>
        <li>Береговая линия, озёра, реки, пустыни: Natural Earth (общественное достояние).</li>
        <li>Шрифты: Cormorant Garamond, Source Serif 4, IBM Plex Sans (SIL Open Font License).</li>
      </ul>
      <p>Исторические границы не показаны: открытого набора с подходящей лицензией и точностью нет, а выдумывать точные контуры мы не стали.</p>`;
    this.root.append(close, inner);
    parent.append(this.root);
  }
  show() {
    this.root.classList.add('on');
  }
}
