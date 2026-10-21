// Procedural impulse responses for Riffstack: mic'd guitar cabinets (magnitude model → minimum
// phase via the real cepstrum, plus time-domain cabinet / floor reflections) and room/hall/plate
// reverbs. Pure math — no Web Audio — so it's testable and the UI can draw the cab response.

// ---------------------------------------------------------------- FFT (radix-2, in place)
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
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
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const br = re[b] * cr - im[b] * ci;
        const bi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - br; im[b] = im[a] - bi;
        re[a] += br; im[a] += bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

// ---------------------------------------------------------------- analog magnitude helpers (|H|², f in Hz)
const hp2 = (f: number, fc: number, q: number) => {
  const r = f / fc;
  return (r ** 4) / ((1 - r * r) ** 2 + (r / q) ** 2);
};
const lpN = (f: number, fc: number, n: number) => 1 / (1 + (f / fc) ** (2 * n));
const bell = (f: number, f0: number, q: number, db: number) => {
  const A = Math.pow(10, db / 40), r = f / f0, d = 1 - r * r;
  return (d * d + ((A * r) / q) ** 2) / (d * d + (r / (A * q)) ** 2);
};
const lowShelf1 = (f: number, fc: number, db: number) => {
  const G = Math.pow(10, db / 20);
  return (f * f + G * G * fc * fc) / (f * f + fc * fc);
};
const highShelf1 = (f: number, fc: number, db: number) => {
  const G = Math.pow(10, db / 20);
  return (G * G * f * f + fc * fc) / (f * f + fc * fc);
};

// ---------------------------------------------------------------- cabinets
interface CabDef {
  fRes: number; qRes: number; // speaker/cabinet low resonance (2nd-order high-pass with Q)
  lp: number; lpOrd: number; // top-end roll-off
  peaks: [number, number, number][]; // cone break-up / body: [Hz, dB, Q]
  open: number; // open-back rear-wave amount (0 = closed)
  depthMs: number; // internal back-panel reflection delay (closed backs)
  seed: number;
}
const CABS: CabDef[] = [
  // 1x12 open back
  { fRes: 92, qRes: 0.75, lp: 5600, lpOrd: 4, peaks: [[140, 2, 1.2], [700, -1, 1.4], [1500, 2.5, 2.2], [2600, 4.5, 2.8], [3700, -3, 4], [4500, 3.5, 4.5]], open: 0.4, depthMs: 1.1, seed: 11 },
  // 2x12 combo (semi-open)
  { fRes: 88, qRes: 0.95, lp: 5400, lpOrd: 4.5, peaks: [[120, 2.5, 1.3], [450, -1.5, 1.2], [1250, 2, 2], [2400, 4, 2.6], [3300, 2.5, 4], [4300, -3, 4]], open: 0.3, depthMs: 1.3, seed: 23 },
  // 4x12 closed, vintage speakers: warm, mid-forward, smooth top
  { fRes: 84, qRes: 1.35, lp: 4600, lpOrd: 5, peaks: [[105, 3.5, 1.6], [220, 1.2, 1.5], [1100, 2.5, 1.6], [2100, 3.5, 2.2], [3100, 2, 3], [4100, -4, 3.5]], open: 0, depthMs: 1.7, seed: 37 },
  // 4x12 closed, modern speakers: thumping lows, scooped low mids, cutting presence
  { fRes: 96, qRes: 1.3, lp: 5300, lpOrd: 6, peaks: [[110, 4.5, 1.4], [420, -2, 1], [1650, 2, 2], [2800, 4, 2.8], [4700, 1, 4]], open: 0, depthMs: 1.8, seed: 41 },
  // 1x15 bass
  { fRes: 46, qRes: 1.0, lp: 3400, lpOrd: 3.5, peaks: [[90, 2, 1.2], [700, 1.5, 1.5], [1800, 3, 2.5], [2700, -3, 3]], open: 0, depthMs: 2.2, seed: 53 },
];

interface MicDef { prox: number; mag: (f: number) => number }
const MICS: MicDef[] = [
  // dynamic: presence bump, low roll-off, strong proximity effect
  { prox: 1.0, mag: (f) => bell(f, 5200, 1.3, 4) * hp2(f, 55, 0.7) * lpN(f, 13000, 2) },
  // ribbon: dark, warm, big proximity
  { prox: 1.25, mag: (f) => bell(f, 180, 0.8, 1.5) * lpN(f, 7500, 1.5) * hp2(f, 30, 0.7) },
  // condenser: extended, slight air, less proximity
  { prox: 0.55, mag: (f) => bell(f, 3000, 1, 1.5) * highShelf1(f, 9000, 2.5) * hp2(f, 25, 0.7) },
];

