// Mixer track / effect-slot operations used by the Mixer window.
// Structural edits (delete / insert / move) shift track indices, so every Channel.mixer link,
// every MixerTrack.route and the mixer selection are remapped in the same undo step.
import { store } from '../core/store';
import { FxSlot, FxType, MixerTrack, Project } from '../core/types';
import { newFx, newMixerTrack } from '../core/project';
import { FX_DEFS, fxDefaults } from '../core/params';
import { clamp } from '../core/util';
import { createsLoop } from './ops';
import { promptDialog, toast } from './widgets';

// ---------------------------------------------------------------------------
// Level curve shared by faders, meters and scales: more travel around 0 dB.
// ---------------------------------------------------------------------------
const CURVE: [number, number][] = [
  [-60, 0],
  [-40, 0.14],
  [-24, 0.3],
  [-12, 0.48],
  [-6, 0.62],
  [0, 0.78],
  [6, 1],
];
export const FADER_MAX_DB = 5.6;

export function dbToNorm(db: number): number {
  if (!(db > -60)) return 0;
  if (db >= 6) return 1;
  for (let k = 1; k < CURVE.length; k++) {
    const [d1, n1] = CURVE[k];
    if (db <= d1) {
      const [d0, n0] = CURVE[k - 1];
      return n0 + ((n1 - n0) * (db - d0)) / (d1 - d0);
    }
  }
  return 1;
}

export function normToDb(n: number): number {
  if (!(n > 0)) return -60;
  if (n >= 1) return 6;
  for (let k = 1; k < CURVE.length; k++) {
    const [d1, n1] = CURVE[k];
    if (n <= n1) {
      const [d0, n0] = CURVE[k - 1];
      return d0 + ((d1 - d0) * (n - n0)) / (n1 - n0);
    }
  }
  return 6;
}

/** Fader norm → dB: 0.1 dB resolution, small detent at unity, clamped to +5.6 dB. */
export function faderFromNorm(n: number): number {
  const d = normToDb(n);
  if (d <= -59.9) return -60;
  if (Math.abs(d) < 0.12) return 0;
  return Math.min(FADER_MAX_DB, Math.round(d * 10) / 10);
}

