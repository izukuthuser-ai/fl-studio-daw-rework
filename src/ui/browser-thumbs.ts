// Plugin thumbnails for the Browser's plugin database: tiny stylised panels drawn on a canvas in
// the plugin's colour (original artwork — FL shows screenshots there). Cached as data URLs.
import { rgba, shade } from '../core/util';

export const THUMB_H = 42;
const cache = new Map<string, { url: string; w: number; h: number }>();

type G = CanvasRenderingContext2D;

function rr(g: G, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function panel(g: G, w: number, h: number, c: string, header = true) {
  const body = g.createLinearGradient(0, 0, 0, h);
  body.addColorStop(0, '#3a4247');
  body.addColorStop(1, '#262c30');
  rr(g, 0.5, 0.5, w - 1, h - 1, 2.5);
  g.fillStyle = body;
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1;
  g.stroke();
  if (header) {
    g.fillStyle = shade(c, -0.15);
    rr(g, 1, 1, w - 2, 5, 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(4, 3, Math.min(22, w * 0.25), 1);
  }
}
function screen(g: G, x: number, y: number, w: number, h: number) {
  rr(g, x, y, w, h, 1.5);
  g.fillStyle = '#141a1d';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.stroke();
}
function knob(g: G, x: number, y: number, r: number, v: number, c: string) {
  g.beginPath();
  g.arc(x, y, r + 1.4, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * v);
  g.strokeStyle = c;
  g.lineWidth = 1.3;
  g.stroke();
  const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.4, 0.5, x, y, r);
  grad.addColorStop(0, '#79858c');
  grad.addColorStop(1, '#2c3338');
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = grad;
  g.fill();
  const a = Math.PI * 0.75 + Math.PI * 1.5 * v;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85);
  g.strokeStyle = '#eef4f6';
  g.lineWidth = 1;
  g.stroke();
}
function keyboard(g: G, x: number, y: number, w: number, h: number) {
  const n = Math.max(7, Math.floor(w / 4.2));
  const kw = w / n;
  g.fillStyle = '#e9edef';
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = 1; i < n; i++) g.fillRect(x + Math.round(i * kw), y, 0.6, h);
  g.fillStyle = '#1c2226';
  for (let i = 0; i < n - 1; i++) {
    const m = i % 7;
    if (m === 2 || m === 6) continue;
    g.fillRect(x + (i + 1) * kw - kw * 0.3, y, kw * 0.6, h * 0.58);
  }
}
function slider(g: G, x: number, y: number, h: number, v: number, c: string) {
  g.fillStyle = '#12171a';
  g.fillRect(x, y, 2, h);
  g.fillStyle = c;
  g.fillRect(x, y + h * (1 - v), 2, h * v);
  g.fillStyle = '#c9d2d6';
  g.fillRect(x - 2, y + h * (1 - v) - 1.5, 6, 3);
}
function curve(g: G, x: number, y: number, w: number, h: number, c: string, f: (t: number) => number, fill = true) {
  g.beginPath();
  for (let i = 0; i <= w; i++) {
    const v = f(i / w);
    const py = y + h - v * h;
    i ? g.lineTo(x + i, py) : g.moveTo(x, py);
  }
  if (fill) {
    g.lineTo(x + w, y + h);
    g.lineTo(x, y + h);
    g.closePath();
    g.fillStyle = rgba(c, 0.22);
    g.fill();
    g.beginPath();
    for (let i = 0; i <= w; i++) {
      const v = f(i / w);
      i ? g.lineTo(x + i, y + h - v * h) : g.moveTo(x, y + h - v * h);
    }
  }
  g.strokeStyle = c;
  g.lineWidth = 1.2;
  g.stroke();
}
function meter(g: G, x: number, y: number, h: number, v: number) {
  g.fillStyle = '#12171a';
  g.fillRect(x, y, 3, h);
  const grad = g.createLinearGradient(0, y + h, 0, y);
  grad.addColorStop(0, '#6fcf5a');
  grad.addColorStop(0.75, '#d9e35a');
  grad.addColorStop(1, '#f2683f');
  g.fillStyle = grad;
  g.fillRect(x, y + h * (1 - v), 3, h * v);
}

function render(key: string, w: number, h: number, draw: (g: G) => void) {
  let c = cache.get(key);
  if (c) return c;
  const cv = document.createElement('canvas');
  const S = 2;
  cv.width = w * S;
  cv.height = h * S;
  const g = cv.getContext('2d')!;
  g.scale(S, S);
  draw(g);
  c = { url: cv.toDataURL('image/png'), w, h };
  cache.set(key, c);
  return c;
}

