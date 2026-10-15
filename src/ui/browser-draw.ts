// Small HiDPI canvas previews for the Browser's info strip: sample waveforms, a synth patch's
// summed oscillator shape, a pattern's notes and an automation curve.
import type { AutoPoint, SynthParams, Wave } from '../core/types';
import { rgba } from '../core/util';

export type Preview =
  | { kind: 'none' }
  | { kind: 'peaks'; data: Float32Array; color: string }
  | { kind: 'line'; data: Float32Array; color: string }
  | { kind: 'notes'; notes: { start: number; len: number; key: number; muted?: boolean }[]; length: number; color: string }
  | { kind: 'auto'; points: AutoPoint[]; length: number; color: string };

function waveAt(w: Wave, p: number, rnd: () => number): number {
  switch (w) {
    case 'sine':
      return Math.sin(p * Math.PI * 2);
    case 'triangle':
      return 1 - 4 * Math.abs(p - 0.5);
    case 'sawtooth':
      return 2 * p - 1;
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'noise':
      return rnd() * 0.6;
  }
}

/** Two cycles of the patch's summed oscillators (coarse tuning respected), normalised to ±1. */
export function synthCurve(s: SynthParams, n = 180): Float32Array {
  const out = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const ph = (i / n) * 2;
    let v = 0;
    for (const o of s.osc) {
      if (o.level <= 0) continue;
      const f = Math.pow(2, (o.coarse + o.fine / 100) / 12);
      const p = (((ph * f) % 1) + 1) % 1;
      v += o.level * waveAt(o.wave, p, rnd);
    }
    out[i] = v;
  }
  let m = 0;
  for (const v of out) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < n; i++) out[i] /= m;
  return out;
}

function prep(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (c.width !== W) c.width = W;
  if (c.height !== H) c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

export function drawPreview(c: HTMLCanvasElement, p: Preview) {
  const ctx = prep(c);
  if (!ctx) return;
  const { g, w, h } = ctx;
  const mid = h / 2;
  // faint grid: centre line + quarter ticks
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 1; i < 4; i++) g.fillRect(Math.round((w * i) / 4), 0, 1, h);
  if (p.kind === 'peaks' || p.kind === 'line') {
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, Math.round(mid), w, 1);
  }
  switch (p.kind) {
    case 'none':
      return;
    case 'peaks': {
      const n = p.data.length / 2;
      let mx = 0;
      for (const v of p.data) mx = Math.max(mx, Math.abs(v));
      const k = mx > 0 ? Math.min(1 / mx, 8) : 1;
      const amp = mid - 2;
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, rgba(p.color, 0.65));
      grad.addColorStop(0.5, p.color);
      grad.addColorStop(1, rgba(p.color, 0.65));
      g.fillStyle = grad;
      const bw = w / n;
      for (let i = 0; i < n; i++) {
        const lo = p.data[i * 2] * k;
        const hi = p.data[i * 2 + 1] * k;
        const y0 = mid - hi * amp;
        const y1 = mid - lo * amp;
        g.fillRect(i * bw, y0, Math.max(1, bw + 0.3), Math.max(1, y1 - y0));
      }
      return;
    }
    case 'line': {
      const n = p.data.length;
      const amp = mid - 3;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = mid - p.data[i] * amp;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.lineTo(w, mid);
      g.lineTo(0, mid);
      g.closePath();
      g.fillStyle = rgba(p.color, 0.14);
      g.fill();
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = mid - p.data[i] * amp;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.strokeStyle = p.color;
      g.lineWidth = 1.5;
      g.lineJoin = 'round';
      g.stroke();
      return;
    }
    case 'notes': {
      if (!p.notes.length || p.length <= 0) return;
      let lo = 127, hi = 0;
      for (const n of p.notes) {
        lo = Math.min(lo, n.key);
        hi = Math.max(hi, n.key);
      }
      lo -= 1;
      hi += 1;
      const rows = hi - lo + 1;
      const rh = Math.max(1.5, Math.min(5, (h - 4) / rows));
      const top = (h - rh * rows) / 2;
      for (const n of p.notes) {
        const x = (n.start / p.length) * w;
        const nw = Math.max(1.5, (n.len / p.length) * w - 0.5);
        const y = top + (hi - n.key) * rh;
        g.fillStyle = n.muted ? rgba(p.color, 0.3) : p.color;
        g.fillRect(x, y, nw, Math.max(1.5, rh - 0.5));
      }
      return;
    }
    case 'auto': {
      if (!p.points.length || p.length <= 0) return;
      const pts = [...p.points].sort((a, b) => a.t - b.t);
      const X = (t: number) => (t / p.length) * w;
      const Y = (v: number) => 3 + (1 - v) * (h - 6);
      g.beginPath();
      g.moveTo(0, Y(pts[0].v));
      for (const pt of pts) g.lineTo(X(pt.t), Y(pt.v));
      g.lineTo(w, Y(pts[pts.length - 1].v));
      g.lineTo(w, h);
      g.lineTo(0, h);
      g.closePath();
      g.fillStyle = rgba(p.color, 0.16);
      g.fill();
      g.beginPath();
      g.moveTo(0, Y(pts[0].v));
      for (const pt of pts) g.lineTo(X(pt.t), Y(pt.v));
      g.lineTo(w, Y(pts[pts.length - 1].v));
      g.strokeStyle = p.color;
      g.lineWidth = 1.5;
      g.stroke();
      g.fillStyle = p.color;
      for (const pt of pts) {
        g.beginPath();
        g.arc(X(pt.t), Y(pt.v), 2.2, 0, Math.PI * 2);
        g.fill();
      }
      return;
    }
  }
}