export function fmtDbShort(db: number): string {
  if (db <= -60) return '-∞';
  if (Math.abs(db) < 0.05) return '0.0';
  return (db > 0 ? '+' : '') + db.toFixed(1);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export function trackLabel(i: number, m: MixerTrack[] = store.project.mixer): string {
  if (i === 0) return 'Master';
  return `${i}. ${m[i]?.name ?? 'Insert ' + i}`;
}

/** Effective destination of an insert (0 = master); -1 for the master itself. */
export function destOf(m: MixerTrack[], i: number): number {
  if (i <= 0) return -1;
  const r = m[i]?.route ?? 0;
  return r > 0 && r < m.length && r !== i ? r : 0;
}

type IndexMap = (old: number) => number; // returns -1 when the old track was removed

/** Rewrite channel links and routes (must run BEFORE the mixer array is restructured). */
function remapValues(p: Project, map: IndexMap) {
  const len = p.mixer.length;
  for (const c of p.channels) {
    const n = c.mixer > 0 && c.mixer < len ? map(c.mixer) : 0;
    c.mixer = n < 0 ? 0 : n;
  }
  p.mixer.forEach((t, i) => {
    if (i === 0) {
      t.route = -1;
      return;
    }
    const r = t.route > 0 && t.route < len ? map(t.route) : 0;
    t.route = r < 0 ? 0 : r;
  });
}

/** Tracks still carrying a default "Insert N" name follow their new position (like FL). */
function renumberDefaults(p: Project) {
  p.mixer.forEach((t, i) => {
    if (i > 0 && /^Insert \d+$/.test(t.name)) t.name = `Insert ${i}`;
  });
}

function remapSelection(map: IndexMap, fallback: number) {
  const len = store.project.mixer.length;
  let sel = map(store.ui.selectedMixer);
  if (sel < 0) sel = fallback;
  sel = clamp(sel, 0, len - 1);
  let multi = store.ui.selectedMixerTracks.map(map).filter((i) => i >= 0 && i < len);
  if (!multi.includes(sel)) multi = [sel];
  store.setUI({ selectedMixer: sel, selectedMixerTracks: multi });
}

/** Remove automation clips that target deleted tracks / effect slots. Returns removed automation ids. */
function dropAutomations(p: Project, trackIds: Set<string>, fxIds: Set<string>): Set<string> {
  const dead = new Set<string>();
  for (const a of p.automations) {
    const t = a.target;
    if (((t.scope === 'mixer' || t.scope === 'master') && trackIds.has(t.id)) || (t.scope === 'fx' && fxIds.has(t.id))) dead.add(a.id);
  }
  if (dead.size) {
    p.automations = p.automations.filter((a) => !dead.has(a.id));
    p.playlist.clips = p.playlist.clips.filter((c) => !(c.kind === 'automation' && dead.has(c.ref)));
  }
  return dead;
}

function fixUIRefs(dead: Set<string>) {
  if (!dead.size) return;
  const ui = store.ui;
  const patch: Record<string, unknown> = {};
  if (ui.plSource?.kind === 'automation' && dead.has(ui.plSource.ref)) patch.plSource = { kind: 'pattern', ref: ui.currentPattern };
  if (ui.editAutomation && dead.has(ui.editAutomation)) patch.editAutomation = null;
  if (Object.keys(patch).length) store.setUI(patch);
}

/** Tracks an action applies to: the whole multi-selection if `i` is part of it, else just `i`. */
export function targetsFor(i: number): number[] {
  const multi = store.ui.selectedMixerTracks;
  if (multi.length > 1 && multi.includes(i)) return [...multi].sort((a, b) => a - b);
  return [i];
}

// ---------------------------------------------------------------------------
// structural operations
// ---------------------------------------------------------------------------
export function deleteTracks(indices: number[]) {
  const len = store.project.mixer.length;
  const del = [...new Set(indices)].filter((i) => i > 0 && i < len).sort((a, b) => a - b);
  if (!del.length) {
    toast("The master track can't be deleted", 'warn');
    return;
  }
  const delSet = new Set(del);
  const map: IndexMap = (old) => {
    if (delSet.has(old)) return -1;
    let shift = 0;
    for (const d of del) if (d < old) shift++;
    return old - shift;
  };
  const m = store.project.mixer;
  const trackIds = new Set(del.map((i) => m[i].id));
  const fxIds = new Set(del.flatMap((i) => m[i].fx.map((f) => f.id)));
  let dead = new Set<string>();
  store.commit(del.length > 1 ? 'Delete mixer tracks' : 'Delete mixer track', (p) => {
    remapValues(p, map);
    p.mixer = p.mixer.filter((_, i) => !delSet.has(i));
    renumberDefaults(p);
    dead = dropAutomations(p, trackIds, fxIds);
  });
  remapSelection(map, Math.min(del[0], store.project.mixer.length - 1));
  fixUIRefs(dead);
}

export function insertTrackAfter(i: number): number {
  const at = clamp(i + 1, 1, store.project.mixer.length);
  const map: IndexMap = (old) => (old < at ? old : old + 1);
  store.commit('Insert mixer track', (p) => {
    remapValues(p, map);
    p.mixer.splice(at, 0, newMixerTrack(at));
    renumberDefaults(p);
  });
  remapSelection(map, at);
  store.setUI({ selectedMixer: at, selectedMixerTracks: [at] });
  return at;
}

/** Swap track `i` with its neighbour in direction `dir`. Returns the new index (or -1). */
export function moveTrack(i: number, dir: -1 | 1): number {
  const len = store.project.mixer.length;
  const j = i + dir;
  if (i < 1 || j < 1 || i >= len || j >= len) return -1;
  const map: IndexMap = (old) => (old === i ? j : old === j ? i : old);
  store.commit('Move mixer track', (p) => {
    remapValues(p, map);
    const a = p.mixer[i];
    p.mixer[i] = p.mixer[j];
    p.mixer[j] = a;
    renumberDefaults(p);
  });
  remapSelection(map, j);
  store.setUI({ selectedMixer: j });
  return j;
}

export async function renameTrack(i: number) {
  const t = store.project.mixer[i];
  if (!t) return;
  const name = await promptDialog(i === 0 ? 'Rename master track' : `Rename insert ${i}`, 'Track name', t.name);
  if (name === null || !name.trim()) return;
  const id = t.id;
  store.commit('Rename mixer track', (p) => {
    const x = p.mixer.find((m) => m.id === id);
    if (x) x.name = name.trim();
  });
}

export function setColor(indices: number[], color: string) {
  store.commit('Mixer track color', (p) => {
    for (const i of indices) if (p.mixer[i]) p.mixer[i].color = color;
  });
}

export function setArmed(indices: number[], armed: boolean) {
  store.commit(armed ? 'Arm mixer track' : 'Disarm mixer track', (p) => {
    for (const i of indices) if (i > 0 && p.mixer[i]) p.mixer[i].armed = armed;
  });
}

export function toggleMute(i: number) {
  if (!store.project.mixer[i]) return;
  store.commit('Mute mixer track', (p) => (p.mixer[i].mute = !p.mixer[i].mute));
}

export function setVolume(i: number, db: number) {
  store.commit('Mixer volume', (p) => {
    if (p.mixer[i]) p.mixer[i].volDb = clamp(db, -60, FADER_MAX_DB);
  });
}

/** Route tracks to `to`. Tracks that would form a loop (or are the master) are skipped. */
export function routeTracks(from: number[], to: number) {
  const m = store.project.mixer;
  if (to < 0 || to >= m.length) return;
  const ok = from.filter((i) => i > 0 && i < m.length && i !== to && !createsLoop(m, i, to));
  if (!ok.length) {
    if (from.some((i) => i > 0 && i !== to)) toast("Can't route there — it would create a feedback loop", 'warn');
    return;
  }
  store.commit('Route mixer track', (p) => {
    for (const i of ok) p.mixer[i].route = to;
  });
  if (ok.length < from.filter((i) => i > 0 && i !== to).length) toast('Some tracks were skipped to avoid a feedback loop', 'info');
}

// ---------------------------------------------------------------------------
// solo
// ---------------------------------------------------------------------------
/** Inserts kept audible when soloing `i`: the track plus the chain of tracks it feeds into
 *  (so the soloed track can still reach the master). With routing, also every track feeding it. */
export function soloSet(m: MixerTrack[], i: number, withRouting: boolean): Set<number> {
  const s = new Set<number>([i]);
  let cur = destOf(m, i);
  let guard = 0;
  while (cur > 0 && !s.has(cur) && guard++ < m.length) {
    s.add(cur);
    cur = destOf(m, cur);
  }
  if (withRouting) {
    const up = new Set<number>([i]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let k = 1; k < m.length; k++) {
        if (!up.has(k) && up.has(destOf(m, k))) {
          up.add(k);
          changed = true;
        }
      }
    }
    for (const k of up) s.add(k);
  }
  return s;
}

