// Piano Roll note operations. Every function mutates the given note array in place
// (callers run them inside store.commit / store.live) and may return new ids to select.
import { Note } from '../core/types';
import { clamp, snapRound, uid } from '../core/util';
import { inScale, snapToScale, stepInScale } from './pianoRoll-theory';

export type Mask = boolean[] | null;

const K = (k: number) => clamp(Math.round(k), 0, 127);
const T = (t: number) => Math.max(0, Math.round(t));
const L = (l: number) => Math.max(1, Math.round(l));
const end = (n: Note) => n.start + n.len;

export function cloneNote(n: Note, patch: Partial<Note> = {}): Note {
  const c: Note = { id: uid('n'), key: n.key, start: n.start, len: n.len, vel: n.vel, pan: n.pan };
  if (n.muted) c.muted = true;
  return Object.assign(c, patch);
}

function removeIds(arr: Note[], ids: Set<string>) {
  let w = 0;
  for (let r = 0; r < arr.length; r++) if (!ids.has(arr[r].id)) arr[w++] = arr[r];
  arr.length = w;
}

/** Groups notes by identical start time (chords), sorted by time. */
export function chords(target: Note[]): Note[][] {
  const m = new Map<number, Note[]>();
  for (const n of target) {
    const g = m.get(n.start);
    if (g) g.push(n);
    else m.set(n.start, [n]);
  }
  return [...m.keys()].sort((a, b) => a - b).map((k) => m.get(k)!);
}

export function span(target: Note[]) {
  let a = Infinity, b = -Infinity, lo = 127, hi = 0;
  for (const n of target) {
    a = Math.min(a, n.start);
    b = Math.max(b, end(n));
    lo = Math.min(lo, n.key);
    hi = Math.max(hi, n.key);
  }
  return { start: a, end: b, lo, hi };
}

// ---------------------------------------------------------------- pitch
/** Semitone transpose. With a scale mask, ±1 moves by scale degree and results are forced into the scale. */
export function transpose(target: Note[], semis: number, mask: Mask) {
  if (!target.length || !semis) return;
  const next = target.map((n) => {
    if (mask && Math.abs(semis) === 1) return stepInScale(snapToScale(n.key, mask, semis > 0 ? -1 : 1), mask, semis as 1 | -1);
    const k = n.key + semis;
    return mask ? snapToScale(k, mask, semis > 0 ? 1 : -1) : k;
  });
  if (next.some((k) => k < 0 || k > 127)) return; // keep the shape: refuse to clip at the keyboard edges
  target.forEach((n, i) => (n.key = next[i]));
}

/** Fold keys into [lo, hi] by octaves (clamps when the range is narrower than an octave). */
export function limit(target: Note[], lo: number, hi: number) {
  if (hi < lo) [lo, hi] = [hi, lo];
  for (const n of target) {
    let k = n.key;
    if (hi - lo >= 11) {
      while (k < lo) k += 12;
      while (k > hi) k -= 12;
    } else k = clamp(k, lo, hi);
    n.key = K(k);
  }
}

// ---------------------------------------------------------------- time
export function shiftTime(target: Note[], dt: number) {
  if (!target.length) return;
  const s = span(target);
  if (s.start + dt < 0) dt = -s.start;
  for (const n of target) n.start = T(n.start + dt);
}

/** Move notes by dt, wrapping around the pattern length. */
export function rotate(target: Note[], dt: number, patLen: number) {
  if (patLen <= 0) return;
  for (const n of target) n.start = T((((n.start + dt) % patLen) + patLen) % patLen);
}

export function quantize(target: Note[], o: { grid: number; strength: number; starts: boolean; ends: boolean }) {
  const g = Math.max(1, o.grid);
  const s = clamp(o.strength, 0, 1);
  for (const n of target) {
    const e = end(n);
    let st = n.start;
    if (o.starts) st = n.start + (snapRound(n.start, g) - n.start) * s;
    let en = o.ends ? e + (snapRound(e, g) - e) * s : st + n.len;
    if (o.ends && en - st < g * s) en = st + Math.max(n.len * (1 - s) + g * s, 1);
    n.start = T(st);
    n.len = L(en - n.start);
  }
}

/** Quick quantize: snap start times (and lengths) to the grid. */
export function quickQuantize(target: Note[], grid: number, lengths: boolean) {
  const g = Math.max(1, grid);
  for (const n of target) {
    n.start = T(snapRound(n.start, g));
    if (lengths) n.len = L(Math.max(g, snapRound(n.len, g)));
  }
}

