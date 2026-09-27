// Decodes a level's height file (see scripts/build-data.mjs → writeHeights) and
// builds a half-float mip chain for the GPU.
import { inflateSync } from 'fflate';

interface Req {
  url: string;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  const m = x & 0x7fffff;
  if (e <= 0) return sign; // tiny → 0
  if (e >= 31) return sign | 0x7c00;
  // round to nearest
  let mh = m >>> 13;
  if (m & 0x1000) {
    mh++;
    if (mh & 0x400) {
      mh = 0;
      e++;
      if (e >= 31) return sign | 0x7c00;
    }
  }
  return sign | (e << 10) | mh;
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { url } = ev.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const W = dv.getUint32(4, true), H = dv.getUint32(8, true), q = dv.getFloat32(12, true);
    const raw = inflateSync(buf.subarray(16));
    const v = new Int16Array(W * H);
    let o = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let e = 0, shift = 0, b: number;
        do {
          b = raw[o++];
          e |= (b & 127) << shift;
          shift += 7;
        } while (b & 128);
        e = e & 1 ? -((e + 1) >>> 1) : e >>> 1;
        const a = x ? v[i - 1] : y ? v[i - W] : 0;
        const bb = y ? v[i - W] : a;
        const c = x && y ? v[i - W - 1] : a;
        let p: number;
        if (c >= Math.max(a, bb)) p = Math.min(a, bb);
        else if (c <= Math.min(a, bb)) p = Math.max(a, bb);
        else p = a + bb - c;
        v[i] = p + e;
      }
    }
    // mip chain in metres, half floats
    const mips: { data: Uint16Array; width: number; height: number }[] = [];
    let w = W, h = H;
    let cur = new Float32Array(W * H);
    for (let i = 0; i < cur.length; i++) cur[i] = v[i] * q;
    for (;;) {
      const half = new Uint16Array(w * h);
      for (let i = 0; i < half.length; i++) half[i] = toHalf(cur[i]);
      mips.push({ data: half, width: w, height: h });
      if (w === 1 && h === 1) break;
      const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
      const next = new Float32Array(nw * nh);
      for (let y = 0; y < nh; y++) {
        const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
        for (let x = 0; x < nw; x++) {
          const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
          next[y * nw + x] = (cur[y0 * w + x0] + cur[y0 * w + x1] + cur[y1 * w + x0] + cur[y1 * w + x1]) * 0.25;
        }
      }
      cur = next;
      w = nw;
      h = nh;
    }
    (self as unknown as Worker).postMessage({ ok: true, W, H, q, v, mips }, [v.buffer, ...mips.map((m) => m.data.buffer)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err) });
  }
};
