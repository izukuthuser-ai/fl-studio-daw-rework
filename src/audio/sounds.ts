// Procedurally generated built-in sound pack. No third-party samples are shipped.

export interface BuiltinSound {
  id: string;
  name: string;
  category: 'Kicks' | '808s' | 'Snares' | 'Claps' | 'Hats' | 'Cymbals' | 'Percussion' | 'FX';
  rootKey: number;
  cutGroup?: number;
  gen: (sr: number) => Float32Array[];
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type BqType = 'lp' | 'hp' | 'bp';
class Biquad {
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(private type: BqType, f: number, private q: number, private sr: number) {
    this.set(f);
  }
  set(f: number) {
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * this.q);
    const a0 = 1 + alpha;
    let b0: number, b1: number, b2: number;
    if (this.type === 'lp') {
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    } else if (this.type === 'hp') {
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    } else {
      b0 = alpha; b1 = 0; b2 = -alpha;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0; this.a2 = (1 - alpha) / a0;
  }
  p(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function normalize(chs: Float32Array[], peak = 0.9) {
  let m = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  if (m > 0) for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= peak / m;
  // tiny fade-out to avoid clicks
  for (const c of chs) {
    const n = Math.min(64, c.length);
    for (let i = 0; i < n; i++) c[c.length - 1 - i] *= i / n;
  }
  return chs;
}

function buf(sr: number, sec: number) {
  return new Float32Array(Math.max(1, Math.floor(sr * sec)));
}

function kick(o: { f0: number; f1: number; sweep: number; decay: number; drive: number; click: number; dur?: number; seed?: number }) {
  return (sr: number) => {
    const dur = o.dur ?? o.decay * 4;
    const out = buf(sr, dur);
    const r = rng(o.seed ?? 7);
    const hp = new Biquad('hp', 1500, 0.7, sr);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const f = o.f1 + (o.f0 - o.f1) * Math.exp(-t / o.sweep);
      ph += (2 * Math.PI * f) / sr;
      const amp = Math.exp(-t / o.decay) * Math.min(1, t * sr / 8);
      let s = Math.sin(ph) * amp;
      const clickEnv = Math.exp(-t / 0.003);
      s += hp.p(r() * 2 - 1) * clickEnv * o.click;
      out[i] = Math.tanh(s * o.drive) / Math.tanh(o.drive);
    }
    return normalize([out], 0.95);
  };
}

function bass808(o: { decay: number; drive: number }) {
  return (sr: number) => {
    const base = 65.406; // C2 (MIDI 36)
    const out = buf(sr, Math.min(3.5, o.decay * 3.2));
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const f = base + base * 1.6 * Math.exp(-t / 0.025);
      ph += (2 * Math.PI * f) / sr;
      const amp = Math.exp(-t / o.decay) * Math.min(1, t * sr / 16);
      out[i] = Math.tanh(Math.sin(ph) * amp * o.drive) / Math.tanh(o.drive);
    }
    return normalize([out], 0.92);
  };
}

function snare(o: { tone: number; toneDecay: number; noiseDecay: number; noiseAmt: number; hpf: number; seed: number }) {
  return (sr: number) => {
    const out = buf(sr, Math.max(o.noiseDecay, o.toneDecay) * 5);
    const r = rng(o.seed);
    const hp = new Biquad('hp', o.hpf, 0.7, sr);
    const lp = new Biquad('lp', 9000, 0.7, sr);
    let p1 = 0, p2 = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const f = o.tone * (1 + 0.5 * Math.exp(-t / 0.01));
      p1 += (2 * Math.PI * f) / sr;
      p2 += (2 * Math.PI * f * 1.78) / sr;
      const tone = (Math.sin(p1) + 0.5 * Math.sin(p2)) * Math.exp(-t / o.toneDecay);
      const noise = lp.p(hp.p(r() * 2 - 1)) * Math.exp(-t / o.noiseDecay) * o.noiseAmt;
      out[i] = Math.tanh((tone * 0.7 + noise) * 1.4);
    }
    return normalize([out]);
  };
}

function clap(seed: number, tail: number) {
  return (sr: number) => {
    const out = buf(sr, tail * 5 + 0.05);
    const r = rng(seed);
    const bp = new Biquad('bp', 1200, 1.1, sr);
    const hp = new Biquad('hp', 600, 0.7, sr);
    const bursts = [0, 0.011, 0.022, 0.031];
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      let env = 0;
      for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.007));
      const last = bursts[bursts.length - 1];
      if (t >= last) env = Math.max(env, 0.6 * Math.exp(-(t - last) / tail));
      out[i] = hp.p(bp.p(r() * 2 - 1)) * env;
    }
    return normalize([out]);
  };
}

