// Halcyon UI — oscillator panels (pseudo-3D wavetable view, live frame position) and the sub / noise strip.
import { el } from '../../../core/util';
import { NOISE_TYPES, ROUTES, ROUTES_SHORT, SUB_SHAPES, W_BENDM, W_BENDP, W_FM, W_MIRROR, W_QUANT, W_RM, W_SQUEEZE, W_SYNC, WARP_MODES, WT_NAMES } from './defs';
import { previewFrames, WT_FRAMES } from './wavetables';
import { cents, COL, Ctx, def, hcanvas, HCanvas, panel, panFmt, pct, pknob, pled, psel, rgba, st, tag } from './ui-kit';

const previews = new Map<number, Float32Array[]>();
export function framesOf(wt: number): Float32Array[] {
  let p = previews.get(wt);
  if (!p) {
    p = previewFrames(wt, 256);
    previews.set(wt, p);
  }
  return p;
}

/** Same phase warps as the DSP, for the display. */
export function warpPhase(mode: number, a: number, p: number): number {
  const c = a * 8;
  switch (mode) {
    case W_BENDP:
      return (p * (1 + c)) / (1 + c * p);
    case W_BENDM:
      return p / (1 + c * (1 - p));
    case W_SQUEEZE: {
      const x = 2 * p - 1;
      const ax = Math.abs(x);
      const y = (ax * (1 + c)) / (1 + c * ax);
      return 0.5 + 0.5 * Math.sign(x) * y;
    }
    case W_SYNC: {
      const q = p * (1 + a * 7);
      return q - Math.floor(q);
    }
    case W_MIRROR: {
      const m = p < 0.5 ? 2 * p : 2 - 2 * p;
      return Math.min(0.99999, p + a * (m - p));
    }
  }
  return p;
}

function sampleFrame(frames: Float32Array[], pos: number, q: number): number {
  const F = frames.length;
  const fi = Math.max(0, Math.min(F - 1, pos * (F - 1)));
  const i0 = Math.floor(fi), i1 = Math.min(F - 1, i0 + 1), t = fi - i0;
  const N = frames[0].length;
  const x = q * N;
  const j0 = Math.floor(x) % N, j1 = (j0 + 1) % N, u = x - Math.floor(x);
  const a = frames[i0][j0] + (frames[i0][j1] - frames[i0][j0]) * u;
  const b = frames[i1][j0] + (frames[i1][j1] - frames[i1][j0]) * u;
  return a + (b - a) * t;
}

