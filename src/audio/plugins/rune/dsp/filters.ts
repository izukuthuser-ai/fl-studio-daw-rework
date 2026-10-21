// Rune — per-voice filters (stereo, zero-delay-feedback / TPT structures where it matters).
// Coefficients are computed once per control block; each type processes a channel buffer in place.

export const FT_OFF = 0, FT_LADDER = 1, FT_SVF = 2, FT_SEM = 3, FT_K35 = 4, FT_DIODE = 5, FT_COMB = 6, FT_FORMANT = 7, FT_RING = 8;

/** Rational tanh approximation (exact at ±3, monotonic, cheap). */
export function ftanh(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// Diode ladder: stage cutoff multipliers (spread real poles) and feedback scale, calibrated offline so
// the resonant peak lands on the cutoff and res 1 self-oscillates.
const DIODE_M = [2.6, 1.05, 0.62, 0.38];
let DIODE_NORM = 1;
let DIODE_KMAX = 9;
{
  // calibrate in closed form at load: find -3 dB point and the 180° frequency of the cascade
  // resonance peak (180° point of the cascade) sits at the cutoff
  const mag = (w: number) => DIODE_M.reduce((p, m) => p / Math.hypot(1, w / m), 1);
  const phase = (w: number) => DIODE_M.reduce((p, m) => p + Math.atan(w / m), 0);
  let lo = 0.01, hi = 1000;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (phase(mid) < Math.PI) lo = mid;
    else hi = mid;
  }
  DIODE_NORM = 1 / lo;
  DIODE_KMAX = 1 / mag(lo);
}

// Formant table: vowels A E I O U → [f1, f2, f3, g1, g2, g3]
const VOWELS = [
  [800, 1150, 2900, 1, 0.5, 0.28],
  [400, 1700, 2600, 1, 0.38, 0.25],
  [290, 2200, 3000, 1, 0.28, 0.2],
  [450, 800, 2830, 1, 0.45, 0.12],
  [325, 700, 2530, 1, 0.3, 0.08],
];

export class Filter {
  type = FT_OFF;
  mode = 0;
  /** state: L channel at [0, 16), R channel at [16, 32) */
  readonly z = new Float64Array(32);
  combL: Float32Array | null = null;
  combR: Float32Array | null = null;
  combMask = 0;
  combW = 0;
  ringPh = 0;
  private seed = 22222;
  // per-block coefficients
  private c = new Float64Array(24);
  /** Block inputs (set by the voice before process(); fields avoid boxing doubles across calls). */
  fc = 1000;
  res = 0;
  drive = 0;
  morph = 0;
  sr = 48000;

  reset() {
    this.z.fill(0);
    this.combL?.fill(0);
    this.combR?.fill(0);
    this.combW = 0;
    this.ringPh = 0;
  }

  ensureComb(sr: number) {
    if (this.combL) return;
    let n = 1;
    while (n < sr / 15) n <<= 1;
    this.combL = new Float32Array(n);
    this.combR = new Float32Array(n);
    this.combMask = n - 1;
  }

  /** Process L (and R when stereo) in place, using the block inputs fc (Hz) / res / drive / morph. */
  process(L: Float64Array, R: Float64Array, n: number, stereo: boolean) {
    const t = this.type;
    if (t === FT_OFF) return;
    const fmax = this.sr * 0.43;
    if (this.fc > fmax) this.fc = fmax;
    if (this.fc < 8) this.fc = 8;
    if (t === FT_RING) return this.ring(L, R, n, stereo);
    switch (t) {
      case FT_LADDER: this.setupLadder(); break;
      case FT_SVF: case FT_SEM: this.setupSvf(); break;
      case FT_K35: this.setupK35(); break;
      case FT_DIODE: this.setupDiode(); break;
      case FT_COMB: this.setupComb(); break;
      case FT_FORMANT: this.setupFormant(); break;
    }
    this.run(L, n, 0);
    if (stereo) this.run(R, n, 16);
    else {
      const z = this.z;
      for (let i = 0; i < 16; i++) z[16 + i] = z[i];
    }
    if (t === FT_COMB) this.combW = this.combWNext;
  }

