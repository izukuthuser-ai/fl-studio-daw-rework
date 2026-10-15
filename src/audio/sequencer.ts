// Converts project data in a tick range into scheduled audio events. Shared by live playback & export.
import { ID, Project, STEP, PPQ } from '../core/types';
import { barLen } from '../core/util';
import { autoValueAt, patternLen, targetKey } from '../core/timing';
import { fromNorm } from '../core/params';
import { AudioGraph } from './graph';

export interface SpanOpts {
  mode: 'pattern' | 'song';
  patternId: ID;
  from: number;
  to: number;
  time0: number; // audio time of `from`
  spt: number; // seconds per tick
  metronome?: boolean;
  autoInit?: Set<string>; // automation clip ids already initialized this pass
}

function swingTicks(p: Project, localTick: number) {
  if (!p.swing) return 0;
  return localTick % (2 * STEP) === STEP ? p.swing * STEP * 0.5 : 0;
}

export function scheduleSpan(g: AudioGraph, p: Project, o: SpanOpts) {
  const { from, to, time0, spt } = o;
  const tAt = (tick: number) => time0 + (tick - from) * spt;
  const chMap = new Map(p.channels.map((c) => [c.id, c]));

  if (o.metronome) {
    const bl = barLen(p.timeSig);
    for (let b = Math.ceil(from / PPQ) * PPQ; b < to; b += PPQ) g.click(tAt(b), b % bl === 0);
  }

  if (o.mode === 'pattern') {
    const pat = p.patterns.find((x) => x.id === o.patternId);
    if (!pat) return;
    for (const [cid, notes] of Object.entries(pat.notes)) {
      const ch = chMap.get(cid);
      if (!ch) continue;
      for (const n of notes) {
        if (n.muted || n.start < from || n.start >= to) continue;
        const t = tAt(n.start + swingTicks(p, n.start));
        g.noteOn(ch, n.key, n.vel, n.pan, t, n.len * spt);
      }
    }
    return;
  }

  // song mode
  const tracks = p.playlist.tracks;
  for (const c of p.playlist.clips) {
    if (c.muted || tracks[c.track]?.mute) continue;
    const cEnd = c.start + c.len;
    if (cEnd <= from || c.start >= to) continue;
    if (c.kind === 'pattern') {
      const pat = p.patterns.find((x) => x.id === c.ref);
      if (!pat) continue;
      const plen = patternLen(pat, p.timeSig);
      const a = Math.max(from, c.start);
      const b = Math.min(to, cEnd);
      const base = c.start - c.offset; // song tick of pattern tick 0 (loop k=0)
      const kStart = Math.floor((a - base) / plen) - 1;
      const kEnd = Math.floor((b - base) / plen);
      for (const [cid, notes] of Object.entries(pat.notes)) {
        const ch = chMap.get(cid);
        if (!ch) continue;
        for (let k = Math.max(0, kStart); k <= kEnd; k++) {
          for (const n of notes) {
            if (n.muted || n.start >= plen) continue;
            const st = base + k * plen + n.start;
            if (st < a || st >= b) continue;
            const len = Math.min(n.len, cEnd - st);
            g.noteOn(ch, n.key, n.vel, n.pan, tAt(st + swingTicks(p, n.start)), len * spt);
          }
        }
      }
    } else if (c.kind === 'audio') {
      if (c.start < from || c.start >= to) continue;
      const ch = chMap.get(c.ref);
      if (ch) g.playAudioClip(ch, tAt(c.start), c.offset * spt, c.len * spt);
    } else if (c.kind === 'automation') {
      const auto = p.automations.find((x) => x.id === c.ref);
      if (!auto) continue;
      const tgt = g.resolveTarget(auto.target);
      if (!tgt) continue;
      const a = Math.max(from, c.start);
      const b = Math.min(to, cEnd);
      const val = (songTick: number) => {
        const local = songTick - c.start + c.offset;
        return tgt.map(fromNorm(tgt.def, autoValueAt(auto, local)));
      };
      try {
        if (!o.autoInit || !o.autoInit.has(c.id) || a === c.start) {
          tgt.param.cancelScheduledValues(tAt(a));
          tgt.param.setValueAtTime(val(a), tAt(a));
          o.autoInit?.add(c.id);
        }
        tgt.param.linearRampToValueAtTime(val(b), tAt(b));
      } catch (e) {
        // ignore invalid automation values
      }
    }
  }
}

/** Audio clips that are already playing at `pos` when playback starts mid-clip. */
export function startMidClips(g: AudioGraph, p: Project, pos: number, time0: number, spt: number) {
  const tracks = p.playlist.tracks;
  for (const c of p.playlist.clips) {
    if (c.kind !== 'audio' || c.muted || tracks[c.track]?.mute) continue;
    if (c.start < pos && c.start + c.len > pos) {
      const ch = p.channels.find((x) => x.id === c.ref);
      if (ch) g.playAudioClip(ch, time0, (c.offset + pos - c.start) * spt, (c.start + c.len - pos) * spt);
    }
  }
}

export function automatedTargets(p: Project): Set<string> {
  const s = new Set<string>();
  const used = new Set(p.playlist.clips.filter((c) => c.kind === 'automation').map((c) => c.ref));
  for (const a of p.automations) if (used.has(a.id)) s.add(targetKey(a.target));
  return s;
}
