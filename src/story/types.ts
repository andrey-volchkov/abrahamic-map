// Data shapes for src/data/*.json. All years are astronomical-ish integers:
// negative = BCE (−586 → 586 г. до н. э.), positive = CE.

export type Cert = 'tradition' | 'scripture' | 'approx' | 'disputed' | 'faith';

export interface Religion {
  id: string;
  name: string;
  color: string;
  /** zone channel (0–7 solid, 8–11 hatched) */
  zone: number;
  note?: string;
}

export interface ViewJson {
  lon: number;
  lat: number;
  dist: number;
  pitch?: number;
  heading?: number;
}

export interface Act {
  id: number;
  roman: string;
  title: string;
  subtitle: string;
  range: string;
  from: number;
  to: number;
  view: ViewJson;
  /** the glowing "memory" of this act seen from later acts */
  hearth: { lon: number; lat: number; r: number };
}

export interface Chapter {
  id: string;
  act: number;
  title: string;
  dates: string;
  years: [number, number];
  text: string[];
  view: ViewJson;
  /** optional second view the camera drifts to while the chapter plays */
  view2?: ViewJson;
  events?: string[];
  routes?: string[];
  focus?: { lon: number; lat: number; r: number };
  /** seconds the chapter plays before advancing */
  dur?: number;
  /** hide the year counter (undated tradition) */
  noYear?: boolean;
}

export interface EventItem {
  id: string;
  act: number;
  year: number;
  date: string;
  title: string;
  place: string;
  lon: number;
  lat: number;
  rel: string;
  cert?: Cert[];
  text: string;
  rank?: number;
}

export interface Place {
  id: string;
  name: string;
  lon: number;
  lat: number;
  kind: 'city' | 'region' | 'sea' | 'polity';
  from?: number;
  to?: number;
  rank?: number;
  /** visible camera-distance window (km) */
  min?: number;
  max?: number;
  acts?: number[];
  angle?: number;
}

export interface Route {
  id: string;
  name: string;
  rel: string;
  kind: 'journey' | 'road' | 'sea' | 'flow' | 'forced';
  from: number;
  to: number;
  /** waypoints [lon, lat] */
  pts: [number, number][];
  dash?: boolean;
  arc?: number;
  width?: number;
  /** stays visible (dimmed) after its chapter */
  persist?: boolean;
  /** year after which the route disappears */
  until?: number;
  color?: string;
}

/** a place where a tradition takes root: phases of [year, religion id | null] */
export interface Hearth {
  n: string;
  lon: number;
  lat: number;
  r: number;
  ph: [number, string | null][];
  rule?: [number, string | null][];
  grow?: number;
  /** weight < 1 for minorities */
  w?: number;
}

export interface CounterPoint {
  year: number;
  value: string;
  source: string;
}
