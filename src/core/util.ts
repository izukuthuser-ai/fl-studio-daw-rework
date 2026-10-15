import { PPQ, STEP, Snap } from './types';

let idCounter = 0;
export function uid(prefix = ''): string {
  idCounter = (idCounter + 1) % 1679616;
  return prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7) + idCounter.toString(36);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** FL naming: MIDI 60 = C5 */
export function noteName(key: number): string {
  return NOTE_NAMES[((key % 12) + 12) % 12] + (Math.floor(key / 12));
}
export const isBlackKey = (key: number) => [1, 3, 6, 8, 10].includes(((key % 12) + 12) % 12);
export const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => (g <= 0.001 ? -60 : 20 * Math.log10(g));
/** Channel volume knob (0..1.25, 0.8 = unity) to gain */
/** FL-like curve: 100% = 0 dB, default 78% ≈ -4.3 dB, 125% ≈ +3.9 dB */
export const chanVolToGain = (v: number) => v * v;

export function fmtDb(db: number): string {
  if (db <= -60) return '-inf dB';
  return (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';
}
export function fmtPan(p: number): string {
  if (Math.abs(p) < 0.005) return 'Centered';
  return Math.round(Math.abs(p) * 100) + '% ' + (p < 0 ? 'left' : 'right');
}
export function fmtHz(hz: number): string {
  return hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + ' kHz' : Math.round(hz) + ' Hz';
}

export function barLen(timeSig: [number, number]) {
  return Math.round(PPQ * 4 * timeSig[0] / timeSig[1]);
}

export function snapTicks(snap: Snap, timeSig: [number, number] = [4, 4]): number {
  switch (snap) {
    case 'none':
      return 1;
    case '1/6step':
      return STEP / 6;
    case '1/4step':
      return STEP / 4;
    case '1/3step':
      return STEP / 3;
    case '1/2step':
      return STEP / 2;
    case 'line':
    case 'cell':
    case 'step':
      return STEP;
    case '1/3beat':
      return PPQ / 3;
    case '1/2beat':
      return PPQ / 2;
    case 'beat':
      return PPQ;
    case 'bar':
      return barLen(timeSig);
  }
}

export const SNAP_LABELS: Record<Snap, string> = {
  line: '(Main) Line',
  cell: 'Cell',
  none: '(none)',
  '1/6step': '1/6 step',
  '1/4step': '1/4 step',
  '1/3step': '1/3 step',
  '1/2step': '1/2 step',
  step: 'Step',
  '1/3beat': '1/3 beat',
  '1/2beat': '1/2 beat',
  beat: 'Beat',
  bar: 'Bar',
};

export function snapDown(t: number, grid: number) {
  return Math.floor(t / grid + 1e-6) * grid;
}
export function snapRound(t: number, grid: number) {
  return Math.round(t / grid) * grid;
}

/** Format ticks as Bar:Step:Tick (1-based bar & step like FL). */
export function fmtBST(ticks: number, timeSig: [number, number] = [4, 4]) {
  const bl = barLen(timeSig);
  const bar = Math.floor(ticks / bl) + 1;
  const rem = ticks - (bar - 1) * bl;
  const step = Math.floor(rem / STEP) + 1;
  const tick = Math.floor(rem - (step - 1) * STEP);
  return `${bar}:${String(step).padStart(2, '0')}:${String(tick).padStart(2, '0')}`;
}
export function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  return `${m}:${String(s).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}

export const PALETTE = [
  '#c95f4f', '#cf8846', '#c9ae4b', '#86b358', '#51ad80', '#4aa8a7', '#5a92c4', '#6e78c6',
  '#9470c2', '#b866b3', '#c96687', '#8a979f', '#a97e55', '#6a9e7c', '#5d82a8', '#a184bb',
];
export function paletteColor(i: number) {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex: string, a: number) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
export function shade(hex: string, amt: number) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) => clamp(Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)), 0, 255);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: any;
  return ((...a: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}

export type Listener<T> = (v: T) => void;
export class Emitter<Events extends Record<string, any>> {
  private map = new Map<keyof Events, Set<Listener<any>>>();
  on<K extends keyof Events>(ev: K, fn: Listener<Events[K]>): () => void {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev)!.add(fn);
    return () => this.map.get(ev)!.delete(fn);
  }
  emit<K extends keyof Events>(ev: K, v: Events[K]) {
    this.map.get(ev)?.forEach((fn) => {
      try {
        fn(v);
      } catch (e) {
        console.error(e);
      }
    });
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') (e as any)[k.toLowerCase()] = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k in e && typeof v !== 'string') (e as any)[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Simple fuzzy match score: returns -1 if no match, higher is better. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length) * 0.1;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
