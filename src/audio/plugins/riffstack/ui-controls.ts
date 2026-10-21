// Riffstack UI controls: knobs (amp chicken-head, stompbox, rack), switches, selectors, sliders and
// LED meters. Every control binds to one FxSlot param and re-reads it in update().
import type { FxPluginUIApi } from '../api';
import { fmtParam, fromNorm, toNorm, type ParamDef } from '../../../core/params';
import { clamp, el } from '../../../core/util';
import { drag, lockHint, showMenu, promptDialog, type MenuItem } from '../../../ui/widgets';
import { AUTOMATABLE, RS_PARAM } from './params';

export interface Ctl {
  el: HTMLElement;
  update(): void;
}

/** Binding context shared by all controls of one rack window. */
export class Binder {
  ctls: Ctl[] = [];
  constructor(public api: FxPluginUIApi) {}
  def(k: string): ParamDef {
    return RS_PARAM[k];
  }
  get(k: string): number {
    const v = this.api.getSlot()?.params[k];
    return typeof v === 'number' && isFinite(v) ? v : RS_PARAM[k]?.def ?? 0;
  }
  on(k: string) {
    return this.get(k) >= 0.5;
  }
  fmt(k: string, v = this.get(k)) {
    return fmtParam(RS_PARAM[k], v);
  }
  commit(label: string, k: string, v: number) {
    this.api.commit(label, (s) => {
      s.params[k] = v;
    });
  }
  toggle(k: string, label?: string) {
    const v = this.on(k) ? 0 : 1;
    this.commit(`${label ?? RS_PARAM[k].label} ${v ? 'on' : 'off'}`, k, v);
  }
  add<T extends Ctl>(c: T): T {
    this.ctls.push(c);
    return c;
  }
  update() {
    for (const c of this.ctls) c.update();
  }
  /** Right-click menu shared by continuous controls. */
  menu(e: MouseEvent, k: string, unit: string) {
    e.preventDefault();
    e.stopPropagation();
    const d = RS_PARAM[k];
    const items: MenuItem[] = [
      { label: `Reset ${d.label} (${fmtParam(d, d.def)})`, action: () => this.commit('Reset ' + d.label, k, d.def) },
      {
        label: 'Type in value…',
        action: async () => {
          const v = await promptDialog(`${unit} — ${d.label}`, `Value (${d.min} – ${d.max})`, String(+this.get(k).toFixed(4)));
          if (v === null) return;
          const n = parseFloat(v);
          if (!isNaN(n)) this.commit(d.label, k, clamp(n, d.min, d.max));
        },
      },
    ];
    if (AUTOMATABLE.has(k)) items.push({ sep: true }, { label: 'Create automation clip', action: () => this.api.automate(k) });
    showMenu(items, e.clientX, e.clientY);
  }
}

/** Shared drag behaviour: vertical drag (Shift/Ctrl = fine), wheel, double-click / Alt-click reset. */
function bindDrag(b: Binder, target: HTMLElement, k: string, unit: string, onChange: () => void, sens = 200) {
  const d = RS_PARAM[k];
  const hint = () => `${unit} — ${d.label}: ${b.fmt(k)}`;
  const setN = (n: number) => {
    const v = fromNorm(d, clamp(n, 0, 1));
    if (v !== b.get(k)) b.api.live((s) => (s.params[k] = v));
    onChange();
    lockHint(hint());
  };
  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) {
      b.commit('Reset ' + d.label, k, d.def);
      return;
    }
    const startN = toNorm(d, b.get(k));
    b.api.begin(`${unit} ${d.label}`);
    target.classList.add('active');
    lockHint(hint());
    let acc = 0, last = 0;
    drag(
      e,
      (_dx, dy, ev) => {
        const fine = ev.shiftKey || ev.ctrlKey ? 0.15 : 1;
        acc += (dy - last) * fine;
        last = dy;
        setN(startN - acc / sens);
      },
      () => {
        target.classList.remove('active');
        lockHint(null);
        b.api.end();
      },
    );
  });
  target.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    b.commit('Reset ' + d.label, k, d.def);
  });
  target.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const step = d.step ? 1 / ((d.max - d.min) / d.step) : e.shiftKey ? 0.004 : 0.02;
      const n = clamp(toNorm(d, b.get(k)) + (e.deltaY < 0 ? step : -step), 0, 1);
      b.commit(d.label, k, fromNorm(d, n));
      lockHint(null);
    },
    { passive: false },
  );
  target.addEventListener('contextmenu', (e) => b.menu(e, k, unit));
  return hint;
}

