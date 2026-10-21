// Rune — canvas displays (oscillator scope, filter response, envelope, LFO). Main thread only.
import type { RuneEnv, RuneFilter, RuneLfo, RuneOsc } from './defs';

export interface Cv {
  c: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** HiDPI canvas of CSS size w × h. */
export function canvas(w: number, h: number, cls = 'rn-cv'): Cv {
  const c = document.createElement('canvas');
  c.className = cls;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.width = w + 'px';
  c.style.height = h + 'px';
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, g, w, h };
}

function frame(cv: Cv, gridX = 4, gridY = 2) {
  const { g, w, h } = cv;
  g.clearRect(0, 0, w, h);
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0b1013');
  bg.addColorStop(1, '#111a1f');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(160,190,210,0.07)';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < gridX; i++) {
    const x = Math.round((i * w) / gridX) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  for (let i = 1; i < gridY; i++) {
    const y = Math.round((i * h) / gridY) + 0.5;
    g.moveTo(0, y);
    g.lineTo(w, y);
  }
  g.stroke();
}

function glowLine(g: CanvasRenderingContext2D, color: string, width = 1.6) {
  g.save();
  g.shadowColor = color;
  g.shadowBlur = 6;
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineJoin = 'round';
  g.stroke();
  g.restore();
}

// ---------------- oscillator waveform (display approximation of the DSP shapes) ----------------
const TAU = Math.PI * 2;
const saw = (p: number) => 2 * (p - Math.floor(p)) - 1;
const sq = (p: number, pw = 0.5) => (p - Math.floor(p) < 1 - pw ? -1 : 1);
const tri = (p: number) => {
  p -= Math.floor(p);
  return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
};
const organ = (p: number) => (Math.sin(TAU * p) + 0.75 * Math.cos(TAU * 2 * p) + 0.55 * Math.sin(TAU * 3 * p) + 0.45 * Math.cos(TAU * 4 * p) + 0.3 * Math.cos(TAU * 8 * p)) / 2.2;
const vox = (p: number) => {
  let y = 0;
  for (let n = 1; n < 18; n++) {
    const env = 0.18 + Math.exp(-(((n - 3) / 1.4) ** 2)) + 0.75 * Math.exp(-(((n - 8) / 2.2) ** 2));
    y += ((n % 2 ? 1 : -1) * env * Math.sin(TAU * n * p)) / Math.pow(n, 0.6);
  }
  return y / 1.6;
};
const NES = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

export function oscSample(o: RuneOsc, p: number, seed: number): number {
  switch (o.type) {
    case 'analog': {
      const w = o.wave, seg = Math.min(2, Math.floor(w)), f = w - seg;
      const pulse = sq(p, o.pw) / (1 + Math.abs(1 - 2 * o.pw)) * 1.2;
      if (seg === 0) return saw(p) * (1 - f) + pulse * f;
      if (seg === 1) return pulse * (1 - f) + tri(p) * f;
      return tri(p) * (1 - f) + Math.sin(TAU * p) * f;
    }
    case 'multi': {
      let y = 0;
      const K = o.voices, span = Math.pow(o.detune, 1.5) * 0.9;
      for (let j = 0; j < K; j++) {
        const pos = K === 1 ? 0 : (j / (K - 1)) * 2 - 1;
        const r = Math.pow(2, (pos * span) / 12);
        const ph = p * r + j * 0.37;
        y += saw(ph) * (1 - o.wave) + sq(ph) * o.wave;
      }
      return (y / Math.sqrt(K)) * 0.8;
    }
    case 'fm':
      return Math.sin(TAU * p + o.index * Math.sin(TAU * p * o.ratio + o.fb * 2 * Math.sin(TAU * p * o.ratio)));
    case 'pm': {
      const w = o.wave, seg = Math.min(2, Math.floor(w)), f = w - seg;
      const q = p * o.ratio;
      const shapes = [Math.sin(TAU * q), tri(q), saw(q), sq(q)];
      const m = shapes[seg] * (1 - f) + shapes[seg + 1] * f;
      return Math.sin(TAU * p + o.index * m);
    }
    case 'chip':
      if (o.duty === 3) return NES[Math.floor((p - Math.floor(p)) * 32)] / 7.5 - 1;
      return sq(p, [0.125, 0.25, 0.5][o.duty]) * 0.9;
    case 'noise': {
      const x = Math.sin((Math.floor(p * 220) + seed) * 12.9898) * 43758.5453;
      const r = (x - Math.floor(x)) * 2 - 1;
      if (o.noise === 2) return Math.abs(r) > 0.93 ? r : r * 0.05;
      return r * (o.noise === 1 ? 0.7 : 0.85);
    }
    case 'vector': {
      const x = o.x, y = o.y;
      return (1 - x) * (1 - y) * Math.sin(TAU * p) + x * (1 - y) * saw(p) + (1 - x) * y * organ(p) + x * y * vox(p);
    }
  }
  return 0;
}