function metal(o: { decay: number; hp: number; noise: number; seed: number; dur?: number; stereo?: boolean; base?: number }) {
  return (sr: number) => {
    const chs: Float32Array[] = [];
    const nCh = o.stereo ? 2 : 1;
    for (let c = 0; c < nCh; c++) {
      const out = buf(sr, o.dur ?? o.decay * 6);
      const r = rng(o.seed + c * 101);
      const bp = new Biquad('bp', 10000, 0.8, sr);
      const hp = new Biquad('hp', o.hp, 0.7, sr);
      const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
      const base = (o.base ?? 40) * (1 + c * 0.003);
      const ph = ratios.map(() => r());
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        let s = 0;
        for (let k = 0; k < ratios.length; k++) {
          ph[k] += (base * ratios[k]) / sr;
          s += ph[k] % 1 < 0.5 ? 1 : -1;
        }
        s = s / 6 + (r() * 2 - 1) * o.noise;
        const env = Math.exp(-t / o.decay) * Math.min(1, t * sr / 4);
        out[i] = hp.p(bp.p(s)) * env;
      }
      chs.push(out);
    }
    return normalize(chs, 0.85);
  };
}

function tom(f0: number, f1: number, decay: number) {
  return (sr: number) => {
    const out = buf(sr, decay * 4);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const f = f1 + (f0 - f1) * Math.exp(-t / 0.06);
      ph += (2 * Math.PI * f) / sr;
      out[i] = Math.sin(ph) * Math.exp(-t / decay);
    }
    return normalize([out]);
  };
}

function rim(sr: number) {
  const out = buf(sr, 0.15);
  const r = rng(31);
  const bp = new Biquad('bp', 1700, 3, sr);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * 820) / sr;
    out[i] = (Math.sin(ph) * 0.6 + bp.p(r() * 2 - 1) * 2) * Math.exp(-t / 0.018);
  }
  return normalize([out]);
}

function shaker(sr: number) {
  const out = buf(sr, 0.25);
  const r = rng(91);
  const hp = new Biquad('hp', 6000, 0.7, sr);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.012) * Math.exp(-Math.max(0, t - 0.012) / 0.05);
    out[i] = hp.p(r() * 2 - 1) * env;
  }
  return normalize([out], 0.7);
}

function cowbell(sr: number) {
  const out = buf(sr, 0.6);
  const bp = new Biquad('bp', 900, 2, sr);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    p1 += 540 / sr;
    p2 += 800 / sr;
    const s = (p1 % 1 < 0.5 ? 1 : -1) + (p2 % 1 < 0.5 ? 1 : -1);
    const env = t < 0.01 ? 1 : 0.6 * Math.exp(-(t - 0.01) / 0.12) + 0.4 * Math.exp(-(t - 0.01) / 0.02);
    out[i] = bp.p(s) * env;
  }
  return normalize([out], 0.8);
}

function snap(sr: number) {
  const out = buf(sr, 0.2);
  const r = rng(17);
  const bp = new Biquad('bp', 2600, 1.5, sr);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] = bp.p(r() * 2 - 1) * Math.exp(-t / 0.025) + Math.sin(2 * Math.PI * 1300 * t) * Math.exp(-t / 0.006) * 0.3;
  }
  return normalize([out]);
}

function conga(sr: number) {
  const out = buf(sr, 0.5);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = 300 + 80 * Math.exp(-t / 0.02);
    ph += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.11);
  }
  return normalize([out]);
}

function riser(sr: number) {
  const dur = 4;
  const chs: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const out = buf(sr, dur);
    const r = rng(200 + c);
    const bp = new Biquad('bp', 300, 2, sr);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const k = t / dur;
      if (i % 64 === 0) bp.set(300 * Math.pow(40, k));
      ph += (2 * Math.PI * (200 * Math.pow(8, k))) / sr;
      const env = Math.pow(k, 1.6) * (t > dur - 0.05 ? (dur - t) / 0.05 : 1);
      out[i] = (bp.p(r() * 2 - 1) * 1.5 + Math.sin(ph) * 0.15) * env;
    }
    chs.push(out);
  }
  return normalize(chs, 0.8);
}

function impact(sr: number) {
  const chs: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const out = buf(sr, 2.5);
    const r = rng(300 + c);
    const lp = new Biquad('lp', 3000, 0.7, sr);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const f = 38 + 100 * Math.exp(-t / 0.08);
      ph += (2 * Math.PI * f) / sr;
      if (i % 64 === 0) lp.set(200 + 4000 * Math.exp(-t / 0.3));
      out[i] = Math.tanh(Math.sin(ph) * Math.exp(-t / 0.7) * 1.5) + lp.p(r() * 2 - 1) * Math.exp(-t / 0.5) * 0.6;
    }
    chs.push(out);
  }
  return normalize(chs, 0.9);
}

function subdrop(sr: number) {
  const out = buf(sr, 2);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = 30 + 70 * Math.exp(-t / 0.5);
    ph += (2 * Math.PI * f) / sr;
    out[i] = Math.sin(ph) * Math.min(1, t * 200) * (t > 1.7 ? (2 - t) / 0.3 : 1);
  }
  return normalize([out]);
}