export type KnobKind = 'chicken' | 'pedal' | 'rack' | 'mini';

const NS = 'http://www.w3.org/2000/svg';
function svg(w: number, h: number, inner: string, cls = '') {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('width', String(w));
  s.setAttribute('height', String(h));
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = inner;
  return s;
}
function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

export interface KnobOpts {
  key: string;
  unit: string;
  label?: string;
  kind: KnobKind;
  size?: number;
  /** override the value text (e.g. delay time shows note or ms) */
  text?: () => string;
  /** hide the numeric readout */
  noValue?: boolean;
}

/** A knob drawn in one of the faceplate styles. */
export function knob(b: Binder, o: KnobOpts): Ctl {
  const d = RS_PARAM[o.key];
  const size = o.size ?? (o.kind === 'chicken' ? 50 : o.kind === 'pedal' ? 40 : o.kind === 'rack' ? 40 : 30);
  const sweep = o.kind === 'chicken' ? 150 : 135;
  const face = el('div', { class: 'rs-kface', style: { width: size + 'px', height: size + 'px' } });
  // scale (ticks / numbers / value arc)
  const pad = o.kind === 'chicken' ? 13 : 7;
  const S = size + pad * 2;
  const c = S / 2;
  let scale = '';
  if (o.kind === 'chicken') {
    for (let i = 0; i <= 10; i++) {
      const a = -sweep + (i / 10) * sweep * 2;
      const r1 = size / 2 + 2, r2 = size / 2 + 6;
      const sx = Math.sin((a * Math.PI) / 180), sy = -Math.cos((a * Math.PI) / 180);
      scale += `<line x1="${(c + sx * r1).toFixed(1)}" y1="${(c + sy * r1).toFixed(1)}" x2="${(c + sx * r2).toFixed(1)}" y2="${(c + sy * r2).toFixed(1)}" class="rs-tick${i % 5 === 0 ? ' maj' : ''}"/>`;
      if (i % 5 === 0) scale += `<text x="${(c + sx * (r2 + 4.5)).toFixed(1)}" y="${(c + sy * (r2 + 4.5) + 2.6).toFixed(1)}" class="rs-num">${i}</text>`;
    }
  } else if (o.kind === 'rack' || o.kind === 'mini') {
    scale += `<path d="${arc(c, c, size / 2 + 4, -sweep, sweep)}" class="rs-arc-bg"/><path class="rs-arc"/>`;
  } else {
    for (let i = 0; i <= 10; i++) {
      const a = -sweep + (i / 10) * sweep * 2;
      const r1 = size / 2 + 2, r2 = size / 2 + (i % 5 === 0 ? 6 : 4);
      const sx = Math.sin((a * Math.PI) / 180), sy = -Math.cos((a * Math.PI) / 180);
      scale += `<line x1="${(c + sx * r1).toFixed(1)}" y1="${(c + sy * r1).toFixed(1)}" x2="${(c + sx * r2).toFixed(1)}" y2="${(c + sy * r2).toFixed(1)}" class="rs-tick"/>`;
    }
  }
  const scaleSvg = svg(S, S, scale, 'rs-kscale');
  scaleSvg.style.left = scaleSvg.style.top = -pad + 'px';
  const arcEl = scaleSvg.querySelector('.rs-arc') as SVGPathElement | null;
  const rot = el('div', { class: 'rs-krot' });
  if (o.kind === 'chicken') {
    // bakelite skirt (cap) + raised chicken-head pointer
    const s = size, h = s / 2;
    const P = (x: number, y: number) => `${(h + x * s).toFixed(2)},${(y * s).toFixed(2)}`;
    rot.append(
      svg(s, s, `<path class="rs-ch-body" d="M${P(0, 0.02)} C${P(0.05, 0.08)} ${P(0.165, 0.38)} ${P(0.165, 0.56)} C${P(0.165, 0.69)} ${P(0.09, 0.76)} ${P(0, 0.76)} C${P(-0.09, 0.76)} ${P(-0.165, 0.69)} ${P(-0.165, 0.56)} C${P(-0.165, 0.38)} ${P(-0.05, 0.08)} ${P(0, 0.02)} Z"/>` +
        `<path class="rs-ch-hi" d="M${P(-0.035, 0.12)} C${P(-0.11, 0.3)} ${P(-0.135, 0.45)} ${P(-0.135, 0.58)}"/>` +
        `<line class="rs-ch-line" x1="${h}" y1="${(s * 0.08).toFixed(2)}" x2="${h}" y2="${(s * 0.4).toFixed(2)}"/>`),
    );
  } else {
    rot.append(el('div', { class: 'rs-kptr' }));
  }
  face.append(scaleSvg, el('div', { class: 'rs-kcap' }), rot);
  const val = el('div', { class: 'rs-kval' });
  const lab = o.label === '' ? null : el('div', { class: 'rs-klabel', text: o.label ?? d.label });
  const wrap = el('div', { class: `rs-knob rs-k-${o.kind}` }, face, lab, o.noValue ? null : val);
  const update = () => {
    const v = b.get(o.key);
    const n = clamp(toNorm(d, v), 0, 1);
    const a = -sweep + n * sweep * 2;
    rot.style.transform = `rotate(${a.toFixed(1)}deg)`;
    if (arcEl) {
      const bip = d.min < 0 && d.max > 0;
      const a0 = bip ? -sweep + toNorm(d, 0) * sweep * 2 : -sweep;
      arcEl.setAttribute('d', Math.abs(a - a0) < 0.5 ? '' : arc(c, c, size / 2 + 4, Math.min(a0, a), Math.max(a0, a)));
    }
    const t = o.text ? o.text() : b.fmt(o.key, v);
    val.textContent = t;
    wrap.dataset.hint = `${o.unit} — ${d.label}: ${t}. Drag or scroll to adjust (Shift = fine), double-click to reset, right-click for more`;
  };
  bindDrag(b, face, o.key, o.unit, update);
  update();
  return b.add({ el: wrap, update });
}

