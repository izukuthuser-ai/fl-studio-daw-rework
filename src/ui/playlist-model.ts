// Playlist data helpers: clip sources, lengths, slicing, offsets and track operations.
// Everything here works on a Project passed in (call from inside store.commit / store.live).
import { store } from '../core/store';
import { Channel, Clip, ClipKind, ID, Project, STEP } from '../core/types';
import { newTrack } from '../core/project';
import { barLen, uid } from '../core/util';
import { patternLen, secPerTick } from '../core/timing';
import { samples } from '../audio/samples';

export interface Source {
  kind: ClipKind;
  ref: ID;
}

export interface SourceInfo {
  name: string;
  color: string;
  exists: boolean;
}

export const DEFAULT_TRACK_H = 56;
export const TRACK_HEIGHTS = { small: 34, medium: 56, large: 90 } as const;

export function sourceInfo(p: Project, kind: ClipKind, ref: ID): SourceInfo {
  if (kind === 'pattern') {
    const pt = p.patterns.find((x) => x.id === ref);
    return pt ? { name: pt.name, color: pt.color, exists: true } : { name: '(missing pattern)', color: '#6b7680', exists: false };
  }
  if (kind === 'audio') {
    const ch = p.channels.find((x) => x.id === ref);
    return ch ? { name: ch.name, color: ch.color, exists: true } : { name: '(missing audio)', color: '#6b7680', exists: false };
  }
  const a = p.automations.find((x) => x.id === ref);
  return a ? { name: a.name, color: a.color, exists: true } : { name: '(missing automation)', color: '#6b7680', exists: false };
}

/** Playback-rate of an audio-clip channel (channel pitch transposes the sample). */
export function audioRate(ch: Channel | undefined): number {
  return Math.pow(2, (ch?.pitch ?? 0) / 12);
}

/** Full sample length on the timeline (ticks) for an audio-clip channel, or null if not decoded. */
export function sampleTicks(p: Project, ch: Channel | undefined): number | null {
  const ref = ch?.sampler?.sampleRef;
  if (!ref) return null;
  const b = samples.get(ref);
  if (!b) return null;
  return b.duration / audioRate(ch) / secPerTick(p.bpm);
}

/** Source ticks per timeline tick for a clip (offset units). */
export function contentRate(p: Project, c: Clip): number {
  if (c.kind !== 'audio') return 1;
  return audioRate(p.channels.find((x) => x.id === c.ref));
}

/** Default length for a new clip of this source. */
export function sourceLength(p: Project, kind: ClipKind, ref: ID): number {
  const bar = barLen(p.timeSig);
  if (kind === 'pattern') return patternLen(p.patterns.find((x) => x.id === ref), p.timeSig);
  if (kind === 'audio') {
    const t = sampleTicks(p, p.channels.find((x) => x.id === ref));
    return t ? Math.max(1, Math.round(t)) : bar;
  }
  const a = p.automations.find((x) => x.id === ref);
  return Math.max(STEP, a?.length ?? bar);
}

/** Longest allowed length for a clip starting at its current offset (audio can't run past the sample end). */
export function maxClipLen(p: Project, c: Clip): number {
  if (c.kind !== 'audio') return Infinity;
  const ch = p.channels.find((x) => x.id === c.ref);
  const t = sampleTicks(p, ch);
  if (t === null) return Infinity;
  return Math.max(1, t - c.offset / audioRate(ch));
}

/** Keep offsets valid: pattern offsets wrap inside the loop, others stay >= 0. */
export function normalizeOffset(p: Project, c: Clip) {
  if (c.kind === 'pattern') {
    const plen = patternLen(p.patterns.find((x) => x.id === c.ref), p.timeSig);
    if (plen > 0) c.offset = ((c.offset % plen) + plen) % plen;
  } else if (c.offset < 0) c.offset = 0;
  c.offset = Math.round(c.offset * 1000) / 1000;
}

/** Split a clip at song tick t. Mutates `c` into the left part and returns the right part (or null). */
export function sliceClip(p: Project, c: Clip, t: number): Clip | null {
  if (t <= c.start || t >= c.start + c.len) return null;
  const cut = t - c.start;
  const right: Clip = { ...c, id: uid('k'), start: t, len: c.len - cut, offset: c.offset + cut * contentRate(p, c) };
  normalizeOffset(p, right);
  c.len = cut;
  return right;
}

export function cloneClip(c: Clip): Clip {
  return { ...c, id: uid('k') };
}

export function ensureTracks(p: Project, n: number) {
  const t = p.playlist.tracks;
  while (t.length < n) t.push(newTrack(t.length));
}

export function insertTrack(p: Project, i: number) {
  const t = newTrack(i);
  p.playlist.tracks.splice(i, 0, t);
  for (const c of p.playlist.clips) if (c.track >= i) c.track++;
  renumberDefaultNames(p);
}

export function deleteTrack(p: Project, i: number) {
  if (p.playlist.tracks.length <= 1) {
    p.playlist.clips = p.playlist.clips.filter((c) => c.track !== i);
    return;
  }
  p.playlist.tracks.splice(i, 1);
  p.playlist.clips = p.playlist.clips.filter((c) => c.track !== i);
  for (const c of p.playlist.clips) if (c.track > i) c.track--;
  renumberDefaultNames(p);
}

export function swapTracks(p: Project, i: number, j: number) {
  const t = p.playlist.tracks;
  if (i < 0 || j < 0 || i >= t.length || j >= t.length || i === j) return;
  [t[i], t[j]] = [t[j], t[i]];
  for (const c of p.playlist.clips) {
    if (c.track === i) c.track = j;
    else if (c.track === j) c.track = i;
  }
  renumberDefaultNames(p);
}

/** Tracks still called "Track N" follow their position, like FL. */
function renumberDefaultNames(p: Project) {
  p.playlist.tracks.forEach((t, i) => {
    if (/^Track \d+$/.test(t.name)) t.name = `Track ${i + 1}`;
  });
}

/** Solo: mute every other track; if it's already the only unmuted one, unmute all. */
export function soloTrack(p: Project, i: number) {
  const t = p.playlist.tracks;
  const alreadySolo = !t[i].mute && t.every((x, k) => k === i || x.mute);
  t.forEach((x, k) => (x.mute = alreadySolo ? false : k !== i));
}

export function extent(clips: Clip[]): { start: number; end: number } | null {
  if (!clips.length) return null;
  let s = Infinity, e = -Infinity;
  for (const c of clips) {
    s = Math.min(s, c.start);
    e = Math.max(e, c.start + c.len);
  }
  return { start: s, end: e };
}

/** Channels of a pattern that actually contain notes. */
export function channelsWithNotes(p: Project, patternId: ID): ID[] {
  const pt = p.patterns.find((x) => x.id === patternId);
  if (!pt) return [];
  return p.channels.filter((c) => (pt.notes[c.id]?.length ?? 0) > 0).map((c) => c.id);
}

/** Current paint source, falling back to the current pattern when the stored one disappeared. */
export function currentSource(): Source | null {
  const p = store.project;
  const s = store.ui.plSource;
  if (s && sourceInfo(p, s.kind, s.ref).exists) return s;
  const pat = store.currentPattern;
  return pat ? { kind: 'pattern', ref: pat.id } : null;
}
