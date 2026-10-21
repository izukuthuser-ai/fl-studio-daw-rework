// Halcyon wavetables: procedurally generated (original) tables, band-limited per octave.
// Each table = WT_FRAMES single-cycle frames. A frame is described by its harmonic spectrum
// (sine / cosine amplitudes for harmonics 1..1024), either directly (spectral generators) or by
// sampling a time-domain function at 4× and taking an FFT. Mip level k keeps only harmonics
// ≤ 1024 >> k and is rebuilt with an inverse FFT, so playback never aliases from the table itself.
// Shared by the worklet (full mip-maps) and the UI (level-0 previews).

export const WT_FRAMES = 64;
export const WT_SIZE = 2048;
export const MAX_H = 1024;
export const MIP_COUNT = 11;
export const MIP_HARM = [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
/** Table length per mip level (≥ 8× oversampled above level 2 so linear interpolation stays clean). */
export const MIP_SIZE = [2048, 2048, 2048, 1024, 512, 256, 256, 256, 256, 256, 256];

export interface Wavetable {
  frames: number;
  /** levels[k] = frames × MIP_SIZE[k] samples, frame f at offset f * MIP_SIZE[k]. */
  levels: Float32Array[];
}

// ---------------- FFT (radix-2, in place) ----------------
interface Plan {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}
const plans = new Map<number, Plan>();
function plan(n: number): Plan {
  let p = plans.get(n);
  if (p) return p;
  const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1), rev = new Uint32Array(n);
  for (let k = 0; k < n >> 1; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  const bits = Math.round(Math.log2(n));
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  p = { cos, sin, rev };
  plans.set(n, p);
  return p;
}
/** In-place complex FFT. inverse = e^{+i} kernel, unnormalised. */
export function fft(re: Float64Array, im: Float64Array, n: number, inverse: boolean) {
  const { cos, sin, rev } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sg = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const c = cos[k], s = sg * sin[k];
        const a = i + j, b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// ---------------- generators ----------------
type SpecGen = (p: number, sn: Float64Array, cs: Float64Array) => void;
type TimeGen = (p: number, t: number) => number;
interface Gen {
  spec?: SpecGen;
  time?: TimeGen;
}
const PI = Math.PI;
const TAU = 2 * Math.PI;

/** Add a (rising) saw at harmonic multiple `mult`, time-shifted by `shift` cycles of that saw. */
function addSaw(sn: Float64Array, cs: Float64Array, w: number, mult = 1, shift = 0, tilt = 1) {
  for (let k = 1; k * mult <= MAX_H; k++) {
    const n = k * mult;
    const a = (w * (2 / PI) * (k & 1 ? 1 : -1)) / Math.pow(k, tilt);
    if (shift) {
      const th = TAU * k * shift;
      sn[n] += a * Math.cos(th);
      cs[n] -= a * Math.sin(th);
    } else sn[n] += a;
  }
}
function addShape(sn: Float64Array, cs: Float64Array, shape: number, w: number) {
  if (w === 0) return;
  if (shape === 0) sn[1] += w;
  else if (shape === 1) {
    for (let n = 1; n <= MAX_H; n += 2) sn[n] += (w * (8 / (PI * PI)) * (((n - 1) >> 1) & 1 ? -1 : 1)) / (n * n);
  } else if (shape === 2) addSaw(sn, cs, w);
  else for (let n = 1; n <= MAX_H; n += 2) sn[n] += (w * (4 / PI)) / n;
}
/** Deterministic PRNG for repeatable "random" tables. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const GENS: Gen[] = [
  // 0 Basic Shapes: sine → triangle → saw → square
  {
    spec(p, sn, cs) {
      const x = p * 3;
      const i = Math.min(2, Math.floor(x));
      const t = x - i;
      addShape(sn, cs, i, 1 - t);
      addShape(sn, cs, i + 1, t);
    },
  },
  // 1 PWM: 50 % → 3 % pulse
  {
    spec(p, sn, cs) {
      const d = 0.5 - p * 0.47;
      for (let n = 1; n <= MAX_H; n++) {
        const a = (2 / (PI * n)) * Math.sin(PI * n * d);
        cs[n] += a * Math.cos(PI * n * d);
        sn[n] += a * Math.sin(PI * n * d);
      }
    },
  },
  // 2 Harmonic Sweep: a resonant band gliding up the harmonic series
  {
    spec(p, sn) {
      const c = 1 + p * p * 56;
      const w = 1.1 + p * 3.5;
      for (let n = 1; n <= 320; n++) {
        const base = 0.12 / n;
        const pk = Math.exp(-(((n - c) / w) ** 2));
        sn[n] += (base + pk) * (n & 1 ? 1 : -1);
      }
      sn[1] += 0.35;
    },
  },
  // 3 Formant Vowels: a → e → i → o → u on a buzzy source
  {
    spec(p, sn) {
      const x = p * 4;
      const i = Math.min(3, Math.floor(x));
      const t = x - i;
      const V = [
        [730, 1090, 2440, 1, 0.5, 0.28],
        [530, 1840, 2480, 1, 0.42, 0.3],
        [290, 2250, 3000, 1, 0.26, 0.24],
        [570, 840, 2410, 1, 0.62, 0.2],
        [320, 870, 2240, 1, 0.38, 0.14],
      ];
      const f = V[i].map((v, k) => v + (V[i + 1][k] - v) * t);
      const f0 = 98;
      const bw = [90, 110, 150];
      for (let n = 1; n * f0 < 14000; n++) {
        const hz = n * f0;
        let env = 0.012;
        for (let j = 0; j < 3; j++) env += f[3 + j] / (1 + ((hz - f[j]) / bw[j]) ** 2);
        sn[n] += (env / Math.pow(n, 0.25)) * (n & 1 ? 1 : -1);
      }
    },
  },
  // 4 Supersaw Stack: saws stacked on the harmonic series with offsets
  {
    spec(p, sn, cs) {
      const m = 1 + p * 6;
      for (let k = 1; k <= Math.ceil(m); k++) {
        const w = (k <= Math.floor(m) ? 1 : m - Math.floor(m)) / Math.pow(k, 0.6);
        addSaw(sn, cs, w, k, k === 1 ? 0 : k * 0.137);
      }
    },
  },
  // 5 Digital Growl: nested phase modulation
  {
    time(p, t) {
      const i1 = p * 5.5, i2 = 0.3 + p * 2.4;
      return Math.sin(TAU * t + i1 * Math.sin(TAU * 2 * t + i2 * Math.sin(TAU * 3 * t)) + 0.5 * p * Math.sin(TAU * 5 * t));
    },
  },
  // 6 Glass Bells: sparse bright partials, brightness rising
  {
    spec(p, sn, cs) {
      const parts = [[1, 1], [2, 0.12], [3, 0.5], [5, 0.38], [7, 0.3], [9, 0.3], [12, 0.26], [15, 0.22], [19, 0.2], [24, 0.17], [30, 0.14], [37, 0.12], [45, 0.1]];
      const bright = 2 + p * 34;
      for (const [n, a0] of parts) {
        const a = a0 * Math.exp(-(n - 1) / bright) * (n === 1 ? 1 : 0.35 + 0.65 * p);
        if (n % 3 === 0) cs[n] += a;
        else sn[n] += a;
      }
    },
  },
  // 7 Hollow Pulse: odd harmonics with moving notches
  {
    spec(p, sn) {
      const q = p * 0.23;
      for (let n = 1; n <= MAX_H; n += 2) sn[n] += ((4 / PI) / n) * Math.cos(TAU * n * q);
    },
  },
  // 8 Noise to Tone: periodic noise burst resolving into a saw
  {
    spec(p, sn, cs) {
      const r = rng(0x5eed1234);
      const m = Math.pow(p, 0.8);
      for (let n = 1; n <= MAX_H; n++) {
        const amp = (0.25 + 0.75 * r()) / Math.sqrt(n);
        const ph = TAU * r();
        const sawA = ((2 / PI) * (n & 1 ? 1 : -1)) / n;
        sn[n] += (1 - m) * amp * Math.cos(ph) + m * sawA;
        cs[n] += (1 - m) * amp * Math.sin(ph);
      }
    },
  },
  // 9 Spectral Ramp: harmonics switching on one after another
  {
    spec(p, sn) {
      const h = 1 + p * p * 220;
      for (let n = 1; n <= Math.min(MAX_H, h + 3); n++) {
        const edge = Math.max(0, Math.min(1, (h - n) / 3 + 1));
        sn[n] += (edge / Math.pow(n, 0.65)) * (n & 1 ? 1 : -1);
      }
    },
  },
  // 10 Sync Sweep: hard-synced saw, ratio 1 → 8
  {
    time(p, t) {
      const r = 1 + p * 7;
      const x = r * t;
      return 2 * (x - Math.floor(x)) - 1;
    },
  },
  // 11 Drawbar Organ: additive registrations
  {
    spec(p, sn) {
      const H = [1, 2, 3, 4, 5, 6, 8];
      const R = [
        [8, 0, 0, 0, 0, 0, 0],
        [8, 8, 0, 0, 0, 0, 0],
        [8, 6, 8, 0, 0, 0, 0],
        [8, 8, 8, 8, 0, 0, 0],
        [6, 8, 4, 6, 3, 4, 5],
        [8, 0, 8, 0, 8, 0, 8],
        [4, 8, 8, 8, 8, 8, 8],
        [8, 8, 8, 8, 8, 8, 8],
      ];
      const x = p * 7;
      const i = Math.min(6, Math.floor(x));
      const t = x - i;
      const amp = (s: number) => (s > 0 ? Math.pow(10, ((s - 8) * 3) / 20) : 0);
      for (let k = 0; k < H.length; k++) sn[H[k]] += amp(R[i][k]) * (1 - t) + amp(R[i + 1][k]) * t;
    },
  },
];
export const WT_COUNT = GENS.length;

// ---------------- builders ----------------
const OS = 8192; // time-domain oversampled length (4×)
let scratch: { sn: Float64Array; cs: Float64Array; re: Float64Array; im: Float64Array } | null = null;
function bufs() {
  if (!scratch) scratch = { sn: new Float64Array(MAX_H + 1), cs: new Float64Array(MAX_H + 1), re: new Float64Array(OS), im: new Float64Array(OS) };
  return scratch;
}

/** Fill sn/cs (harmonics 1..MAX_H) for frame position p (0..1) of table `index`. */
function frameSpectrum(index: number, p: number, sn: Float64Array, cs: Float64Array) {
  sn.fill(0);
  cs.fill(0);
  const g = GENS[index] ?? GENS[0];
  if (g.spec) g.spec(p, sn, cs);
  else if (g.time) {
    const { re, im } = bufs();
    for (let i = 0; i < OS; i++) {
      re[i] = g.time(p, i / OS);
      im[i] = 0;
    }
    fft(re, im, OS, false);
    for (let n = 1; n <= MAX_H; n++) {
      cs[n] = (2 * re[n]) / OS;
      sn[n] = (-2 * im[n]) / OS;
    }
  }
}

/** Inverse-FFT harmonics 1..h into out[off .. off+size). */
function synth(sn: Float64Array, cs: Float64Array, h: number, size: number, out: Float32Array, off: number, scale: number) {
  const { re, im } = bufs();
  re.fill(0, 0, size);
  im.fill(0, 0, size);
  const top = Math.min(h, size / 2 - 1);
  for (let n = 1; n <= top; n++) {
    const c = cs[n] * 0.5 * scale, s = sn[n] * 0.5 * scale;
    re[n] = c;
    im[n] = -s;
    re[size - n] = c;
    im[size - n] = s;
  }
  fft(re, im, size, true);
  for (let i = 0; i < size; i++) out[off + i] = re[i];
}

/** Peak of the full-band frame (used to normalise every frame to ±1). */
function framePeak(sn: Float64Array, cs: Float64Array, tmp: Float32Array): number {
  synth(sn, cs, MAX_H, WT_SIZE, tmp, 0, 1);
  let pk = 0;
  for (let i = 0; i < WT_SIZE; i++) pk = Math.max(pk, Math.abs(tmp[i]));
  return pk;
}

/** Build the full mip-mapped wavetable (worklet side; ~20–60 ms). */
export function buildWavetable(index: number): Wavetable {
  const { sn, cs } = bufs();
  const F = WT_FRAMES;
  const levels = MIP_SIZE.map((s) => new Float32Array(F * s));
  for (let f = 0; f < F; f++) {
    frameSpectrum(index, f / (F - 1), sn, cs);
    const pk = framePeak(sn, cs, levels[0].subarray(f * WT_SIZE, (f + 1) * WT_SIZE));
    const sc = pk > 1e-9 ? 1 / pk : 0;
    for (let k = 0; k < MIP_COUNT; k++) synth(sn, cs, MIP_HARM[k], MIP_SIZE[k], levels[k], f * MIP_SIZE[k], sc);
  }
  return { frames: F, levels };
}

/** Level-0 frames decimated to `points` samples each (UI display). */
export function previewFrames(index: number, points = 256): Float32Array[] {
  const { sn, cs } = bufs();
  const tmp = new Float32Array(WT_SIZE);
  const out: Float32Array[] = [];
  const step = WT_SIZE / points;
  for (let f = 0; f < WT_FRAMES; f++) {
    frameSpectrum(index, f / (WT_FRAMES - 1), sn, cs);
    const pk = framePeak(sn, cs, tmp);
    const sc = pk > 1e-9 ? 1 / pk : 0;
    const fr = new Float32Array(points);
    for (let i = 0; i < points; i++) fr[i] = tmp[Math.floor(i * step)] * sc;
    out.push(fr);
  }
  return out;
}
