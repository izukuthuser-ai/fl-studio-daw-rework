// Canvas painters for the Piano Roll: note grid, piano keyboard, ruler and velocity / pan lane.
// All painters work in CSS pixels; the caller sets the HiDPI transform.
import { Note, STEP } from '../core/types';
import { clamp, hexToRgb, isBlackKey, noteName, rgba } from '../core/util';

export interface View {
  zx: number; // px per tick
  rowH: number; // px per key row
  sx: number; // tick at left edge
  sy: number; // px scrolled from key 127's top edge
  gw: number; // grid css width
  gh: number; // grid css height
}

export const FONT = "'Segoe UI', 'Inter', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

export const keyY = (v: View, key: number) => (127 - key) * v.rowH - v.sy;
export const tickX = (v: View, t: number) => (t - v.sx) * v.zx;
export const yKey = (v: View, y: number) => 127 - Math.floor((y + v.sy) / v.rowH);
export const xTick = (v: View, x: number) => v.sx + x / v.zx;

/** Finest grid spacing (ticks) that stays at least `minPx` wide at this zoom. */
export function lineSpacing(zx: number, bar: number, minPx = 7): number {
  const cands = [3, 6, 12, STEP, STEP * 2, 96, bar, bar * 2, bar * 4, bar * 8, bar * 16, bar * 32, bar * 64];
  for (const c of cands) if (c * zx >= minPx) return c;
  return cands[cands.length - 1];
}

