// Halcyon UI toolkit: a cached, normalised copy of the patch + helpers that bind widgets to it.
import type { PluginUIApi } from '../api';
import type { ParamDef } from '../../../core/params';
import { el } from '../../../core/util';
import { knob, KnobEl, select } from '../../../ui/widgets';
import { ensureState, HState } from './defs';

export interface Viz {
  fr: number[];
  cut: number[];
  lv: number[];
  lp: number[];
  env: number[];
  es: number[];
  n: number;
  mac: number[];
}

export class Ctx {
  cur: HState;
  viz: Viz | null = null;
  vizAt = 0;
  private last = '';
  private updaters: (() => void)[] = [];
  private frames: ((now: number) => void)[] = [];
  constructor(public api: PluginUIApi) {
    this.cur = ensureState(JSON.parse(JSON.stringify(api.getState() ?? {})));
  }
  get s(): HState {
    return this.cur;
  }
  /** Re-read the project state; run updaters only when it actually changed. */
  refresh(force = false) {
    const str = JSON.stringify(this.api.getState() ?? null);
    if (!force && str === this.last) return;
    this.last = str;
    this.cur = ensureState(JSON.parse(str));
    for (const u of this.updaters) u();
  }
  onUpdate(fn: () => void) {
    this.updaters.push(fn);
  }
  onFrame(fn: (now: number) => void) {
    this.frames.push(fn);
  }
  tick(now: number) {
    for (const f of this.frames) f(now);
  }
  /** One undoable change (also applied to the local copy right away). */
  commit(label: string, fn: (s: HState) => void) {
    fn(this.cur);
    this.api.commit(label, (s) => fn(ensureState(s)));
  }
  begin(label: string) {
    this.api.begin(label);
  }
  live(fn: (s: HState) => void) {
    fn(this.cur);
    this.api.live((s) => fn(ensureState(s)));
  }
  end() {
    this.api.end();
  }
  /** Live viz is recent enough to trust (voices sounding). */
  vizLive() {
    return !!this.viz && performance.now() - this.vizAt < 400 && this.viz.n > 0;
  }
}

// ---------------- formatting ----------------
export const pct = (v: number) => Math.round(v * 100) + '%';
export const bip = (v: number) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%';
export const secs = (v: number) => (v < 0.001 ? '0 ms' : v < 1 ? (v * 1000).toFixed(v < 0.01 ? 1 : 0) + ' ms' : v.toFixed(2) + ' s');
export const hz = (v: number) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' Hz');
export const st = (v: number) => (v > 0 ? '+' : '') + Math.round(v) + ' st';
export const cents = (v: number) => (v > 0 ? '+' : '') + Math.round(v) + ' ct';
export const panFmt = (v: number) => (Math.abs(v) < 0.01 ? 'C' : Math.round(Math.abs(v) * 100) + (v < 0 ? 'L' : 'R'));
export const dbFmt = (g: number) => (g <= 1e-5 ? '-inf dB' : (20 * Math.log10(g) > 0 ? '+' : '') + (20 * Math.log10(g)).toFixed(1) + ' dB');

export function def(label: string, min: number, max: number, d: number, fmt?: (v: number) => string, extra: Partial<ParamDef> = {}): ParamDef {
  return { key: label, label, min, max, def: d, fmt, ...extra };
}

// ---------------- bound widgets ----------------
export interface PKnob {
  label: string;
  name: string;
  def: ParamDef;
  get: (s: HState) => number;
  set: (s: HState, v: number) => void;
  size?: number;
  color?: string;
  bipolar?: boolean;
  onAutomate?: () => void;
}
export function pknob(ctx: Ctx, o: PKnob): KnobEl {
  const k = knob({
    def: o.def,
    get: () => o.get(ctx.s),
    set: (v) => ctx.live((s) => o.set(s, v)),
    begin: () => ctx.begin(`${o.name} ${o.def.label}`),
    end: () => ctx.end(),
    size: o.size ?? 26,
    label: o.label,
    bipolar: o.bipolar,
    color: o.color,
    name: o.name,
    onAutomate: o.onAutomate,
  });
  ctx.onUpdate(() => k.update());
  return k;
}

