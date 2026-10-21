// Riffstack DSP core: input selection, noise gate, compressor and wah at the base rate; fuzz,
// overdrive and the amp (cascaded triode-like stages, passive tone stack, power amp with sag)
// at 4× oversampling with antiderivative anti-aliasing on every waveshaper.
// No AudioWorklet globals in here, so it can be unit-tested in Node.
import { MODELS, type AmpModelDef } from './models';

export const OS = 4;
const TAPS = 128; // polyphase FIR length at the oversampled rate (32 taps per phase)
const PH = TAPS / OS;
/** Latency of the oversampling (up + down FIR, linear phase) in base-rate samples. */
export const RS_LATENCY = Math.round((TAPS - 1) / OS);

/** AudioParam-driven (automatable) keys: [min, max, default]. Keep in sync with params.ts. */
export const AUTO_RANGES: Record<string, [number, number, number]> = {
  inGain: [-12, 24, 0],
  gain: [0, 10, 5],
  bass: [0, 10, 5],
  middle: [0, 10, 5],
  treble: [0, 10, 5],
  presence: [0, 10, 5],
  depth: [0, 10, 5],
  master: [0, 10, 5],
  wahPos: [0, 1, 0.5],
  odDrive: [0, 1, 0.3],
  fzGain: [0, 1, 0.6],
};
export const AUTO_KEYS = Object.keys(AUTO_RANGES);