// ------------------------------------------------------------------ colours
const fillCache = new Map<string, string>();
/** Note fill: channel colour, lightness by velocity (quantised to 16 levels). */
export function noteFill(hex: string, vel: number, lift = 0): string {
  const lv = Math.round(clamp(vel, 0, 1) * 15);
  const key = hex + '|' + lv + '|' + lift;
  let c = fillCache.get(key);
  if (!c) {
    const [r, g, b] = hexToRgb(hex);
    const amt = -0.56 + (lv / 15) * 0.74 + lift; // -0.56 (quiet, dark) .. +0.18 (loud, bright)
    const f = (x: number) => clamp(Math.round(amt >= 0 ? x + (255 - x) * amt : x * (1 + amt)), 0, 255);
    c = `rgb(${f(r)},${f(g)},${f(b)})`;
    fillCache.set(key, c);
  }
  return c;
}
function luminance(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

const C = {
  // FL 21-style dark teal-slate grid
  rowW: '#36464e',
  rowB: '#2f3e46',
  rowWOut: '#2e3b42',
  rowBOut: '#29353b',
  rowSep: 'rgba(14,20,24,0.32)',
  octSep: '#172126',
  rootTint: 'rgba(255,157,42,0.06)',
  hoverRow: 'rgba(255,255,255,0.05)',
  barShade: 'rgba(0,0,0,0.06)',
  lineBar: 'rgba(14,19,22,0.85)',
  lineBeat: 'rgba(14,19,22,0.42)',
  lineStep: 'rgba(14,19,22,0.20)',
  lineSub: 'rgba(14,19,22,0.10)',
  lineSnap: 'rgba(100,195,230,0.08)',
  afterEnd: 'rgba(16,22,25,0.38)',
  endLine: 'rgba(255,157,42,0.6)',
  accent: '#ff9d2a',
  accent2: '#64c3e6',
};

// ------------------------------------------------------------------ grid
export interface GridData {
  notes: Note[];
  color: string;
  sel: Set<string>;
  ghosts: { notes: Note[]; color: string }[];
  patLen: number;
  bar: number;
  snapGrid: number; // ticks of the active snap (for faint snap lines); 0 = none
  mask: boolean[] | null; // scale highlight
  root: number;
  hoverKey: number | null;
  hoverNote: string | null;
  hoverEdge: boolean;
  timeSel: { start: number; end: number } | null;
  box: { x0: number; y0: number; x1: number; y1: number; kind: 'select' | 'zoom' } | null;
  slice: { t: number; lo: number; hi: number } | null;
  scrub: number | null;
  showNames: boolean;
}

export function drawGrid(ctx: CanvasRenderingContext2D, v: View, d: GridData) {
  const { gw, gh, rowH } = v;
  ctx.clearRect(0, 0, gw, gh);
  const kTop = clamp(yKey(v, 0), 0, 127);
  const kBot = clamp(yKey(v, gh - 1), 0, 127);
  const t0 = v.sx, t1 = xTick(v, gw);

  // rows
  for (let k = kTop; k >= kBot; k--) {
    const y = keyY(v, k);
    const black = isBlackKey(k);
    const out = d.mask && !d.mask[((k % 12) + 12) % 12];
    ctx.fillStyle = out ? (black ? C.rowBOut : C.rowWOut) : black ? C.rowB : C.rowW;
    ctx.fillRect(0, y, gw, rowH);
    if (d.mask && !out && ((k % 12) + 12) % 12 === d.root) {
      ctx.fillStyle = C.rootTint;
      ctx.fillRect(0, y, gw, rowH);
    }
    if (k === d.hoverKey) {
      ctx.fillStyle = C.hoverRow;
      ctx.fillRect(0, y, gw, rowH);
    }
    const pcn = ((k % 12) + 12) % 12;
    if (pcn === 0) {
      ctx.fillStyle = C.octSep;
      ctx.fillRect(0, Math.round(y + rowH) - 1, gw, 1);
    } else if (rowH >= 6) {
      ctx.fillStyle = C.rowSep;
      ctx.fillRect(0, Math.round(y + rowH) - 1, gw, 1);
    }
  }

  // alternate bar shading
  const bar = d.bar;
  for (let b = Math.floor(t0 / bar); b * bar < t1; b++) {
    if (b % 2 === 0) continue;
    const x = tickX(v, b * bar);
    ctx.fillStyle = C.barShade;
    ctx.fillRect(x, 0, bar * v.zx, gh);
  }

  // time selection
  if (d.timeSel) {
    const x0 = tickX(v, d.timeSel.start), x1 = tickX(v, d.timeSel.end);
    ctx.fillStyle = 'rgba(79,198,230,0.07)';
    ctx.fillRect(x0, 0, x1 - x0, gh);
  }

  // snap lines that don't coincide with the display grid (e.g. triplets)
  const minor = lineSpacing(v.zx, bar);
  if (d.snapGrid > 1 && d.snapGrid * v.zx >= 5 && minor % d.snapGrid !== 0 && d.snapGrid % minor !== 0) {
    ctx.fillStyle = C.lineSnap;
    for (let t = Math.ceil(t0 / d.snapGrid) * d.snapGrid; t < t1; t += d.snapGrid) ctx.fillRect(Math.round(tickX(v, t)), 0, 1, gh);
  }
  // vertical lines
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = Math.round(tickX(v, t));
    ctx.fillStyle = t % bar === 0 ? C.lineBar : t % 96 === 0 ? C.lineBeat : t % STEP === 0 ? C.lineStep : C.lineSub;
    ctx.fillRect(x, 0, 1, gh);
  }

  // ghost notes (one path per channel)
  for (const gch of d.ghosts) {
    ctx.beginPath();
    let any = false, outline = rowH >= 6;
    const seen = new Set<number>();
    for (const n of gch.notes) {
      if (n.key > kTop || n.key < kBot || n.start > t1 || n.start + n.len < t0) continue;
      const x = Math.round(tickX(v, n.start)), y = keyY(v, n.key);
      const w = Math.round(n.len * v.zx);
      if (w < 4) {
        // level of detail: tiny ghosts become flat, de-duplicated blips
        const k = n.key * 1e6 + x;
        if (seen.has(k)) continue;
        seen.add(k);
        outline = false;
      }
      ctx.rect(x + 0.5, Math.round(y) + 1.5, Math.max(2, w - 1), rowH - 2);
      any = true;
    }
    if (!any) continue;
    // FL ghost notes: dim outlines in the other channel's colour
    ctx.fillStyle = rgba(gch.color, outline ? 0.09 : 0.22);
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = rgba(gch.color, 0.55);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // pattern end
  const xe = tickX(v, d.patLen);
  if (xe < gw) {
    ctx.fillStyle = C.afterEnd;
    ctx.fillRect(Math.max(0, xe), 0, gw - Math.max(0, xe), gh);
    if (xe >= 0) {
      ctx.fillStyle = C.endLine;
      ctx.fillRect(Math.round(xe), 0, 1, gh);
    }
  }

  // notes — batched by fill style (one path / fill / stroke per bucket); selected ones on top
  const tiny = rowH < 7;
  const r = Math.min(3, rowH / 3.5);
  const lightText = luminance(d.color) < 0.5;
  const buckets = new Map<string, { fill: string; sel: boolean; muted: boolean; rects: number[]; flat: number[]; seen: Set<number> }>();
  const labels: { n: Note; x: number; y: number; w: number; h: number; sel: boolean }[] = [];
  let grip: number[] | null = null;
  for (const n of d.notes) {
    if (n.key > kTop || n.key < kBot || n.start > t1 || n.start + n.len < t0) continue;
    const isSel = d.sel.has(n.id);
    const hov = n.id === d.hoverNote;
    const x = tickX(v, n.start);
    const y = keyY(v, n.key) + 0.5;
    const w = Math.max(3, n.len * v.zx);
    const h = rowH - 1;
    const flat = w < 5;
    const fill = n.muted ? (isSel ? '#6a737a' : '#525b61') : isSel ? noteFill('#ff6b62', n.vel, flat ? 0.3 : 0.08) : noteFill(d.color, n.vel, hov ? 0.08 : 0);
    const bk = (isSel ? 'S' : 'N') + fill;
    let b = buckets.get(bk);
    if (!b) buckets.set(bk, (b = { fill, sel: isSel, muted: !!n.muted, rects: [], flat: [], seen: new Set() }));
    if (flat) {
      // level of detail: tiny notes are flat rects, de-duplicated per pixel column
      const k = n.key * 1e6 + Math.round(x);
      if (!b.seen.has(k)) {
        b.seen.add(k);
        b.flat.push(Math.round(x), y, w, h);
      }
    } else b.rects.push(x, y, w, h);
    if (hov && d.hoverEdge && w > 8) grip = [x, y, w, h];
    if (d.showNames && rowH >= 9 && w > 22) labels.push({ n, x, y, w, h, sel: isSel });
  }
  for (const pass of [false, true]) {
    const hl: number[] = [];
    for (const b of buckets.values()) {
      if (b.sel !== pass) continue;
      const R = b.rects;
      ctx.fillStyle = b.fill;
      if (b.flat.length) {
        ctx.beginPath();
        const F = b.flat;
        for (let i = 0; i < F.length; i += 4) ctx.rect(F[i], F[i + 1], F[i + 2], F[i + 3]);
        ctx.fill();
      }
      if (!R.length) continue;
      ctx.beginPath();
      for (let i = 0; i < R.length; i += 4) {
        if (tiny || R[i + 2] < 6) ctx.rect(R[i], R[i + 1], R[i + 2], R[i + 3]);
        else ctx.roundRect(R[i] + 0.5, R[i + 1] + 0.5, R[i + 2] - 1, R[i + 3] - 1, r);
        if (!b.muted && !tiny && R[i + 2] > 4) hl.push(R[i] + 1.5, R[i + 1] + 1, R[i + 2] - 3);
      }
      ctx.fill();
      if (!tiny || b.sel) {
        ctx.strokeStyle = b.sel ? (b.muted ? '#f3f6f8' : 'rgba(60,8,4,0.85)') : b.muted ? '#2a2f35' : 'rgba(10,30,8,0.6)';
        ctx.lineWidth = b.sel ? 1.5 : 1;
        ctx.stroke();
      }
    }
    if (hl.length) {
      // top highlight for a little depth
      ctx.beginPath();
      for (let i = 0; i < hl.length; i += 3) ctx.rect(hl[i], hl[i + 1], hl[i + 2], 1);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
    }
  }
  if (grip) {
    const [x, y, w, h] = grip;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(x + w - 4, y + 3, 1, Math.max(1, h - 6));
    ctx.fillRect(x + w - 6, y + 3, 1, Math.max(1, h - 6));
  }
  if (labels.length) {
    ctx.font = `600 ${rowH >= 15 ? 10 : 9}px ${FONT}`;
    ctx.textBaseline = 'middle';
    for (const L of labels) {
      const name = noteName(L.n.key);
      if (textW(ctx, name) + 8 >= L.w) continue;
      ctx.fillStyle = L.n.muted ? '#a0a9b0' : L.sel ? '#2a0602' : lightText || L.n.vel < 0.45 ? 'rgba(255,255,255,0.86)' : 'rgba(12,30,8,0.85)';
      ctx.fillText(name, Math.round(L.x + 4), Math.round(L.y + L.h / 2) + 0.5);
    }
  }

  // overlays
  if (d.slice) {
    const x = Math.round(tickX(v, d.slice.t)) + 0.5;
    const yA = keyY(v, d.slice.hi), yB = keyY(v, d.slice.lo) + rowH;
    ctx.strokeStyle = C.accent2;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, gh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(79,198,230,0.16)';
    ctx.fillRect(x - 3, yA, 6, yB - yA);
    ctx.fillStyle = C.accent2;
    ctx.fillRect(x - 1, yA, 2, yB - yA);
  }
  if (d.scrub !== null) {
    const x = Math.round(tickX(v, d.scrub));
    ctx.fillStyle = 'rgba(79,198,230,0.85)';
    ctx.fillRect(x, 0, 1, gh);
  }
  if (d.box) {
    const x = Math.min(d.box.x0, d.box.x1), y = Math.min(d.box.y0, d.box.y1);
    const w = Math.abs(d.box.x1 - d.box.x0), h = Math.abs(d.box.y1 - d.box.y0);
    ctx.fillStyle = d.box.kind === 'zoom' ? 'rgba(79,198,230,0.10)' : 'rgba(246,164,50,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = d.box.kind === 'zoom' ? C.accent2 : C.accent;
    ctx.lineWidth = 1;
    if (d.box.kind === 'zoom') ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.setLineDash([]);
  }
}

const twCache = new Map<string, number>();
function textW(ctx: CanvasRenderingContext2D, s: string) {
  const k = ctx.font + '|' + s;
  let w = twCache.get(k);
  if (w === undefined) {
    w = ctx.measureText(s).width;
    twCache.set(k, w);
  }
  return w;
}

// ------------------------------------------------------------------ keyboard
export interface KeysData {
  lit: Map<number, string>; // key -> highlight colour
  hoverKey: number | null;
  mask: boolean[] | null;
  root: number;
}

const WHITE_EDGES = new Set([1, 3, 6, 8, 10]); // black keys: white-key seams run through their middle

export function drawKeys(ctx: CanvasRenderingContext2D, v: View, w: number, d: KeysData) {
  const { gh, rowH } = v;
  ctx.clearRect(0, 0, w, gh);
  const kTop = clamp(yKey(v, 0), 0, 127);
  const kBot = clamp(yKey(v, gh - 1), 0, 127);
  const bw = Math.round(w * 0.6);
  // white key bed
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#b9c1c8');
  grad.addColorStop(0.18, '#dfe4e8');
  grad.addColorStop(1, '#eef1f3');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, gh);
  // white-key tints (lit / hover) and seams
  for (let k = kTop + 1; k >= kBot - 1; k--) {
    if (k < 0 || k > 127 || isBlackKey(k)) continue;
    const pcn = ((k % 12) + 12) % 12;
    // a white key spans its own row plus half of each neighbouring black-key row
    let top = keyY(v, k), bot = top + rowH;
    if (WHITE_EDGES.has(pcn + 1)) top -= rowH / 2;
    if (WHITE_EDGES.has(pcn - 1 < 0 ? 11 : pcn - 1)) bot += rowH / 2;
    const lit = d.lit.get(k);
    if (lit || d.hoverKey === k) {
      ctx.fillStyle = lit ?? 'rgba(246,164,50,0.28)';
      ctx.fillRect(0, top, w, bot - top);
    }
    ctx.fillStyle = 'rgba(40,46,52,0.55)';
    ctx.fillRect(0, Math.round(bot) - 1, w, 1);
  }
  // black keys (one gradient shared by every key — it only varies horizontally)
  const blackGrad = ctx.createLinearGradient(0, 0, bw, 0);
  blackGrad.addColorStop(0, '#0f1114');
  blackGrad.addColorStop(0.85, '#2a2f35');
  blackGrad.addColorStop(1, '#16191c');
  for (let k = kTop; k >= kBot; k--) {
    if (!isBlackKey(k)) continue;
    const y = keyY(v, k);
    const lit = d.lit.get(k);
    ctx.fillStyle = blackGrad;
    ctx.beginPath();
    ctx.roundRect(0, y + 0.5, bw, rowH - 1, [0, 2, 2, 0]);
    ctx.fill();
    if (lit || d.hoverKey === k) {
      ctx.fillStyle = lit ?? 'rgba(246,164,50,0.45)';
      ctx.globalAlpha = lit ? 0.85 : 1;
      ctx.fillRect(0, y + 1, bw - 1, rowH - 2);
      ctx.globalAlpha = 1;
    }
    if (rowH >= 6) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(2, y + 1.5, bw - 5, 1);
    }
  }
  // labels
  const fs = rowH >= 12 ? 10 : rowH >= 8 ? 9 : 8;
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let k = kTop; k >= kBot; k--) {
    if (k % 12 !== 0) continue;
    if (rowH < 5 && (k / 12) % 2 !== 0) continue;
    const y = keyY(v, k);
    ctx.fillStyle = d.lit.has(k) ? '#2a1a04' : k === 60 ? '#a55f08' : '#56626d';
    ctx.fillText(noteName(k), w - 4, Math.round(y + rowH / 2) + 0.5);
  }
  ctx.textAlign = 'left';
  // right edge shadow
  ctx.fillStyle = '#0d1013';
  ctx.fillRect(w - 1, 0, 1, gh);
}

