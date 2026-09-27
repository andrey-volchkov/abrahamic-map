// AWS Terrain Tiles (Terrarium encoding) — download + bilinear sampling.
// https://registry.opendata.aws/terrain-tiles/
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PNG } from 'pngjs';

const BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const MAX_LAT = 85.05112878;

export function lonLatToTilePx(lon, lat, z) {
  const n = 256 * 2 ** z;
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * (Math.PI / 180);
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
  return [x, y];
}

export class TileSampler {
  constructor(cacheDir, z) {
    this.dir = path.join(cacheDir, String(z));
    this.z = z;
    this.n = 2 ** z;
    this.cache = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
  }
  file(x, y) {
    return path.join(this.dir, `${x}_${y}.png`);
  }
  // ensure a set of "x,y" keys is downloaded
  fetchAll(keys) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const missing = [...keys].filter((k) => {
        const [x, y] = k.split(',');
        const f = this.file(x, y);
        return !fs.existsSync(f) || fs.statSync(f).size < 100;
      });
      if (!missing.length) return;
      console.log(`  downloading ${missing.length} tiles at z${this.z}`);
      const list = missing
        .map((k) => {
          const [x, y] = k.split(',');
          return `${BASE}/${this.z}/${x}/${y}.png\n${this.file(x, y)}`;
        })
        .join('\n');
      const lf = path.join(this.dir, '_list.txt');
      fs.writeFileSync(lf, list + '\n');
      try {
        execSync(`xargs -P 12 -n 2 sh -c 'curl -sS --retry 4 --retry-delay 2 -o "$1" "$0" || rm -f "$1"' < "${lf}"`, {
          stdio: 'inherit',
        });
      } catch (e) {
        console.log('  some downloads failed, retrying');
      }
    }
    throw new Error('tiles could not be downloaded');
  }
  tile(x, y) {
    const key = y * this.n + x;
    let t = this.cache.get(key);
    if (t) return t;
    const png = PNG.sync.read(fs.readFileSync(this.file(x, y)));
    t = new Float32Array(256 * 256);
    const d = png.data;
    for (let i = 0; i < 65536; i++) t[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    this.cache.set(key, t);
    return t;
  }
  px(ix, iy) {
    const size = 256 * this.n;
    ix = ((ix % size) + size) % size;
    iy = Math.max(0, Math.min(size - 1, iy));
    const tx = ix >> 8, ty = iy >> 8;
    return this.tile(tx, ty)[(iy & 255) * 256 + (ix & 255)];
  }
  sample(lon, lat) {
    const [x, y] = lonLatToTilePx(lon, lat, this.z);
    const fx = x - 0.5, fy = y - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const a = this.px(x0, y0), b = this.px(x0 + 1, y0), c = this.px(x0, y0 + 1), d = this.px(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  tileKey(lon, lat) {
    const [x, y] = lonLatToTilePx(lon, lat, this.z);
    const size = 256 * this.n;
    const keys = [];
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      let ix = Math.floor(x + dx), iy = Math.floor(y + dy);
      ix = ((ix % size) + size) % size;
      iy = Math.max(0, Math.min(size - 1, iy));
      keys.push(`${ix >> 8},${iy >> 8}`);
    }
    return keys;
  }
}