  private run(b: Float64Array, n: number, o: number) {
    switch (this.type) {
      case FT_LADDER: return this.ladder(b, n, o);
      case FT_SVF: return this.svf(b, n, o);
      case FT_SEM: return this.sem(b, n, o);
      case FT_K35: return this.mode === 1 ? this.k35hp(b, n, o) : this.k35lp(b, n, o);
      case FT_DIODE: return this.diode(b, n, o);
      case FT_COMB: return this.comb(b, n, o === 0 ? this.combL! : this.combR!, o);
      case FT_FORMANT: return this.formant(b, n, o);
    }
  }

  private noise() {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x;
    return (x | 0) * 2.3283064365386963e-10;
  }

  // ---------------- Moog-style 24 dB ladder (TPT, tanh on the solved input) ----------------
  private setupLadder() {
    const c = this.c, fc = this.fc, res = this.res, drive = this.drive, sr = this.sr;
    const g = Math.tan((Math.PI * fc) / sr);
    const G = g / (1 + g), b = 1 / (1 + g);
    const k = res * 4.4;
    const pre = 0.65 * (1 + drive * 7);
    c[0] = G;
    c[1] = G * G * G * b;
    c[2] = G * G * b;
    c[3] = G * b;
    c[4] = b;
    c[5] = k;
    c[6] = 1 / (1 + k * G * G * G * G);
    c[7] = pre * (1 + 0.45 * k);
    c[8] = (1 / pre) * (1 + drive * 0.6);
    c[9] = res > 0.85 ? 2e-4 : 0;
  }
  private ladder(buf: Float64Array, n: number, o: number) {
    const c = this.c, z = this.z;
    const G = c[0], c1 = c[1], c2 = c[2], c3 = c[3], c4 = c[4], k = c[5], den = c[6], inG = c[7], post = c[8], nz = c[9];
    let s1 = z[o], s2 = z[o + 1], s3 = z[o + 2], s4 = z[o + 3];
    for (let i = 0; i < n; i++) {
      let x = buf[i] * inG;
      if (nz) x += this.noise() * nz;
      const S = c1 * s1 + c2 * s2 + c3 * s3 + c4 * s4;
      let u = (x - k * S) * den;
      u = u > 3 ? 1 : u < -3 ? -1 : (u * (27 + u * u)) / (27 + 9 * u * u);
      let v = (u - s1) * G;
      const y1 = v + s1;
      s1 = y1 + v;
      v = (y1 - s2) * G;
      const y2 = v + s2;
      s2 = y2 + v;
      v = (y2 - s3) * G;
      const y3 = v + s3;
      s3 = y3 + v;
      v = (y3 - s4) * G;
      const y4 = v + s4;
      s4 = y4 + v;
      buf[i] = y4 * post;
    }
    z[o] = s1; z[o + 1] = s2; z[o + 2] = s3; z[o + 3] = s4;
  }