// ------------------------------------------------------------------ ruler
export interface RulerData {
  patLen: number;
  bar: number;
  timeSig: [number, number];
  timeSel: { start: number; end: number } | null;
  hoverTick: number | null;
}

export function drawRuler(ctx: CanvasRenderingContext2D, v: View, h: number, d: RulerData) {
  const w = v.gw;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#36444b');
  g.addColorStop(1, '#2e3a40');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const t0 = v.sx, t1 = xTick(v, w);
  const bar = d.bar;
  // after-end shading
  const xe = tickX(v, d.patLen);
  if (xe < w) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(Math.max(0, xe), 0, w - Math.max(0, xe), h);
  }
  if (d.timeSel) {
    const x0 = tickX(v, d.timeSel.start), x1 = tickX(v, d.timeSel.end);
    ctx.fillStyle = 'rgba(79,198,230,0.28)';
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.fillStyle = '#4fc6e6';
    ctx.fillRect(x0, h - 2, x1 - x0, 2);
  }
  const minor = lineSpacing(v.zx, bar, 6);
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = Math.round(tickX(v, t));
    const isBar = t % bar === 0, isBeat = t % 96 === 0;
    ctx.fillStyle = isBar ? 'rgba(255,255,255,0.32)' : isBeat ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)';
    const th = isBar ? h - 3 : isBeat ? h * 0.32 : h * 0.18;
    ctx.fillRect(x, h - th, 1, th);
  }
  // labels: every N bars so they never collide; beats when zoomed in
  const barPx = bar * v.zx;
  let every = 1;
  while (every * barPx < 28) every *= 2;
  ctx.textBaseline = 'top';
  ctx.font = `600 10.5px ${FONT}`;
  for (let b = Math.floor(t0 / bar / every) * every; b * bar <= t1; b += every) {
    const x = Math.round(tickX(v, b * bar));
    ctx.fillStyle = b * bar < d.patLen ? '#e1e8ec' : '#8d9aa2';
    ctx.fillText(String(b + 1), x + 3, 3);
  }
  if (96 * v.zx >= 46) {
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = '#7f8c95';
    for (let t = Math.ceil(t0 / 96) * 96; t <= t1; t += 96) {
      if (t % bar === 0) continue;
      const x = Math.round(tickX(v, t));
      ctx.fillText(`${Math.floor(t / bar) + 1}.${Math.floor((t % bar) / 96) + 1}`, x + 3, 4);
    }
  }
  // pattern end flag
  if (xe >= -8 && xe <= w + 8) {
    ctx.fillStyle = '#f6a432';
    ctx.beginPath();
    ctx.moveTo(xe, h);
    ctx.lineTo(xe, h - 11);
    ctx.lineTo(xe - 7, h - 11);
    ctx.lineTo(xe, h - 4);
    ctx.closePath();
    ctx.fill();
  }
  if (d.hoverTick !== null) {
    const x = Math.round(tickX(v, d.hoverTick));
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x, 0, 1, h);
  }
  ctx.fillStyle = '#121719';
  ctx.fillRect(0, h - 1, w, 1);
}

