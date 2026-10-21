// Rune — mip-mapped band-limited single-cycle tables (built once per AudioWorkletGlobalScope).
// Levels are spaced half an octave apart; each level keeps only partials whose alias image would land
// above ~19 kHz, so table playback is alias-free across the keyboard. Built with an inverse FFT.

export const TN = 2048; // samples per cycle (+1 guard sample)
export const NLEV = 22;
export const SH_SAW = 0, SH_SQR = 1, SH_TRI = 2, SH_SIN = 3, SH_ORGAN = 4, SH_VOX = 5, SH_CHIP = 6, SH_COUNT = 7;

export interface TableSet {
  /** [shape][level] → Float32Array(TN + 1) */
  t: Float32Array[][];
  /** max phase increment (f / sr) served by each level */
  incMax: Float64Array;
}

let cache: TableSet | null = null;
let cacheSr = 0;

function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Harmonic amplitudes: a[n] cos + b[n] sin, n = 1..TN/2-1 */
function spectrum(shape: number): { a: Float64Array; b: Float64Array } {
  const H = TN / 2;
  const a = new Float64Array(H), b = new Float64Array(H);
  if (shape === SH_SAW) for (let n = 1; n < H; n++) b[n] = -2 / (Math.PI * n); // rising ramp, jump at phase 0
  else if (shape === SH_SQR) for (let n = 1; n < H; n += 2) b[n] = 4 / (Math.PI * n);
  else if (shape === SH_TRI) for (let n = 1; n < H; n += 2) b[n] = ((8 / (Math.PI * Math.PI)) * (((n - 1) / 2) % 2 === 0 ? 1 : -1)) / (n * n);
  else if (shape === SH_SIN) b[1] = 1;
  else if (shape === SH_ORGAN) {
    const reg: [number, number][] = [[1, 1], [2, 0.75], [3, 0.55], [4, 0.45], [6, 0.32], [8, 0.3], [10, 0.16], [12, 0.14], [16, 0.1]];
    for (const [h, g] of reg) (h % 2 ? b : a)[h] = g;
  } else if (shape === SH_VOX) {
    for (let n = 1; n < Math.min(H, 80); n++) {
      const env = 0.18 + Math.exp(-(((n - 3) / 1.4) ** 2)) + 0.75 * Math.exp(-(((n - 8) / 2.2) ** 2)) + 0.4 * Math.exp(-(((n - 14) / 3.5) ** 2));
      const g = env / Math.pow(n, 0.6);
      if (n % 2) b[n] = g; else b[n] = -g;
    }
  } else if (shape === SH_CHIP) {
    // NES-style 32-step, 4-bit triangle: analyse the stepped shape
    const re = new Float64Array(TN), im = new Float64Array(TN);
    const seq = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    for (let i = 0; i < TN; i++) re[i] = seq[Math.floor((i / TN) * 32)] / 7.5 - 1;
    fft(re, im, false);
    for (let n = 1; n < H; n++) {
      a[n] = (2 * re[n]) / TN;
      b[n] = (-2 * im[n]) / TN;
    }
  }
  return { a, b };
}

function build(sr: number): TableSet {
  const incMax = new Float64Array(NLEV);
  const t: Float32Array[][] = [];
  const re = new Float64Array(TN), im = new Float64Array(TN);
  for (let k = 0; k < NLEV; k++) incMax[k] = (20 * Math.pow(2, k / 2)) / sr;
  for (let s = 0; s < SH_COUNT; s++) {
    const { a, b } = spectrum(s);
    const levels: Float32Array[] = [];
    let norm = 0;
    for (let k = 0; k < NLEV; k++) {
      const fTop = incMax[k] * sr;
      // partials above Nyquist are allowed only while their alias folds back above ~19 kHz
      const nh = Math.max(1, Math.min(TN / 2 - 1, Math.floor(Math.max(sr - 19000, sr * 0.5) / fTop)));
      re.fill(0);
      im.fill(0);
      for (let n = 1; n <= nh; n++) {
        re[n] = a[n] / 2;
        im[n] = -b[n] / 2;
        re[TN - n] = a[n] / 2;
        im[TN - n] = b[n] / 2;
      }
      fft(re, im, true);
      const tab = new Float32Array(TN + 1);
      for (let i = 0; i < TN; i++) tab[i] = re[i];
      tab[TN] = tab[0];
      if (k === 0) {
        for (let i = 0; i < TN; i++) norm = Math.max(norm, Math.abs(tab[i]));
        norm = norm > 0 ? 1 / norm : 1;
      }
      levels.push(tab);
    }
    for (const tab of levels) for (let i = 0; i <= TN; i++) tab[i] *= norm;
    t.push(levels);
  }
  return { t, incMax };
}

export function getTables(sr: number): TableSet {
  if (!cache || cacheSr !== sr) {
    cache = build(sr);
    cacheSr = sr;
  }
  return cache;
}

/** Mip level for a phase increment (|f| / sr). */
export function levelFor(ts: TableSet, inc: number): number {
  if (inc < 0) inc = -inc;
  const m = ts.incMax;
  let k = 0;
  while (k < NLEV - 1 && inc > m[k]) k++;
  return k;
}

/** Linear-interpolated table read, phase in [0, 1). */
export function lk(t: Float32Array, ph: number): number {
  const x = ph * TN;
  const i = x | 0;
  return t[i] + (x - i) * (t[i + 1] - t[i]);
}