  // ---------------- ZDF state-variable (SVF 12 dB: LP / BP / HP; SEM: continuous morph) ----------------
  private setupSvf() {
    const c = this.c, fc = this.fc, res = this.res, drive = this.drive, morph = this.morph, sr = this.sr;
    const g = Math.tan((Math.PI * fc) / sr);
    const sem = this.type === FT_SEM;
    const k = sem ? 2 - 1.88 * res : 2 - 1.97 * res;
    const a1 = 1 / (1 + g * (g + k));
    c[0] = a1;
    c[1] = g * a1;
    c[2] = g * g * a1;
    c[3] = k;
    const pre = 1 + drive * 6;
    c[4] = drive > 0.002 ? pre : 0;
    c[5] = drive > 0.002 ? 1 / Math.sqrt(pre) : 1;
    // output weights lp, bp(normalised), hp
    let wl = 0, wb = 0, wh = 0;
    if (sem) {
      const m = Math.min(2.9999, Math.max(0, morph * 3));
      const seg = m | 0, f = m - seg;
      if (seg === 0) { wl = 1 - f; wb = f; }
      else if (seg === 1) { wb = 1 - f; wh = f; }
      else { wh = 1; wl = f; } // HP → notch (LP + HP)
    } else if (this.mode === 0) wl = 1;
    else if (this.mode === 1) wb = 1;
    else wh = 1;
    c[6] = wl;
    c[7] = wb * Math.min(1.4, k * 1.15);
    c[8] = wh;
  }
  private svf(buf: Float64Array, n: number, o: number) { this.svfRun(buf, n, o); }
  private sem(buf: Float64Array, n: number, o: number) { this.svfRun(buf, n, o); }
  private svfRun(buf: Float64Array, n: number, o: number) {
    const c = this.c, z = this.z;
    const a1 = c[0], a2 = c[1], a3 = c[2], k = c[3], pre = c[4], post = c[5], wl = c[6], wb = c[7], wh = c[8];
    let ic1 = z[o], ic2 = z[o + 1];
    for (let i = 0; i < n; i++) {
      let x = buf[i];
      if (pre) {
        x *= pre;
        x = x > 3 ? 1 : x < -3 ? -1 : (x * (27 + x * x)) / (27 + 9 * x * x);
        x *= post;
      }
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      buf[i] = wl * v2 + wb * v1 + wh * (x - k * v1 - v2);
    }
    z[o] = ic1; z[o + 1] = ic2;
  }

