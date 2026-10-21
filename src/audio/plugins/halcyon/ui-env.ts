// Halcyon UI — envelope editor: ENV1 (amp) / ENV2 / ENV3 with draggable time / level points and
// curve handles, plus knobs. Shows the newest voice's live level while notes play.
import { el } from '../../../core/util';
import { drag } from '../../../ui/widgets';
import { EnvS, envCurve } from './defs';
import { COL, Ctx, def, hcanvas, panel, pct, pknob, rgba, secs, tabs, tag } from './ui-kit';

const T_LO = 0.0005, T_HI = 20;
const clampT = (t: number) => Math.max(T_LO, Math.min(T_HI, t));

export function envPanel(ctx: Ctx): HTMLElement {
  const color = COL.env;
  let cur = 0;
  const E = (s: any): EnvS => s.env[cur];
  const tb = tabs(
    ['AMP', 'ENV 2', 'ENV 3'],
    () => cur,
    (i) => {
      cur = i;
      tb.update();
      knobs.forEach((k) => k.update());
      dirty = true;
    },
    (i) => (i === 0 ? 'Envelope 1 — always controls the amplitude (also usable as a mod source)' : `Envelope ${i + 1} — a modulation source (assign it in the mod matrix)`),
  );
  const p = panel('hc-env', el('span', { class: 'hc-title', style: { color } }, 'ENVELOPES'), tb.el);
  const W = 274, H = 72;
  const c = hcanvas(W, H, 'hc-envc', 'Drag the points to set attack / hold / decay / sustain / release; drag the small curve handles up or down to bend a segment');
  const name = 'Envelope';
  const tdef = (label: string, d: number) => def(label, T_LO, T_HI, d, secs, { curve: 'log' });
  const knobs = [
    pknob(ctx, { label: 'ATTACK', name, def: tdef('Attack', 0.003), get: (s) => E(s).a, set: (s, v) => (E(s).a = v), color }),
    pknob(ctx, { label: 'HOLD', name, def: def('Hold', T_LO, T_HI, T_LO, (v) => (v <= 0.0006 ? '0 ms' : secs(v)), { curve: 'log' }), get: (s) => Math.max(T_LO, E(s).h), set: (s, v) => (E(s).h = v <= 0.0006 ? 0 : v), color }),
    pknob(ctx, { label: 'DECAY', name, def: tdef('Decay', 0.6), get: (s) => E(s).d, set: (s, v) => (E(s).d = v), color }),
    pknob(ctx, { label: 'SUSTAIN', name, def: def('Sustain', 0, 1, 0.8, pct), get: (s) => E(s).s, set: (s, v) => (E(s).s = v), color }),
    pknob(ctx, { label: 'RELEASE', name, def: tdef('Release', 0.22), get: (s) => E(s).r, set: (s, v) => (E(s).r = v), color }),
  ];
  p.body.append(c.cv, el('div', { class: 'hc-row hc-spread' }, ...knobs));

  // ---- geometry ----
  const padL = 6, padR = 8, top = 9, bot = H - 7, susW = 32;
  const avail = W - padL - padR - susW;
  let K = 0;
  let dragging = false;
  const fitK = (e: EnvS) => {
    const sum = Math.sqrt(e.a) + Math.sqrt(e.h) + Math.sqrt(e.d) + Math.sqrt(e.r);
    return Math.min(avail / (4 * Math.sqrt(1.5)), avail / Math.max(sum, 1e-3));
  };
  const geo = (e: EnvS) => {
    if (!dragging || !K) K = fitK(e);
    const xA = padL + K * Math.sqrt(e.a);
    const xH = xA + K * Math.sqrt(e.h);
    const xD = xH + K * Math.sqrt(e.d);
    const xS = xD + susW;
    const xR = xS + K * Math.sqrt(e.r);
    const yS = bot - e.s * (bot - top);
    return { xA, xH, xD, xS, xR, yS };
  };
  const levelAt = (e: EnvS, seg: number, t: number) =>
    seg === 0 ? envCurve(t, e.ac) : seg === 1 ? 1 - (1 - e.s) * envCurve(t, e.dc) : e.s * (1 - envCurve(t, e.rc));
  const yOf = (lvl: number) => bot - lvl * (bot - top);
  type Handle = { id: string; x: number; y: number; curve?: boolean };
  const handles = (e: EnvS): Handle[] => {
    const g = geo(e);
    return [
      { id: 'a', x: g.xA, y: top },
      { id: 'h', x: g.xH, y: top },
      { id: 'd', x: g.xD, y: g.yS },
      { id: 'r', x: g.xR, y: bot },
      { id: 'ac', x: padL + (g.xA - padL) / 2, y: yOf(levelAt(e, 0, 0.5)), curve: true },
      { id: 'dc', x: g.xH + (g.xD - g.xH) / 2, y: yOf(levelAt(e, 1, 0.5)), curve: true },
      { id: 'rc', x: g.xS + (g.xR - g.xS) / 2, y: yOf(levelAt(e, 2, 0.5)), curve: true },
    ];
  };
  let hover: string | null = null;
  let dirty = true;
  let lastLvl = -1;

  const draw = () => {
    const { g, w, h } = c;
    const e = E(ctx.s);
    const G = geo(e);
    g.clearRect(0, 0, w, h);
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0a0d12');
    bg.addColorStop(1, '#0f141b');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(140,160,190,0.07)';
    g.lineWidth = 1;
    for (const y of [top, (top + bot) / 2, bot]) {
      g.beginPath();
      g.moveTo(0, Math.round(y) + 0.5);
      g.lineTo(w, Math.round(y) + 0.5);
      g.stroke();
    }
    // path
    const pts: number[] = [padL, bot];
    const seg = (x0: number, x1: number, s: number) => {
      const n = Math.max(2, Math.ceil((x1 - x0) / 2));
      for (let i = 1; i <= n; i++) pts.push(x0 + ((x1 - x0) * i) / n, yOf(levelAt(e, s, i / n)));
    };
    seg(padL, G.xA, 0);
    pts.push(G.xH, top);
    seg(G.xH, G.xD, 1);
    pts.push(G.xS, G.yS);
    seg(G.xS, G.xR, 2);
    const grad = g.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, rgba(color, 0.32));
    grad.addColorStop(1, rgba(color, 0.03));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.lineTo(pts[pts.length - 2], bot);
    g.closePath();
    g.fill();
    g.save();
    g.shadowColor = rgba(color, 0.6);
    g.shadowBlur = 6;
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.stroke();
    g.restore();
    // sustain marker
    g.strokeStyle = rgba(color, 0.25);
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(G.xD, G.yS);
    g.lineTo(G.xD, bot);
    g.moveTo(G.xS, G.yS);
    g.lineTo(G.xS, bot);
    g.stroke();
    g.setLineDash([]);
    // live level
    const v = ctx.vizLive() ? ctx.viz! : null;
    if (v && v.es[cur] < 5) {
      const lvl = v.env[cur];
      const st = v.es[cur];
      let x = G.xS - susW / 2;
      const find = (x0: number, x1: number, sg: number) => {
        let best = x0, bd = 9;
        for (let i = 0; i <= 24; i++) {
          const t = i / 24;
          const d = Math.abs(levelAt(e, sg, t) - lvl);
          if (d < bd) {
            bd = d;
            best = x0 + (x1 - x0) * t;
          }
        }
        return best;
      };
      if (st === 0) x = find(padL, G.xA, 0);
      else if (st === 1) x = G.xA + (G.xH - G.xA) / 2;
      else if (st === 2) x = find(G.xH, G.xD, 1);
      else if (st === 4) x = find(G.xS, G.xR, 2);
      g.fillStyle = '#fff';
      g.shadowColor = color;
      g.shadowBlur = 10;
      g.beginPath();
      g.arc(x, yOf(lvl), 3, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    }
    // handles
    for (const hd of handles(e)) {
      const on = hover === hd.id;
      g.beginPath();
      if (hd.curve) {
        g.fillStyle = on ? '#fff' : rgba(color, 0.55);
        g.arc(hd.x, hd.y, on ? 3 : 2.2, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = '#0d1116';
        g.strokeStyle = on ? '#fff' : color;
        g.lineWidth = 1.5;
        g.arc(hd.x, hd.y, on ? 4.2 : 3.4, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
    const total = e.a + e.h + e.d + e.r;
    tag(g, `${cur === 0 ? 'AMP' : 'ENV ' + (cur + 1)} · ${secs(total)}`, w - 4, 12, rgba(color, 0.95));
  };

  const hit = (x: number, y: number) => {
    let best: Handle | null = null, bd = 9;
    const hs = handles(E(ctx.s));
    for (const hd of hs) {
      const d = Math.hypot(hd.x - x, hd.y - y);
      if (d < bd) {
        bd = d;
        best = hd;
      }
    }
    // attack and hold points coincide when hold = 0: right of the point grabs hold
    if (best && (best.id === 'a' || best.id === 'h') && Math.abs(hs[0].x - hs[1].x) < 3) best = x > hs[0].x + 0.5 ? hs[1] : hs[0];
    return best;
  };
  const local = (ev: PointerEvent | MouseEvent) => {
    const r = c.cv.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
  };
  c.cv.addEventListener('pointermove', (ev) => {
    if (dragging) return;
    const { x, y } = local(ev);
    const h = hit(x, y);
    const id = h?.id ?? null;
    c.cv.style.cursor = h ? (h.curve ? 'ns-resize' : h.id === 'd' ? 'move' : 'ew-resize') : 'default';
    if (id !== hover) {
      hover = id;
      dirty = true;
    }
  });
  c.cv.addEventListener('pointerleave', () => {
    if (!dragging && hover) {
      hover = null;
      dirty = true;
    }
  });
  c.cv.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const { x, y } = local(ev);
    const h = hit(x, y);
    if (!h) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    const e0 = { ...E(ctx.s) };
    const G0 = geo(e0);
    ctx.begin(`Envelope ${cur + 1} edit`);
    drag(
      ev,
      (dx, dy) => {
        ctx.live((s) => {
          const e = s.env[cur];
          const tFrom = (px: number) => clampT((Math.max(0, px) / K) ** 2);
          switch (h.id) {
            case 'a':
              e.a = tFrom(G0.xA + dx - padL);
              break;
            case 'h': {
              const t = (Math.max(0, G0.xH + dx - G0.xA) / K) ** 2;
              e.h = t < 0.0008 ? 0 : Math.min(T_HI, t);
              break;
            }
            case 'd':
              e.d = tFrom(G0.xD + dx - G0.xH);
              e.s = Math.max(0, Math.min(1, e0.s - dy / (bot - top)));
              break;
            case 'r':
              e.r = tFrom(G0.xR + dx - G0.xS);
              break;
            case 'ac':
              e.ac = Math.max(-1, Math.min(1, e0.ac - dy / 30));
              break;
            case 'dc':
              e.dc = Math.max(-1, Math.min(1, e0.dc + dy / 30));
              break;
            case 'rc':
              e.rc = Math.max(-1, Math.min(1, e0.rc + dy / 30));
              break;
          }
        });
        knobs.forEach((k) => k.update());
        dirty = true;
      },
      () => {
        dragging = false;
        ctx.end();
        dirty = true;
      },
    );
  });
  c.cv.addEventListener('dblclick', (ev) => {
    const { x, y } = local(ev);
    const h = hit(x, y);
    if (!h?.curve) return;
    ctx.commit('Reset envelope curve', (s) => ((s.env[cur] as any)[h.id] = 0));
  });

  ctx.onUpdate(() => (dirty = true));
  ctx.onFrame(() => {
    const v = ctx.vizLive() ? ctx.viz!.env[cur] : -1;
    if (!dirty && Math.abs(v - lastLvl) < 1e-4) return;
    lastLvl = v;
    dirty = false;
    draw();
  });
  return p.root;
}

