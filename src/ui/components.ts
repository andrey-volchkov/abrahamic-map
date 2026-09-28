import { anim, animCfg, rise, stop } from './anim';
import { el, esc, ICON } from './dom';
import { CERT_HINT, CERT_LABEL, yearParts } from '../story/format';
import type { Act, Chapter, EventItem } from '../story/types';
import { relById, relColor } from '../story/world';

const wait = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000 * animCfg.scale));

// ---------------------------------------------------------------------------
// The page: a text column on the left, the framed map on the right, a control strip
// under the map. Every piece of text has its own fixed place in this grid.
export class Layout {
  col = el('aside', 'col');
  head = el('div', 'col-head');
  yearRow = el('div', 'col-year');
  body = el('div', 'col-body');
  legendRow = el('div', 'col-legend');
  frame = el('div', 'map-frame map-box');
  foot = el('div', 'map-foot');
  constructor(parent: HTMLElement) {
    this.col.append(this.head, this.yearRow, this.body, this.legendRow);
    parent.append(this.col, this.frame, this.foot);
  }
  setMode(m: 'intro' | 'film' | 'free') {
    document.body.dataset.mode = m;
  }
}

// ---------------------------------------------------------------------------
/** One text sheet at a time in the column body: the old one leaves before the new one enters. */
export class Sheets {
  private cur: HTMLElement | null = null;
  private seq = 0;
  constructor(public root: HTMLElement) {}
  add(sheet: HTMLElement) {
    sheet.classList.add('sheet');
    this.root.append(sheet);
  }
  get current() {
    return this.cur;
  }
  private leaving: Promise<void> = Promise.resolve();
  async show(sheet: HTMLElement | null, fill?: () => void) {
    const my = ++this.seq;
    const prev = this.cur;
    if (prev && prev.classList.contains('on')) {
      prev.classList.remove('on');
      this.leaving = wait(0.34);
    }
    // whatever is leaving must be gone before anything new appears
    await this.leaving;
    if (my !== this.seq) return;
    this.cur = sheet;
    if (!sheet) return;
    fill?.();
    sheet.scrollTop = 0;
    stop(...Array.from(sheet.children));
    sheet.classList.add('on');
    rise(Array.from(sheet.children), 8, 0.7, 0.06);
  }
}

// ---------------------------------------------------------------------------
export class Header {
  brand = el('div', 'brand', 'От колыбели к&nbsp;миру');
  actEl = el('div', 'act-line', '');
  modes = el('div', 'modes');
  onMode: (m: 'film' | 'free') => void = () => {};
  onAbout: () => void = () => {};
  private last = '';
  constructor(head: HTMLElement, foot: HTMLElement) {
    head.append(this.brand, this.actEl);
    const film = el('button', 'on', 'Фильм');
    const free = el('button', '', 'Свободный режим');
    const about = el('button', '', 'О проекте');
    film.onclick = () => this.onMode('film');
    free.onclick = () => this.onMode('free');
    about.onclick = () => this.onAbout();
    this.modes.append(film, free, about);
    foot.append(this.modes);
  }
  show(on: boolean) {
    this.modes.classList.toggle('off', !on);
  }
  setMode(m: 'film' | 'free') {
    const [film, free] = Array.from(this.modes.children) as HTMLElement[];
    film.classList.toggle('on', m === 'film');
    free.classList.toggle('on', m === 'free');
  }
  setAct(a: Act | null) {
    const t = a ? `Акт ${a.roman} · ${a.title}` : '';
    if (t === this.last) return;
    this.last = t;
    this.actEl.textContent = t;
    if (t) anim(this.actEl, [{ opacity: 0 }, { opacity: 1 }], 0.6);
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
    this.era.textContent = p.era || 'год';
  }
  show(on: boolean) {
    this.root.classList.toggle('off', !on);
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
    this.root.append(el('div', 'lbl', esc(label)), this.val, this.yr, this.src);
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
    anim(this.val, [{ opacity: 0 }, { opacity: 1 }], 0.8);
  }
}