let lastSolo: { id: string; withRouting: boolean } | null = null;
/** Identity of the most recent solo action (part of the cache key for soloedTracks). */
export function lastSoloKey(): string {
  return lastSolo ? lastSolo.id + (lastSolo.withRouting ? '+r' : '') : '';
}

/** FL-style solo: mute every insert except the solo set; repeating it on an already-soloed track unmutes all. */
export function soloTrack(i: number, withRouting = false) {
  const m = store.project.mixer;
  if (i <= 0 || i >= m.length) {
    toast('Select an insert track to solo', 'info', 1200);
    return;
  }
  const set = soloSet(m, i, withRouting);
  const unmuted: number[] = [];
  for (let k = 1; k < m.length; k++) if (!m[k].mute) unmuted.push(k);
  const already = unmuted.length === set.size && unmuted.every((k) => set.has(k));
  lastSolo = already ? null : { id: m[i].id, withRouting };
  store.commit(already ? 'Unsolo mixer' : 'Solo mixer track', (p) =>
    p.mixer.forEach((t, k) => {
      if (k > 0) t.mute = already ? false : !set.has(k);
    }),
  );
}

export function unmuteAll() {
  store.commit('Unmute all mixer tracks', (p) => p.mixer.forEach((t) => (t.mute = false)));
}

