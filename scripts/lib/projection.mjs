// Equal Earth projection (Šavrič, Patterson, Jenny 2018), central meridian 11°E.
// Output in kilometres. Mirrors src/geo/projection.ts.
export const R = 6371;
export const CM = 11;
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const D2R = Math.PI / 180;

export function wrapLon(lon) {
  let l = lon - CM;
  l = ((((l + 180) % 360) + 360) % 360) - 180;
  return l;
}

// lambda' already relative to CM, in degrees (may be exactly ±180)
export function projectRel(lrel, lat) {
  const lam = lrel * D2R;
  const phi = lat * D2R;
  const t = Math.asin(M * Math.sin(phi));
  const t2 = t * t, t6 = t2 * t2 * t2;
  const x = (lam * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)));
  const y = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  return [x * R, y * R];
}

export function project(lon, lat) {
  return projectRel(wrapLon(lon), lat);
}

// returns [lonRel, lat] in degrees, or null when outside the map outline
export function invertRel(xk, yk) {
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
  const lam = (M * x * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))) / Math.cos(t);
  const lrel = lam / D2R;
  if (lrel < -180 || lrel > 180) return null;
  return [lrel, Math.asin(s) / D2R];
}

export function invert(xk, yk) {
  const r = invertRel(xk, yk);
  if (!r) return null;
  let lon = r[0] + CM;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return [lon, r[1]];
}

export const X_MAX = projectRel(180, 0)[0];
export const Y_MAX = projectRel(0, 90)[1];