/** Instrument thumbnail: header, display, knobs and a mini keyboard. */
export function instrumentThumb(id: string, color: string): { url: string; w: number; h: number } {
  const w = id === 'sampler' ? 92 : 108;
  const h = THUMB_H;
  return render('inst:' + id + color, w, h, (g) => {
    const r = rng(hash(id));
    panel(g, w, h, color);
    const kbH = 9;
    if (id === 'triosc') {
      // three oscillator rows with wave glyphs + level sliders
      for (let i = 0; i < 3; i++) {
        const y = 9 + i * 8;
        screen(g, 4, y, 26, 6.5);
        const kind = i;
        curve(g, 5, y + 1, 24, 4.5, color, (t) => (kind === 0 ? 0.5 + 0.5 * Math.sin(t * Math.PI * 4) : kind === 1 ? (t * 2) % 1 : (t * 2) % 1 < 0.5 ? 0.9 : 0.1), false);
        knob(g, 37, y + 3.2, 2.6, 0.3 + r() * 0.5, color);
        knob(g, 46, y + 3.2, 2.6, 0.3 + r() * 0.5, color);
      }
      screen(g, 54, 9, w - 58, 22);
      curve(g, 56, 12, w - 62, 16, color, (t) => (t < 0.08 ? t / 0.08 : t < 0.35 ? 1 - (t - 0.08) * 1.4 : t < 0.8 ? 0.62 : 0.62 * (1 - (t - 0.8) / 0.2)));
    } else if (id === 'sampler') {
      screen(g, 4, 9, w - 8, 18);
      g.fillStyle = color;
      for (let x = 0; x < w - 12; x++) {
        const env = Math.exp(-x / 22);
        const a = (0.15 + 0.85 * env) * (0.4 + r() * 0.6) * 7.5;
        g.fillRect(6 + x, 18 - a, 1, a * 2);
      }
      for (let i = 0; i < 5; i++) knob(g, 9 + i * 10, 31, 2.4, r(), color);
    } else {
      // generic synth: display with harmonic stack / wavetable lines + knob row + sliders
      const dw = Math.round(w * 0.46);
      screen(g, 4, 9, dw, 20);
      const layers = 4 + Math.floor(r() * 3);
      for (let l = 0; l < layers; l++) {
        const off = l * 2.2;
        const ph = r() * 6;
        const k = 1 + Math.floor(r() * 3);
        curve(g, 6 + off, 12 + off * 0.6, dw - 8 - layers * 2, 12, rgba(color, 0.35 + (l / layers) * 0.65), (t) => 0.5 + 0.45 * Math.sin(t * Math.PI * 2 * k + ph) * Math.cos(t * Math.PI * (l + 1) * 0.5), false);
      }
      const kx = dw + 10;
      const cols = Math.max(2, Math.floor((w - kx - 22) / 9));
      for (let row = 0; row < 2; row++) for (let i = 0; i < cols; i++) knob(g, kx + i * 9 + 3, 13 + row * 10, 2.7, r(), color);
      for (let i = 0; i < 3; i++) slider(g, w - 18 + i * 5, 9, 19, 0.3 + r() * 0.6, color);
    }
    keyboard(g, 3, h - kbH - 3, w - 6, kbH);
  });
}