// ---------------------------------------------------------------------------
export class Caption {
  root = el('div', 'caption');
  constructor(private sheets: Sheets) {
    sheets.add(this.root);
  }
  show(ch: Chapter, meta: string, hint: string) {
    return this.sheets.show(this.root, () => {
      this.root.innerHTML = '';
      this.root.append(el('div', 'kicker', esc(ch.dates)), el('h2', '', esc(ch.title)));
      for (const t of ch.text) this.root.append(el('p', '', esc(t)));
      this.root.append(el('div', 'meta', `${esc(meta)}${hint ? `<br><span>${esc(hint)}</span>` : ''}`));
    });
  }
}

// ---------------------------------------------------------------------------
export class ActTitle {
  root = el('div', 'act-sheet');
  constructor(private sheets: Sheets) {
    sheets.add(this.root);
  }
  show(a: Act, hold = 3.2): Promise<void> {
    this.sheets.show(this.root, () => {
      this.root.innerHTML = '';
      this.root.append(
        el('div', 'kick', `Акт ${a.roman}`),
        el('h1', '', esc(a.title)),
        el('div', 'rule'),
        el('div', 'sub', esc(a.subtitle)),
        el('div', 'range', esc(a.range)),
      );
    });
    return wait(0.35 + 1.2 + hold);
  }
}

// ---------------------------------------------------------------------------
export class FreeSheet {
  root = el('div', 'free-sheet');
  constructor(private sheets: Sheets) {
    sheets.add(this.root);
    this.root.innerHTML = `
      <div class="kicker">Свободный режим</div>
      <h2>Карта во времени</h2>
      <p>Передвиньте бегунок на шкале под картой или нажмите ▶, чтобы время пошло само. Зоны, пути и точки событий показываются для выбранного года.</p>
      <p class="how"><b>Мышь:</b> перетаскивание — сдвиг, колесо — масштаб, правая кнопка — поворот и наклон.<br><b>Сенсорный экран:</b> один палец — сдвиг, два — масштаб и поворот.</p>
      <p class="how">Точка на карте открывает описание события; подпись на шкале акта переносит к нему.</p>`;
  }
  show() {
    return this.sheets.show(this.root);
  }
}