export function drawScope(cv: Cv, o: RuneOsc, color: string) {
  frame(cv, 4, 2);
  const { g, w, h } = cv;
  if (o.type === 'off') {
    g.fillStyle = 'rgba(200,215,225,0.25)';
    g.font = '600 9px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('OFF', w / 2, h / 2 + 3);
    return;
  }
  const N = Math.max(2, Math.floor(w * 1.5));
  let pk = 0.001;
  const ys = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    ys[i] = oscSample(o, (i / (N - 1)) * 2, 7);
    pk = Math.max(pk, Math.abs(ys[i]));
  }
  const sc = ((h / 2 - 4) / Math.max(1, pk)) * (0.35 + 0.65 * o.level);
  g.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * w, y = h / 2 - ys[i] * sc;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  glowLine(g, color, 1.5);
}

// ---------------- filter magnitude response ----------------
type C = [number, number];
const cadd = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cabs = (a: C) => Math.hypot(a[0], a[1]);
const DIODE_M = [2.6, 1.05, 0.62, 0.38];
const DIODE_NORM = (() => {
  let lo = 0.01, hi = 1000;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (DIODE_M.reduce((p, m) => p + Math.atan(mid / m), 0) < Math.PI) lo = mid;
    else hi = mid;
  }
  return lo;
})();
const VOW = [
  [800, 1150, 2900, 1, 0.5, 0.28], [400, 1700, 2600, 1, 0.38, 0.25], [290, 2200, 3000, 1, 0.28, 0.2], [450, 800, 2830, 1, 0.45, 0.12], [325, 700, 2530, 1, 0.3, 0.08],
];

export function filterMag(f: RuneFilter, freq: number): number {
  const fc = f.cutoff;
  const s: C = [0, freq / fc];
  const one: C = [1, 0];
  const svf = (k: number) => {
    const den = cadd(cadd(cmul(s, s), [k * s[0], k * s[1]]), one);
    return { lp: cdiv(one, den), bp: cdiv([k * s[0], k * s[1]], den), hp: cdiv(cmul(s, s), den) };
  };
  switch (f.type) {
    case 'ladder': {
      const G = cdiv(one, cadd(one, s));
      const G4 = cmul(cmul(G, G), cmul(G, G));
      const k = Math.min(3.85, f.res * 4.4);
      return cabs(G4) / cabs(cadd(one, [k * G4[0], k * G4[1]]));
    }
    case 'svf': {
      const r = svf(Math.max(0.06, 2 - 1.97 * f.res));
      return cabs(f.mode === 0 ? r.lp : f.mode === 1 ? r.bp : r.hp);
    }
    case 'sem': {
      const r = svf(Math.max(0.1, 2 - 1.88 * f.res));
      const m = Math.min(2.9999, f.morph * 3), seg = Math.floor(m), t = m - seg;
      let y: C;
      if (seg === 0) y = cadd([r.lp[0] * (1 - t), r.lp[1] * (1 - t)], [r.bp[0] * t, r.bp[1] * t]);
      else if (seg === 1) y = cadd([r.bp[0] * (1 - t), r.bp[1] * (1 - t)], [r.hp[0] * t, r.hp[1] * t]);
      else y = cadd(r.hp, [r.lp[0] * t, r.lp[1] * t]);
      return cabs(y);
    }
    case 'k35': {
      const K = Math.min(1.93, 0.01 + f.res * 2.04);
      const r = svf(Math.max(0.07, 2 - K));
      return cabs(f.mode === 1 ? r.hp : r.lp);
    }
    case 'diode': {
      let H: C = one;
      for (const m of DIODE_M) H = cmul(H, cdiv(one, cadd(one, [0, (freq / (fc * DIODE_NORM)) / m])));
      const kmax = 1 / DIODE_M.reduce((p, m) => p / Math.hypot(1, DIODE_NORM / m), 1);
      const k = Math.min(0.93 * kmax, f.res * kmax * 1.3);
      return cabs(H) / cabs(cadd(one, [k * H[0], k * H[1]]));
    }
    case 'comb': {
      const fb = f.res * 0.985 * (f.mode === 1 ? -1 : 1);
      const ph = (-2 * Math.PI * freq) / fc;
      const den: C = [1 - fb * Math.cos(ph), -fb * Math.sin(ph)];
      return Math.sqrt(1 - fb * fb * 0.85) / cabs(den);
    }
    case 'formant': {
      const m = Math.min(3.9999, f.morph * 4), seg = Math.floor(m), t = m - seg;
      const A = VOW[seg], B = VOW[seg + 1];
      const shift = Math.min(2.2, Math.max(0.45, Math.pow(fc / 1000, 0.5)));
      const k = 1 / (3 + f.res * 14);
      let y: C = [0, 0];
      for (let j = 0; j < 3; j++) {
        const fj = (A[j] + (B[j] - A[j]) * t) * shift, gj = A[3 + j] + (B[3 + j] - A[3 + j]) * t;
        const sj: C = [0, freq / fj];
        const bp = cdiv([k * sj[0], k * sj[1]], cadd(cadd(cmul(sj, sj), [k * sj[0], k * sj[1]]), one));
        y = cadd(y, [bp[0] * gj * 2.2, bp[1] * gj * 2.2]);
      }
      return cabs(y);
    }
    case 'ring':
      return 1;
  }
  return 1;
}

