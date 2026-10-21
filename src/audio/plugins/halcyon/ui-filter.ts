// Halcyon UI — filter panels with a frequency-response curve computed from the parameters
// (follows modulation live while notes play).
import { el } from '../../../core/util';
import {
  clamp01, combFb, cutToNorm, FILTER_TYPES, formantQ, formantSet, formantShift, FT_BP12, FT_BP24, FT_COMB, FT_FORMANT, FT_HP12, FT_HP24, FT_LADDER, FT_LP12,
  FT_LP24, FT_N24, ladderK, normToCut, svfK, svfK24a, svfK24b,
} from './defs';
import { COL, Ctx, def, hcanvas, HCanvas, hz, panel, pct, pknob, pled, psel, rgba, tag } from './ui-kit';

const SR = 48000;
const fm6 = new Float64Array(6);

/** Complex magnitude response of a Halcyon filter at frequency f (linear gain). */
export function filterMag(type: number, fc: number, reso: number, morph: number, mix: number, f: number): number {
  let re = 1, im = 0;
  const mul = (ar: number, ai: number) => {
    const r = re * ar - im * ai;
    im = re * ai + im * ar;
    re = r;
  };
  const div = (br: number, bi: number) => {
    const d = br * br + bi * bi;
    const r = (re * br + im * bi) / d;
    im = (im * br - re * bi) / d;
    re = r;
  };
  const svf = (w: number, k: number, kind: number) => {
    // numerator by kind: 0 LP, 1 HP, 2 BP(normalised), 3 notch
    if (kind === 0) mul(1, 0);
    else if (kind === 1) mul(-w * w, 0);
    else if (kind === 2) mul(0, k * w);
    else mul(1 - w * w, 0);
    div(1 - w * w, k * w);
  };
  if (type === FT_COMB) {
    const fb = combFb(reso) * (1 - 2 * morph);
    const nrm = Math.pow(1 - Math.abs(fb), 0.5) * 1.4;
    const fcc = Math.min(fc, SR / 3);
    const om = (2 * Math.PI * f) / SR;
    // loop: 0.7 / (1 - 0.3 e^-jω) · e^{-j2π f/fc}
    const lpDr = 1 - 0.3 * Math.cos(om), lpDi = 0.3 * Math.sin(om);
    const ph = (-2 * Math.PI * f) / fcc;
    let lr = 0.7 * Math.cos(ph), li = 0.7 * Math.sin(ph);
    const d = lpDr * lpDr + lpDi * lpDi;
    const tr = (lr * lpDr + li * lpDi) / d;
    li = (li * lpDr - lr * lpDi) / d;
    lr = tr;
    re = nrm;
    im = 0;
    div(1 - fb * lr, -fb * li);
  } else if (type === FT_FORMANT) {
    formantSet(morph, fm6);
    const sh = formantShift(cutToNorm(fc));
    const k = 1 / formantQ(reso);
    let sr = 0, si = 0;
    for (let j = 0; j < 3; j++) {
      const w = f / Math.min(SR * 0.45, fm6[j] * sh);
      re = 3.2 * fm6[3 + j];
      im = 0;
      svf(w, k, 2);
      sr += re;
      si += im;
    }
    re = sr;
    im = si;
  } else if (type === FT_LADDER) {
    const w = f / fc;
    const k = ladderK(reso);
    // G = 1/(1+jw); G^4
    let gr = 1, gi = 0;
    for (let i = 0; i < 4; i++) {
      const d = 1 + w * w;
      const r = (gr * 1 + gi * w) / d;
      gi = (gi * 1 - gr * w) / d;
      gr = r;
    }
    re = gr * (1 + k * 0.55);
    im = gi * (1 + k * 0.55);
    div(1 + k * gr, k * gi);
  } else {
    const w = f / fc;
    const kind = type === FT_LP12 || type === FT_LP24 ? 0 : type === FT_HP12 || type === FT_HP24 ? 1 : type === FT_BP12 || type === FT_BP24 ? 2 : 3;
    const two = type === FT_LP24 || type === FT_HP24 || type === FT_BP24 || type === FT_N24;
    if (two) {
      svf(w, svfK24a(reso), kind);
      svf(w, svfK24b(reso), kind);
    } else svf(w, svfK(reso), kind);
  }
  const hr = 1 - mix + mix * re, hi = mix * im;
  return Math.hypot(hr, hi);
}