/** Two-state switch: 'toggle' (bat-handle), 'led' (push button with LED), 'foot' (stomp footswitch). */
export function toggle(b: Binder, key: string, unit: string, kind: 'toggle' | 'led' | 'foot' | 'power', label?: string, hint?: string): Ctl {
  const d = RS_PARAM[key];
  const inner = kind === 'toggle' ? el('div', { class: 'rs-bat' }, el('div', { class: 'rs-bat-h' })) : kind === 'foot' ? el('div', { class: 'rs-foot-cap' }) : el('div', { class: 'rs-led' });
  const wrap = el('button', { class: `rs-sw rs-sw-${kind}` }, inner, label ? el('span', { class: 'rs-sw-l', text: label }) : null);
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    b.toggle(key, `${unit} ${label ?? d.label}`);
  });
  const update = () => {
    const on = b.on(key);
    wrap.classList.toggle('on', on);
    wrap.dataset.hint = `${unit} — ${hint ?? d.label}: ${on ? 'ON' : 'OFF'} (click to toggle)`;
  };
  update();
  return b.add({ el: wrap, update });
}

/** Segmented selector for discrete params (options as buttons). */
export function seg(b: Binder, key: string, unit: string, labels?: string[], cls = '', hints?: string[]): Ctl {
  const d = RS_PARAM[key];
  const opts = labels ?? d.options ?? [];
  const btns = opts.map((t, i) => {
    const btn = el('button', { class: 'rs-seg-b', text: t });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (Math.round(b.get(key)) !== i) b.commit(`${unit} ${d.label}: ${d.options?.[i] ?? t}`, key, i);
    });
    btn.dataset.hint = `${unit} — ${d.label}: ${hints?.[i] ?? d.options?.[i] ?? t}`;
    return btn;
  });
  const wrap = el('div', { class: 'rs-seg ' + cls }, ...btns);
  const update = () => {
    const v = Math.round(b.get(key));
    btns.forEach((x, i) => x.classList.toggle('on', i === v));
  };
  update();
  return b.add({ el: wrap, update });
}