const fx = (f: number, w: number) => (Math.log(f / 20) / Math.log(1000)) * w;

export function drawFilter(cv: Cv, f: RuneFilter, color: string) {
  const { g, w, h } = cv;
  g.clearRect(0, 0, w, h);
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0b1013');
  bg.addColorStop(1, '#111a1f');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // decade grid
  g.strokeStyle = 'rgba(160,190,210,0.08)';
  g.beginPath();
  for (const fr of [100, 1000, 10000]) {
    const x = Math.round(fx(fr, w)) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  const top = 24, bot = -36;
  const yOf = (db: number) => ((top - Math.max(bot, Math.min(top, db))) / (top - bot)) * h;
  const y0 = Math.round(yOf(0)) + 0.5;
  g.moveTo(0, y0);
  g.lineTo(w, y0);
  g.stroke();
  if (f.type === 'off') {
    g.fillStyle = 'rgba(200,215,225,0.25)';
    g.font = '600 9px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('BYPASS', w / 2, h / 2 + 3);
    return;
  }
  g.beginPath();
  const N = Math.floor(w);
  for (let i = 0; i <= N; i++) {
    const fr = 20 * Math.pow(1000, i / N);
    const m = filterMag(f, fr);
    const y = yOf(20 * Math.log10(m + 1e-9));
    if (i) g.lineTo(i, y);
    else g.moveTo(i, y);
  }
  glowLine(g, color, 1.6);
  g.lineTo(w, h);
  g.lineTo(0, h);
  g.closePath();
  const fill = g.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, color + '40');
  fill.addColorStop(1, color + '00');
  g.fillStyle = fill;
  g.fill();
  // cutoff marker
  const cx = fx(f.cutoff, w);
  g.strokeStyle = color + '80';
  g.setLineDash([2, 3]);
  g.beginPath();
  g.moveTo(Math.round(cx) + 0.5, 0);
  g.lineTo(Math.round(cx) + 0.5, h);
  g.stroke();
  g.setLineDash([]);
}

// ---------------- envelope ----------------
const tw = (t: number) => Math.log(1 + t * 12);

export function envGeom(e: RuneEnv, w: number) {
  const sus = 0.16;
  const total = tw(e.a) + tw(e.d) + tw(e.r);
  const avail = w * (1 - sus) - 8;
  const xa = 4 + (tw(e.a) / total) * avail;
  const xd = xa + (tw(e.d) / total) * avail;
  const xs = xd + w * sus;
  const xr = xs + (tw(e.r) / total) * avail;
  return { xa, xd, xs, xr };
}