const dbLin = (d: number) => Math.pow(10, d / 20);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- building blocks
/** Kaiser-windowed sinc low-pass, normalised to unity DC gain. fc in cycles/sample. */
function kaiserLowpass(n: number, fc: number, beta: number): Float64Array {
  const i0 = (x: number) => {
    let s = 1, t = 1;
    for (let k = 1; k < 40; k++) {
      t *= (x / (2 * k)) * (x / (2 * k));
      s += t;
    }
    return s;
  };
  const h = new Float64Array(n);
  const m = n - 1;
  const ib = i0(beta);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const r = (2 * i) / m - 1;
    h[i] = sinc * (i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / ib);
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

let FIR: Float64Array | null = null;
function fir() {
  // pass-band to ~0.42·fs, stop-band from ~0.58·fs (base rate), ≈80 dB rejection
  return (FIR ??= kaiserLowpass(TAPS, 0.5 / OS, 8));
}

class Upsampler {
  private buf = new Float64Array(PH * 2);
  private pos = 0;
  private ph: Float64Array[] = [];
  constructor() {
    const h = fir();
    for (let p = 0; p < OS; p++) {
      const a = new Float64Array(PH);
      for (let k = 0; k < PH; k++) a[k] = OS * h[k * OS + p];
      this.ph.push(a);
    }
  }
  run(x: number, out: Float64Array) {
    this.pos = this.pos === 0 ? PH - 1 : this.pos - 1;
    const b = this.buf, o = this.pos;
    b[o] = x;
    b[o + PH] = x;
    for (let p = 0; p < OS; p++) {
      const c = this.ph[p];
      let s = 0;
      for (let k = 0; k < PH; k++) s += c[k] * b[o + k];
      out[p] = s;
    }
  }
}

class Downsampler {
  private buf = new Float64Array(TAPS * 2);
  private pos = 0;
  private h = fir();
  push(v: number) {
    this.pos = this.pos === 0 ? TAPS - 1 : this.pos - 1;
    this.buf[this.pos] = v;
    this.buf[this.pos + TAPS] = v;
  }
  out() {
    const b = this.buf, h = this.h, o = this.pos;
    let s = 0;
    for (let j = 0; j < TAPS; j++) s += h[j] * b[o + j];
    return s;
  }
}

/** Topology-preserving one-pole (low-pass / high-pass). */
class OnePole {
  g = 0;
  s = 0;
  set(fc: number, fs: number) {
    const w = Math.tan((Math.PI * Math.min(fc, fs * 0.45)) / fs);
    this.g = w / (1 + w);
  }
  lp(x: number) {
    const v = (x - this.s) * this.g;
    const y = v + this.s;
    this.s = y + v;
    return y;
  }
  hp(x: number) {
    const v = (x - this.s) * this.g;
    const y = v + this.s;
    this.s = y + v;
    return x - y;
  }
}

/** RBJ biquad (transposed direct form II, double precision). */
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  run(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  private n(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  hp(f: number, fs: number, q: number) {
    const w = (2 * Math.PI * Math.min(f, fs * 0.45)) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.n((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  peak(f: number, fs: number, q: number, db: number) {
    const A = Math.pow(10, db / 40), w = (2 * Math.PI * Math.min(f, fs * 0.45)) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.n(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  highShelf(f: number, fs: number, db: number) {
    const A = Math.pow(10, db / 40), w = (2 * Math.PI * Math.min(f, fs * 0.45)) / fs, c = Math.cos(w), s = Math.sin(w);
    const al = (s / 2) * Math.SQRT2, sa = 2 * Math.sqrt(A) * al;
    this.n(A * (A + 1 + (A - 1) * c + sa), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - sa), A + 1 - (A - 1) * c + sa, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - sa);
  }
  reset() {
    this.z1 = this.z2 = 0;
  }
}

/**
 * Asymmetric soft saturator  f(x) = x / sqrt(1 + (x/c)²)  with c = cp for x ≥ 0, cn for x < 0,
 * evaluated with first-order antiderivative anti-aliasing (ADAA).
 */
class Shaper {
  private icp = 1; private icn = 1; private cp2 = 1; private cn2 = 1;
  private x1 = 0; private F1 = 0;
  set(cp: number, cn: number) {
    this.icp = 1 / cp; this.icn = 1 / cn; this.cp2 = cp * cp; this.cn2 = cn * cn;
    this.F1 = this.F(this.x1);
  }
  private F(x: number) {
    if (x >= 0) {
      const u = x * this.icp;
      return this.cp2 * (Math.sqrt(1 + u * u) - 1);
    }
    const u = x * this.icn;
    return this.cn2 * (Math.sqrt(1 + u * u) - 1);
  }
  private f(x: number) {
    const u = x >= 0 ? x * this.icp : x * this.icn;
    return x / Math.sqrt(1 + u * u);
  }
  run(x: number) {
    const F = this.F(x);
    const d = x - this.x1;
    const y = d > 1e-7 || d < -1e-7 ? (F - this.F1) / d : this.f(0.5 * (x + this.x1));
    this.x1 = x;
    this.F1 = F;
    return y;
  }
  reset() {
    this.x1 = 0;
    this.F1 = 0;
  }
}

/** Passive treble/middle/bass tone stack (3rd-order analog model, bilinear-transformed). */
class ToneStack {
  private b0 = 0; private b1 = 0; private b2 = 0; private b3 = 0;
  private a1 = 0; private a2 = 0; private a3 = 0;
  private z1 = 0; private z2 = 0; private z3 = 0;
  set(c: number[], t: number, m: number, l: number, fs: number) {
    const [C1, C2, C3, R1, R2, R3, R4] = c;
    t = clamp(t, 0.001, 0.999);
    m = clamp(m, 0.001, 0.999);
    l = clamp(l, 0.001, 0.999);
    const b1 = t * C1 * R1 + m * C3 * R3 + l * (C1 * R2 + C2 * R2) + (C1 * R3 + C2 * R3);
    const b2 = t * (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4) - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + m * (C1 * C3 * R1 * R3 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * (C1 * C2 * R1 * R2 + C1 * C2 * R2 * R4 + C1 * C3 * R2 * R4)
      + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
      + (C1 * C2 * R1 * R3 + C1 * C2 * R3 * R4 + C1 * C3 * R3 * R4);
    const b3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
      - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + t * C1 * C2 * C3 * R1 * R3 * R4 - t * m * C1 * C2 * C3 * R1 * R3 * R4
      + t * l * C1 * C2 * C3 * R1 * R2 * R4;
    const a0 = 1;
    const a1 = (C1 * R1 + C1 * R3 + C2 * R3 + C2 * R4 + C3 * R4) + m * C3 * R3 + l * (C1 * R2 + C2 * R2);
    const a2 = m * (C1 * C3 * R1 * R3 - C2 * C3 * R3 * R4 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3)
      - m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3)
      + l * (C1 * C2 * R2 * R4 + C1 * C2 * R1 * R2 + C1 * C3 * R2 * R4 + C2 * C3 * R2 * R4)
      + (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4 + C1 * C2 * R3 * R4 + C1 * C2 * R1 * R3 + C1 * C3 * R3 * R4 + C2 * C3 * R3 * R4);
    const a3 = l * m * (C1 * C2 * C3 * R1 * R2 * R3 + C1 * C2 * C3 * R2 * R3 * R4)
      - m * m * (C1 * C2 * C3 * R1 * R3 * R3 + C1 * C2 * C3 * R3 * R3 * R4)
      + m * (C1 * C2 * C3 * R3 * R3 * R4 + C1 * C2 * C3 * R1 * R3 * R3 - C1 * C2 * C3 * R1 * R3 * R4)
      + l * C1 * C2 * C3 * R1 * R2 * R4
      + C1 * C2 * C3 * R1 * R3 * R4;
    const k = 2 * fs, k2 = k * k, k3 = k2 * k;
    const B0 = b1 * k + b2 * k2 + b3 * k3;
    const B1 = b1 * k - b2 * k2 - 3 * b3 * k3;
    const B2 = -b1 * k - b2 * k2 + 3 * b3 * k3;
    const B3 = -b1 * k + b2 * k2 - b3 * k3;
    const A0 = a0 + a1 * k + a2 * k2 + a3 * k3;
    const A1 = 3 * a0 + a1 * k - a2 * k2 - 3 * a3 * k3;
    const A2 = 3 * a0 - a1 * k - a2 * k2 + 3 * a3 * k3;
    const A3 = a0 - a1 * k + a2 * k2 - a3 * k3;
    this.b0 = B0 / A0; this.b1 = B1 / A0; this.b2 = B2 / A0; this.b3 = B3 / A0;
    this.a1 = A1 / A0; this.a2 = A2 / A0; this.a3 = A3 / A0;
  }
  run(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y + this.z3;
    this.z3 = this.b3 * x - this.a3 * y;
    return y;
  }
  reset() {
    this.z1 = this.z2 = this.z3 = 0;
  }
}

/** Magnitude (linear) of the analog tone stack at frequency f — used by the UI curve and tests. */
export function toneStackMag(c: number[], t: number, m: number, l: number, f: number): number {
  const ts = new ToneStack();
  // evaluate the analog prototype directly via a very high "sample rate" bilinear (negligible warping)
  ts.set(c, t, m, l, 4e6);
  const w = (2 * Math.PI * f) / 4e6;
  const z = (re: number, im: number) => ({ re, im });
  const zi = z(Math.cos(-w), Math.sin(-w));
  const mul = (a: any, b: any) => z(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const z2 = mul(zi, zi), z3 = mul(z2, zi);
  const s: any = ts;
  const num = z(s.b0 + s.b1 * zi.re + s.b2 * z2.re + s.b3 * z3.re, s.b1 * zi.im + s.b2 * z2.im + s.b3 * z3.im);
  const den = z(1 + s.a1 * zi.re + s.a2 * z2.re + s.a3 * z3.re, s.a1 * zi.im + s.a2 * z2.im + s.a3 * z3.im);
  return Math.hypot(num.re, num.im) / Math.hypot(den.re, den.im);
}

/** Bass pot is log-taper; treble and middle linear. */
export const bassTaper = (v: number) => Math.exp((clamp(v, 0, 1) - 1) * 3.4);
/** Gain pot (knob 0..10) → linear gain for a model. */
export function gainPotLin(m: AmpModelDef, knob: number) {
  const kk = clamp(knob / 10, 0, 1);
  const g = dbLin(m.gainDb[0] + (m.gainDb[1] - m.gainDb[0]) * kk);
  return kk < 0.04 ? g * (kk / 0.04) : g;
}
/** Master (0..10) → linear: audio taper, 0 = silent. */
export const masterLin = (knob: number) => {
  const kk = clamp(knob / 10, 0, 1);
  return kk * kk;
};
const levelLin = (v: number) => dbLin((v - 0.5) * 30);

// ---------------------------------------------------------------- amp stage
class Stage {
  sh = new Shaper();
  lp = new OnePole();
  hp = new OnePole();
  pre = 1;
  g = 1;
}

export interface RiffViz {
  gate: number; // gate gain 0..1
  gr: number; // compressor gain reduction dB (>= 0)
  wah: number; // wah position 0..1
  drive: number; // amp power-stage level 0..1 (glow)
}

// ---------------------------------------------------------------- the processor
export class RiffDSP {
  readonly sr: number;
  readonly osr: number;
  private p: Record<string, number> = {};
  private dirty = true;

  // input
  private wl = 0.5; private wr = 0.5; private eL = 0; private eR = 0;
  private inG = 1;
  // gate
  private gEnv = 0; private gOpen = false; private gHold = 0; private gGain = 1;
  private gDet = 0; private gAtk = 0; private gRel = 0; private gThrO = 0; private gThrC = 0; private gHoldN = 0;
  // compressor
  private cEnv = 0; private cAtk = 0; private cRel = 0; private cThr = 0; private cSlope = 0; private cMk = 1; private cGr = 0; private cGain = 1;
  // wah
  private wIc1 = 0; private wIc2 = 0; private wG = 0; private wK = 0.2; private wEnv = 0; private wPos = 0.5; private wCnt = 0;
  // pedal mixes (click-free on/off)
  private mComp = 0; private mWah = 0; private mFz = 0; private mOd = 0; private mAmp = 1;
  private mStep = 0;
  // fuzz (OS rate)
  private fzIn = new OnePole(); private fzMid = new OnePole(); private fzLpT = new OnePole(); private fzHpT = new OnePole();
  private fzSh1 = new Shaper(); private fzSh2 = new Shaper();
  private fzPre = 1; private fzTone = 0.5; private fzOut = 1;
  // overdrive (OS rate)
  private odHp = new OnePole(); private odFb = new OnePole(); private odTlp = new OnePole(); private odOutLp = new OnePole();
  private odSh = new Shaper();
  private odG = 10; private odT = 0.5; private odOut = 1; private odDriveKey = -1;
  // amp (OS rate)
  private model: AmpModelDef = MODELS[1];
  private modelIdx = -1;
  private pendingModel = -1;
  private fade = 1; private fadeDir = 0;
  private aInHp = new OnePole();
  private aFixed = new Biquad(); private aFixed2 = new Biquad(); private aPreMid = new Biquad();
  private aTight = new Biquad(); private tightOn = false;
  private aBright = new OnePole(); private brightG = 1;
  private stages: Stage[] = [];
  private stack = new ToneStack(); private stackMk = 1; private stackKey = '';
  private pres = new Biquad(); private depthF = new Biquad(); private pdKey = '';
  private paSh = new Shaper(); private sagEnv = 0; private sagAtk = 0; private sagRel = 0; private sagV = 1;
  private otHp = new OnePole(); private otLp = new OnePole();
  private trim = 1; private paPeak = 0; private blendSign = 1;
  // ramped per-sample values
  private gainPot = 0; private gainPotT = 0;
  private masterV = 0; private masterT = 0;
  // resampling
  private up = new Upsampler();
  private down = new Downsampler();
  private osBuf = new Float64Array(OS);
  private dc = new OnePole();
  private dn = 1e-18; // anti-denormal dither

  constructor(sr: number) {
    this.sr = sr;
    this.osr = sr * OS;
    this.dc.set(8, sr);
    this.mStep = 1 / (0.012 * sr);
    this.sagAtk = 1 - Math.exp(-1 / (0.006 * this.osr));
    this.sagRel = 1 - Math.exp(-1 / (0.14 * this.osr));
    this.gDet = Math.exp(-1 / (0.006 * sr));
    this.gAtk = 1 - Math.exp(-1 / (0.0004 * sr));
    this.gHoldN = Math.round(0.012 * sr);
    this.cRel = 1 - Math.exp(-1 / (0.16 * sr));
    this.fzIn.set(70, this.osr);
    this.fzMid.set(5200, this.osr);
    this.fzLpT.set(420, this.osr);
    this.fzHpT.set(1150, this.osr);
    this.fzSh1.set(0.55, 0.9);
    this.fzSh2.set(1, 1);
    this.odHp.set(720, this.osr);
    this.odTlp.set(723, this.osr);
    this.odOutLp.set(9000, this.osr);
    this.odSh.set(0.38, 0.46);
    for (const k of AUTO_KEYS) this.p[k] = AUTO_RANGES[k][2];
  }

  setParams(p: Record<string, number>) {
    for (const k in p) if (typeof p[k] === 'number' && isFinite(p[k])) this.p[k] = p[k];
    this.dirty = true;
  }

  viz(): RiffViz {
    const v = { gate: this.p.gateOn >= 0.5 ? this.gGain : 1, gr: this.cGr * this.mComp, wah: this.wPos, drive: Math.min(1, this.paPeak) };
    this.paPeak *= 0.5;
    return v;
  }

  private setModel(i: number) {
    const m = MODELS[clamp(Math.round(i), 0, MODELS.length - 1)];
    this.model = m;
    this.modelIdx = MODELS.indexOf(m);
    const fs = this.osr;
    this.aInHp.set(m.inHp, fs);
    this.aInHp.s = 0;
    if (m.fixedHpHz > 0) {
      this.aFixed.hp(m.fixedHpHz, fs, 0.6);
      this.aFixed2.hp(m.fixedHpHz, fs, 0.6);
    }
    this.aFixed.reset();
    this.aFixed2.reset();
    if (m.preMid) this.aPreMid.peak(m.preMid[0], fs, m.preMid[2], m.preMid[1]);
    this.aPreMid.reset();
    this.aTight.hp(m.tightHz, fs, 0.7);
    this.aTight.reset();
    this.aBright.set(m.brightHz, fs);
    this.stages = m.stages.map((d) => {
      const s = new Stage();
      s.sh.set(d.cp, d.cn);
      s.lp.set(d.lp, fs);
      s.hp.set(d.hp, fs);
      s.pre = d.pre;
      s.g = d.g;
      return s;
    });
    this.stack.reset();
    this.stackKey = '';
    this.pdKey = '';
    this.stackMk = dbLin(m.stackMakeupDb);
    this.paSh.set(m.paCp, m.paCn);
    this.paSh.reset();
    this.sagEnv = 0;
    this.sagV = 1;
    this.otHp.set(m.otHp, fs);
    this.otLp.set(m.otLp, fs);
    this.otHp.s = this.otLp.s = 0;
    this.trim = dbLin(m.trimDb);
    // each stage inverts: match the clean tap's polarity to the preamp output
    this.blendSign = (m.stages.length - 1 - m.stackAt) % 2 === 1 ? -1 : 1;
  }

  /** Recompute coefficients from the current params (once per block). */
  private prepare() {
    const p = this.p, sr = this.sr, fs = this.osr;
    const wantModel = clamp(Math.round(p.ampModel ?? 1), 0, MODELS.length - 1);
    if (this.modelIdx < 0) this.setModel(wantModel);
    else if (wantModel !== this.modelIdx && this.pendingModel !== wantModel) {
      this.pendingModel = wantModel;
      this.fadeDir = -1;
    } else if (wantModel === this.modelIdx && this.pendingModel >= 0) {
      // switched back before the fade-out finished: keep the current model
      this.pendingModel = -1;
      this.fadeDir = 1;
    }
    const m = this.model;
    this.inG = dbLin(p.inGain ?? 0);
    if (this.dirty) {
      this.dirty = false;
      // gate
      this.gThrO = dbLin(p.gateThr ?? -64);
      this.gThrC = dbLin((p.gateThr ?? -64) - (p.gateHyst ?? 6));
      this.gRel = Math.exp(-1 / (Math.max(0.005, (p.gateRel ?? 90) / 1000 / 4.6) * sr));
      // comp
      const sus = clamp(p.compSus ?? 0.5, 0, 1);
      this.cThr = -8 - 34 * sus;
      const ratio = 2 + 10 * sus;
      this.cSlope = 1 - 1 / ratio;
      this.cMk = dbLin(-this.cThr * this.cSlope * 0.45) * levelLin(p.compLevel ?? 0.5);
      this.cAtk = 1 - Math.exp(-1 / (Math.max(0.5, p.compAtk ?? 8) / 1000 * sr));
      // fuzz / od
      this.fzTone = clamp(p.fzTone ?? 0.5, 0, 1);
      this.fzOut = levelLin(p.fzLevel ?? 0.5) * 0.42;
      this.odT = clamp(p.odTone ?? 0.5, 0, 1);
      this.odOut = levelLin(p.odLevel ?? 0.6) * 0.8;
      // amp switches
      const tight = (p.tight ?? 0) >= 0.5;
      if (tight !== this.tightOn) {
        this.tightOn = tight;
        this.aTight.reset();
      }
    }
    // fuzz gain (automatable)
    const fg = clamp(p.fzGain ?? 0.6, 0, 1);
    this.fzPre = 2 + 600 * fg * fg;
    // overdrive drive (automatable): op-amp gain and its feedback low-pass
    const dr = clamp(p.odDrive ?? 0.3, 0, 1);
    if (dr !== this.odDriveKey) {
      this.odDriveKey = dr;
      const rd = 500e3 * (Math.exp(dr * 4.6) - 1) / (Math.exp(4.6) - 1);
      this.odG = (51e3 + rd) / 4.7e3;
      this.odFb.set(1 / (2 * Math.PI * (51e3 + rd) * 51e-12), fs);
    }
    // amp knobs (automatable)
    const gk = clamp(p.gain ?? 5, 0, 10);
    this.gainPotT = gainPotLin(m, gk);
    this.brightG = (p.bright ?? 0) >= 0.5 ? dbLin(m.brightDb * (1 - 0.85 * (gk / 10))) : 1;
    this.masterT = masterLin(p.master ?? 5) * m.paDrive;
    const t = clamp((p.treble ?? 5) / 10, 0, 1), mm = clamp((p.middle ?? 5) / 10, 0, 1), l = bassTaper((p.bass ?? 5) / 10);
    const sk = `${this.modelIdx}|${t.toFixed(4)}|${mm.toFixed(4)}|${l.toFixed(5)}`;
    if (sk !== this.stackKey) {
      this.stackKey = sk;
      this.stack.set(m.stack, t, mm, l, fs);
    }
    const pr = clamp((p.presence ?? 5) / 10, 0, 1), dp = clamp((p.depth ?? 5) / 10, 0, 1);
    const pk = `${this.modelIdx}|${pr.toFixed(4)}|${dp.toFixed(4)}`;
    if (pk !== this.pdKey) {
      this.pdKey = pk;
      this.pres.highShelf(m.presHz, fs, (pr - 0.5) * 2 * m.presRange);
      this.depthF.peak(m.depthHz, fs, 0.8, (dp - 0.5) * 2 * m.depthRange);
    }
  }

  // ------------------------------------------------ OS-rate sections
  private fuzz(x: number) {
    x = this.fzIn.hp(x);
    let y = this.fzSh1.run(x * this.fzPre);
    y = this.fzMid.lp(y);
    y = this.fzSh2.run(y * 3);
    // scooped "muff" style tone: blend of a low-pass and a high-pass branch
    const lo = this.fzLpT.lp(y), hi = this.fzHpT.hp(y);
    const t = this.fzTone;
    return ((1 - t) * lo + t * hi * 1.15) * 2.1 * this.fzOut;
  }

  private od(x: number) {
    // op-amp stage: only the band above ~720 Hz gets the (drive-dependent) gain and the diode clip
    const v = this.odFb.lp(this.odHp.hp(x) * (this.odG - 1));
    const y = x + this.odSh.run(v);
    // tone: fixed treble cut, tone knob adds the highs back
    const lo = this.odTlp.lp(y);
    const z = lo + (0.12 + 1.35 * this.odT * this.odT) * (y - lo);
    return this.odOutLp.lp(z) * this.odOut;
  }

  private amp(x: number, gainPot: number, master: number) {
    const m = this.model;
    x = this.aInHp.hp(x);
    if (m.fixedHpHz > 0) x = this.aFixed2.run(this.aFixed.run(x));
    if (m.preMid) x = this.aPreMid.run(x);
    if (this.tightOn) x = this.aTight.run(x);
    const st = this.stages;
    let clean = 0;
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      if (i === m.gainAt) {
        if (this.brightG !== 1) {
          const lo = this.aBright.lp(x);
          x = lo + this.brightG * (x - lo);
        }
        x *= gainPot;
      }
      x = -s.g * s.sh.run(x * s.pre);
      x = s.hp.hp(s.lp.lp(x));
      if (i === m.stackAt) {
        x = this.stack.run(x) * this.stackMk;
        clean = x;
      }
    }
    if (m.blend > 0) x += this.blendSign * m.blend * clean;
    x = this.depthF.run(this.pres.run(x));
    // power amp: push-pull saturation with supply sag
    const V = this.sagV;
    let y = V * this.paSh.run((x * master) / V);
    const a = y < 0 ? -y : y;
    this.sagEnv += (a - this.sagEnv) * (a > this.sagEnv ? this.sagAtk : this.sagRel);
    this.sagV = 1 / (1 + m.sag * this.sagEnv);
    if (a > this.paPeak) this.paPeak = a;
    y = this.otLp.lp(this.otHp.hp(y));
    return y;
  }

  // ------------------------------------------------ main loop
  process(L: Float32Array | undefined, R: Float32Array | undefined, out: Float32Array, n: number, auto?: Record<string, number>) {
    const p = this.p;
    if (auto) for (const k of AUTO_KEYS) if (auto[k] !== undefined) p[k] = auto[k];
    this.prepare();
    const sr = this.sr;
    // input channel selection
    const sel = Math.round(p.inSel ?? 0);
    let tl = 0.5, tr = 0.5;
    if (sel === 2) (tl = 1), (tr = 0);
    else if (sel === 3) (tl = 0), (tr = 1);
    else if (sel === 0 && L && R && L !== R) {
      let sl = 0, sr2 = 0;
      for (let i = 0; i < n; i++) {
        sl += L[i] * L[i];
        sr2 += R[i] * R[i];
      }
      this.eL = this.eL * 0.9 + sl * 0.1;
      this.eR = this.eR * 0.9 + sr2 * 0.1;
      if (this.eR < this.eL * 0.01) (tl = 1), (tr = 0);
      else if (this.eL < this.eR * 0.01) (tl = 0), (tr = 1);
    }
    if (!R || L === R) (tl = 1), (tr = 0);
    const wl0 = this.wl, wr0 = this.wr;
    this.wl += (tl - this.wl) * 0.25;
    this.wr += (tr - this.wr) * 0.25;
    const dwl = (this.wl - wl0) / n, dwr = (this.wr - wr0) / n;

    const gateOn = (p.gateOn ?? 1) >= 0.5;
    const compOn = (p.compOn ?? 0) >= 0.5, wahOn = (p.wahOn ?? 0) >= 0.5, fzOn = (p.fzOn ?? 0) >= 0.5, odOn = (p.odOn ?? 0) >= 0.5, ampOn = (p.ampOn ?? 1) >= 0.5;
    const wahAuto = (p.wahAuto ?? 0) >= 0.5, wahSens = p.wahSens ?? 0.5, wahBase = clamp(p.wahPos ?? 0.5, 0, 1);
    const ms = this.mStep;
    const inG = this.inG;
    // per-sample ramps for gain pot and master
    const gp0 = this.gainPot, gpd = (this.gainPotT - gp0) / n;
    const ma0 = this.masterV, mad = (this.masterT - ma0) / n;
    const wahRel = 1 - Math.exp(-1 / (0.12 * sr)), wahAtk = 1 - Math.exp(-1 / (0.004 * sr));
    const fadeStep = 1 / (0.006 * sr);
    for (let i = 0; i < n; i++) {
      const wl = wl0 + dwl * (i + 1), wr = wr0 + dwr * (i + 1);
      let x = ((L ? L[i] : 0) * wl + (R ? R[i] : 0) * wr) * inG;
      // ---- noise gate (detector on the input, gain applied before the pedals and after the amp)
      let gg = 1;
      if (gateOn) {
        const a = x < 0 ? -x : x;
        this.gEnv = a > this.gEnv ? a : this.gEnv * this.gDet;
        if (this.gEnv > this.gThrO) {
          this.gOpen = true;
          this.gHold = this.gHoldN;
        } else if (this.gOpen && this.gEnv < this.gThrC && --this.gHold <= 0) this.gOpen = false;
        if (this.gOpen) this.gGain += (1 - this.gGain) * this.gAtk;
        else {
          this.gGain *= this.gRel;
          if (this.gGain < 1e-5) this.gGain = 0;
        }
        gg = this.gGain;
      } else {
        this.gGain = 1;
        this.gOpen = true;
      }
      x *= gg;
      x += this.dn;
      this.dn = -this.dn;
      // ---- compressor
      this.mComp = compOn ? Math.min(1, this.mComp + ms) : Math.max(0, this.mComp - ms);
      if (this.mComp > 0) {
        const a = x < 0 ? -x : x;
        this.cEnv += (a - this.cEnv) * (a > this.cEnv ? this.cAtk : this.cRel);
        const lev = 20 * Math.log10(this.cEnv + 1e-9);
        const over = lev - this.cThr;
        // 6 dB soft knee
        const gr = over <= -3 ? 0 : over >= 3 ? over * this.cSlope : ((over + 3) * (over + 3) / 12) * this.cSlope;
        this.cGr = gr;
        this.cGain = dbLin(-gr) * this.cMk;
        x += this.mComp * (x * this.cGain - x);
      }
      // ---- wah (state-variable band-pass, pedal or envelope controlled)
      this.mWah = wahOn ? Math.min(1, this.mWah + ms) : Math.max(0, this.mWah - ms);
      if (this.mWah > 0) {
        if (this.wCnt-- <= 0) {
          this.wCnt = 15;
          let pos = wahBase;
          if (wahAuto) pos = clamp(wahBase * 0.5 + wahSens * 1.6 * Math.sqrt(Math.min(1, this.wEnv * 3)), 0, 1);
          this.wPos += (pos - this.wPos) * 0.35;
          const fc = 360 * Math.pow(2300 / 360, this.wPos);
          this.wG = Math.tan((Math.PI * fc) / sr);
          this.wK = 1 / 4.2;
        }
        const a = x < 0 ? -x : x;
        this.wEnv += (a - this.wEnv) * (a > this.wEnv ? wahAtk : wahRel);
        const g = this.wG, k = this.wK;
        const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
        const v3 = x - this.wIc2;
        const v1 = a1 * this.wIc1 + a2 * v3;
        const v2 = this.wIc2 + a2 * this.wIc1 + a3 * v3;
        this.wIc1 = 2 * v1 - this.wIc1;
        this.wIc2 = 2 * v2 - this.wIc2;
        const w = k * v1 * 2.6 + v2 * 0.22;
        x += this.mWah * (w - x);
      }
      // ---- oversampled nonlinear section
      this.mFz = fzOn ? Math.min(1, this.mFz + ms) : Math.max(0, this.mFz - ms);
      this.mOd = odOn ? Math.min(1, this.mOd + ms) : Math.max(0, this.mOd - ms);
      this.mAmp = ampOn ? Math.min(1, this.mAmp + ms) : Math.max(0, this.mAmp - ms);
      const gpot = gp0 + gpd * (i + 1), mst = ma0 + mad * (i + 1);
      const mFz = this.mFz, mOd = this.mOd, mAmp = this.mAmp, trim = this.trim;
      this.up.run(x, this.osBuf);
      for (let j = 0; j < OS; j++) {
        let v = this.osBuf[j];
        if (mFz > 0) v += mFz * (this.fuzz(v) - v);
        if (mOd > 0) v += mOd * (this.od(v) - v);
        if (mAmp > 0) v += mAmp * (this.amp(v, gpot, mst) * trim - v);
        this.down.push(v);
      }
      let y = this.dc.hp(this.down.out());
      // ---- model switch fade + post gate
      if (this.fadeDir !== 0) {
        this.fade += this.fadeDir * fadeStep;
        if (this.fade <= 0) {
          this.fade = 0;
          this.setModel(this.pendingModel);
          this.prepare();
          this.pendingModel = -1;
          this.fadeDir = 1;
        } else if (this.fade >= 1) {
          this.fade = 1;
          this.fadeDir = 0;
        }
      }
      y *= gg * this.fade;
      // safety: transparent below +6 dBFS, soft ceiling at +12 dBFS (runaway settings can't explode)
      const ay = y < 0 ? -y : y;
      if (ay > 2) y = (y < 0 ? -1 : 1) * (2 + 2 * Math.tanh((ay - 2) * 0.5));
      out[i] = y;
    }
    this.gainPot = this.gainPotT;
    this.masterV = this.masterT;
  }
}