export function psel(ctx: Ctx, options: string[] | { value: number; label: string }[], get: (s: HState) => number, set: (s: HState, v: number) => void, hint: string, label: string, cls = ''): HTMLSelectElement {
  const opts = options.map((o, i) => (typeof o === 'string' ? { value: i, label: o } : o));
  const sel = select(opts, get(ctx.s), (v) => ctx.commit(label, (s) => set(s, v)), hint);
  sel.classList.add('hc-sel');
  if (cls) sel.classList.add(...cls.split(' '));
  ctx.onUpdate(() => {
    const v = String(get(ctx.s));
    if (sel.value !== v) sel.value = v;
  });
  return sel;
}

export function pled(ctx: Ctx, get: (s: HState) => boolean, set: (s: HState, v: boolean) => void, hint: string, label: string): HTMLButtonElement {
  const b = el('button', { class: 'hc-led', 'data-hint': hint }) as HTMLButtonElement;
  b.onclick = (e) => {
    e.stopPropagation();
    const v = !get(ctx.s);
    ctx.commit(label, (s) => set(s, v));
  };
  ctx.onUpdate(() => b.classList.toggle('on', get(ctx.s)));
  return b;
}

export function ptoggle(ctx: Ctx, text: string, get: (s: HState) => boolean, set: (s: HState, v: boolean) => void, hint: string, label: string): HTMLButtonElement {
  const b = el('button', { class: 'hc-tog', text, 'data-hint': hint }) as HTMLButtonElement;
  b.onclick = () => {
    const v = !get(ctx.s);
    ctx.commit(label, (s) => set(s, v));
  };
  ctx.onUpdate(() => b.classList.toggle('on', get(ctx.s)));
  return b;
}

export interface HCanvas {
  cv: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
}
export function hcanvas(w: number, h: number, cls: string, hint: string): HCanvas {
  const cv = el('canvas', { class: cls, 'data-hint': hint }) as HTMLCanvasElement;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cv, g, w, h };
}

/** Panel shell: header (title + extras) and body. */
export function panel(cls: string, title: string | HTMLElement, ...extra: (HTMLElement | null)[]): { root: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const head = el('div', { class: 'hc-head' }, typeof title === 'string' ? el('span', { class: 'hc-title', text: title }) : title, ...extra);
  const body = el('div', { class: 'hc-body' });
  const root = el('div', { class: 'hc-panel ' + cls }, head, body);
  return { root, head, body };
}

/** Segmented tab strip. */
export function tabs(labels: string[], get: () => number, set: (i: number) => void, hint: (i: number) => string): { el: HTMLElement; update: () => void; btns: HTMLButtonElement[] } {
  const btns = labels.map((l, i) => el('button', { class: 'hc-tab', text: l, 'data-hint': hint(i), onclick: () => set(i) }) as HTMLButtonElement);
  const wrap = el('div', { class: 'hc-tabs' }, ...btns);
  const update = () => btns.forEach((b, i) => b.classList.toggle('on', i === get()));
  update();
  return { el: wrap, update, btns };
}

/** Small canvas read-out with a dark pill behind it (stays legible over curves). align: 'right' anchors at x. */
export function tag(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, align: 'left' | 'right' = 'right') {
  g.save();
  g.font = '700 9px Inter, Segoe UI, sans-serif';
  const w = g.measureText(text).width + 8;
  const x0 = align === 'right' ? x - w : x;
  g.fillStyle = 'rgba(8,11,15,0.78)';
  g.beginPath();
  if ((g as any).roundRect) (g as any).roundRect(x0, y - 9, w, 13, 3);
  else g.rect(x0, y - 9, w, 13);
  g.fill();
  g.fillStyle = color;
  g.textAlign = 'left';
  g.fillText(text, x0 + 4, y + 1);
  g.restore();
}

export function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export const COL = {
  osc: ['#4fd1ff', '#62a8ff', '#8f8cff'],
  sub: '#4fd1ff',
  filt: '#ffb648',
  env: '#74e39a',
  lfo: '#b28cff',
  mod: '#ff6fa8',
  fx: '#5ee6d0',
  mac: '#ffd166',
  master: '#e8eef5',
};
