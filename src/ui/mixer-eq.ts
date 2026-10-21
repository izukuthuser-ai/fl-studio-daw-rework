// Track EQ view for the Mixer's side panel (FL's per-track 3-band EQ): a frequency-response graph with
// low-shelf / mid-peak / high-shelf handles plus three gain sliders. It edits the track's first
// "Parametric EQ" effect slot; when the track has none, one is added on the first drag (one undo step).
import { store } from '../core/store';
import { FxSlot, MixerTrack } from '../core/types';
import { FX_DEFS, ParamDef } from '../core/params';
import { newFx } from '../core/project';
import { clamp, el, fmtHz } from '../core/util';
import { engine } from '../audio/engine';
import { drag, lockHint, showMenu, toast } from './widgets';
import { openFxWindow } from './pluginWindow';
import { MAX_FX, commitSlot, liveSlot, removeFx, resetFx, toggleFx } from './mixer-ops';

const F_MIN = 20;
const F_MAX = 20000;
const G_MAX = 18;

type Band = 'low' | 'mid' | 'high';
const BANDS: { id: Band; f: string; g: string; label: string; color: string }[] = [
  { id: 'low', f: 'lowFreq', g: 'lowGain', label: 'Low', color: '#f0b43c' },
  { id: 'mid', f: 'midFreq', g: 'midGain', label: 'Mid', color: '#a7d94b' },
  { id: 'high', f: 'highFreq', g: 'highGain', label: 'High', color: '#5cc8e8' },
];

// ---------------------------------------------------------------------------
// biquad magnitude (Web Audio / RBJ formulas, same filters as the EQ effect)
// ---------------------------------------------------------------------------
type BQ = [number, number, number, number, number, number];
function coef(type: 'hp' | 'lp' | 'ls' | 'hs' | 'pk', f: number, fs: number, gain = 0, q = 0.707): BQ {
  const w0 = (2 * Math.PI * clamp(f, 1, fs / 2 - 1)) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, gain / 40);
  if (type === 'hp' || type === 'lp') {
    const a = sw / (2 * Math.pow(10, q / 20)); // Web Audio: LP/HP Q is in dB
    const b1 = type === 'lp' ? 1 - cw : -(1 + cw);
    const b0 = type === 'lp' ? (1 - cw) / 2 : (1 + cw) / 2;
    return [b0, b1, b0, 1 + a, -2 * cw, 1 - a];
  }
  if (type === 'pk') {
    const a = sw / (2 * q);
    return [1 + a * A, -2 * cw, 1 - a * A, 1 + a / A, -2 * cw, 1 - a / A];
  }
  const a = (sw / 2) * Math.SQRT2;
  const s = 2 * Math.sqrt(A) * a;
  if (type === 'ls') return [A * (A + 1 - (A - 1) * cw + s), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - s), A + 1 + (A - 1) * cw + s, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - s];
  return [A * (A + 1 + (A - 1) * cw + s), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - s), A + 1 - (A - 1) * cw + s, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - s];
}

/** Complex response (re, im) of a cascade at frequency f. */
function cascade(bqs: BQ[], f: number, fs: number): [number, number] {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let re = 1, im = 0;
  for (const [b0, b1, b2, a0, a1, a2] of bqs) {
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    const dd = dr * dr + di * di || 1e-12;
    const hr = (nr * dr + ni * di) / dd, hi = (ni * dr - nr * di) / dd;
    const r2 = re * hr - im * hi;
    im = re * hi + im * hr;
    re = r2;
  }
  return [re, im];
}