const DB_TOP = 18, DB_BOT = -36;

function drawResponse(c: HCanvas, type: number, cutN: number, reso: number, morph: number, mix: number, on: boolean, color: string, live: boolean) {
  const { g, w, h } = c;
  g.clearRect(0, 0, w, h);
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0a0d12');
  bg.addColorStop(1, '#0f141b');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const xOf = (f: number) => (Math.log2(f / 20) / Math.log2(1000)) * w;
  const yOf = (db: number) => ((DB_TOP - db) / (DB_TOP - DB_BOT)) * h;
  g.strokeStyle = 'rgba(140,160,190,0.07)';
  g.lineWidth = 1;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(f)) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
  for (const db of [12, 0, -12, -24]) {
    const y = Math.round(yOf(db)) + 0.5;
    g.strokeStyle = db === 0 ? 'rgba(140,160,190,0.16)' : 'rgba(140,160,190,0.07)';
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  g.fillStyle = 'rgba(160,175,195,0.35)';
  g.font = '8px Inter, Segoe UI, sans-serif';
  g.fillText('100', xOf(100) + 2, h - 3);
  g.fillText('1k', xOf(1000) + 2, h - 3);
  g.fillText('10k', xOf(10000) + 2, h - 3);
  const fc = normToCut(cutN);
  const pts: number[] = [];
  const N = Math.round(w);
  for (let i = 0; i <= N; i++) {
    const f = 20 * Math.pow(1000, i / N);
    const m = on ? filterMag(type, fc, reso, morph, mix, f) : 1;
    const db = 20 * Math.log10(Math.max(1e-6, m));
    pts.push(i, Math.max(-2, Math.min(h + 2, yOf(db))));
  }
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, rgba(color, on ? 0.34 : 0.08));
  grad.addColorStop(1, rgba(color, 0.02));
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, h);
  for (let i = 0; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.lineTo(w, h);
  g.closePath();
  g.fill();
  g.save();
  if (on) {
    g.shadowColor = rgba(color, 0.7);
    g.shadowBlur = 6;
  }
  g.strokeStyle = on ? color : rgba(color, 0.3);
  g.lineWidth = 1.6;
  g.beginPath();
  for (let i = 0; i < pts.length; i += 2) i === 0 ? g.moveTo(pts[i], pts[i + 1]) : g.lineTo(pts[i], pts[i + 1]);
  g.stroke();
  g.restore();
  if (on && type !== FT_FORMANT) {
    const x = xOf(Math.min(20000, fc));
    g.strokeStyle = rgba(color, live ? 0.55 : 0.3);
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
    g.setLineDash([]);
  }
  tag(g, type === FT_FORMANT ? 'VOWEL ' + 'AEIOU'[Math.min(4, Math.round(morph * 4))] : type === FT_COMB ? hz(fc) + ' comb' : hz(fc), w - 4, 12, rgba(color, on ? 0.95 : 0.35));
}