class WtView {
  private layer: HTMLCanvasElement | null = null;
  private layerKey = '';
  constructor(public c: HCanvas, private color: string) {}
  private geom() {
    const { w, h } = this.c;
    const dx = 40, dy = 20, amp = 14;
    return { w, h, dx, dy, amp, x0: 6, ww: w - 12 - dx, yc0: h - 13 - amp };
  }
  private buildLayer(frames: Float32Array[], on: boolean) {
    const { w, h, dx, dy, amp, x0, ww, yc0 } = this.geom();
    const dpr = this.c.cv.width / w;
    const cv = this.layer ?? document.createElement('canvas');
    cv.width = this.c.cv.width;
    cv.height = this.c.cv.height;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0a0d12');
    bg.addColorStop(1, '#0f141b');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // floor grid (perspective)
    g.strokeStyle = 'rgba(120,150,180,0.06)';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const z = i / 4;
      g.beginPath();
      g.moveTo(x0 + z * dx, yc0 - z * dy);
      g.lineTo(x0 + ww + z * dx, yc0 - z * dy);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(x0, yc0);
    g.lineTo(x0 + dx, yc0 - dy);
    g.moveTo(x0 + ww, yc0);
    g.lineTo(x0 + ww + dx, yc0 - dy);
    g.stroke();
    const N = frames[0].length;
    const F = frames.length;
    for (let f = F - 1; f >= 0; f -= 3) {
      const z = f / (F - 1);
      const ox = x0 + z * dx, oy = yc0 - z * dy;
      g.strokeStyle = rgba(this.color, (on ? 0.07 : 0.04) + (on ? 0.16 : 0.06) * (1 - z));
      g.beginPath();
      for (let i = 0; i <= N; i += 2) {
        const v = frames[f][i % N];
        const x = ox + (i / N) * ww, y = oy - v * amp;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    this.layer = cv;
  }
  draw(frames: Float32Array[], wt: number, pos: number, base: number, on: boolean, warp: number, warpAmt: number) {
    const key = wt + '|' + on + '|' + this.c.cv.width;
    if (key !== this.layerKey || !this.layer) {
      this.buildLayer(frames, on);
      this.layerKey = key;
    }
    const { g, w, h } = this.c;
    const { dx, dy, amp, x0, ww, yc0 } = this.geom();
    g.clearRect(0, 0, w, h);
    g.drawImage(this.layer!, 0, 0, w, h);
    const z = Math.max(0, Math.min(1, pos));
    const ox = x0 + z * dx, oy = yc0 - z * dy;
    const N = 192;
    const pts: number[] = [];
    for (let i = 0; i <= N; i++) {
      const p = i / N;
      const q = warpPhase(warp, warpAmt, Math.min(0.99999, p));
      let v = sampleFrame(frames, pos, q);
      if (warp === W_QUANT) {
        const L = 2 + (1 - warpAmt) * (1 - warpAmt) * 126;
        v = Math.round(v * L) / L;
      }
      pts.push(ox + p * ww, oy - Math.max(-1.2, Math.min(1.2, v)) * amp);
    }
    // filled body
    const grad = g.createLinearGradient(0, oy - amp, 0, oy + amp);
    grad.addColorStop(0, rgba(this.color, on ? 0.35 : 0.1));
    grad.addColorStop(0.5, rgba(this.color, on ? 0.06 : 0.02));
    grad.addColorStop(1, rgba(this.color, on ? 0.3 : 0.08));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(ox, oy);
    for (let i = 0; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.lineTo(ox + ww, oy);
    g.closePath();
    g.fill();
    g.save();
    if (on) {
      g.shadowColor = rgba(this.color, 0.8);
      g.shadowBlur = 8;
    }
    g.strokeStyle = on ? this.color : rgba(this.color, 0.35);
    g.lineWidth = 1.6;
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) i === 0 ? g.moveTo(pts[i], pts[i + 1]) : g.lineTo(pts[i], pts[i + 1]);
    g.stroke();
    g.restore();
    // frame bar
    const by = h - 5;
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(6, by - 1, w - 12, 3);
    g.fillStyle = rgba(this.color, on ? 0.55 : 0.2);
    g.fillRect(6, by - 1, (w - 12) * z, 3);
    const bx = 6 + (w - 12) * Math.max(0, Math.min(1, base));
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fillRect(bx - 0.5, by - 3, 1, 7);
    g.fillStyle = on ? '#fff' : '#889';
    g.beginPath();
    g.arc(6 + (w - 12) * z, by + 0.5, 2.6, 0, Math.PI * 2);
    g.fill();
    tag(g, `FRAME ${Math.round(z * (WT_FRAMES - 1)) + 1}/${WT_FRAMES}`, w - 4, 12, rgba(this.color, on ? 0.95 : 0.4));
  }
}

export function oscPanel(ctx: Ctx, o: number): HTMLElement {
  const name = `Osc ${o + 1}`;
  const color = COL.osc[o];
  const O = (s: any) => s.osc[o];
  const led = pled(ctx, (s) => O(s).on, (s, v) => (O(s).on = v), `${name} on / off`, `${name} on/off`);
  const wtSel = psel(ctx, WT_NAMES, (s) => O(s).wt, (s, v) => (O(s).wt = v), `${name} wavetable`, `${name} wavetable`, 'hc-grow');
  const route = psel(
    ctx,
    ROUTES_SHORT.map((l, i) => ({ value: i, label: l })),
    (s) => O(s).dest,
    (s, v) => (O(s).dest = v),
    `${name} output routing: ${ROUTES.join(' / ')}`,
    `${name} routing`,
    'hc-route',
  );
  const title = el('span', { class: 'hc-title', style: { color } }, `OSC ${o + 1}`);
  const p = panel('hc-osc', el('span', { class: 'hc-tl' }, led, title), wtSel, route);
  const view = hcanvas(284, 76, 'hc-wt', `${name} wavetable — frames stacked front (1) to back (64); the bright line is the current frame (live with modulation)`);
  const wv = new WtView(view, color);
  const K = (label: string, d: ReturnType<typeof def>, get: (s: any) => number, set: (s: any, v: number) => void, bipolar = false) =>
    pknob(ctx, { label, name, def: d, get: (s) => get(O(s)), set: (s, v) => set(O(s), v), size: 26, color, bipolar });
  const kFrame = K('FRAME', def('Frame', 0, 1, 0, (v) => 'Frame ' + (Math.round(v * (WT_FRAMES - 1)) + 1)), (x) => x.frame, (x, v) => (x.frame = v));
  const kLevel = K('LEVEL', def('Level', 0, 1, 0.75, pct), (x) => x.level, (x, v) => (x.level = v));
  const kPan = K('PAN', def('Pan', -1, 1, 0, panFmt), (x) => x.pan, (x, v) => (x.pan = v), true);
  const kWarp = K('WARP', def('Warp amount', 0, 1, 0.5, pct), (x) => x.warpAmt, (x, v) => (x.warpAmt = v));
  const warpSel = psel(ctx, WARP_MODES, (s) => O(s).warp, (s, v) => (O(s).warp = v), `${name} warp mode (phase / amplitude distortion, FM or ring-mod from another osc)`, `${name} warp mode`);
  const srcSel = psel(
    ctx,
    [0, 1, 2].map((i) => ({ value: i, label: `from Osc ${i + 1}` })),
    (s) => O(s).warpSrc,
    (s, v) => (O(s).warpSrc = v),
    `${name} FM / RM source oscillator (set its level to 0 to use it only as a modulator)`,
    `${name} warp source`,
  );
  const kUni = K('UNISON', def('Unison voices', 1, 16, 1, (v) => Math.round(v) + (Math.round(v) === 1 ? ' voice' : ' voices'), { step: 1 }), (x) => x.uni, (x, v) => (x.uni = Math.round(v)));
  const kDet = K('DETUNE', def('Unison detune', 0, 1, 0.3, (v) => Math.round(100 * v * v) + ' ct'), (x) => x.detune, (x, v) => (x.detune = v));
  const kSpr = K('SPREAD', def('Stereo spread', 0, 1, 0.7, pct), (x) => x.spread, (x, v) => (x.spread = v));
  const kBl = K('BLEND', def('Unison blend (side voices level)', 0, 1, 0.8, pct), (x) => x.blend, (x, v) => (x.blend = v));
  const kSemi = K('SEMI', def('Coarse tune', -24, 24, 0, st, { step: 1 }), (x) => x.semi, (x, v) => (x.semi = Math.round(v)), true);
  const kFine = K('FINE', def('Fine tune', -100, 100, 0, cents), (x) => x.fine, (x, v) => (x.fine = Math.round(v)), true);
  const kPh = K('PHASE', def('Start phase', 0, 1, 0, (v) => Math.round(v * 360) + '°'), (x) => x.phase, (x, v) => (x.phase = v));
  const kRand = K('RAND', def('Phase randomness', 0, 1, 1, pct), (x) => x.rand, (x, v) => (x.rand = v));
  p.body.append(
    view.cv,
    el('div', { class: 'hc-row' }, kFrame, kLevel, kPan, kWarp, el('div', { class: 'hc-col hc-warp' }, warpSel, srcSel)),
    el('div', { class: 'hc-row' }, kUni, kDet, kSpr, kBl, kSemi, kFine, kPh, kRand),
  );
  let dirty = true;
  let lastPos = -1;
  ctx.onUpdate(() => {
    const s = O(ctx.s);
    p.root.classList.toggle('off', !s.on);
    srcSel.disabled = !(s.warp === W_FM || s.warp === W_RM);
    srcSel.classList.toggle('hc-dim', srcSel.disabled);
    kWarp.classList.toggle('hc-dim', s.warp === 0);
    const uni = Math.round(s.uni) > 1;
    for (const k of [kDet, kSpr, kBl]) k.classList.toggle('hc-dim', !uni);
    dirty = true;
  });
  ctx.onFrame(() => {
    const s = O(ctx.s);
    const live = ctx.vizLive() && s.on;
    const pos = live ? ctx.viz!.fr[o] : s.frame;
    if (!dirty && Math.abs(pos - lastPos) < 1e-4) return;
    dirty = false;
    lastPos = pos;
    wv.draw(framesOf(s.wt), s.wt, pos, s.frame, s.on, s.warp, s.warpAmt);
  });
  return p.root;
}

export function subNoisePanel(ctx: Ctx): HTMLElement {
  const color = COL.sub;
  const p = panel('hc-subnoise', el('span', { class: 'hc-title', style: { color } }, 'SUB · NOISE'));
  const subLed = pled(ctx, (s) => s.sub.on, (s, v) => (s.sub.on = v), 'Sub oscillator on / off', 'Sub on/off');
  const subShape = psel(ctx, SUB_SHAPES, (s) => s.sub.shape, (s, v) => (s.sub.shape = v), 'Sub oscillator waveform', 'Sub shape', 'hc-grow');
  const subOct = psel(
    ctx,
    [
      { value: 0, label: 'Oct 0' },
      { value: -1, label: 'Oct −1' },
      { value: -2, label: 'Oct −2' },
    ],
    (s) => s.sub.oct,
    (s, v) => (s.sub.oct = v),
    'Sub octave (relative to the played note)',
    'Sub octave',
  );
  const subRoute = psel(ctx, ROUTES_SHORT.map((l, i) => ({ value: i, label: l })), (s) => s.sub.dest, (s, v) => (s.sub.dest = v), `Sub routing: ${ROUTES.join(' / ')}`, 'Sub routing', 'hc-route');
  const kSub = pknob(ctx, { label: 'LEVEL', name: 'Sub', def: def('Level', 0, 1, 0.5, pct), get: (s) => s.sub.level, set: (s, v) => (s.sub.level = v), size: 24, color });
  const kSubPan = pknob(ctx, { label: 'PAN', name: 'Sub', def: def('Pan', -1, 1, 0, panFmt), get: (s) => s.sub.pan, set: (s, v) => (s.sub.pan = v), size: 24, color, bipolar: true });
  const nLed = pled(ctx, (s) => s.noise.on, (s, v) => (s.noise.on = v), 'Noise generator on / off', 'Noise on/off');
  const nType = psel(ctx, NOISE_TYPES, (s) => s.noise.type, (s, v) => (s.noise.type = v), 'Noise colour', 'Noise type', 'hc-grow');
  const nRoute = psel(ctx, ROUTES_SHORT.map((l, i) => ({ value: i, label: l })), (s) => s.noise.dest, (s, v) => (s.noise.dest = v), `Noise routing: ${ROUTES.join(' / ')}`, 'Noise routing', 'hc-route');
  const kN = pknob(ctx, { label: 'LEVEL', name: 'Noise', def: def('Level', 0, 1, 0.25, pct), get: (s) => s.noise.level, set: (s, v) => (s.noise.level = v), size: 24, color });
  const kNPan = pknob(ctx, { label: 'PAN', name: 'Noise', def: def('Pan', -1, 1, 0, panFmt), get: (s) => s.noise.pan, set: (s, v) => (s.noise.pan = v), size: 24, color, bipolar: true });
  const subBox = el('div', { class: 'hc-mini' }, el('div', { class: 'hc-mini-head' }, subLed, el('span', { text: 'SUB' }), subShape), el('div', { class: 'hc-mini-row' }, el('div', { class: 'hc-col' }, subOct, subRoute), kSub, kSubPan));
  const nBox = el('div', { class: 'hc-mini' }, el('div', { class: 'hc-mini-head' }, nLed, el('span', { text: 'NOISE' }), nType), el('div', { class: 'hc-mini-row' }, el('div', { class: 'hc-col' }, nRoute), kN, kNPan));
  p.body.append(subBox, nBox);
  ctx.onUpdate(() => {
    subBox.classList.toggle('off', !ctx.s.sub.on);
    nBox.classList.toggle('off', !ctx.s.noise.on);
  });
  return p.root;
}