  // ---------------- Korg-35 style Sallen-Key (TPT, nonlinear feedback) ----------------
  private setupK35() {
    const c = this.c, fc = this.fc, res = this.res, drive = this.drive, sr = this.sr;
    const g = Math.tan((Math.PI * fc) / sr);
    const G = g / (1 + g), b = 1 / (1 + g);
    const K = 0.01 + res * 2.04;
    c[0] = G;
    c[1] = b;
    c[2] = K;
    c[3] = 1 / (1 - K * G * b);
    c[4] = 1 + drive * 4; // saturation
    c[5] = 1 / K;
    c[6] = (1 + drive * 0.5) / Math.min(c[4], 2.5);
  }
  private k35lp(buf: Float64Array, n: number, o: number) {
    const c = this.c, z = this.z;
    const G = c[0], b = c[1], K = c[2], a0 = c[3], sat = c[4], post = c[6];
    let s1 = z[o], s2 = z[o + 1], s3 = z[o + 2];
    const kb2 = K * b * b;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      let v = (x - s1) * G;
      const y1 = v + s1;
      s1 = y1 + v;
      let u = a0 * (y1 + kb2 * s2 - b * s3) * sat;
      u = u > 3 ? 1 : u < -3 ? -1 : (u * (27 + u * u)) / (27 + 9 * u * u);
      v = (u - s2) * G;
      const lp2 = v + s2;
      s2 = lp2 + v;
      const y = K * lp2;
      v = (y - s3) * G; // HPF1 (feedback path) state update
      const lp3 = v + s3;
      s3 = lp3 + v;
      buf[i] = lp2 * post;
    }
    z[o] = s1; z[o + 1] = s2; z[o + 2] = s3;
  }
  private k35hp(buf: Float64Array, n: number, o: number) {
    const c = this.c, z = this.z;
    const G = c[0], b = c[1], K = c[2], a0 = c[3], sat = c[4], iK = c[5], post = c[6];
    let s1 = z[o], s2 = z[o + 1], s3 = z[o + 2];
    const gb = G * b;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      let v = (x - s1) * G;
      let lp = v + s1;
      s1 = lp + v;
      const y1 = x - lp;
      const u = a0 * (y1 - gb * s2 + b * s3);
      let y = K * u * sat;
      y = y > 3 ? 1 : y < -3 ? -1 : (y * (27 + y * y)) / (27 + 9 * y * y);
      v = (y - s2) * G;
      lp = v + s2;
      s2 = lp + v;
      const h2 = y - lp;
      v = (h2 - s3) * G;
      lp = v + s3;
      s3 = lp + v;
      buf[i] = y * iK * post;
    }
    z[o] = s1; z[o + 1] = s2; z[o + 2] = s3;
  }

  // ---------------- diode-style 24 dB (spread poles, high-passed feedback, asymmetric clip) ----------------
  private setupDiode() {
    const c = this.c, fc = this.fc, res = this.res, drive = this.drive, sr = this.sr;
    const w = (Math.PI * fc * DIODE_NORM) / sr;
    let gam = 1;
    for (let s = 0; s < 4; s++) {
      const g = Math.tan(Math.min(1.5, w * DIODE_M[s]));
      const G = g / (1 + g);
      c[s] = G;
      c[4 + s] = 1 / (1 + g);
      gam *= G;
    }
    const G1 = c[0], G2 = c[1], G3 = c[2], G4 = c[3];
    c[8] = G2 * G3 * G4 * c[4];
    c[9] = G3 * G4 * c[5];
    c[10] = G4 * c[6];
    c[11] = c[7];
    const k = res * DIODE_KMAX * 1.3;
    c[12] = k;
    c[13] = 1 / (1 + k * gam);
    const pre = 0.8 * (1 + drive * 6);
    c[14] = pre * (1 + 0.25 * k / DIODE_KMAX * 4);
    c[15] = 1 / pre;
    c[16] = 1 - Math.exp((-2 * Math.PI * 120) / sr); // feedback high-pass corner
    void G1;
  }
  private diode(buf: Float64Array, n: number, o: number) {
    const c = this.c, z = this.z;
    const G1 = c[0], G2 = c[1], G3 = c[2], G4 = c[3];
    const c1 = c[8], c2 = c[9], c3 = c[10], c4 = c[11], k = c[12], den = c[13], inG = c[14], post = c[15], hc = c[16];
    let s1 = z[o], s2 = z[o + 1], s3 = z[o + 2], s4 = z[o + 3], lf = z[o + 4];
    const bias = 0.18, tb = 0.17829046299960424; // ftanh(bias)
    for (let i = 0; i < n; i++) {
      const S = c1 * s1 + c2 * s2 + c3 * s3 + c4 * s4;
      let u = (buf[i] * inG - k * S + k * lf) * den + bias;
      u = (u > 3 ? 1 : u < -3 ? -1 : (u * (27 + u * u)) / (27 + 9 * u * u)) - tb;
      let v = (u - s1) * G1;
      const y1 = v + s1;
      s1 = y1 + v;
      v = (y1 - s2) * G2;
      const y2 = v + s2;
      s2 = y2 + v;
      v = (y2 - s3) * G3;
      const y3 = v + s3;
      s3 = y3 + v;
      v = (y3 - s4) * G4;
      const y4 = v + s4;
      s4 = y4 + v;
      lf += hc * (y4 - lf);
      buf[i] = y4 * post;
    }
    z[o] = s1; z[o + 1] = s2; z[o + 2] = s3; z[o + 3] = s4; z[o + 4] = lf;
  }

  // ---------------- comb (+ / −) ----------------
  private setupComb() {
    const c = this.c, fc = this.fc, res = this.res, drive = this.drive, sr = this.sr;
    const len = this.combMask + 1;
    let d = sr / fc;
    if (d > len - 4) d = len - 4;
    if (d < 1) d = 1;
    c[0] = d;
    const fb = res * 0.985 * (this.mode === 1 ? -1 : 1);
    c[1] = fb;
    c[2] = 1 + drive * 3;
    c[3] = Math.sqrt(1 - fb * fb * 0.85);
  }
  private comb(buf: Float64Array, n: number, line: Float32Array, o: number) {
    const c = this.c;
    const d = c[0], fb = c[1], sat = c[2], norm = c[3], mask = this.combMask;
    let w = this.combW;
    for (let i = 0; i < n; i++) {
      const rp = w - d;
      const ri = Math.floor(rp);
      const f = rp - ri;
      const a = line[ri & mask], bb = line[(ri + 1) & mask];
      const y = buf[i] + fb * (a + (bb - a) * f);
      let s = y * sat;
      s = s > 3 ? 1 : s < -3 ? -1 : (s * (27 + s * s)) / (27 + 9 * s * s);
      line[w & mask] = s / sat + 1e-20;
      w = (w + 1) & mask;
      buf[i] = y * norm;
    }
    void o;
    this.combWNext = w; // both channels share the write head: committed after the block
  }
  private combWNext = 0;

  // ---------------- formant (3 parallel band-passes, vowel morph) ----------------
  private setupFormant() {
    const c = this.c, fc = this.fc, res = this.res, morph = this.morph, sr = this.sr;
    const m = Math.min(3.9999, Math.max(0, morph * 4));
    const seg = m | 0, f = m - seg;
    const A = VOWELS[seg], B = VOWELS[seg + 1];
    const shift = Math.min(2.2, Math.max(0.45, Math.pow(fc / 1000, 0.5)));
    const q = 3 + res * 14;
    const k = 1 / q;
    for (let j = 0; j < 3; j++) {
      const fj = Math.min(sr * 0.42, (A[j] + (B[j] - A[j]) * f) * shift);
      const gj = A[3 + j] + (B[3 + j] - A[3 + j]) * f;
      const g = Math.tan((Math.PI * fj) / sr);
      const a1 = 1 / (1 + g * (g + k));
      c[j * 4] = a1;
      c[j * 4 + 1] = g * a1;
      c[j * 4 + 2] = g * g * a1;
      c[j * 4 + 3] = gj * k * 2.2;
    }
  }
  private formant(buf: Float64Array, n: number, o: number) {
    const c = this.c, z = this.z;
    let p1 = z[o], q1 = z[o + 1], p2 = z[o + 2], q2 = z[o + 3], p3 = z[o + 4], q3 = z[o + 5];
    const a11 = c[0], a12 = c[1], a13 = c[2], g1 = c[3];
    const a21 = c[4], a22 = c[5], a23 = c[6], g2 = c[7];
    const a31 = c[8], a32 = c[9], a33 = c[10], g3 = c[11];
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      let v3 = x - q1;
      let v1 = a11 * p1 + a12 * v3;
      let v2 = q1 + a12 * p1 + a13 * v3;
      p1 = 2 * v1 - p1;
      q1 = 2 * v2 - q1;
      let y = g1 * v1;
      v3 = x - q2;
      v1 = a21 * p2 + a22 * v3;
      v2 = q2 + a22 * p2 + a23 * v3;
      p2 = 2 * v1 - p2;
      q2 = 2 * v2 - q2;
      y += g2 * v1;
      v3 = x - q3;
      v1 = a31 * p3 + a32 * v3;
      v2 = q3 + a32 * p3 + a33 * v3;
      p3 = 2 * v1 - p3;
      q3 = 2 * v2 - q3;
      buf[i] = y + g3 * v1;
    }
    z[o] = p1; z[o + 1] = q1; z[o + 2] = p2; z[o + 3] = q2; z[o + 4] = p3; z[o + 5] = q3;
  }

  // ---------------- ring modulator ----------------
  private ring(L: Float64Array, R: Float64Array, n: number, stereo: boolean) {
    const res = this.res, drive = this.drive;
    const inc = this.fc / this.sr;
    const mix = 0.5 + 0.5 * res;
    const sh = 1 + drive * 7;
    const norm = 1 / ftanh(sh);
    let ph = this.ringPh;
    for (let i = 0; i < n; i++) {
      ph += inc;
      if (ph >= 1) ph -= 1;
      let s = Math.sin(6.283185307179586 * ph);
      if (drive > 0.002) {
        s *= sh;
        s = (s > 3 ? 1 : s < -3 ? -1 : (s * (27 + s * s)) / (27 + 9 * s * s)) * norm;
      }
      const m = 1 - mix + mix * s;
      L[i] *= m;
      if (stereo) R[i] *= m;
    }
    this.ringPh = ph;
  }
}
