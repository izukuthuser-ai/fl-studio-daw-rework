// Halcyon UI — LFO panel: 4 LFOs, shape view with playhead, draggable custom-shape points.
import { el } from '../../../core/util';
import { drag, toast } from '../../../ui/widgets';
import { LFO_CUSTOM, LFO_HZ_MAX, LFO_HZ_MIN, LFO_MAX_PTS, LFO_MODES, LFO_SH, LFO_SHAPES, LFO_SMOOTH, lfoBasic, LfoS, SYNC_DIVS } from './defs';
import { COL, Ctx, def, hcanvas, panel, pknob, psel, ptoggle, rgba, secs, tabs, tag } from './ui-kit';

// deterministic "random" steps for drawing S&H / smooth random
const RND = [0.42, -0.7, 0.85, -0.15, 0.3, -0.9, 0.6, -0.35, 0.42];

export function lfoValue(l: LfoS, p: number): number {
  if (l.shape <= 4) return lfoBasic(l.shape, p);
  if (l.shape === LFO_SH) return RND[Math.min(7, Math.floor(p * 8))];
  if (l.shape === LFO_SMOOTH) {
    const x = p * 8, i = Math.min(7, Math.floor(x)), t = x - i;
    return RND[i] + (RND[i + 1] - RND[i]) * (0.5 - 0.5 * Math.cos(Math.PI * t));
  }
  const pts = l.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (p <= b[0] || i === pts.length - 2) {
      const w = b[0] - a[0];
      const t = w > 1e-6 ? Math.max(0, Math.min(1, (p - a[0]) / w)) : 1;
      return (a[1] + (b[1] - a[1]) * t) * 2 - 1;
    }
  }
  return 0;
}

/** Points approximating a built-in shape (to start editing from it). */
function shapeToPts(l: LfoS): number[][] {
  switch (l.shape) {
    case 1:
      return [[0, 0.5], [0.25, 1], [0.75, 0], [1, 0.5]];
    case 2:
      return [[0, 0], [1, 1]];
    case 3:
      return [[0, 1], [1, 0]];
    case 4:
      return [[0, 1], [0.499, 1], [0.5, 0], [1, 0]];
    case LFO_SH: {
      const p: number[][] = [];
      for (let i = 0; i < 8; i++) p.push([i / 8, (RND[i] + 1) / 2], [(i + 1) / 8 - (i < 7 ? 0.001 : 0), (RND[i] + 1) / 2]);
      return p;
    }
  }
  const p: number[][] = [];
  for (let i = 0; i <= 8; i++) p.push([i / 8, (lfoValue(l, i / 8) + 1) / 2]);
  return p;
}

