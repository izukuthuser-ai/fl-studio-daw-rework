// Playlist canvas rendering: grid, clips (with cached pattern / waveform previews), ruler.
import { Automation, Channel, Clip, ID, PPQ, Pattern, Project, STEP } from '../core/types';
import { autoValueAt, patternLen, secPerTick } from '../core/timing';
import { barLen, clamp, hexToRgb } from '../core/util';
import { samples } from '../audio/samples';
import { audioRate } from './playlist-model';

// ---------------------------------------------------------------------------
// view + lookup structures shared with playlist.ts
// ---------------------------------------------------------------------------
export interface View {
  ppt: number; // css px per tick
  vz: number; // vertical zoom
  sx: number; // scrollLeft (content px)
  sy: number; // scrollTop (content px)
  w: number; // viewport css px
  h: number;
  dpr: number;
  tops: number[]; // track top offsets, length = tracks + 1
  rowH: number; // height of virtual rows below the last track
}

export interface Lookup {
  pat: Map<ID, Pattern>;
  ch: Map<ID, Channel>;
  auto: Map<ID, Automation>;
  byTrack: Clip[][]; // clips per track, sorted by start
  maxLen: number[]; // longest clip per track (for culling)
  lastEnd: number; // end of the last clip
}

export function buildLookup(p: Project): Lookup {
  const byTrack: Clip[][] = [];
  const maxLen: number[] = [];
  let lastEnd = 0;
  for (const c of p.playlist.clips) {
    (byTrack[c.track] ??= []).push(c);
    maxLen[c.track] = Math.max(maxLen[c.track] ?? 0, c.len);
    lastEnd = Math.max(lastEnd, c.start + c.len);
  }
  for (const arr of byTrack) arr?.sort((a, b) => a.start - b.start);
  return {
    pat: new Map(p.patterns.map((x) => [x.id, x])),
    ch: new Map(p.channels.map((x) => [x.id, x])),
    auto: new Map(p.automations.map((x) => [x.id, x])),
    byTrack,
    maxLen,
    lastEnd,
  };
}

export function trackTop(v: View, i: number): number {
  const n = v.tops.length - 1;
  return i <= n ? v.tops[i] : v.tops[n] + (i - n) * v.rowH;
}
export function trackHeight(v: View, i: number): number {
  const n = v.tops.length - 1;
  return i < n ? v.tops[i + 1] - v.tops[i] : v.rowH;
}
/** Track index at content y (rows past the last track are "virtual" and auto-created when used). */
export function trackAt(v: View, cy: number): number {
  const t = v.tops;
  const n = t.length - 1;
  if (cy < 0) return 0;
  if (cy >= t[n]) return n + Math.floor((cy - t[n]) / v.rowH);
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (t[m] <= cy) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/** First index in a start-sorted clip list that may overlap tick t (given the longest clip). */
export function firstCandidate(list: Clip[], t: number, maxLen: number): number {
  const target = t - maxLen;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].start < target) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Adaptive grid: smallest musical unit that's at least `minPx` wide at this zoom. */
export function gridUnit(ppt: number, timeSig: [number, number], minPx = 11): number {
  const bar = barLen(timeSig);
  const beat = (PPQ * 4) / timeSig[1];
  const units = [STEP, beat, bar, bar * 2, bar * 4, bar * 8, bar * 16, bar * 32, bar * 64];
  for (const u of units) if (u * ppt >= minPx) return u;
  return units[units.length - 1];
}

// ---------------------------------------------------------------------------
// colours
// ---------------------------------------------------------------------------
export const COL = {
  // FL-style slate playlist
  bg: '#343c41',
  rowA: '#3b4449',
  rowB: '#384045',
  rowMuted: '#30373b',
  virtual: '#323a3f',
  sep: '#2a3135',
  sepHi: 'rgba(255,255,255,0.04)',
  shade: 'rgba(255,255,255,0.035)',
  lineStep: 'rgba(16,20,23,0.12)',
  lineBeat: 'rgba(16,20,23,0.24)',
  lineBar: 'rgba(16,20,23,0.48)',
  lineGroup: 'rgba(16,20,23,0.70)',
  sel: 'rgba(100,195,230,0.10)',
  selEdge: 'rgba(100,195,230,0.8)',
  accent: '#ff9d2a',
  accent2: '#64c3e6',
  text: '#dde4e8',
  dim: '#a5b1b8',
  faint: '#78868f',
};

