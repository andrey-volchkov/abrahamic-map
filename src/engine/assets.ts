import * as THREE from 'three';
import HeightWorker from './heightWorker?worker';

export interface LevelMeta {
  x0: number;
  y0: number;
  k: number;
  W: number;
  H: number;
  q: number;
}

export interface Level extends LevelMeta {
  id: string;
  /** raw height values (metres = v * q), row 0 = north */
  v: Int16Array;
  hTex: THREE.DataTexture;
  mTex: THREE.Texture;
  lTex: THREE.Texture;
}

export interface Meta {
  levels: Record<string, LevelMeta>;
}

const base = import.meta.env.BASE_URL;
export const dataUrl = (f: string) => `${base}data/${f}`;

async function imageTexture(url: string): Promise<THREE.Texture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const t = new THREE.Texture(bmp as unknown as HTMLImageElement);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function heights(url: string): Promise<{ W: number; H: number; q: number; v: Int16Array; mips: { data: Uint16Array; width: number; height: number }[] }> {
  return new Promise((resolve, reject) => {
    const w = new HeightWorker();
    w.onmessage = (e) => {
      w.terminate();
      if (e.data.ok) resolve(e.data);
      else reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(e);
    };
    w.postMessage({ url: new URL(url, location.href).href });
  });
}

export async function loadMeta(): Promise<Meta> {
  const res = await fetch(dataUrl('meta.json'));
  return res.json();
}

export async function loadLevel(id: string, meta: LevelMeta): Promise<Level> {
  const [h, mTex, lTex] = await Promise.all([
    heights(dataUrl(`${id}_h.bin`)),
    imageTexture(dataUrl(`${id}_m.png`)),
    imageTexture(dataUrl(`${id}_l.png`)),
  ]);
  const hTex = new THREE.DataTexture(h.mips[0].data, h.W, h.H, THREE.RedFormat, THREE.HalfFloatType);
  hTex.internalFormat = 'R16F';
  hTex.mipmaps = h.mips as unknown as THREE.DataTexture['mipmaps'];
  hTex.generateMipmaps = false;
  hTex.minFilter = THREE.LinearMipmapLinearFilter;
  hTex.magFilter = THREE.LinearFilter;
  hTex.unpackAlignment = 2;
  hTex.wrapS = hTex.wrapT = THREE.ClampToEdgeWrapping;
  hTex.needsUpdate = true;
  return { ...meta, id, v: h.v, hTex, mTex, lTex };
}

/** CPU-side height sampling (metres) using the finest loaded level. */
export class HeightField {
  levels: Level[] = [];

  add(l: Level) {
    this.levels.push(l);
    this.levels.sort((a, b) => a.k - b.k);
  }

  sample(mx: number, my: number): number {
    for (const L of this.levels) {
      const fx = (mx - L.x0) / L.k - 0.5, fy = (L.y0 - my) / L.k - 0.5;
      if (fx < 1 || fy < 1 || fx > L.W - 2 || fy > L.H - 2) continue;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const i = y0 * L.W + x0, v = L.v;
      const h = (v[i] * (1 - tx) + v[i + 1] * tx) * (1 - ty) + (v[i + L.W] * (1 - tx) + v[i + L.W + 1] * tx) * ty;
      return h * L.q;
    }
    return 0;
  }

  /** max height (metres) over a rectangle, sampled coarsely */
  maxIn(x0: number, y0: number, x1: number, y1: number): number {
    let m = 0;
    const n = 6;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) m = Math.max(m, this.sample(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n));
    return m;
  }
}