export function lfoPanel(ctx: Ctx): HTMLElement {
  const color = COL.lfo;
  let cur = 0;
  const L = (s: any): LfoS => s.lfo[cur];
  const tb = tabs(
    ['1', '2', '3', '4'],
    () => cur,
    (i) => {
      cur = i;
      tb.update();
      ctx.refresh(true);
    },
    (i) => `LFO ${i + 1}`,
  );
  const p = panel('hc-lfo', el('span', { class: 'hc-title', style: { color } }, 'LFO'), tb.el);
  const W = 282, H = 64;
  const c = hcanvas(W, H, 'hc-lfoc', 'LFO shape — Custom: drag points, double-click to add, right-click (or double-click) a point to remove · other shapes: double-click to turn them into an editable custom shape');
  const name = 'LFO';
  const shape = psel(ctx, LFO_SHAPES, (s) => L(s).shape, (s, v) => (L(s).shape = v), 'LFO shape (Custom = draw your own with up to 16 points)', 'LFO shape', 'hc-grow');
  const mode = psel(ctx, LFO_MODES, (s) => L(s).mode, (s, v) => (L(s).mode = v), 'Retrig: restarts on every note · Free: one shared running phase · Once: runs a single cycle per note (envelope-like)', 'LFO mode');
  const sync = ptoggle(ctx, 'SYNC', (s) => L(s).sync, (s, v) => (L(s).sync = v), 'Tempo sync: rate follows the project tempo (division) instead of Hz', 'LFO sync');
  const div = psel(ctx, SYNC_DIVS.map(([lb], i) => ({ value: i, label: lb })), (s) => L(s).div, (s, v) => (L(s).div = v), 'Tempo-synced cycle length', 'LFO division');
  const kRate = pknob(ctx, { label: 'RATE', name, def: def('Rate', LFO_HZ_MIN, LFO_HZ_MAX, 2, (v) => (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' Hz', { curve: 'log' }), get: (s) => L(s).rate, set: (s, v) => (L(s).rate = v), color, size: 24 });
  const kPhase = pknob(ctx, { label: 'PHASE', name, def: def('Start phase', 0, 1, 0, (v) => Math.round(v * 360) + '°'), get: (s) => L(s).phase, set: (s, v) => (L(s).phase = v), color, size: 24 });
  const kDelay = pknob(ctx, { label: 'DELAY', name, def: def('Delay', 0.0005, 10, 0.0005, (v) => (v <= 0.0006 ? '0 ms' : secs(v)), { curve: 'log' }), get: (s) => Math.max(0.0005, L(s).delay), set: (s, v) => (L(s).delay = v <= 0.0006 ? 0 : v), color, size: 24 });
  const kFade = pknob(ctx, { label: 'FADE', name, def: def('Fade-in', 0.0005, 10, 0.0005, (v) => (v <= 0.0006 ? '0 ms' : secs(v)), { curve: 'log' }), get: (s) => Math.max(0.0005, L(s).fade), set: (s, v) => (L(s).fade = v <= 0.0006 ? 0 : v), color, size: 24 });
  p.body.append(c.cv, el('div', { class: 'hc-row hc-lforow' }, shape, mode, sync, div), el('div', { class: 'hc-row hc-spread' }, kRate, kPhase, kDelay, kFade));

  const pad = 6, top = 6, bot = H - 6;
  const X = (x: number) => pad + x * (W - 2 * pad);
  const Y = (y: number) => top + (1 - y) * (bot - top);
  let dirty = true;
  let hover = -1;
  let lastPh = -1;
  const draw = () => {
    const { g, w, h } = c;
    const l = L(ctx.s);
    g.clearRect(0, 0, w, h);
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0a0d12');
    bg.addColorStop(1, '#0f141b');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(140,160,190,0.07)';
    for (let i = 1; i < 4; i++) {
      const x = Math.round(X(i / 4)) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    g.strokeStyle = 'rgba(140,160,190,0.14)';
    g.beginPath();
    g.moveTo(0, Math.round(Y(0.5)) + 0.5);
    g.lineTo(w, Math.round(Y(0.5)) + 0.5);
    g.stroke();
    const N = 220;
    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const ph = i / N;
      const v = lfoValue(l, Math.min(0.99999, ph));
      const x = X(ph), y = Y((v + 1) / 2);
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    const path = new Path2D();
    path.moveTo(X(0), Y(0.5));
    for (let i = 0; i <= N; i++) {
      const ph = i / N;
      path.lineTo(X(ph), Y((lfoValue(l, Math.min(0.99999, ph)) + 1) / 2));
    }
    path.lineTo(X(1), Y(0.5));
    path.closePath();
    g.fillStyle = rgba(color, 0.13);
    g.fill(path);
    g.save();
    g.shadowColor = rgba(color, 0.6);
    g.shadowBlur = 6;
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.stroke();
    g.restore();
    if (l.shape === LFO_CUSTOM) {
      l.pts.forEach((pt, i) => {
        g.beginPath();
        g.fillStyle = '#0d1116';
        g.strokeStyle = i === hover ? '#fff' : color;
        g.lineWidth = 1.5;
        g.arc(X(pt[0]), Y(pt[1]), i === hover ? 4.2 : 3.2, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      });
    }
    const v = ctx.vizLive() || (ctx.viz && l.mode === 1) ? ctx.viz : null;
    if (v) {
      const ph = v.lp[cur];
      const x = X(ph);
      g.strokeStyle = rgba('#ffffff', 0.25);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
      const val = l.shape === LFO_SH || l.shape === LFO_SMOOTH ? v.lv[cur] : lfoValue(l, ph);
      g.fillStyle = '#fff';
      g.shadowColor = color;
      g.shadowBlur = 10;
      g.beginPath();
      g.arc(x, Y((Math.max(-1, Math.min(1, val)) + 1) / 2), 3, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    }
    tag(g, (l.sync ? SYNC_DIVS[l.div]?.[0] ?? '' : (l.rate < 10 ? l.rate.toFixed(2) : l.rate.toFixed(1)) + ' Hz') + ' · ' + LFO_MODES[l.mode].toUpperCase(), w - 4, 12, rgba(color, 0.95));
  };

  const local = (ev: MouseEvent) => {
    const r = c.cv.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
  };
  const hitPt = (x: number, y: number) => {
    const l = L(ctx.s);
    if (l.shape !== LFO_CUSTOM) return -1;
    let best = -1, bd = 8;
    l.pts.forEach((pt, i) => {
      const d = Math.hypot(X(pt[0]) - x, Y(pt[1]) - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const toNorm = (x: number, y: number) => [Math.max(0, Math.min(1, (x - pad) / (W - 2 * pad))), Math.max(0, Math.min(1, 1 - (y - top) / (bot - top)))];
  c.cv.addEventListener('pointermove', (ev) => {
    const { x, y } = local(ev);
    const i = hitPt(x, y);
    c.cv.style.cursor = i >= 0 ? 'grab' : L(ctx.s).shape === LFO_CUSTOM ? 'crosshair' : 'default';
    if (i !== hover) {
      hover = i;
      dirty = true;
    }
  });
  c.cv.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const { x, y } = local(ev);
    const i = hitPt(x, y);
    if (i < 0) return;
    ev.preventDefault();
    const l0 = L(ctx.s);
    const pts0 = l0.pts.map((p) => [...p]);
    const last = pts0.length - 1;
    ctx.begin(`LFO ${cur + 1} shape`);
    drag(
      ev,
      (dx, dy) => {
        const [nx, ny] = toNorm(X(pts0[i][0]) + dx * (W / c.cv.getBoundingClientRect().width), Y(pts0[i][1]) + dy * (H / c.cv.getBoundingClientRect().height));
        const lo = i === 0 ? 0 : pts0[i - 1][0];
        const hi = i === last ? 1 : pts0[i + 1][0];
        const px = i === 0 ? 0 : i === last ? 1 : Math.max(lo, Math.min(hi, nx));
        ctx.live((s) => {
          const pts = s.lfo[cur].pts.map((p) => [...p]);
          pts[i] = [px, ny];
          s.lfo[cur].pts = pts;
        });
        dirty = true;
      },
      () => ctx.end(),
    );
  });
  c.cv.addEventListener('dblclick', (ev) => {
    const l = L(ctx.s);
    const { x, y } = local(ev);
    if (l.shape !== LFO_CUSTOM) {
      const pts = shapeToPts(l);
      ctx.commit(`LFO ${cur + 1} to custom shape`, (s) => {
        s.lfo[cur].pts = pts;
        s.lfo[cur].shape = LFO_CUSTOM;
      });
      return;
    }
    const i = hitPt(x, y);
    if (i > 0 && i < l.pts.length - 1) {
      ctx.commit(`LFO ${cur + 1} remove point`, (s) => (s.lfo[cur].pts = s.lfo[cur].pts.filter((_, k) => k !== i)));
      return;
    }
    if (i >= 0) return;
    if (l.pts.length >= LFO_MAX_PTS) {
      toast(`Custom LFO shapes hold up to ${LFO_MAX_PTS} points`, 'warn');
      return;
    }
    const [nx, ny] = toNorm(x, y);
    ctx.commit(`LFO ${cur + 1} add point`, (s) => {
      const pts = s.lfo[cur].pts.map((p) => [...p]);
      let k = pts.findIndex((p) => p[0] > nx);
      if (k <= 0) k = pts.length - 1;
      pts.splice(k, 0, [nx, ny]);
      s.lfo[cur].pts = pts;
    });
  });
  c.cv.addEventListener('contextmenu', (ev) => {
    const { x, y } = local(ev);
    const i = hitPt(x, y);
    const l = L(ctx.s);
    if (i > 0 && i < l.pts.length - 1) {
      ev.preventDefault();
      ctx.commit(`LFO ${cur + 1} remove point`, (s) => (s.lfo[cur].pts = s.lfo[cur].pts.filter((_, k) => k !== i)));
    }
  });

  ctx.onUpdate(() => {
    const l = L(ctx.s);
    div.style.display = l.sync ? '' : 'none';
    kRate.classList.toggle('hc-dim', l.sync);
    dirty = true;
  });
  ctx.onFrame(() => {
    const v = ctx.viz;
    const ph = v ? v.lp[cur] : -1;
    if (!dirty && Math.abs(ph - lastPh) < 1e-4) return;
    lastPh = ph;
    dirty = false;
    draw();
  });
  return p.root;
}