export function drawEnv(cv: Cv, e: RuneEnv, color: string, level = -1, stage = 0) {
  frame(cv, 4, 2);
  const { g, w, h } = cv;
  const { xa, xd, xs, xr } = envGeom(e, w);
  const y = (v: number) => h - 4 - v * (h - 10);
  g.beginPath();
  g.moveTo(4, y(0));
  for (let i = 1; i <= 16; i++) {
    const t = i / 16;
    g.lineTo(4 + (xa - 4) * t, y((1 - Math.exp(-t * 1.466)) / (1 - Math.exp(-1.466))));
  }
  for (let i = 1; i <= 20; i++) {
    const t = i / 20;
    g.lineTo(xa + (xd - xa) * t, y(e.s + (1 - e.s) * Math.exp(-t * 4)));
  }
  g.lineTo(xs, y(e.s));
  for (let i = 1; i <= 20; i++) {
    const t = i / 20;
    g.lineTo(xs + (xr - xs) * t, y(Math.max(0, -0.02 + (e.s + 0.02) * Math.exp(-t * 3.93))));
  }
  glowLine(g, color, 1.5);
  g.lineTo(xr, h);
  g.lineTo(4, h);
  g.closePath();
  const fill = g.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, color + '38');
  fill.addColorStop(1, color + '05');
  g.fillStyle = fill;
  g.fill();
  if (e.loop) {
    g.strokeStyle = color + '90';
    g.setLineDash([2, 2]);
    g.beginPath();
    g.moveTo(xd, y(e.s) - 4);
    g.quadraticCurveTo((4 + xd) / 2, 2, 6, y(0.05));
    g.stroke();
    g.setLineDash([]);
  }
  if (level >= 0 && stage > 0) {
    // live position marker
    let x = 4;
    if (stage === 1) x = 4 + (xa - 4) * Math.min(1, Math.max(0, -Math.log(1 - level * (1 - Math.exp(-1.466))) / 1.466));
    else if (stage === 2) x = e.s >= 0.999 || Math.abs(level - e.s) < 0.004 ? (xd + xs) / 2 : xa + (xd - xa) * Math.min(1, Math.max(0, -Math.log(Math.max(1e-4, (level - e.s) / (1 - e.s))) / 4));
    else x = xs + (xr - xs) * Math.min(1, Math.max(0, -Math.log(Math.max(1e-4, (level + 0.02) / (e.s + 0.02))) / 3.93));
    g.fillStyle = '#fff';
    g.shadowColor = color;
    g.shadowBlur = 8;
    g.beginPath();
    g.arc(x, y(level), 2.6, 0, TAU);
    g.fill();
    g.shadowBlur = 0;
  }
}

// ---------------- LFO ----------------
export function lfoShape(shape: string, p: number, seed = 3): number {
  p -= Math.floor(p);
  switch (shape) {
    case 'sine': return Math.sin(TAU * p);
    case 'tri': return tri(p);
    case 'saw': return 2 * p - 1;
    case 'square': return p < 0.5 ? 1 : -1;
    case 'sh': {
      const k = Math.floor(p * 8) + seed;
      const x = Math.sin(k * 78.233) * 43758.5453;
      return (x - Math.floor(x)) * 2 - 1;
    }
    default: {
      const q = p * 4, k = Math.floor(q), f = q - k;
      const r = (j: number) => {
        const x = Math.sin((j + seed) * 78.233) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
      };
      const s = f * f * (3 - 2 * f);
      return r(k) + (r(k + 1) - r(k)) * s;
    }
  }
}

export function drawLfo(cv: Cv, l: RuneLfo, color: string, phase = -1, value = 0) {
  frame(cv, 4, 2);
  const { g, w, h } = cv;
  const y = (v: number) => h / 2 - v * (h / 2 - 4);
  g.beginPath();
  const N = Math.floor(w);
  const stepped = l.shape === 'square' || l.shape === 'sh';
  for (let i = 0; i <= N; i++) {
    const p = i / N;
    const v = lfoShape(l.shape, p);
    if (i === 0) g.moveTo(0, y(v));
    else if (stepped) {
      const pv = lfoShape(l.shape, (i - 1) / N);
      if (pv !== v) g.lineTo(i, y(pv));
      g.lineTo(i, y(v));
    } else g.lineTo(i, y(v));
  }
  glowLine(g, color, 1.4);
  if (l.fade > 0) {
    // fade-in ramp hint
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(Math.min(w, (l.fade / 2) * w), 3);
    g.stroke();
  }
  if (phase >= 0) {
    g.fillStyle = '#fff';
    g.shadowColor = color;
    g.shadowBlur = 8;
    g.beginPath();
    g.arc(phase * w, y(l.shape === 'sh' || l.shape === 'smooth' ? value : lfoShape(l.shape, phase)), 2.6, 0, TAU);
    g.fill();
    g.shadowBlur = 0;
  }
}