const fx = (x: number, w: number) => F_MIN * Math.pow(F_MAX / F_MIN, clamp(x / w, 0, 1));
const xf = (f: number, w: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;

function paramDef(key: string): ParamDef {
  return FX_DEFS.eq.params.find((p) => p.key === key)!;
}
function roundFreq(f: number) {
  const m = Math.pow(10, Math.floor(Math.log10(f)) - 2);
  return Math.round(f / m) * m;
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------
export class EqView {
  readonly root: HTMLElement;
  private cv: HTMLCanvasElement;
  private tag: HTMLElement;
  private sliders: { band: (typeof BANDS)[number]; cap: HTMLElement; track: HTMLElement }[] = [];
  private trackId = '';
  private sig = '';
  private cw = 0;
  private ch = 0;
  private hot: Band | null = null;

  constructor() {
    this.cv = el('canvas', { class: 'mx-eq-cv' }) as HTMLCanvasElement;
    this.tag = el('div', { class: 'mx-eq-tag' });
    const graph = el('div', { class: 'mx-eq-graph' }, this.cv, this.tag);
    const sl = el('div', { class: 'mx-eq-sliders' });
    for (const b of BANDS) {
      const cap = el('div', { class: 'mx-eq-cap' });
      cap.style.setProperty('--bc', b.color);
      const track = el('div', { class: 'mx-eq-track' }, el('div', { class: 'mx-eq-mid' }), cap);
      const col = el('div', { class: 'mx-eq-sl', 'data-hint': `${b.label} band gain — drag, double-click to reset (adds an EQ effect on first use)` }, track, el('div', { class: 'mx-eq-l', text: b.label[0] }));
      this.sliders.push({ band: b, cap, track });
      sl.append(col);
      track.addEventListener('pointerdown', (e) => this.sliderDown(e, b, track));
      track.addEventListener('dblclick', () => this.resetBand(b));
    }
    this.root = el('div', { class: 'mx-eq', 'data-hint': 'Track EQ — drag the handles (low shelf · mid peak · high shelf); wheel on the mid handle sets its width, double-click resets a band, right-click for more. Edits the track’s first Parametric EQ slot (added automatically on first drag)' }, graph, sl);

    this.cv.addEventListener('pointerdown', (e) => this.graphDown(e));
    this.cv.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const b = this.pick(e);
      if (b !== this.hot) {
        this.hot = b;
        this.draw();
      }
    });
    this.cv.addEventListener('pointerleave', () => {
      if (this.hot) {
        this.hot = null;
        this.draw();
      }
    });
    this.cv.addEventListener('dblclick', (e) => {
      const b = this.pick(e);
      if (b) this.resetBand(BANDS.find((x) => x.id === b)!);
    });
    this.cv.addEventListener(
      'wheel',
      (e) => {
        const b = this.pick(e);
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        const ed = this.startEdit();
        if (!ed) return;
        ed.apply((s) => {
          if (b === 'mid') {
            const d = paramDef('midQ');
            s.params.midQ = clamp((s.params.midQ ?? 1) * (e.deltaY < 0 ? 1.12 : 1 / 1.12), d.min, d.max);
          } else {
            const g = BANDS.find((x) => x.id === b)!.g;
            s.params[g] = clamp(Math.round(((s.params[g] ?? 0) + (e.deltaY < 0 ? 0.5 : -0.5)) * 10) / 10, -G_MAX, G_MAX);
          }
        });
        ed.done();
      },
      { passive: false },
    );
    this.cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const s = this.slot();
      showMenu(
        [
          { label: 'Open EQ window', disabled: !s, action: () => s && openFxWindow(s.id, 'show') },
          { label: s && !s.enabled ? 'Enable EQ' : 'Bypass EQ', disabled: !s, action: () => s && toggleFx(s.id) },
          { label: 'Reset EQ', disabled: !s, action: () => s && resetFx(s.id) },
          { sep: true },
          { label: 'Remove EQ effect', disabled: !s, action: () => s && removeFx(s.id) },
        ],
        e.clientX,
        e.clientY,
      );
    });
    new ResizeObserver(() => this.resize()).observe(this.cv);
  }

  setTrack(id: string) {
    if (id !== this.trackId) {
      this.trackId = id;
      this.sig = '';
    }
    this.update();
  }

  private track(): MixerTrack | undefined {
    return store.project.mixer.find((m) => m.id === this.trackId);
  }
  private slot(): FxSlot | undefined {
    return this.track()?.fx.find((f) => f.type === 'eq');
  }

  update() {
    const s = this.slot();
    const t = this.track();
    const sig = s ? `${s.id}|${s.enabled}|${s.mix}|${JSON.stringify(s.params)}` : 'none';
    if (sig === this.sig) return;
    this.sig = sig;
    const k = t ? t.fx.indexOf(s!) : -1;
    this.tag.textContent = s ? `EQ · slot ${k + 1}${s.enabled ? '' : ' (bypassed)'}` : 'EQ · drag to add';
    this.root.classList.toggle('none', !s);
    this.root.classList.toggle('bypassed', !!s && !s.enabled);
    for (const { band, cap } of this.sliders) {
      const g = s?.params[band.g] ?? 0;
      cap.style.top = ((1 - (g + G_MAX) / (2 * G_MAX)) * 100).toFixed(2) + '%';
    }
    this.draw();
  }

  private resize() {
    const r = this.cv.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    const dpr = window.devicePixelRatio || 1;
    this.cw = r.width;
    this.ch = r.height;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.draw();
  }

  private params(): Record<string, number> {
    const s = this.slot();
    const o: Record<string, number> = {};
    for (const p of FX_DEFS.eq.params) o[p.key] = s?.params[p.key] ?? p.def;
    return o;
  }

  private handlePos(b: (typeof BANDS)[number], p: Record<string, number>) {
    const w = this.cw, h = this.ch;
    return { x: xf(p[b.f], w), y: h / 2 - (p[b.g] / G_MAX) * (h / 2 - 5) };
  }

  private pick(e: MouseEvent): Band | null {
    const r = this.cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = this.params();
    let best: Band | null = null;
    let bd = Infinity;
    for (const b of BANDS) {
      const h = this.handlePos(b, p);
      const d = Math.hypot(h.x - x, (h.y - y) * 0.6);
      if (d < bd) {
        bd = d;
        best = b.id;
      }
    }
    return bd < 60 ? best : null;
  }

  private draw() {
    const c = this.cv.getContext('2d');
    const w = this.cw, h = this.ch;
    if (!c || !w || !h) return;
    const dpr = this.cv.width / w;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    // grid
    c.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(xf(f, w)) + 0.5;
      c.strokeStyle = f === 100 || f === 1000 || f === 10000 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.04)';
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
    for (const g of [-12, -6, 6, 12]) {
      const y = Math.round(h / 2 - (g / G_MAX) * (h / 2 - 5)) + 0.5;
      c.strokeStyle = 'rgba(255,255,255,0.04)';
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.beginPath();
    c.moveTo(0, Math.round(h / 2) + 0.5);
    c.lineTo(w, Math.round(h / 2) + 0.5);
    c.stroke();

    // response
    const s = this.slot();
    const p = this.params();
    const fs = engine.ready ? engine.ctx.sampleRate : 48000;
    const bqs: BQ[] = [
      coef('hp', p.lowCut, fs, 0, 0.707),
      coef('ls', p.lowFreq, fs, p.lowGain),
      coef('pk', p.midFreq, fs, p.midGain, p.midQ),
      coef('pk', p.presFreq, fs, p.presGain, 0.9),
      coef('hs', p.highFreq, fs, p.highGain),
      coef('lp', p.highCut, fs, 0, 0.707),
    ];
    const mix = s && s.enabled ? s.mix : 0; // no EQ on the track = flat
    const dry = mix <= 0.5 ? 1 : 2 * (1 - mix);
    const wet = mix <= 0.5 ? 2 * mix : 1;
    const ys: number[] = [];
    const n = Math.max(32, Math.round(w));
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * w;
      const [re, im] = cascade(bqs, fx(x, w), fs);
      const mag = Math.hypot(dry + wet * re, wet * im);
      const db = 20 * Math.log10(Math.max(1e-6, mag));
      ys.push(clamp(h / 2 - (db / G_MAX) * (h / 2 - 5), -2, h + 2));
    }
    const live = !!s && s.enabled;
    const line = live ? '#b6e35a' : s ? '#8a969c' : '#6f7b81';
    c.beginPath();
    c.moveTo(0, h / 2);
    ys.forEach((y, i) => c.lineTo((i / n) * w, y));
    c.lineTo(w, h / 2);
    c.closePath();
    c.fillStyle = live ? 'rgba(167, 217, 75, 0.16)' : 'rgba(160, 175, 182, 0.08)';
    c.fill();
    c.beginPath();
    ys.forEach((y, i) => (i ? c.lineTo((i / n) * w, y) : c.moveTo(0, y)));
    c.strokeStyle = line;
    c.lineWidth = 1.5;
    c.stroke();

    // handles
    for (const b of BANDS) {
      const { x, y } = this.handlePos(b, p);
      const hot = this.hot === b.id;
      c.beginPath();
      c.arc(x, y, hot ? 5.5 : 4.5, 0, Math.PI * 2);
      c.fillStyle = s ? b.color : 'rgba(0,0,0,0)';
      c.globalAlpha = s ? (live ? 1 : 0.55) : 1;
      c.fill();
      c.globalAlpha = 1;
      c.lineWidth = 1.4;
      c.strokeStyle = s ? 'rgba(15,18,20,0.85)' : b.color;
      c.stroke();
    }
  }

  // ---- editing ----
  /** Start an undoable EQ edit; the EQ slot is created lazily on the first change. */
  private startEdit(label = 'Track EQ'): { apply: (fn: (s: FxSlot) => void) => void; done: () => void } | null {
    const tid = this.trackId;
    const t = this.track();
    if (!t) return null;
    let sid = t.fx.find((f) => f.type === 'eq')?.id ?? null;
    if (!sid && t.fx.length >= MAX_FX) {
      toast(`All ${MAX_FX} effect slots are in use — free one to add the track EQ`, 'warn');
      return null;
    }
    store.begin(label);
    return {
      apply: (fn) => {
        if (!sid) {
          const nfx = newFx('eq');
          sid = nfx.id;
          store.live((p) => p.mixer.find((m) => m.id === tid)?.fx.push(nfx));
        }
        liveSlot(sid, fn);
      },
      done: () => store.end(),
    };
  }

  private graphDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const b = this.pick(e);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const band = BANDS.find((x) => x.id === b)!;
    const ed = this.startEdit();
    if (!ed) return;
    const r = this.cv.getBoundingClientRect();
    const fd = paramDef(band.f);
    const p0 = this.params();
    const start = this.handlePos(band, p0);
    this.hot = b;
    drag(
      e,
      (dx, dy, ev) => {
        const fine = ev.shiftKey ? 0.25 : 1;
        const x = start.x + dx * fine, y = start.y + dy * fine;
        const f = clamp(roundFreq(fx(x, r.width)), fd.min, fd.max);
        const g = clamp(Math.round((((r.height / 2 - y) / (r.height / 2 - 5)) * G_MAX) * 10) / 10, -G_MAX, G_MAX);
        ed.apply((s) => {
          if (!ev.altKey) s.params[band.f] = f; // Alt: gain only
          s.params[band.g] = g;
        });
        lockHint(`${band.label}: ${fmtHz(f)} · ${g > 0 ? '+' : ''}${g.toFixed(1)} dB`);
      },
      () => {
        lockHint(null);
        ed.done();
      },
    );
  }

  private sliderDown(e: PointerEvent, band: (typeof BANDS)[number], track: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const ed = this.startEdit();
    if (!ed) return;
    const r = track.getBoundingClientRect();
    const g0 = this.params()[band.g];
    drag(
      e,
      (_dx, dy, ev) => {
        const fine = ev.shiftKey ? 0.25 : 1;
        const g = clamp(Math.round((g0 - (dy / r.height) * 2 * G_MAX * fine) * 10) / 10, -G_MAX, G_MAX);
        ed.apply((s) => (s.params[band.g] = g));
        lockHint(`${band.label} gain: ${g > 0 ? '+' : ''}${g.toFixed(1)} dB`);
      },
      () => {
        lockHint(null);
        ed.done();
      },
    );
  }

  private resetBand(band: (typeof BANDS)[number]) {
    const s = this.slot();
    if (s) commitSlot(s.id, `Reset EQ ${band.label.toLowerCase()}`, (x) => (x.params[band.g] = 0));
  }
}