/** Effect thumbnail, drawn to suggest what the effect does. */
export function effectThumb(type: string, color: string): { url: string; w: number; h: number } {
  const wide = type === 'riffstack';
  const w = wide ? 108 : type === 'eq' || type === 'reverb' ? 84 : 74;
  const h = THUMB_H;
  return render('fx:' + type + color, w, h, (g) => {
    const r = rng(hash(type));
    panel(g, w, h, color, !wide);
    switch (type) {
      case 'eq':
        screen(g, 4, 9, w - 8, h - 13);
        g.strokeStyle = 'rgba(255,255,255,0.06)';
        for (let i = 1; i < 4; i++) g.strokeRect(4 + ((w - 8) * i) / 4, 9, 0.1, h - 13);
        curve(g, 5, 11, w - 10, h - 17, color, (t) => 0.5 + 0.28 * Math.exp(-((t - 0.22) ** 2) / 0.006) - 0.22 * Math.exp(-((t - 0.58) ** 2) / 0.01) + 0.18 * Math.exp(-((t - 0.85) ** 2) / 0.008) - (t < 0.05 ? (0.05 - t) * 8 : 0));
        break;
      case 'compressor':
      case 'limiter': {
        screen(g, 4, 9, 26, h - 13);
        curve(g, 5, 11, 24, h - 17, color, (t) => (type === 'limiter' ? Math.min(t, 0.72) : t < 0.55 ? t : 0.55 + (t - 0.55) * 0.3), false);
        for (let i = 0; i < 4; i++) knob(g, 38 + (i % 2) * 12, 16 + Math.floor(i / 2) * 13, 3.6, r(), color);
        meter(g, w - 14, 9, h - 13, 0.7);
        meter(g, w - 9, 9, h - 13, 0.55);
        break;
      }
      case 'reverb':
        screen(g, 4, 9, w - 34, h - 13);
        g.fillStyle = rgba(color, 0.85);
        for (let i = 0; i < 26; i++) {
          const x = 6 + i * ((w - 40) / 26);
          const a = Math.exp(-i / 9) * (0.6 + r() * 0.4) * (h - 18);
          g.fillRect(x, h - 6 - a, 1.4, a);
        }
        knob(g, w - 21, 16, 4.2, 0.6, color);
        knob(g, w - 21, 31, 3.2, 0.35, color);
        break;
      case 'delay':
        screen(g, 4, 9, w - 8, 15);
        for (let i = 0; i < 6; i++) {
          g.beginPath();
          g.arc(10 + i * 11, 16.5, 3.4 - i * 0.45, 0, Math.PI * 2);
          g.fillStyle = rgba(color, 1 - i * 0.15);
          g.fill();
        }
        for (let i = 0; i < 5; i++) knob(g, 10 + i * 13, 32, 3.4, r(), color);
        break;
      case 'filter':
        screen(g, 4, 9, w - 8, 19);
        curve(g, 5, 11, w - 10, 15, color, (t) => (t < 0.5 ? 0.7 : t < 0.6 ? 0.7 + (t - 0.5) * 3 : Math.max(0, 1 - (t - 0.6) * 3.2)));
        for (let i = 0; i < 4; i++) knob(g, 12 + i * 16, 34, 3.6, r(), color);
        break;
      case 'distortion':
        knob(g, w / 2, 21, 9, 0.72, color);
        knob(g, 12, 15, 4, r(), color);
        knob(g, w - 12, 15, 4, r(), color);
        knob(g, 12, 31, 4, r(), color);
        knob(g, w - 12, 31, 4, r(), color);
        break;
      case 'bitcrusher':
        screen(g, 4, 9, w - 8, 18);
        g.beginPath();
        for (let i = 0; i <= 12; i++) {
          const x = 6 + i * ((w - 12) / 12);
          const v = Math.round((0.5 + 0.45 * Math.sin((i / 12) * Math.PI * 2)) * 5) / 5;
          const y = 25 - v * 14;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
          g.lineTo(x + (w - 12) / 12, y);
        }
        g.strokeStyle = color;
        g.lineWidth = 1.3;
        g.stroke();
        for (let i = 0; i < 3; i++) knob(g, 16 + i * 21, 33, 3.6, r(), color);
        break;
      case 'chorus':
        screen(g, 4, 9, w - 8, 18);
        curve(g, 5, 11, w - 10, 14, color, (t) => 0.5 + 0.4 * Math.sin(t * Math.PI * 4), false);
        curve(g, 5, 11, w - 10, 14, rgba(color, 0.5), (t) => 0.5 + 0.4 * Math.sin(t * Math.PI * 4 + 0.9), false);
        for (let i = 0; i < 3; i++) knob(g, 16 + i * 21, 33, 3.6, r(), color);
        break;
      case 'width': {
        screen(g, 4, 9, w - 8, h - 13);
        const cx = w / 2, cy = h - 6;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx - 22, 12);
        g.lineTo(cx + 22, 12);
        g.closePath();
        g.fillStyle = rgba(color, 0.25);
        g.fill();
        g.strokeStyle = color;
        g.stroke();
        for (let i = 0; i < 30; i++) {
          g.fillStyle = rgba('#e8f2f6', 0.7);
          const t = r();
          g.fillRect(cx + (r() - 0.5) * 36 * t, cy - t * (h - 18), 1.2, 1.2);
        }
        break;
      }
      case 'riffstack': {
        // amp head + stomp boxes
        rr(g, 3, 3, w - 6, 13, 2);
        g.fillStyle = '#1a1f22';
        g.fill();
        for (let i = 0; i < 6; i++) knob(g, 10 + i * 9, 9.5, 2.6, r(), color);
        g.fillStyle = rgba(color, 0.9);
        g.fillRect(w - 26, 6, 20, 7);
        const pedals = ['#e8634a', '#e8d24a', '#8fd14f', '#4aa3e8'];
        pedals.forEach((pc, i) => {
          const x = 4 + i * ((w - 8) / 4);
          const pw = (w - 8) / 4 - 3;
          rr(g, x, 19, pw, h - 22, 2);
          g.fillStyle = shade(pc, -0.25);
          g.fill();
          knob(g, x + pw / 2 - 4, 24.5, 2.2, r(), '#fff');
          knob(g, x + pw / 2 + 4, 24.5, 2.2, r(), '#fff');
          g.fillStyle = '#d8dee1';
          g.beginPath();
          g.arc(x + pw / 2, h - 7, 2.2, 0, Math.PI * 2);
          g.fill();
        });
        break;
      }
      default: {
        // unknown / newly registered effect: generic knob panel with a meter
        const cols = Math.floor((w - 16) / 13);
        for (let row = 0; row < 2; row++) for (let i = 0; i < cols; i++) knob(g, 10 + i * 13, 16 + row * 14, 4, r(), color);
        meter(g, w - 9, 9, h - 13, 0.6);
      }
    }
  });
}