// ------------------------------------------------------------------ overview strip
export interface OverviewData {
  notes: Note[];
  total: number; // ticks across the strip
  patLen: number;
  sel: Set<string>;
  play: number | null;
}

/** Visible window of the overview (strip px) and px-per-tick. */
export function overviewSpan(v: View, w: number, total: number) {
  const k = w / Math.max(1, total);
  return { k, x0: v.sx * k, x1: (v.sx + v.gw / v.zx) * k };
}

export function drawOverview(ctx: CanvasRenderingContext2D, v: View, w: number, h: number, d: OverviewData) {
  ctx.fillStyle = '#232d33';
  ctx.fillRect(0, 0, w, h);
  const { k, x0, x1 } = overviewSpan(v, w, d.total);
  const xe = d.patLen * k;
  if (xe < w) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(xe, 0, w - xe, h);
  }
  if (d.notes.length) {
    let lo = 127, hi = 0;
    for (const n of d.notes) {
      lo = Math.min(lo, n.key);
      hi = Math.max(hi, n.key);
    }
    const span = Math.max(12, hi - lo + 3);
    const mid = (lo + hi) / 2;
    const top = mid + span / 2;
    const rh = (h - 4) / span;
    const nh = Math.max(1, Math.min(2.5, rh));
    for (const pass of [false, true]) {
      ctx.fillStyle = pass ? '#ff8a7f' : '#a6e494';
      ctx.beginPath();
      for (const n of d.notes) {
        if (d.sel.has(n.id) !== pass || n.muted) continue;
        ctx.rect(n.start * k, 2 + (top - n.key) * rh, Math.max(1, n.len * k - 0.5), nh);
      }
      ctx.fill();
    }
  }
  // visible window box
  const a = Math.max(0, Math.min(w - 3, x0)), b = Math.max(a + 3, Math.min(w, x1));
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  ctx.fillRect(a, 0, b - a, h);
  ctx.strokeStyle = 'rgba(236,242,245,0.75)';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(a) + 0.5, 0.5, Math.max(2, Math.round(b - a) - 1), h - 1);
  if (d.play !== null) {
    ctx.fillStyle = '#8fe36d';
    ctx.fillRect(Math.round(d.play * k), 0, 1, h);
  }
}

