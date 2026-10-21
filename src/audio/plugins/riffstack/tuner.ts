// Riffstack tuner: YIN pitch detection on the rack input + an LCD display (needle + strobe band).
import { el } from '../../../core/util';

export interface Pitch {
  freq: number;
  clarity: number;
}

/** YIN on a decimated copy of the analyser block. Returns null for silence / no clear pitch. */
export function detectPitch(buf: Float32Array, sr: number): Pitch | null {
  let ss = 0;
  for (let i = 0; i < buf.length; i++) ss += buf[i] * buf[i];
  if (Math.sqrt(ss / buf.length) < 0.0025) return null; // ≈ −52 dBFS
  const D = sr > 64000 ? 8 : 4;
  const srd = sr / D;
  const n = Math.floor(buf.length / D);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < D; k++) s += buf[i * D + k];
    x[i] = s / D;
  }
  const tauMin = Math.max(2, Math.floor(srd / 1100));
  const tauMax = Math.min(Math.floor(srd / 38), Math.floor(n / 2));
  const W = n - tauMax;
  const cm = new Float32Array(tauMax + 2);
  cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax + 1 && tau < n - W; tau++) {
    let d = 0;
    for (let j = 0; j < W; j++) {
      const v = x[j] - x[j + tau];
      d += v * v;
    }
    run += d;
    cm[tau] = run > 0 ? (d * tau) / run : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau] < 0.15) {
      while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let mv = 1;
    for (let tau = tauMin; tau <= tauMax; tau++) if (cm[tau] < mv) (mv = cm[tau]), (best = tau);
    if (mv > 0.32) return null;
  }
  const a = cm[best - 1] ?? cm[best], b = cm[best], c = cm[best + 1] ?? cm[best];
  const den = a - 2 * b + c;
  const shift = Math.abs(den) > 1e-9 ? (0.5 * (a - c)) / den : 0;
  const tau = best + Math.max(-0.5, Math.min(0.5, shift));
  return { freq: srd / tau, clarity: 1 - b };
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function noteOf(freq: number, a4: number) {
  const m = 69 + 12 * Math.log2(freq / a4);
  const r = Math.round(m);
  return { midi: r, name: NAMES[((r % 12) + 12) % 12], octave: Math.floor(r / 12) - 1, cents: (m - r) * 100 };
}

/** LCD tuner display with smoothing, hold and a strobe band. */
export class TunerDisplay {
  readonly el: HTMLCanvasElement;
  private dpr = 1;
  private cents = 0;
  private shown: { name: string; octave: number; freq: number } | null = null;
  private hold = 0;
  private hist: number[] = [];
  private phase = 0;
  constructor(private w: number, private h: number) {
    this.el = el('canvas', { class: 'rs-tuner-lcd', style: { width: w + 'px', height: h + 'px' } });
    this.resize();
  }
  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.width = Math.round(this.w * this.dpr);
    this.el.height = Math.round(this.h * this.dpr);
  }
  /** Feed one detection result (or null) and redraw. */
  feed(p: Pitch | null, a4: number, dt: number) {
    if (p) {
      const n = noteOf(p.freq, a4);
      if (!this.shown || this.shown.name !== n.name || this.shown.octave !== n.octave) this.hist = [];
      this.hist.push(n.cents);
      if (this.hist.length > 5) this.hist.shift();
      const med = [...this.hist].sort((a, b) => a - b)[Math.floor(this.hist.length / 2)];
      this.cents += (med - this.cents) * (this.shown && this.shown.name === n.name ? 0.35 : 1);
      this.shown = { name: n.name, octave: n.octave, freq: p.freq };
      this.hold = 0.6;
    } else if ((this.hold -= dt) <= 0) {
      this.shown = null;
      this.hist = [];
    }
    this.phase += (this.shown ? this.cents : 0) * dt * 0.9;
    this.draw(a4);
  }
  draw(a4: number) {
    const c = this.el.getContext('2d');
    if (!c) return;
    const d = this.dpr, W = this.w, H = this.h;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, W, H);
    const on = !!this.shown;
    const cents = this.cents;
    const inTune = on && Math.abs(cents) < 3;
    const lit = inTune ? '#7dff9a' : '#ffb347';
    // note readout
    c.textBaseline = 'alphabetic';
    c.font = `700 38px ${getComputedStyle(this.el).getPropertyValue('--rs-lcd-font') || 'monospace'}`;
    c.fillStyle = on ? lit : 'rgba(255,200,120,0.12)';
    c.shadowColor = on ? lit : 'transparent';
    c.shadowBlur = on ? 10 : 0;
    const name = this.shown?.name ?? '–';
    c.fillText(name[0], 12, 46);
    c.shadowBlur = 0;
    c.font = '700 16px system-ui, sans-serif';
    if (name.length > 1) c.fillText('♯', 38, 24);
    if (on) c.fillText(String(this.shown!.octave), 38, 47);
    // scale
    const x0 = 70, x1 = W - 12, cx = (x0 + x1) / 2, y = 30;
    c.strokeStyle = 'rgba(255,200,140,0.35)';
    c.lineWidth = 1;
    for (let i = -50; i <= 50; i += 5) {
      const x = cx + (i / 50) * ((x1 - x0) / 2);
      const big = i % 25 === 0;
      c.beginPath();
      c.moveTo(x, y - (big ? 12 : i % 10 === 0 ? 8 : 5));
      c.lineTo(x, y);
      c.stroke();
    }
    c.fillStyle = 'rgba(255,200,140,0.5)';
    c.font = '9px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('♭', x0 + 4, y + 11);
    c.fillText('♯', x1 - 4, y + 11);
    c.fillText('0', cx, y + 11);
    // centre window
    c.fillStyle = inTune ? 'rgba(125,255,154,0.25)' : 'rgba(125,255,154,0.07)';
    c.fillRect(cx - 6, y - 16, 12, 18);
    // needle
    if (on) {
      const nx = cx + (Math.max(-50, Math.min(50, cents)) / 50) * ((x1 - x0) / 2);
      c.strokeStyle = lit;
      c.shadowColor = lit;
      c.shadowBlur = 8;
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(nx, y - 18);
      c.lineTo(nx, y + 2);
      c.stroke();
      c.shadowBlur = 0;
    }
    // text
    c.textAlign = 'right';
    c.font = '600 10px system-ui, sans-serif';
    c.fillStyle = on ? 'rgba(255,220,170,0.85)' : 'rgba(255,220,170,0.3)';
    c.fillText(on ? `${cents >= 0 ? '+' : ''}${cents.toFixed(1)} ¢   ${this.shown!.freq.toFixed(1)} Hz` : `A4 = ${a4} Hz`, x1, y + 24);
    c.textAlign = 'left';
    // strobe band
    const sy = H - 12, sh = 8;
    c.save();
    c.beginPath();
    c.rect(x0, sy, x1 - x0, sh);
    c.clip();
    c.fillStyle = 'rgba(255,200,140,0.06)';
    c.fillRect(x0, sy, x1 - x0, sh);
    if (on) {
      c.fillStyle = inTune ? 'rgba(125,255,154,0.75)' : 'rgba(255,179,71,0.7)';
      const period = 14;
      const off = ((this.phase % period) + period) % period;
      for (let x = x0 - period + off; x < x1; x += period) c.fillRect(x, sy, period / 2, sh);
    }
    c.restore();
  }
}