/** Which inserts currently look soloed (unmuted set equals their solo set). */
export function soloedTracks(m: MixerTrack[]): Set<number> {
  const out = new Set<number>();
  const unmuted: number[] = [];
  for (let k = 1; k < m.length; k++) if (!m[k].mute) unmuted.push(k);
  if (!unmuted.length || unmuted.length === m.length - 1) return out;
  const eq = (s: Set<number>) => s.size === unmuted.length && unmuted.every((k) => s.has(k));
  // the track that was actually soloed, if the mute pattern still matches it
  if (lastSolo) {
    const k = m.findIndex((t) => t.id === lastSolo!.id);
    if (k > 0 && eq(soloSet(m, k, lastSolo.withRouting))) return out.add(k);
  }
  // otherwise infer it (e.g. after undo / load): plain solo first, then solo-with-routing
  for (const k of unmuted) if (eq(soloSet(m, k, false))) out.add(k);
  if (!out.size) for (const k of unmuted) if (eq(soloSet(m, k, true))) out.add(k);
  return out;
}

// ---------------------------------------------------------------------------
// effect slots (addressed by slot id so stale indices can't hit the wrong track)
// ---------------------------------------------------------------------------
export const MAX_FX = 10;

export function findSlot(p: Project, slotId: string): { track: MixerTrack; index: number; k: number; slot: FxSlot } | null {
  for (let i = 0; i < p.mixer.length; i++) {
    const k = p.mixer[i].fx.findIndex((f) => f.id === slotId);
    if (k >= 0) return { track: p.mixer[i], index: i, k, slot: p.mixer[i].fx[k] };
  }
  return null;
}

export function liveSlot(slotId: string, fn: (s: FxSlot) => void) {
  store.live((p) => {
    const f = findSlot(p, slotId);
    if (f) fn(f.slot);
  });
}

export function commitSlot(slotId: string, label: string, fn: (s: FxSlot) => void) {
  store.commit(label, (p) => {
    const f = findSlot(p, slotId);
    if (f) fn(f.slot);
  });
}

/** Insert a new effect at position `at` (appends when beyond the last filled slot). Returns its id. */
export function insertFx(track: number, type: FxType, at = MAX_FX): string | null {
  const t = store.project.mixer[track];
  if (!t) return null;
  if (t.fx.length >= MAX_FX) {
    toast(`All ${MAX_FX} effect slots are in use on this track`, 'warn');
    return null;
  }
  const fx = newFx(type);
  store.commit('Add effect', (p) => p.mixer[track].fx.splice(clamp(at, 0, p.mixer[track].fx.length), 0, fx));
  return fx.id;
}

export function removeFx(slotId: string) {
  let dead = new Set<string>();
  store.commit('Remove effect', (p) => {
    const f = findSlot(p, slotId);
    if (!f) return;
    f.track.fx.splice(f.k, 1);
    dead = dropAutomations(p, new Set(), new Set([slotId]));
  });
  fixUIRefs(dead);
}

export function replaceFx(slotId: string, type: FxType): string | null {
  const cur = findSlot(store.project, slotId);
  if (!cur || cur.slot.type === type) return null;
  const fx = newFx(type);
  let dead = new Set<string>();
  store.commit('Replace effect', (p) => {
    const f = findSlot(p, slotId);
    if (!f) return;
    f.track.fx[f.k] = fx;
    dead = dropAutomations(p, new Set(), new Set([slotId]));
  });
  fixUIRefs(dead);
  return fx.id;
}

/** Move an effect to position `to` within its track. */
export function moveFx(slotId: string, to: number) {
  const cur = findSlot(store.project, slotId);
  if (!cur) return;
  const dest = clamp(to, 0, cur.track.fx.length - 1);
  if (dest === cur.k) return;
  store.commit('Move effect', (p) => {
    const f = findSlot(p, slotId);
    if (!f) return;
    const [s] = f.track.fx.splice(f.k, 1);
    f.track.fx.splice(dest, 0, s);
  });
}

export function toggleFx(slotId: string) {
  const cur = findSlot(store.project, slotId);
  if (!cur) return;
  commitSlot(slotId, cur.slot.enabled ? 'Bypass effect' : 'Enable effect', (s) => (s.enabled = !s.enabled));
}

export function resetFx(slotId: string) {
  commitSlot(slotId, 'Reset effect', (s) => {
    s.params = fxDefaults(s.type);
    s.mix = FX_DEFS[s.type].defaultMix;
    s.enabled = true;
  });
}