const FONT = '600 10px Inter, "Segoe UI", system-ui, -apple-system, sans-serif';
const FONT_RULER = '600 10px "Cascadia Mono", Consolas, "SF Mono", Menlo, ui-monospace, monospace';

function rgbStr(r: number, g: number, b: number) {
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}
function safeRgb(c: string): [number, number, number] {
  if (c.startsWith('#')) return hexToRgb(c);
  const m = c.match(/\d+(\.\d+)?/g);
  return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : [128, 128, 128];
}
function mixRgb(a: [number, number, number], b: [number, number, number], t: number) {
  return rgbStr(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

interface ClipPal {
  body: string;
  title: string;
  titleSel: string;
  text: string;
  content: string;
  contentFill: string;
  edge: string;
  loopSep: string;
}
const palCache = new Map<string, ClipPal>();
function pal(color: string, muted: boolean): ClipPal {
  const key = color + (muted ? '|m' : '');
  let p = palCache.get(key);
  if (p) return p;
  let c = safeRgb(color);
  if (muted) {
    const g = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    c = [g * 0.55 + 70, g * 0.55 + 76, g * 0.55 + 82];
  }
  const dark: [number, number, number] = [24, 28, 32];
  const white: [number, number, number] = [255, 255, 255];
  const lum = (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255;
  // FL look: darker coloured title strip, lighter tinted body, content drawn dark on the body
  p = {
    body: mixRgb(c, [58, 66, 71], muted ? 0.62 : 0.38),
    title: mixRgb(c, dark, muted ? 0.5 : 0.32),
    titleSel: mixRgb(c, white, 0.25),
    text: '#f4f7f8',
    content: muted ? mixRgb(c, dark, 0.55) : mixRgb(c, dark, 0.7),
    contentFill: `rgba(${dark[0]},${dark[1]},${dark[2]},${muted ? 0.18 : 0.28})`,
    edge: mixRgb(c, dark, 0.78),
    loopSep: `rgba(${dark[0]},${dark[1]},${dark[2]},0.4)`,
  };
  if (palCache.size > 400) palCache.clear();
  palCache.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// preview caches
// ---------------------------------------------------------------------------
interface PatNote {
  s: number;
  e: number;
  y0: number; // 0..1
  y1: number;
}
interface PatLayout {
  gen: number;
  sig: string;
  plen: number;
  notes: PatNote[];
}

let gen = 0;
const layouts = new Map<ID, PatLayout>();
/** Call on every project change; layouts revalidate lazily via a cheap signature. */
export function bumpGeneration() {
  gen++;
}

function patSignature(p: Project, pt: Pattern, plen: number): string {
  let h = 2166136261 >>> 0;
  let count = 0;
  const mix = (n: number) => {
    h ^= n & 0xffffffff;
    h = Math.imul(h, 16777619) >>> 0;
  };
  for (const ch of p.channels) {
    const arr = pt.notes[ch.id];
    if (!arr?.length) continue;
    mix(ch.id.length * 131 + ch.id.charCodeAt(ch.id.length - 1));
    for (const n of arr) {
      mix(n.key);
      mix(Math.round(n.start * 8));
      mix(Math.round(n.len * 8));
      mix(n.muted ? 1 : 0);
      count++;
    }
  }
  return `${plen}|${count}|${h}`;
}

function patLayout(p: Project, pt: Pattern): PatLayout {
  let L = layouts.get(pt.id);
  if (L && L.gen === gen) return L;
  const plen = patternLen(pt, p.timeSig);
  const sig = patSignature(p, pt, plen);
  if (L && L.sig === sig) {
    L.gen = gen;
    return L;
  }
  // lanes: one per channel with notes; melodic channels get taller lanes
  // Few distinct keys -> one row per key (readable chords / drums); many -> pitch-proportional rows.
  const lanes: { id: ID; rowOf: (k: number) => number; rows: number; w: number }[] = [];
  for (const ch of p.channels) {
    const arr = pt.notes[ch.id];
    if (!arr?.length) continue;
    const keys = new Set<number>();
    for (const n of arr) if (!n.muted && n.start < plen) keys.add(n.key);
    if (!keys.size) continue;
    const sorted = [...keys].sort((a, b) => b - a);
    const lo = sorted[sorted.length - 1], hi = sorted[0];
    if (sorted.length <= 12) {
      const rank = new Map(sorted.map((k, i) => [k, i]));
      lanes.push({ id: ch.id, rowOf: (k) => rank.get(k) ?? 0, rows: sorted.length, w: sorted.length === 1 ? 1 : 1.4 + Math.min(sorted.length, 12) / 3 });
    } else lanes.push({ id: ch.id, rowOf: (k) => hi - k, rows: hi - lo + 1, w: 1.6 + Math.min(hi - lo, 24) / 5 });
  }
  const total = lanes.reduce((a, l) => a + l.w, 0) || 1;
  const PAD = 0.08;
  const notes: PatNote[] = [];
  let acc = 0;
  for (const l of lanes) {
    const top = PAD + (acc / total) * (1 - 2 * PAD);
    const hgt = (l.w / total) * (1 - 2 * PAD);
    acc += l.w;
    const rh = hgt / l.rows;
    for (const n of pt.notes[l.id]) {
      if (n.muted || n.start >= plen) continue;
      const y0 = top + l.rowOf(n.key) * rh;
      notes.push({ s: n.start, e: Math.min(plen, n.start + Math.max(1, n.len)), y0, y1: y0 + rh });
    }
  }
  L = { gen, sig, plen, notes };
  layouts.set(pt.id, L);
  return L;
}

/** LRU of pre-rendered preview strips (one pattern loop or one whole sample). */
class StripCache {
  private map = new Map<string, HTMLCanvasElement>();
  get(key: string, w: number, h: number, dpr: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): HTMLCanvasElement | null {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const pw = Math.ceil(w * dpr), ph = Math.ceil(h * dpr);
    if (pw < 1 || ph < 1 || pw > 6144 || ph > 1024) return null;
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    draw(g, w, h);
    this.map.set(key, c);
    if (this.map.size > 120) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    return c;
  }
  clear() {
    this.map.clear();
  }
}
const strips = new StripCache();
export function clearPreviewCaches() {
  strips.clear();
  layouts.clear();
}

function drawNotes(g: CanvasRenderingContext2D, L: PatLayout, x0: number, y0: number, h: number, ppt: number, color: string, vis0 = -Infinity, vis1 = Infinity) {
  g.fillStyle = color;
  const gap = STEP * ppt > 7 ? 1 : 0;
  const gy = h > 30 ? 1 : 0;
  for (const n of L.notes) {
    const x = x0 + n.s * ppt;
    const w = Math.max(1, (n.e - n.s) * ppt - gap);
    if (x > vis1 || x + w < vis0) continue;
    g.fillRect(x, y0 + n.y0 * h, w, Math.max(1, (n.y1 - n.y0) * h - gy));
  }
}

function peaksFor(ref: string, wantBuckets: number): { peaks: Float32Array; B: number } | null {
  const b = samples.get(ref);
  if (!b) return null;
  let B = 64;
  const cap = Math.min(32768, Math.max(64, Math.floor(b.length / 2)));
  while (B < wantBuckets && B < cap) B *= 2;
  const peaks = samples.peaks(ref, B);
  return peaks ? { peaks, B } : null;
}

/** Draw a min/max waveform of a whole sample spanning [x0, x0+w], only columns inside [vis0, vis1]. */
function drawWave(g: CanvasRenderingContext2D, pk: { peaks: Float32Array; B: number }, rev: boolean, x0: number, y0: number, w: number, h: number, colW: number, color: string, vis0: number, vis1: number) {
  const { peaks, B } = pk;
  const mid = y0 + h / 2;
  const amp = (h / 2) * 0.94;
  const a = Math.max(vis0, x0), b = Math.min(vis1, x0 + w);
  if (b <= a) return;
  g.fillStyle = color;
  g.beginPath();
  const start = Math.floor((a - x0) / colW) * colW + x0;
  for (let px = start; px < b; px += colW) {
    let f0 = (px - x0) / w, f1 = (px + colW - x0) / w;
    if (rev) [f0, f1] = [1 - f1, 1 - f0];
    let i0 = Math.max(0, Math.floor(f0 * B));
    const i1 = Math.min(B, Math.max(i0 + 1, Math.ceil(f1 * B)));
    let mn = 0, mx = 0;
    for (; i0 < i1; i0++) {
      const lo = peaks[i0 * 2], hi = peaks[i0 * 2 + 1];
      if (lo < mn) mn = lo;
      if (hi > mx) mx = hi;
    }
    const top = mid - Math.min(1, mx) * amp;
    const hh = Math.max(colW, (Math.min(1, mx) - Math.max(-1, mn)) * amp);
    g.rect(px, top, colW, hh);
  }
  g.fill();
}

// ---------------------------------------------------------------------------
// clip drawing
// ---------------------------------------------------------------------------
export const TITLE_H = 14;
export function titleHeight(h: number) {
  return h >= 26 ? TITLE_H : 0;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export interface ClipGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen geometry of a clip (canvas-local css px). */
export function clipGeom(v: View, c: Clip): ClipGeom {
  const top = trackTop(v, c.track) - v.sy;
  const th = trackHeight(v, c.track);
  return { x: c.start * v.ppt - v.sx, y: top + 1, w: c.len * v.ppt, h: th - 2 };
}

export function drawClip(g: CanvasRenderingContext2D, v: View, p: Project, L: Lookup, c: Clip, selected: boolean, hoverPoint = -1) {
  const { x, y, w, h } = clipGeom(v, c);
  if (w < 0.3 || h < 3) return;
  const vx0 = Math.max(x, -6), vx1 = Math.min(x + w, v.w + 6);
  if (vx1 <= vx0) return;
  let color = '#6b7680', name = '?';
  let pt: Pattern | undefined, ch: Channel | undefined, au: Automation | undefined;
  if (c.kind === 'pattern') {
    pt = L.pat.get(c.ref);
    if (pt) (color = pt.color), (name = pt.name);
  } else if (c.kind === 'audio') {
    ch = L.ch.get(c.ref);
    if (ch) (color = ch.color), (name = ch.name);
  } else {
    au = L.auto.get(c.ref);
    if (au) (color = au.color), (name = au.name);
  }
  const P = pal(color, !!c.muted);
  const rx = vx0, rw = vx1 - vx0;
  const th = titleHeight(h);

  roundRect(g, rx, y, rw, h, 3);
  g.fillStyle = P.body;
  g.fill();
  g.save();
  g.clip();
  // title strip
  if (th) {
    g.fillStyle = selected ? P.titleSel : P.title;
    g.fillRect(rx, y, rw, th);
  }
  const cy = y + th + 1;
  const chh = h - th - 3;
  if (chh >= 2) {
    if (pt) drawPatternContent(g, v, p, pt, c, x, w, cy, chh, P, vx0, vx1);
    else if (ch) drawAudioContent(g, v, p, ch, c, x, cy, chh, P, vx0, vx1);
    else if (au) drawAutoContent(g, v, au, c, x, w, cy, chh, P, color, !!c.muted);
  }
  // name
  if (w > 18) {
    g.font = FONT;
    g.textBaseline = 'middle';
    const tx = Math.max(x, 0) + 4;
    if (th) {
      g.fillStyle = P.text;
      g.fillText(name, tx, y + th / 2 + 0.5);
    } else if (h >= 12) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText(name, tx, y + h / 2 + 0.5);
    }
  }
  if (c.group) {
    // small group marker in the top-right corner
    g.fillStyle = selected ? '#ffffff' : P.text;
    g.globalAlpha = 0.65;
    const gx = Math.min(x + w, v.w) - 8;
    g.fillRect(gx, y + 3, 4, 4);
    g.globalAlpha = 1;
  }
  g.restore();
  // outline
  roundRect(g, rx + 0.5, y + 0.5, rw - 1, h - 1, 3);
  if (selected) {
    g.lineWidth = 1.6;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.lineWidth = 1;
  } else {
    g.lineWidth = 1;
    g.strokeStyle = P.edge;
    g.stroke();
  }
  if (au && chh >= 2) drawAutoHandles(g, v, au, c, x, cy, chh, P, hoverPoint);
}

function drawPatternContent(g: CanvasRenderingContext2D, v: View, p: Project, pt: Pattern, c: Clip, x: number, w: number, cy: number, chh: number, P: ClipPal, vx0: number, vx1: number) {
  const L = patLayout(p, pt);
  const plen = L.plen;
  const loopW = plen * v.ppt;
  if (loopW < 0.5) return;
  const base = x - c.offset * v.ppt; // x of pattern tick 0 (loop k = 0)
  const kStart = Math.max(0, Math.floor((Math.max(vx0, x) - base) / loopW));
  const right = Math.min(vx1, x + w);
  if (!L.notes.length) return;
  const key = `p|${pt.id}|${L.sig}|${v.ppt.toFixed(6)}|${chh.toFixed(1)}|${P.content}|${v.dpr}`;
  const strip = strips.get(key, loopW, chh, v.dpr, (s, sw, sh) => drawNotes(s, L, 0, 0, sh, v.ppt, P.content));
  for (let k = kStart; ; k++) {
    const lx = base + k * loopW;
    if (lx > right) break;
    if (k > 0 && lx > x + 0.5) {
      g.fillStyle = P.loopSep;
      g.fillRect(Math.round(lx), cy - 1, 1, chh + 2);
    }
    if (strip) g.drawImage(strip, lx, cy, strip.width / v.dpr, strip.height / v.dpr);
    else drawNotes(g, L, lx, cy, chh, v.ppt, P.content, vx0, vx1);
  }
}

function drawAudioContent(g: CanvasRenderingContext2D, v: View, p: Project, ch: Channel, c: Clip, x: number, cy: number, chh: number, P: ClipPal, vx0: number, vx1: number) {
  const ref = ch.sampler?.sampleRef;
  const buf = ref ? samples.get(ref) : undefined;
  if (!ref || !buf) {
    g.font = FONT;
    g.fillStyle = P.content;
    g.textBaseline = 'middle';
    g.fillText(ref && samples.isMissing(ref) ? 'missing sample' : 'loading…', Math.max(x, 0) + 4, cy + chh / 2);
    return;
  }
  const rate = audioRate(ch);
  const spt = secPerTick(p.bpm);
  const totalTicks = buf.duration / rate / spt;
  const sw = totalTicks * v.ppt;
  const sx0 = x - (c.offset / rate) * v.ppt;
  const rev = !!ch.sampler?.reverse;
  const colW = 1 / v.dpr;
  // centre line
  g.fillStyle = P.contentFill;
  g.fillRect(Math.max(vx0, sx0), cy + chh / 2 - 0.5, Math.max(0, Math.min(vx1, sx0 + sw) - Math.max(vx0, sx0)), 1);
  const key = `a|${ref}|${rev ? 1 : 0}|${rate.toFixed(5)}|${spt.toFixed(8)}|${v.ppt.toFixed(6)}|${chh.toFixed(1)}|${P.content}|${v.dpr}`;
  const strip = strips.get(key, sw, chh, v.dpr, (s, w, h) => {
    const pk = peaksFor(ref, Math.ceil(w * v.dpr));
    if (pk) drawWave(s, pk, rev, 0, 0, w, h, colW, P.content, 0, w);
  });
  if (strip) g.drawImage(strip, sx0, cy, strip.width / v.dpr, strip.height / v.dpr);
  else {
    const pk = peaksFor(ref, Math.ceil(sw * v.dpr));
    if (pk) drawWave(g, pk, rev, sx0, cy, sw, chh, colW, P.content, vx0, vx1);
  }
}

function drawAutoContent(g: CanvasRenderingContext2D, v: View, a: Automation, c: Clip, x: number, w: number, cy: number, chh: number, P: ClipPal, color: string, muted: boolean) {
  const top = cy + 2;
  const hh = Math.max(2, chh - 4);
  const vy = (val: number) => top + (1 - clamp(val, 0, 1)) * hh;
  const tx = (t: number) => x + (t - c.offset) * v.ppt;
  const t0 = c.offset, t1 = c.offset + c.len;
  g.beginPath();
  g.moveTo(x, vy(autoValueAt(a, t0)));
  for (const pnt of a.points) if (pnt.t > t0 && pnt.t < t1) g.lineTo(tx(pnt.t), vy(pnt.v));
  g.lineTo(x + w, vy(autoValueAt(a, t1)));
  const line = new Path2D();
  // fill under the curve
  g.lineTo(x + w, top + hh + 2);
  g.lineTo(x, top + hh + 2);
  g.closePath();
  g.fillStyle = P.contentFill;
  g.fill();
  line.moveTo(x, vy(autoValueAt(a, t0)));
  for (const pnt of a.points) if (pnt.t > t0 && pnt.t < t1) line.lineTo(tx(pnt.t), vy(pnt.v));
  line.lineTo(x + w, vy(autoValueAt(a, t1)));
  g.strokeStyle = muted ? P.content : color;
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.stroke(line);
  g.lineWidth = 1;
}

function drawAutoHandles(g: CanvasRenderingContext2D, v: View, a: Automation, c: Clip, x: number, cy: number, chh: number, P: ClipPal, hoverPoint: number) {
  if (chh < 14) return;
  const top = cy + 2;
  const hh = Math.max(2, chh - 4);
  const t0 = c.offset, t1 = c.offset + c.len;
  a.points.forEach((pnt, i) => {
    if (pnt.t < t0 || pnt.t > t1) return;
    const px = x + (pnt.t - c.offset) * v.ppt, py = top + (1 - clamp(pnt.v, 0, 1)) * hh;
    if (px < -6 || px > v.w + 6) return;
    const r = i === hoverPoint ? 4.2 : 3;
    g.beginPath();
    g.arc(px, py, r, 0, Math.PI * 2);
    g.fillStyle = i === hoverPoint ? '#ffffff' : P.title;
    g.fill();
    g.lineWidth = 1.2;
    g.strokeStyle = '#101417';
    g.stroke();
    g.lineWidth = 1;
  });
}

/** Point positions (canvas css px) for automation hit-testing; mirrors drawAutoContent's mapping. */
export function autoPointMap(v: View, c: Clip) {
  const G = clipGeom(v, c);
  const th = titleHeight(G.h);
  const cy = G.y + th + 1;
  const chh = G.h - th - 3;
  const top = cy + 2;
  const hh = Math.max(2, chh - 4);
  return {
    top,
    hh,
    xOf: (t: number) => G.x + (t - c.offset) * v.ppt,
    yOf: (val: number) => top + (1 - clamp(val, 0, 1)) * hh,
    vAt: (py: number) => clamp(1 - (py - top) / hh, 0, 1),
    bodyTop: G.y + th,
  };
}

// ---------------------------------------------------------------------------
// main grid + clips
// ---------------------------------------------------------------------------
export interface MainExtras {
  sel: Set<ID>;
  loop: { start: number; end: number } | null;
  hoverAuto: { clipId: ID; point: number } | null;
}

export function drawMain(g: CanvasRenderingContext2D, v: View, p: Project, L: Lookup, x: MainExtras) {
  const { w: W, h: H, ppt, sx, sy } = v;
  g.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  g.fillStyle = COL.bg;
  g.fillRect(0, 0, W, H);
  const tracks = p.playlist.tracks;
  const n = tracks.length;
  const i0 = trackAt(v, sy);
  const i1 = trackAt(v, sy + H);
  // rows
  for (let i = i0; i <= i1; i++) {
    const top = Math.round(trackTop(v, i) - sy);
    const hh = Math.round(trackTop(v, i + 1) - sy) - top;
    g.fillStyle = i >= n ? COL.virtual : tracks[i].mute ? COL.rowMuted : i % 2 ? COL.rowB : COL.rowA;
    g.fillRect(0, top, W, hh);
  }
  // alternating bar shading
  const bar = barLen(p.timeSig);
  const beat = (PPQ * 4) / p.timeSig[1];
  const shadeUnit = bar * ppt >= 22 ? bar : bar * 4 * ppt >= 22 ? bar * 4 : bar * 16;
  const t0 = sx / ppt, t1 = (sx + W) / ppt;
  g.fillStyle = COL.shade;
  for (let k = Math.floor(t0 / shadeUnit); k * shadeUnit < t1; k++) {
    if (k % 2 === 0) continue;
    const a = Math.round(k * shadeUnit * ppt - sx);
    const b = Math.round((k + 1) * shadeUnit * ppt - sx);
    g.fillRect(a, 0, b - a, H);
  }
  // grid lines
  const unit = gridUnit(ppt, p.timeSig, 9);
  const contentBottom = Math.min(H, trackTop(v, Math.max(n, i1 + 1)) - sy);
  for (let t = Math.floor(t0 / unit) * unit; t <= t1; t += unit) {
    const xx = Math.round(t * ppt - sx);
    let c: string;
    if (t % (bar * 4) === 0 && unit >= bar) c = COL.lineGroup;
    else if (t % bar === 0) c = unit >= bar ? COL.lineBeat : COL.lineBar;
    else if (t % beat === 0) c = COL.lineBeat;
    else c = COL.lineStep;
    g.fillStyle = c;
    g.fillRect(xx, 0, 1, contentBottom);
  }
  // track separators
  for (let i = i0; i <= i1; i++) {
    const yb = Math.round(trackTop(v, i + 1) - sy) - 1;
    g.fillStyle = i >= n - 1 ? 'rgba(10,12,14,0.5)' : COL.sep;
    g.fillRect(0, yb, W, 1);
    g.fillStyle = COL.sepHi;
    g.fillRect(0, yb + 1, W, 1);
  }
  // time selection
  if (x.loop && x.loop.end > x.loop.start) {
    const a = x.loop.start * ppt - sx, b = x.loop.end * ppt - sx;
    if (b > 0 && a < W) {
      g.fillStyle = COL.sel;
      g.fillRect(a, 0, b - a, H);
      g.fillStyle = COL.selEdge;
      g.globalAlpha = 0.5;
      g.fillRect(Math.round(a), 0, 1, H);
      g.fillRect(Math.round(b) - 1, 0, 1, H);
      g.globalAlpha = 1;
    }
  }
  // clips (selected ones last so their outline sits on top)
  const selected: Clip[] = [];
  for (let i = i0; i <= Math.min(i1, n - 1 + 64); i++) {
    const list = L.byTrack[i];
    if (!list?.length) continue;
    const ml = L.maxLen[i] ?? 0;
    for (let k = firstCandidate(list, t0, ml); k < list.length; k++) {
      const c = list[k];
      if (c.start > t1) break;
      if (c.start + c.len < t0) continue;
      if (x.sel.has(c.id)) {
        selected.push(c);
        continue;
      }
      drawClip(g, v, p, L, c, false, x.hoverAuto?.clipId === c.id ? x.hoverAuto.point : -1);
    }
  }
  for (const c of selected) drawClip(g, v, p, L, c, true, x.hoverAuto?.clipId === c.id ? x.hoverAuto.point : -1);
}

// ---------------------------------------------------------------------------
// ruler
// ---------------------------------------------------------------------------
export interface RulerState {
  loop: { start: number; end: number } | null;
  songStart: number;
  songEnd: number;
  playhead: number | null; // song-mode playback position
  hoverTick: number | null;
}

export const RULER_H = 30;

export function drawRuler(g: CanvasRenderingContext2D, v: View, p: Project, r: RulerState) {
  const W = v.w, H = RULER_H, { ppt, sx } = v;
  g.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#465057');
  grd.addColorStop(1, '#3a4248');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  const bar = barLen(p.timeSig);
  const beat = (PPQ * 4) / p.timeSig[1];
  const t0 = sx / ppt, t1 = (sx + W) / ppt;
  // loop band
  if (r.loop && r.loop.end > r.loop.start) {
    const a = r.loop.start * ppt - sx, b = r.loop.end * ppt - sx;
    g.fillStyle = 'rgba(79,198,230,0.26)';
    g.fillRect(a, 13, b - a, H - 13);
    g.fillStyle = COL.accent2;
    g.fillRect(a, 13, b - a, 2);
    g.fillRect(Math.round(a), 13, 1, H - 13);
    g.fillRect(Math.round(b) - 1, 13, 1, H - 13);
  }
  // past-the-end dimming
  const endX = r.songEnd * ppt - sx;
  if (endX < W) {
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.fillRect(Math.max(0, endX), 0, W - Math.max(0, endX), H);
  }
  // ticks + labels
  let labelEvery = 1;
  while (labelEvery * bar * ppt < 34 && labelEvery < 4096) labelEvery *= 2;
  g.font = FONT_RULER;
  g.textBaseline = 'alphabetic';
  if (beat * ppt >= 7) {
    g.fillStyle = 'rgba(255,255,255,0.16)';
    for (let t = Math.floor(t0 / beat) * beat; t <= t1; t += beat) {
      if (t % bar === 0) continue;
      g.fillRect(Math.round(t * ppt - sx), H - 4, 1, 4);
    }
  }
  const tickEvery = bar * ppt >= 5 ? 1 : labelEvery;
  for (let b = Math.floor(t0 / bar / tickEvery) * tickEvery; b * bar <= t1; b += tickEvery) {
    const xx = Math.round(b * bar * ppt - sx);
    const lab = b % labelEvery === 0;
    g.fillStyle = lab ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.22)';
    g.fillRect(xx, lab ? H - 11 : H - 7, 1, lab ? 11 : 7);
    if (lab) {
      g.fillStyle = b * bar < r.songEnd ? '#c9d3db' : '#7d8a95';
      g.fillText(String(b + 1), xx + 3, 11);
    }
  }
  // song end marker
  if (endX > -10 && endX < W + 10) {
    g.fillStyle = '#9aa7b0';
    g.beginPath();
    g.moveTo(endX, 13);
    g.lineTo(endX, H);
    g.lineTo(endX - 1, H);
    g.lineTo(endX - 1, 13);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(endX, 13);
    g.lineTo(endX + 7, 16.5);
    g.lineTo(endX, 20);
    g.closePath();
    g.fill();
  }
  // hover tick
  if (r.hoverTick !== null) {
    const hx = Math.round(r.hoverTick * ppt - sx);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(hx, 13, 1, H - 13);
  }
  // song position marker
  const mx = r.songStart * ppt - sx;
  if (mx > -10 && mx < W + 10) {
    g.fillStyle = r.playhead === null ? COL.accent : 'rgba(246,164,50,0.55)';
    g.beginPath();
    g.moveTo(mx - 6, 14);
    g.lineTo(mx + 6, 14);
    g.lineTo(mx + 6, 19);
    g.lineTo(mx, H - 1);
    g.lineTo(mx - 6, 19);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.stroke();
  }
  if (r.playhead !== null) {
    const px = r.playhead * ppt - sx;
    if (px > -10 && px < W + 10) {
      g.fillStyle = '#7dffa8';
      g.beginPath();
      g.moveTo(px - 5, 15);
      g.lineTo(px + 5, 15);
      g.lineTo(px, H - 2);
      g.closePath();
      g.fill();
      g.fillRect(Math.round(px), 15, 1, H - 15);
    }
  }
  g.fillStyle = '#22292d';
  g.fillRect(0, H - 1, W, 1);
}