function nextStarts(target: Note[]) {
  const starts = [...new Set(target.map((n) => n.start))].sort((a, b) => a - b);
  const next = new Map<number, number>();
  for (let i = 0; i < starts.length - 1; i++) next.set(starts[i], starts[i + 1]);
  return next;
}

export function legato(target: Note[]) {
  const nx = nextStarts(target);
  for (const n of target) {
    const s = nx.get(n.start);
    if (s !== undefined) n.len = L(s - n.start);
  }
}

export function articulate(target: Note[], pct: number, mode: 'length' | 'gap') {
  const nx = nextStarts(target);
  for (const n of target) {
    const base = mode === 'gap' ? (nx.get(n.start) ?? end(n)) - n.start : n.len;
    n.len = L(base * pct);
  }
}

export function discardLengths(target: Note[], len: number) {
  for (const n of target) n.len = L(len);
}

/** Cut notes at every multiple of `piece` (aligned to the grid); gate shortens each piece. */
export function chop(arr: Note[], target: Note[], piece: number, gate = 1): string[] {
  piece = Math.max(1, Math.round(piece));
  const out: string[] = [];
  const kill = new Set<string>();
  const add: Note[] = [];
  for (const n of target) {
    const e = end(n);
    const cuts: number[] = [];
    for (let t = (Math.floor(n.start / piece) + 1) * piece; t < e; t += piece) cuts.push(t);
    if (!cuts.length && gate >= 1) {
      out.push(n.id);
      continue;
    }
    kill.add(n.id);
    let s = n.start;
    for (const c of [...cuts, e]) {
      const p = cloneNote(n, { start: s, len: L((c - s) * gate) });
      add.push(p);
      out.push(p.id);
      s = c;
    }
  }
  removeIds(arr, kill);
  arr.push(...add);
  return out;
}

/** Cut notes crossing `t` whose key lies in [lo, hi]. Returns ids of the right-hand halves. */
export function sliceAt(arr: Note[], t: number, lo: number, hi: number, only?: Set<string>): string[] {
  const out: string[] = [];
  const add: Note[] = [];
  for (const n of arr) {
    if (only && !only.has(n.id)) continue;
    if (n.key < lo || n.key > hi) continue;
    if (n.start < t && end(n) > t) {
      const right = cloneNote(n, { start: t, len: end(n) - t });
      n.len = t - n.start;
      add.push(right);
      out.push(right.id);
    }
  }
  arr.push(...add);
  return out;
}

/** Merge touching / overlapping notes on the same key. */
export function glue(arr: Note[], target: Note[]) {
  const byKey = new Map<number, Note[]>();
  for (const n of target) {
    const g = byKey.get(n.key);
    if (g) g.push(n);
    else byKey.set(n.key, [n]);
  }
  const kill = new Set<string>();
  for (const g of byKey.values()) {
    g.sort((a, b) => a.start - b.start);
    let cur = g[0];
    for (let i = 1; i < g.length; i++) {
      const n = g[i];
      if (n.start <= end(cur) + 1) {
        cur.len = L(Math.max(end(cur), end(n)) - cur.start);
        kill.add(n.id);
      } else cur = n;
    }
  }
  removeIds(arr, kill);
}

export function setMuted(target: Note[], muted: boolean) {
  for (const n of target) {
    if (muted) n.muted = true;
    else delete n.muted;
  }
}

/** Copy target to the right by its span rounded up to `unit`. Returns the new ids. */
export function duplicateRight(arr: Note[], target: Note[], unit: number): string[] {
  if (!target.length) return [];
  const s = span(target);
  const u = Math.max(1, unit);
  const off = Math.max(u, Math.ceil((s.end - s.start) / u - 1e-9) * u);
  const add = target.map((n) => cloneNote(n, { start: n.start + off }));
  arr.push(...add);
  return add.map((n) => n.id);
}

// ---------------------------------------------------------------- generators
export interface ArpOpts {
  pattern: 'up' | 'down' | 'updown' | 'downup' | 'random';
  step: number; // ticks
  octaves: number;
  gate: number; // 0..1
  slide?: boolean;
}