// ---------------------------------------------------------------------------
export class Intro {
  root = el('div', 'intro-sheet');
  private bar = el('b');
  private status = el('div', 'status', 'Загрузка рельефа');
  private go: HTMLButtonElement;
  private alt: HTMLButtonElement;
  onStart: (mode: 'film' | 'free') => void = () => {};
  constructor(private sheets: Sheets) {
    const load = el('div', 'load');
    load.append(this.bar);
    this.go = el('button', 'go', 'Смотреть фильм');
    this.alt = el('button', 'alt', 'Исследовать карту');
    this.go.disabled = this.alt.disabled = true;
    this.go.onclick = () => this.onStart('film');
    this.alt.onclick = () => this.onStart('free');
    const actions = el('div', 'actions');
    actions.append(this.go, this.alt);
    const loadRow = el('div', 'load-row');
    loadRow.append(load, this.status);
    this.root.append(
      el('div', 'kicker', 'Интерактивная карта в трёх актах'),
      el('h1', '', 'От колыбели к&nbsp;миру'),
      el('div', 'rule'),
      el('p', 'sub', 'Как на узкой полосе земли между Средиземным морем и Месопотамией возникли иудаизм, христианство и ислам — и как христианство выросло в мировую религию.'),
      actions,
      loadRow,
      el('p', 'foot', 'Рельеф: AWS Terrain Tiles (SRTM, ETOPO1 и др.) · Контуры: Natural Earth · Проекция Equal Earth. Зоны влияния приблизительны и не являются границами.'),
    );
    sheets.add(this.root);
    sheets.show(this.root);
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
    if (this.sheets.current === this.root) this.sheets.show(null);
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
    prev.title = 'Предыдущая глава (←)';
    this.play = el('button', 'btn play', ICON.pause);
    this.play.setAttribute('aria-label', 'Пауза');
    this.play.title = 'Пауза / смотреть (пробел)';
    const next = el('button', 'btn', ICON.next);
    next.setAttribute('aria-label', 'Следующая глава');
    next.title = 'Следующая глава (→)';
    prev.onclick = () => this.onPrev();
    next.onclick = () => this.onNext();
    this.play.onclick = () => this.onToggle();
    btns.append(prev, this.play, next);
    const chs = el('div', 'chapters');
    for (const a of acts) {
      const g = el('div', 'act-group');
      const list = chapters.map((c, i) => [c, i] as const).filter(([c]) => c.act === a.id);
      g.style.flex = String(list.length);
      g.append(el('div', 'lbl', `${a.roman}&thinsp;·&thinsp;${esc(a.title)}`));
      const segs = el('div', 'segs');
      for (const [c, i] of list) {
        const s = el('button', 'seg');
        s.setAttribute('aria-label', c.title);
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
    this.root.append(btns, chs);
    parent.append(this.root);
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
  constructor(parent: HTMLElement, acts: Act[], events: EventItem[]) {
    this.playBtn = el('button', 'btn play', ICON.play);
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
      const l = el('button', 'lbl', `${a.roman}&thinsp;·&thinsp;${esc(a.title)}`);
      l.onclick = (e) => {
        e.stopPropagation();
        this.onAct(a);
      };
      l.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.append(l);
      this.track.append(b);
      this.bands.push(b);
    });
    this.track.append(el('div', 'axis'));
    for (const y of [-1000, -500, 1, 500, 1000, 1500, 1800, 2000]) {
      const lb = el('div', 'yr', y < 0 ? `${-y} до н.&nbsp;э.` : String(y));
      lb.style.left = `${yearToT(y) * 100}%`;
      this.track.append(lb);
    }
    for (const e of events) {
      const t = el('div', `tick${(e.rank ?? 3) === 1 ? ' big' : ''}`);
      t.style.left = `${yearToT(e.year) * 100}%`;
      t.style.background = relColor(e.rel);
      t.style.bottom = `${4 + ((e.rank ?? 3) === 1 ? 0 : (hash(e.id) % 3) * 6)}px`;
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
/** Event details: a sheet laid over the column text, so the map stays uncovered. */
export class Panel {
  root = el('div', 'panel');
  onClose = () => {};
  onNav: (id: string) => void = () => {};
  current: string | null = null;
  constructor(private body: HTMLElement) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Событие');
    body.append(this.root);
  }
  show(e: EventItem, prev: EventItem | null, next: EventItem | null) {
    this.current = e.id;
    const rel = relById.get(e.rel);
    this.root.innerHTML = '';
    const close = el('button', 'close', `${ICON.close}<span>Назад к главе</span>`);
    close.setAttribute('aria-label', 'Закрыть');
    close.onclick = () => this.onClose();
    const kick = el('div', 'kicker', `<i style="background:${relColor(e.rel)}"></i>${esc(rel?.name ?? 'Контекст')}`);
    const h = el('h3', '', esc(e.title));
    const meta = el('dl', 'meta');
    meta.innerHTML = `<dt>Дата</dt><dd>${esc(e.date)}</dd><dt>Место</dt><dd>${esc(e.place)}</dd>`;
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
      } else b.disabled = true;
      return b;
    };
    nav.append(mk(prev, 'Раньше'), mk(next, 'Позже'));
    this.root.append(close, kick, h, meta);
    if ((e.cert ?? []).length) this.root.append(badges);
    this.root.append(text, nav);
    this.root.scrollTop = 0;
    this.body.classList.add('panel-on');
    this.root.classList.add('on');
    rise(Array.from(this.root.children).slice(1), 8, 0.6, 0.05, 0.1);
  }
  hide() {
    this.current = null;
    this.root.classList.remove('on');
    this.body.classList.remove('panel-on');
  }
  get open() {
    return this.root.classList.contains('on');
  }
}

// ---------------------------------------------------------------------------
const SYMBOLS = `
  <div class="sym"><svg viewBox="0 0 22 22" width="22" height="22"><circle cx="11" cy="11" r="8.5" fill="#f4eedf"/><circle cx="11" cy="11" r="6" fill="#cc3a22" stroke="#2a2219" stroke-width="1.4"/></svg><span>событие — нажмите</span></div>
  <div class="sym"><svg viewBox="0 0 34 22" width="34" height="22"><path d="M2 11h20" stroke="#f4eedf" stroke-width="7"/><path d="M2 11h19" stroke="#cc3a22" stroke-width="4"/><path d="M19 4.5 31 11 19 17.5z" fill="#cc3a22" stroke="#f4eedf" stroke-width="1.2"/></svg><span>путь, поход, миссия</span></div>
  <div class="sym city"><svg viewBox="0 0 22 22" width="22" height="22"><circle cx="11" cy="11" r="4" fill="#f4eedf" stroke="#2a2219" stroke-width="1.5"/></svg><span>город</span></div>`;

export class Legend {
  root = el('div', 'legend');
  private list = el('div', 'items');
  private items = new Map<string, HTMLElement>();
  constructor(parent: HTMLElement) {
    this.root.append(el('div', 'title', 'Условные обозначения'), this.list, el('div', 'symbols', SYMBOLS));
    parent.append(this.root);
  }
  /** ids of traditions on the map; `muted` are drawn but are not the chapter's subject */
  set(ids: string[], muted: Set<string>) {
    const want = new Set(ids);
    for (const [id, it] of this.items) {
      if (!want.has(id)) {
        it.remove();
        this.items.delete(id);
      }
    }
    for (const id of ids) {
      let it = this.items.get(id);
      if (!it) {
        const r = relById.get(id);
        if (!r) continue;
        it = el('div', 'it');
        const sw = el('i', r.zone >= 8 ? 'hatch' : '');
        sw.style.setProperty('--c', relColor(id));
        it.append(sw, el('span', '', esc(r.name)));
        if (r.zone >= 8 && r.note) it.title = r.note;
        this.list.append(it);
        this.items.set(id, it);
        // no fill: the .muted class must keep control of the opacity afterwards
        it.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600 * animCfg.scale });
      }
      it.classList.toggle('muted', muted.has(id));
    }
    // keep a stable order (touch the DOM only when it changes)
    const order = ids.map((id) => this.items.get(id)).filter((x): x is HTMLElement => !!x);
    if (order.some((it, k) => this.list.children[k] !== it)) for (const it of order) this.list.append(it);
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
      <div class="kicker">О проекте</div>
      <h2>Как устроена эта карта</h2>
      <p>Визуализация показывает возникновение иудаизма, христианства и ислама и распространение христианства от одного региона до всего мира. Масштаб растёт вместе с религией: Акт I — Восточное Средиземноморье, Акт II — Европа, Акт III — весь мир.</p>
      <h4>Как читать зоны</h4>
      <p>Цветные области — не границы государств, а приблизительные зоны влияния, которые вырастают из «очагов»: городов и областей с датами появления общин. Традиции, о которых идёт речь в главе, показаны насыщенным цветом, остальные — приглушённым. Штриховкой показана политическая власть халифата там, где большинство населения ещё не было мусульманским. Даты и контуры зон упрощены.</p>
      <h4>Пометки достоверности</h4>
      <ul>
        <li><b>по преданию</b> — сведения религиозной традиции, исторически не подтверждённые или подтверждённые частично;</li>
        <li><b>по священному тексту</b> — событие описано в Библии или другом священном тексте, его масштаб обсуждается;</li>
        <li><b>дата приблизительна</b> и <b>датировка спорна</b> — точная дата неизвестна или историки называют разные;</li>
        <li><b>предмет веры</b> — утверждение, которое нельзя проверить методами истории.</li>
      </ul>
      <h4>Числа</h4>
      <p>Доля христиан в мире показывается только там, где есть опубликованные оценки: 1910 г. — около 35% (Pew Research Center, 2011, по Atlas of Global Christianity), 2010 г. — 30,6% и 2020 г. — 28,8% (Pew Research Center, 2025). Для более ранних эпох сопоставимых надёжных данных нет, поэтому цифры не приводятся.</p>
      <h4>Данные карты</h4>
      <ul>
        <li>Рельеф и глубины: AWS Terrain Tiles / Mapzen (SRTM, GMTED2010, ETOPO1 и др.), перепроецировано в Equal Earth.</li>
        <li>Береговая линия, озёра, реки, пустыни: Natural Earth (общественное достояние).</li>
        <li>Шрифты: Old Standard TT, PT Sans Narrow (SIL Open Font License).</li>
      </ul>
      <p>Исторические границы не показаны: открытого набора с подходящей лицензией и точностью нет, а выдумывать точные контуры мы не стали.</p>`;
    this.root.append(close, inner);
    parent.append(this.root);
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.root.classList.remove('on');
    });
  }
  show() {
    this.root.classList.add('on');
    (this.root.querySelector('.close') as HTMLElement).focus();
  }
}
