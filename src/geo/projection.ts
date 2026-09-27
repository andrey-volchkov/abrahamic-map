// Equal Earth projection (Šavrič, Patterson & Jenny, 2018), central meridian 11°E,
// kilometres. Mirrors scripts/lib/projection.mjs used to build the map textures.
export const R = 6371;
export const CM = 11;
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const D2R = Math.PI / 180;

export function project(lon: number, lat: number): [number, number] {
  let l = lon - CM;
  l = ((((l + 180) % 360) + 360) % 360) - 180;
  return projectRel(l, lat);
}

export function projectRel(lrel: number, lat: number): [number, number] {
  const lam = lrel * D2R;
  const t = Math.asin(M * Math.sin(lat * D2R));
  const t2 = t * t, t6 = t2 * t2 * t2;
  const x = (lam * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return [x * R, y * R];
}

export function invert(xk: number, yk: number): [number, number] | null {
  const x = xk / R, y = yk / R;
  let t = y, t2 = t * t, t6 = t2 * t2 * t2;
  for (let i = 0; i < 12; i++) {
    const fy = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)) - y;
    const fpy = A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
    const d = fy / fpy;
    t -= d; t2 = t * t; t6 = t2 * t2 * t2;
    if (Math.abs(d) < 1e-12) break;
  }
  const s = Math.sin(t) / M;
  if (s > 1 || s < -1) return null;
  const lrel = (M * x * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))) / Math.cos(t) / D2R;
  if (lrel < -180 || lrel > 180) return null;
  let lon = lrel + CM;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return [lon, Math.asin(s) / D2R];
}

export const X_MAX = projectRel(180, 0)[0];
export const Y_MAX = projectRel(0, 90)[1];

/** Map outline (clockwise), used for the slab walls. */
export function outline(stepsPerSide = 180): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= stepsPerSide; i++) pts.push(projectRel(-180 + (360 * i) / stepsPerSide, 90)); // top W→E
  for (let i = 1; i <= stepsPerSide; i++) pts.push(projectRel(180, 90 - (180 * i) / stepsPerSide)); // east N→S
  for (let i = 1; i <= stepsPerSide; i++) pts.push(projectRel(180 - (360 * i) / stepsPerSide, -90)); // bottom E→W
  for (let i = 1; i < stepsPerSide; i++) pts.push(projectRel(-180, -90 + (180 * i) / stepsPerSide)); // west S→N
  return pts;
}