export const BUILTIN_SOUNDS: BuiltinSound[] = [
  { id: 'kick-punch', name: 'Kick Punch', category: 'Kicks', rootKey: 60, gen: kick({ f0: 190, f1: 52, sweep: 0.03, decay: 0.26, drive: 1.6, click: 0.35 }) },
  { id: 'kick-deep', name: 'Kick Deep', category: 'Kicks', rootKey: 60, gen: kick({ f0: 140, f1: 43, sweep: 0.05, decay: 0.45, drive: 1.2, click: 0.2 }) },
  { id: 'kick-hard', name: 'Kick Hard', category: 'Kicks', rootKey: 60, gen: kick({ f0: 280, f1: 56, sweep: 0.018, decay: 0.2, drive: 3.2, click: 0.55 }) },
  { id: 'kick-house', name: 'Kick House', category: 'Kicks', rootKey: 60, gen: kick({ f0: 220, f1: 48, sweep: 0.025, decay: 0.32, drive: 2.2, click: 0.25, seed: 11 }) },
  { id: '808-long', name: '808 Long', category: '808s', rootKey: 36, gen: bass808({ decay: 0.9, drive: 1.3 }) },
  { id: '808-dist', name: '808 Distorted', category: '808s', rootKey: 36, gen: bass808({ decay: 0.8, drive: 4.5 }) },
  { id: '808-short', name: '808 Short', category: '808s', rootKey: 36, gen: bass808({ decay: 0.35, drive: 1.8 }) },
  { id: 'snare-crisp', name: 'Snare Crisp', category: 'Snares', rootKey: 60, gen: snare({ tone: 190, toneDecay: 0.05, noiseDecay: 0.13, noiseAmt: 1.2, hpf: 1200, seed: 3 }) },
  { id: 'snare-fat', name: 'Snare Fat', category: 'Snares', rootKey: 60, gen: snare({ tone: 160, toneDecay: 0.09, noiseDecay: 0.2, noiseAmt: 1, hpf: 500, seed: 5 }) },
  { id: 'snare-trap', name: 'Snare Trap', category: 'Snares', rootKey: 60, gen: snare({ tone: 230, toneDecay: 0.04, noiseDecay: 0.17, noiseAmt: 1.5, hpf: 1800, seed: 9 }) },
  { id: 'clap', name: 'Clap Classic', category: 'Claps', rootKey: 60, gen: clap(21, 0.12) },
  { id: 'clap-wide', name: 'Clap Roomy', category: 'Claps', rootKey: 60, gen: clap(23, 0.25) },
  { id: 'snap', name: 'Finger Snap', category: 'Claps', rootKey: 60, gen: snap },
  { id: 'hat-closed', name: 'Hat Closed', category: 'Hats', rootKey: 60, cutGroup: 1, gen: metal({ decay: 0.045, hp: 7000, noise: 0.3, seed: 41 }) },
  { id: 'hat-tight', name: 'Hat Tight', category: 'Hats', rootKey: 60, cutGroup: 1, gen: metal({ decay: 0.022, hp: 8000, noise: 0.4, seed: 43 }) },
  { id: 'hat-open', name: 'Hat Open', category: 'Hats', rootKey: 60, cutGroup: 1, gen: metal({ decay: 0.35, hp: 6500, noise: 0.3, seed: 45 }) },
  { id: 'shaker', name: 'Shaker', category: 'Hats', rootKey: 60, gen: shaker },
  { id: 'crash', name: 'Crash', category: 'Cymbals', rootKey: 60, gen: metal({ decay: 1.1, hp: 4000, noise: 0.9, seed: 51, dur: 3.5, stereo: true, base: 47 }) },
  { id: 'ride', name: 'Ride', category: 'Cymbals', rootKey: 60, gen: metal({ decay: 0.9, hp: 3000, noise: 0.15, seed: 53, dur: 2.5, stereo: true, base: 62 }) },
  { id: 'rim', name: 'Rimshot', category: 'Percussion', rootKey: 60, gen: rim },
  { id: 'tom-low', name: 'Tom Low', category: 'Percussion', rootKey: 60, gen: tom(130, 92, 0.3) },
  { id: 'tom-high', name: 'Tom High', category: 'Percussion', rootKey: 60, gen: tom(220, 165, 0.22) },
  { id: 'conga', name: 'Conga', category: 'Percussion', rootKey: 60, gen: conga },
  { id: 'cowbell', name: 'Cowbell', category: 'Percussion', rootKey: 60, gen: cowbell },
  { id: 'riser', name: 'Noise Riser', category: 'FX', rootKey: 60, gen: riser },
  { id: 'impact', name: 'Impact', category: 'FX', rootKey: 60, gen: impact },
  { id: 'subdrop', name: 'Sub Drop', category: 'FX', rootKey: 60, gen: subdrop },
];

export const BUILTIN_BY_ID = new Map(BUILTIN_SOUNDS.map((s) => [s.id, s]));