// ------------------------------------------------------------------ velocity / pan lane
export interface LaneData {
  notes: Note[];
  color: string;
  sel: Set<string>;
  mode: 'vel' | 'pan';
  patLen: number;
  bar: number;
  hoverNote: string | null;
}

export function drawLane(ctx: CanvasRenderingContext2D, v: View, h: number, d: LaneData) {
  const w = v.gw;
  ctx.fillStyle = '#26323a';
  ctx.fillRect(0, 0, w, h);
  const top = 6, bot = h - 4, span = Math.max(1, bot - top);
  // guides
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (const f of [0.25, 0.5, 0.75]) ctx.fillRect(0, Math.round(top + span * f), w, 1);
  if (d.mode === 'pan') {
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.fillRect(0, Math.round(top + span / 2), w, 1);
  }
  const t0 = v.sx, t1 = xTick(v, w);
  // bar / beat lines like the grid
  const minor = lineSpacing(v.zx, d.bar, 7);
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    if (t % 96 !== 0) continue;
    ctx.fillStyle = t % d.bar === 0 ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.2)';
    ctx.fillRect(Math.round(tickX(v, t)), 0, 1, h);
  }
  const xe = tickX(v, d.patLen);
  if (xe < w) {
    ctx.fillStyle = C.afterEnd;
    ctx.fillRect(Math.max(0, xe), 0, w - Math.max(0, xe), h);
  }
  const anySel = d.sel.size > 0;
  // level of detail: when stems are denser than ~5px, draw bare stems (no heads), one per pixel column
  let visible = 0;
  for (const n of d.notes) if (n.start <= t1 && n.start >= t0 - 4 / v.zx) visible++;
  const dense = visible > w / 5;
  // bucket stems by colour so each bucket is one stroke (+ one head path)
  const buckets = new Map<string, { col: string; sel: boolean; dim: boolean; pts: number[]; seen: Map<number, number> }>();
  for (const n of d.notes) {
    if (n.start > t1 || n.start < t0 - 4 / v.zx) continue;
    const isSel = d.sel.has(n.id);
    const x = Math.round(tickX(v, n.start)) + 0.5;
    const val = d.mode === 'vel' ? clamp(n.vel, 0, 1) : clamp(n.pan, -1, 1);
    const y = d.mode === 'vel' ? bot - val * span : top + span / 2 - (val * span) / 2;
    const col = n.muted ? '#66717a' : isSel ? '#ff7a6e' : noteFill(d.color, d.mode === 'vel' ? Math.max(0.55, n.vel) : 0.8, n.id === d.hoverNote ? 0.2 : 0.08);
    const dim = anySel && !isSel;
    const k = col + (dim ? 'd' : '') + (isSel ? 's' : '');
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { col, sel: isSel, dim, pts: [], seen: new Map() }));
    if (dense) {
      const prev = b.seen.get(x);
      if (prev !== undefined) {
        if (y < b.pts[prev + 1]) b.pts[prev + 1] = y; // keep the tallest stem per column
        continue;
      }
      b.seen.set(x, b.pts.length);
    }
    b.pts.push(x, y);
  }
  const base = d.mode === 'vel' ? bot + 2 : top + span / 2;
  const rad = 3.2;
  for (const pass of [false, true]) {
    for (const b of buckets.values()) {
      if (b.sel !== pass) continue;
      const P = b.pts;
      ctx.globalAlpha = b.dim ? 0.45 : 1;
      // stems (FL: thin vertical lines ending in a round, hollow head)
      ctx.beginPath();
      for (let i = 0; i < P.length; i += 2) {
        const up = P[i + 1] < base;
        ctx.moveTo(P[i], base);
        ctx.lineTo(P[i], dense ? P[i + 1] : P[i + 1] + (up ? rad : -rad));
      }
      ctx.strokeStyle = b.col;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (dense) continue;
      ctx.beginPath();
      for (let i = 0; i < P.length; i += 2) {
        ctx.moveTo(P[i] + rad, P[i + 1]);
        ctx.arc(P[i], P[i + 1], rad, 0, Math.PI * 2);
      }
      ctx.fillStyle = '#26323a';
      ctx.fill();
      ctx.lineWidth = b.sel ? 1.6 : 1.3;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0d1013';
  ctx.fillRect(0, 0, w, 1);
}
