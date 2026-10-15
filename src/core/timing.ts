import { Automation, AutoTarget, Pattern, Project } from './types';
import { barLen } from './util';

export function patternLen(p: Pattern | undefined, timeSig: [number, number]): number {
  const bl = barLen(timeSig);
  if (!p) return bl;
  if (p.length > 0) return p.length;
  let end = 0;
  for (const notes of Object.values(p.notes)) for (const n of notes) end = Math.max(end, n.start + Math.max(n.len, 1));
  return Math.max(bl, Math.ceil(end / bl) * bl);
}

export function songLen(p: Project): number {
  const bl = barLen(p.timeSig);
  let end = 0;
  for (const c of p.playlist.clips) end = Math.max(end, c.start + c.len);
  return Math.max(bl, Math.ceil(end / bl) * bl);
}

export function secPerTick(bpm: number) {
  return 60 / (bpm * 96);
}

/** Linear interpolation of an automation curve at clip-local tick t. */
export function autoValueAt(a: Automation, t: number): number {
  const pts = a.points;
  if (!pts.length) return 0.5;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    if (t <= p1.t) {
      const span = p1.t - p0.t;
      return span <= 0 ? p1.v : p0.v + ((p1.v - p0.v) * (t - p0.t)) / span;
    }
  }
  return pts[pts.length - 1].v;
}

export function targetKey(t: AutoTarget) {
  return `${t.scope === 'master' ? 'mixer' : t.scope}:${t.id}:${t.param}`;
}