export function filterPanel(ctx: Ctx, f: number): HTMLElement {
  const name = `Filter ${f + 1}`;
  const color = COL.filt;
  const F = (s: any) => s.filt[f];
  const led = pled(ctx, (s) => F(s).on, (s, v) => (F(s).on = v), `${name} on / off (off = signal passes through)`, `${name} on/off`);
  const type = psel(ctx, FILTER_TYPES, (s) => F(s).type, (s, v) => (F(s).type = v), `${name} type`, `${name} type`, 'hc-grow');
  const extra: HTMLElement[] = [];
  if (f === 1) {
    const mode = el('button', { class: 'hc-tog hc-mode', 'data-hint': 'Filter routing: SERIAL = Filter 1 feeds Filter 2 · PARALLEL = both filters side by side, outputs summed' }) as HTMLButtonElement;
    mode.onclick = () => {
      const v = ctx.s.filtMode === 1 ? 0 : 1;
      ctx.commit('Filter routing', (s) => (s.filtMode = v));
    };
    ctx.onUpdate(() => {
      mode.textContent = ctx.s.filtMode === 1 ? 'PARALLEL' : 'SERIAL';
      mode.classList.toggle('on', ctx.s.filtMode === 1);
    });
    extra.push(mode);
  }
  const p = panel('hc-filter', el('span', { class: 'hc-tl' }, led, el('span', { class: 'hc-title', style: { color } }, `FILTER ${f + 1}`)), type, ...extra);
  const view = hcanvas(230, 62, 'hc-resp', `${name} frequency response (follows modulation while notes play)`);
  const K = (label: string, d: ReturnType<typeof def>, get: (x: any) => number, set: (x: any, v: number) => void, bipolar = false) =>
    pknob(ctx, { label, name, def: d, get: (s) => get(F(s)), set: (s, v) => set(F(s), v), size: 26, color, bipolar });
  const kCut = K('CUTOFF', def('Cutoff', 20, 20000, 20000, hz, { curve: 'log' }), (x) => x.cutoff, (x, v) => (x.cutoff = v));
  const kRes = K('RESO', def('Resonance', 0, 1, 0.1, pct), (x) => x.reso, (x, v) => (x.reso = v));
  const kDrv = K('DRIVE', def('Drive', 0, 1, 0, pct), (x) => x.drive, (x, v) => (x.drive = v));
  const kKey = K('KEY', def('Key tracking', 0, 1, 0, pct), (x) => x.key, (x, v) => (x.key = v));
  const kMix = K('MIX', def('Mix (dry / filtered)', 0, 1, 1, pct), (x) => x.mix, (x, v) => (x.mix = v));
  const kMorph = K('MORPH', def('Morph (Formant: vowel A-E-I-O-U · Comb: + / − feedback)', 0, 1, 0, pct), (x) => x.morph, (x, v) => (x.morph = v));
  const morphLbl = kMorph.querySelector('.knob-label') as HTMLElement | null;
  const cutLbl = kCut.querySelector('.knob-label') as HTMLElement | null;
  p.body.append(view.cv, el('div', { class: 'hc-row' }, kCut, kRes, kDrv, kKey, kMix, kMorph));
  let dirty = true;
  let lastCut = -1;
  ctx.onUpdate(() => {
    const s = F(ctx.s);
    p.root.classList.toggle('off', !s.on);
    const t = s.type;
    if (morphLbl) morphLbl.textContent = t === FT_FORMANT ? 'VOWEL' : t === FT_COMB ? 'FLAVOR' : 'MORPH';
    if (cutLbl) cutLbl.textContent = t === FT_FORMANT ? 'SHIFT' : t === FT_COMB ? 'PITCH' : 'CUTOFF';
    kMorph.classList.toggle('hc-dim', t !== FT_FORMANT && t !== FT_COMB);
    dirty = true;
  });
  ctx.onFrame(() => {
    const s = F(ctx.s);
    const live = ctx.vizLive() && s.on;
    const cutN = live ? clamp01(ctx.viz!.cut[f]) : cutToNorm(s.cutoff);
    if (!dirty && Math.abs(cutN - lastCut) < 1e-4) return;
    dirty = false;
    lastCut = cutN;
    drawResponse(view, s.type, cutN, s.reso, s.morph, s.mix, s.on, color, live);
  });
  return p.root;
}