/** Squared magnitude of the cab+mic model at f (before time-domain reflections). */
function cabMag2(cab: CabDef, mic: MicDef, pos: number, distCm: number, f: number, ripple: (f: number) => number) {
  const prox = Math.max(0, Math.min(1, 1 - Math.log10(Math.max(1, distCm)) / 2)); // 1 cm → 1, 100 cm → 0
  const lp = cab.lp * (1.12 - 0.42 * pos) * (1 - 0.15 * (1 - prox));
  let m = hp2(f, cab.fRes, cab.qRes) * lpN(f, lp, cab.lpOrd);
  for (const [pf, pdb, pq] of cab.peaks) m *= bell(f, pf, pq, pf > 1800 ? pdb * (1 - 0.7 * pos) : pdb);
  // dust-cap brightness (center) vs. cone warmth (edge)
  m *= bell(f, 4600, 2, 3.5 * (1 - pos)) * bell(f, 380, 0.9, 1.8 * pos);
  // proximity effect of a directional mic
  m *= lowShelf1(f, 190, 7 * prox * mic.prox);
  m *= mic.mag(f) * ripple(f);
  return m;
}

/** Fine-grained deterministic response ripple (cone irregularities) for one cab. */
function makeRipple(seed: number) {
  const r = rng(seed);
  const bumps: [number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const f = 900 * Math.pow(7, (i + 0.5 + r() * 0.4) / 14);
    bumps.push([f, r() * 2.2, 5 + 4 * Math.abs(r())]);
  }
  return (f: number) => {
    let m = 1;
    for (const [bf, bd, bq] of bumps) m *= bell(f, bf, bq, bd);
    return m;
  };
}

/** Real-cepstrum minimum-phase reconstruction from a squared-magnitude spectrum (bins 0..N/2). */
function minPhase(mag2: Float64Array, N: number): Float64Array {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const v = 0.5 * Math.log(Math.max(mag2[k], 1e-14));
    re[k] = v;
    if (k > 0 && k < N / 2) re[N - k] = v;
  }
  fft(re, im, true); // cepstrum (real, even)
  for (let n = 1; n < N / 2; n++) { re[n] *= 2; im[n] = 0; }
  for (let n = N / 2 + 1; n < N; n++) { re[n] = 0; im[n] = 0; }
  im[0] = 0;
  im[N / 2] = 0;
  fft(re, im);
  for (let k = 0; k < N; k++) {
    const e = Math.exp(re[k]);
    const c = Math.cos(im[k]), s = Math.sin(im[k]);
    re[k] = e * c;
    im[k] = e * s;
  }
  fft(re, im, true);
  return re;
}

function onePoleLp(x: Float64Array, fc: number, sr: number) {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  let s = 0;
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = s = (1 - a) * x[i] + a * s;
  return y;
}

export interface CabSpec { cab: number; mic: number; pos: number; dist: number }

/** Mono cabinet IR at `sr`. Normalised so the 100 Hz–5 kHz average gain is 0 dB. */
export function cabIR(sr: number, spec: CabSpec): Float32Array {
  const cab = CABS[Math.max(0, Math.min(CABS.length - 1, Math.round(spec.cab)))];
  const mic = MICS[Math.max(0, Math.min(MICS.length - 1, Math.round(spec.mic)))];
  const pos = Math.max(0, Math.min(1, spec.pos));
  const dist = Math.max(1, Math.min(100, spec.dist));
  const N = sr > 64000 ? 32768 : 16384;
  const ripple = makeRipple(cab.seed);
  const mag2 = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) mag2[k] = cabMag2(cab, mic, pos, dist, Math.max(1, (k * sr) / N), ripple);
  const mp = minPhase(mag2, N);
  const D = dist / 100;
  const roomAmt = Math.max(0, Math.min(1, (D - 0.15) / 0.85));
  const len = Math.min(N, Math.round(sr * (0.07 + 0.11 * roomAmt)));
  const h = new Float64Array(len);
  for (let i = 0; i < len; i++) h[i] = mp[i];
  // cabinet: closed back → back-panel reflection through the cone (low-passed);
  // open back → inverted rear wave diffracting around the cabinet (thins the lows)
  const src = h.slice();
  const lpBody = onePoleLp(src, cab.open > 0 ? 900 : 1600, sr);
  const dBody = Math.round((cab.depthMs / 1000) * sr);
  const gBody = cab.open > 0 ? -cab.open : 0.2;
  for (let i = dBody; i < len; i++) h[i] += gBody * lpBody[i - dBody];
  // floor reflection (path difference grows as the mic moves away)
  const hgt = 0.38;
  const path = Math.sqrt(D * D + 4 * hgt * hgt);
  const dFloor = Math.round(((path - D) / 343) * sr);
  const gFloor = (0.55 * D) / path;
  const lpFloor = onePoleLp(src, 4500, sr);
  for (let i = dFloor; i < len; i++) h[i] += gFloor * lpFloor[i - dFloor];
  // diffuse room pickup for distant mics
  if (roomAmt > 0) {
    const r = rng(cab.seed * 7 + 3);
    let lp = 0;
    let e = 0;
    for (let i = 0; i < len; i++) e += src[i] * src[i];
    const amp = Math.sqrt(e) * 0.022 * roomAmt;
    const start = Math.round(0.004 * sr);
    for (let i = start; i < len; i++) {
      lp += 0.35 * (r() - lp);
      const t = (i - start) / sr;
      h[i] += lp * amp * Math.exp(-t / 0.045) * Math.min(1, t / 0.003);
    }
  }
  // fade out the last 20 %
  const f0 = Math.floor(len * 0.8);
  for (let i = f0; i < len; i++) h[i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i - f0)) / (len - f0));
  // normalise: mean power gain over log-spaced 100 Hz–5 kHz = 1
  const re = new Float64Array(N), im = new Float64Array(N);
  re.set(h);
  fft(re, im);
  let acc = 0, cnt = 0;
  for (let f = 100; f <= 5000; f *= 1.02) {
    const k = Math.round((f * N) / sr);
    acc += re[k] * re[k] + im[k] * im[k];
    cnt++;
  }
  const g = 1 / Math.sqrt(acc / cnt);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = h[i] * g;
  return out;
}