/** Vertical fader (graphic EQ). */
export function vslider(b: Binder, key: string, unit: string, label: string, h = 92): Ctl {
  const d = RS_PARAM[key];
  const cap = el('div', { class: 'rs-vs-cap' });
  const fill = el('div', { class: 'rs-vs-fill' });
  const track = el('div', { class: 'rs-vs-track', style: { height: h + 'px' } }, el('div', { class: 'rs-vs-zero' }), fill, cap);
  const val = el('div', { class: 'rs-vs-val' });
  const wrap = el('div', { class: 'rs-vs' }, track, el('div', { class: 'rs-vs-l', text: label }), val);
  const update = () => {
    const v = b.get(key);
    const n = clamp(toNorm(d, v), 0, 1);
    cap.style.bottom = `calc(${(n * 100).toFixed(2)}% - 7px)`;
    const z = toNorm(d, 0);
    fill.style.bottom = (Math.min(n, z) * 100).toFixed(2) + '%';
    fill.style.height = (Math.abs(n - z) * 100).toFixed(2) + '%';
    fill.classList.toggle('neg', n < z);
    val.textContent = (v > 0 ? '+' : '') + v.toFixed(1);
    wrap.dataset.hint = `${unit} — ${d.label}: ${b.fmt(key, v)}. Drag to adjust, double-click to reset`;
  };
  bindDrag(b, track, key, unit, update, h);
  update();
  return b.add({ el: wrap, update });
}

/** Bind an arbitrary element as a vertical drag handle for a param (e.g. the wah treadle). */
export function dragArea(b: Binder, target: HTMLElement, key: string, unit: string, onChange: () => void, sens = 120) {
  bindDrag(b, target, key, unit, onChange, sens);
}

// ---------------------------------------------------------------- LED meters
export class LedMeter {
  readonly el: HTMLCanvasElement;
  private level = -90;
  private peak = -90;
  private peakT = 0;
  private dpr = 1;
  constructor(private w: number, private h: number, private vertical = false, private segs = 24) {
    this.el = el('canvas', { class: 'rs-meter', style: { width: w + 'px', height: h + 'px' } });
    this.resize();
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.el.width = Math.round(this.w * dpr);
    this.el.height = Math.round(this.h * dpr);
  }
  /** Feed a new peak (linear) — ballistics: instant attack, ~20 dB/s fall, 1.2 s peak hold. */
  push(pk: number, dt: number) {
    const db = 20 * Math.log10(Math.max(pk, 1e-5));
    this.level = db > this.level ? db : Math.max(db, this.level - 26 * dt);
    if (db >= this.peak) {
      this.peak = db;
      this.peakT = 1.2;
    } else if ((this.peakT -= dt) < 0) this.peak = Math.max(this.level, this.peak - 18 * dt);
    this.draw();
  }
  reset() {
    this.level = this.peak = -90;
    this.draw();
  }
  get peakDb() {
    return this.peak;
  }
  private draw() {
    const c = this.el.getContext('2d');
    if (!c) return;
    const { dpr, segs } = this;
    const W = this.el.width, H = this.el.height;
    c.clearRect(0, 0, W, H);
    const min = -60;
    const gap = 1.5 * dpr;
    const len = this.vertical ? H : W;
    const seg = (len - gap * (segs - 1)) / segs;
    const lit = clamp((this.level - min) / -min, 0, 1) * segs;
    const pk = Math.floor(clamp((this.peak - min) / -min, 0, 1) * segs - 0.001);
    for (let i = 0; i < segs; i++) {
      const dbAt = min + ((i + 1) / segs) * -min;
      const col = dbAt > -3 ? [240, 70, 55] : dbAt > -12 ? [240, 196, 60] : [110, 220, 90];
      const on = i < lit || i === pk;
      c.fillStyle = on ? `rgb(${col[0]},${col[1]},${col[2]})` : `rgba(${col[0]},${col[1]},${col[2]},0.13)`;
      const p = i * (seg + gap);
      if (this.vertical) c.fillRect(0, H - p - seg, W, seg);
      else c.fillRect(p, 0, seg, H);
    }
  }
}

/** Peak of an analyser's time-domain block. */
export function analyserPeak(a: AnalyserNode, buf: Float32Array): number {
  a.getFloatTimeDomainData(buf as any);
  let pk = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] < 0 ? -buf[i] : buf[i];
    if (v > pk) pk = v;
  }
  return pk;
}