export function arpeggiate(arr: Note[], target: Note[], o: ArpOpts): string[] {
  const step = Math.max(1, Math.round(o.step));
  const kill = new Set<string>();
  const add: Note[] = [];
  for (const g of chords(target)) {
    const base = [...new Set(g.map((n) => n.key))].sort((a, b) => a - b);
    let keys: number[] = [];
    for (let oc = 0; oc < Math.max(1, o.octaves); oc++) for (const k of base) if (k + oc * 12 <= 127) keys.push(k + oc * 12);
    if (o.pattern === 'down' || o.pattern === 'downup') keys.reverse();
    if ((o.pattern === 'updown' || o.pattern === 'downup') && keys.length > 2) keys = [...keys, ...keys.slice(1, -1).reverse()];
    const st = g[0].start;
    const en = Math.max(...g.map(end));
    const proto = g.reduce((a, b) => (b.vel > a.vel ? b : a), g[0]);
    let i = 0;
    for (let t = st; t < en; t += step, i++) {
      const key = o.pattern === 'random' ? keys[Math.floor(Math.random() * keys.length)] : keys[i % keys.length];
      add.push(cloneNote(proto, { key, start: t, len: L(Math.min(step * clamp(o.gate, 0.05, 1), en - t)) }));
    }
    for (const n of g) kill.add(n.id);
  }
  removeIds(arr, kill);
  arr.push(...add);
  return add.map((n) => n.id);
}

export interface StrumOpts {
  ticks: number; // offset per note
  dir: 'up' | 'down' | 'alt';
  velCurve: number; // -1..1: velocity change from first to last note
  keepEnds: boolean;
}

export function strum(target: Note[], o: StrumOpts) {
  chords(target).forEach((g, ci) => {
    if (g.length < 2) return;
    const up = o.dir === 'up' || (o.dir === 'alt' && ci % 2 === 0);
    g.sort((a, b) => (up ? a.key - b.key : b.key - a.key));
    g.forEach((n, i) => {
      const off = o.ticks * i;
      const e = end(n);
      n.start = T(n.start + off);
      n.len = o.keepEnds ? L(e - n.start) : n.len;
      n.vel = clamp(n.vel * (1 + o.velCurve * (i / (g.length - 1))), 0.01, 1);
    });
  });
}

export interface FlamOpts {
  count: number;
  spacing: number; // ticks
  vel: number; // 0..1 factor per repeat
  after: boolean;
}

export function flam(arr: Note[], target: Note[], o: FlamOpts): string[] {
  const add: Note[] = [];
  const sp = Math.max(1, Math.round(o.spacing));
  for (const n of target) {
    for (let i = 1; i <= Math.max(1, o.count); i++) {
      const s = o.after ? n.start + i * sp : n.start - i * sp;
      if (s < 0) break;
      add.push(cloneNote(n, { start: s, len: L(Math.min(sp, n.len)), vel: clamp(n.vel * Math.pow(o.vel, i), 0.01, 1) }));
    }
  }
  arr.push(...add);
  return [...target.map((n) => n.id), ...add.map((n) => n.id)];
}

export function flip(target: Note[], axis: 'h' | 'v', mask: Mask) {
  if (!target.length) return;
  const s = span(target);
  for (const n of target) {
    if (axis === 'h') n.start = T(s.start + s.end - end(n));
    else {
      const k = K(s.lo + s.hi - n.key);
      n.key = mask && !inScale(k, mask) ? snapToScale(k, mask) : k;
    }
  }
}

export interface RandOpts {
  vel: number; // 0..1 amount (± fraction of full range)
  timing: number; // ± ticks
  length: number; // ± fraction of length
  pan: number; // ± amount
  pitch: number; // ± semitones
}

export function randomize(target: Note[], o: RandOpts, mask: Mask, rnd: () => number = Math.random) {
  const r = () => rnd() * 2 - 1;
  for (const n of target) {
    if (o.vel) n.vel = clamp(n.vel + r() * o.vel, 0.01, 1);
    if (o.timing) n.start = T(n.start + r() * o.timing);
    if (o.length) n.len = L(n.len * (1 + r() * o.length));
    if (o.pan) n.pan = clamp(n.pan + r() * o.pan, -1, 1);
    if (o.pitch) {
      const k = K(n.key + Math.round(r() * o.pitch));
      n.key = mask ? snapToScale(k, mask) : k;
    }
  }
}

/** Ramp velocity (or pan) linearly from `a` to `b` across the target, in time order. */
export function scaleLevels(target: Note[], a: number, b: number, param: 'vel' | 'pan') {
  if (!target.length) return;
  const s = span(target);
  const lastStart = Math.max(...target.map((n) => n.start));
  const w = lastStart - s.start;
  for (const n of target) {
    const t = w > 0 ? (n.start - s.start) / w : 0;
    const v = a + (b - a) * t;
    if (param === 'vel') n.vel = clamp(v, 0.01, 1);
    else n.pan = clamp(v, -1, 1);
  }
}