/** dB response of an IR at the given frequencies (for drawing). */
export function irResponse(ir: Float32Array, sr: number, freqs: number[]): number[] {
  let N = 4096;
  while (N < ir.length * 2) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < ir.length; i++) re[i] = ir[i];
  fft(re, im);
  return freqs.map((f) => {
    const kf = (f * N) / sr;
    const k0 = Math.floor(kf);
    // average a few bins for a smoother curve
    let a = 0, c = 0;
    const w = Math.max(1, Math.round(kf * 0.04));
    for (let k = k0 - w; k <= k0 + w; k++) if (k > 0 && k < N / 2) { a += re[k] * re[k] + im[k] * im[k]; c++; }
    return 10 * Math.log10(a / Math.max(1, c) + 1e-12);
  });
}

// ---------------------------------------------------------------- reverb
/** Stereo reverb IR: 0 = room, 1 = hall, 2 = plate. Energy-normalised. */
export function reverbIR(sr: number, type: number, decay: number, tone: number): [Float32Array, Float32Array] {
  type = Math.max(0, Math.min(2, Math.round(type)));
  tone = Math.max(0, Math.min(1, tone));
  decay = Math.max(0.15, Math.min(12, decay));
  const cfg = [
    { pre: 0.004, ers: 16, erSpan: 0.028, erG: 0.55, build: 0.006, hfr: 0.35 + 0.35 * tone, lfr: 1.1, lp: 2800 + 8000 * tone },
    { pre: 0.024, ers: 12, erSpan: 0.075, erG: 0.35, build: 0.05, hfr: 0.3 + 0.35 * tone, lfr: 1.2, lp: 2400 + 7000 * tone },
    { pre: 0.001, ers: 0, erSpan: 0, erG: 0, build: 0.0015, hfr: 0.6 + 0.3 * tone, lfr: 0.9, lp: 4500 + 10000 * tone },
  ][type];
  const len = Math.max(1, Math.round(sr * Math.min(12, cfg.pre + decay * 1.15)));
  const chans: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const r = rng(9001 + c * 7919 + type * 31);
    const h = new Float64Array(len);
    // three-band noise tail with band-dependent RT60 (highs die first)
    const aLo = Math.exp((-2 * Math.PI * 350) / sr), aHi = Math.exp((-2 * Math.PI * 3500) / sr);
    let lo = 0, hiLp = 0;
    const kLo = -6.91 / (decay * cfg.lfr * sr), kMid = -6.91 / (decay * sr), kHi = -6.91 / (decay * cfg.hfr * sr);
    const p0 = Math.round(cfg.pre * sr);
    for (let i = p0; i < len; i++) {
      const n = r();
      lo = (1 - aLo) * n + aLo * lo;
      hiLp = (1 - aHi) * n + aHi * hiLp;
      const hi = n - hiLp;
      const mid = hiLp - lo;
      const t = i - p0;
      const env = 1 - Math.exp(-t / (cfg.build * sr));
      h[i] = env * (lo * 1.6 * Math.exp(kLo * t) + mid * Math.exp(kMid * t) + hi * Math.exp(kHi * t));
    }
    // early reflections
    for (let e = 0; e < cfg.ers; e++) {
      const t = cfg.pre * 0.5 + cfg.erSpan * Math.pow((e + 1 + r() * 0.5) / cfg.ers, 1.3);
      const i = Math.round(t * sr);
      if (i < len) h[i] += (r() > 0 ? 1 : -1) * cfg.erG * (1 - (e / cfg.ers) * 0.6) * 0.25;
    }
    // overall tone: low-pass + low-cut so the guitar stays defined
    const aL = Math.exp((-2 * Math.PI * cfg.lp) / sr), aH = Math.exp((-2 * Math.PI * 160) / sr);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) {
      s1 = (1 - aL) * h[i] + aL * s1;
      s2 = (1 - aH) * s1 + aH * s2;
      h[i] = s1 - s2;
    }
    chans.push(Float32Array.from(h));
  }
  // energy normalisation (both channels)
  let e = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) e += ch[i] * ch[i];
  const g = 0.9 / Math.sqrt(e / 2);
  for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return [chans[0], chans[1]];
}
