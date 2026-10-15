// Channel rack operations: steps, mute / solo, ordering, groups, clipboard, sample & preset
// replacement. Shared by the Channel Rack and Channel Settings windows. Every edit is undoable.
import { store } from '../core/store';
import { Channel, ID, Note, Pattern, STEP } from '../core/types';
import { PALETTE, deepClone, uid } from '../core/util';
import { SYNTH_PRESETS, defaultSampler, synthPreset } from '../core/project';
import { colorMenu, confirmDialog, promptDialog, toast } from './widgets';
import { addChannel, deleteChannels } from './ops';
import { samples } from '../audio/samples';
import { BUILTIN_BY_ID } from '../audio/sounds';
import type { DragSample } from './dnd';

export const STEP_KEY = 60;
export const STEP_VEL = 0.78;
export const BASE_GROUPS = ['Drums', 'Bass', 'Synths', 'Audio', 'Unsorted'];

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------
export const groupOf = (c: Channel) => c.group || 'Unsorted';

/** Channels shown under the current group filter, in rack order. */
export function visibleChannels(group = store.ui.channelGroup): Channel[] {
  const chs = store.project.channels;
  if (!group || group === 'All') return chs;
  return chs.filter((c) => groupOf(c) === group);
}

/** Filter options: All + groups present (rack order) + Unsorted. */
export function groupOptions(): string[] {
  const seen: string[] = [];
  for (const c of store.project.channels) {
    const g = groupOf(c);
    if (g !== 'Unsorted' && !seen.includes(g)) seen.push(g);
  }
  const cur = store.ui.channelGroup;
  if (cur && cur !== 'All' && cur !== 'Unsorted' && !seen.includes(cur)) seen.push(cur);
  return ['All', ...seen, 'Unsorted'];
}

/** Number of step buttons for a pattern (at least 16). */
export function stepCount(p: Pattern | undefined = store.currentPattern): number {
  return Math.max(16, Math.ceil(store.patternLength(p) / STEP));
}

export const isStepNote = (n: Note) => n.key === STEP_KEY && n.len === STEP && n.start % STEP === 0;

/** Selected channel ids in rack order. */
export function orderedSelection(ids: ID[] = store.ui.selectedChannels): ID[] {
  const set = new Set(ids);
  return store.project.channels.filter((c) => set.has(c.id)).map((c) => c.id);
}

function findCh(p: { channels: Channel[] }, id: ID) {
  return p.channels.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------
/** Set one step on/off (call inside store.live / commit). */
export function writeStep(pt: Pattern, chId: ID, i: number, on: boolean) {
  const t = i * STEP;
  const arr = pt.notes[chId] ?? [];
  const has = arr.some((n) => n.start === t);
  if (on && !has) {
    const n: Note = { id: uid('n'), key: STEP_KEY, start: t, len: STEP, vel: STEP_VEL, pan: 0 };
    const k = arr.findIndex((x) => x.start > t);
    if (k < 0) arr.push(n);
    else arr.splice(k, 0, n);
    pt.notes[chId] = arr;
  } else if (!on && has) {
    const rest = arr.filter((n) => n.start !== t);
    if (rest.length) pt.notes[chId] = rest;
    else delete pt.notes[chId];
  }
}

function targetPattern(p: { patterns: Pattern[] }) {
  return p.patterns.find((x) => x.id === store.ui.currentPattern) ?? p.patterns[0];
}

export function fillSteps(ids: ID[], every: number) {
  if (!ids.length) return;
  const n = stepCount();
  store.commit(`Fill each ${every} steps`, (p) => {
    const pt = targetPattern(p);
    if (!pt) return;
    for (const id of ids) {
      const arr: Note[] = [];
      for (let i = 0; i < n; i += every) arr.push({ id: uid('n'), key: STEP_KEY, start: i * STEP, len: STEP, vel: STEP_VEL, pan: 0 });
      pt.notes[id] = arr;
    }
  });
}

export function clearSteps(ids: ID[], label = 'Clear steps') {
  if (!ids.length) return;
  store.commit(label, (p) => {
    const pt = targetPattern(p);
    if (pt) for (const id of ids) delete pt.notes[id];
  });
}

// ---------------------------------------------------------------------------
// clipboard (notes of the selected channels in the current pattern)
// ---------------------------------------------------------------------------
let clipboard: Note[][] | null = null;

export function copySteps(ids: ID[] = orderedSelection()) {
  if (!ids.length) return;
  const pid = store.currentPattern.id;
  clipboard = ids.map((id) => deepClone(store.notes(pid, id)));
  const n = clipboard.reduce((a, x) => a + x.length, 0);
  toast(`Copied ${n} note${n === 1 ? '' : 's'} from ${ids.length} channel${ids.length === 1 ? '' : 's'}`, 'info', 1200);
}

export function cutSteps(ids: ID[] = orderedSelection()) {
  if (!ids.length) return;
  copySteps(ids);
  clearSteps(ids, 'Cut steps');
}

export function pasteSteps(ids: ID[] = orderedSelection()) {
  if (!clipboard) {
    toast('Nothing copied yet — select channels and press Ctrl+C', 'info', 1600);
    return;
  }
  if (!ids.length) return;
  const clip = clipboard;
  // one source -> every selected channel; several sources -> selected channel(s) and the ones below
  let targets: ID[];
  if (clip.length === 1) targets = ids;
  else if (ids.length >= clip.length) targets = ids.slice(0, clip.length);
  else {
    const vis = visibleChannels().map((c) => c.id);
    const start = vis.indexOf(ids[0]);
    targets = start >= 0 ? vis.slice(start, start + clip.length) : ids;
  }
  store.commit('Paste steps', (p) => {
    const pt = targetPattern(p);
    if (!pt) return;
    targets.forEach((id, k) => {
      const src = clip[clip.length === 1 ? 0 : k];
      if (!src) return;
      const arr = src.map((n) => ({ ...n, id: uid('n') }));
      if (arr.length) pt.notes[id] = arr;
      else delete pt.notes[id];
    });
  });
}

// ---------------------------------------------------------------------------
// mute / solo
// ---------------------------------------------------------------------------
export function toggleMute(ids: ID[]) {
  if (!ids.length) return;
  store.commit('Mute channel', (p) => {
    for (const id of ids) {
      const c = findCh(p, id);
      if (c) c.mute = !c.mute;
    }
  });
}

/** FL semantics: solo mutes every other channel; soloing the soloed channel again unmutes all. */
export function soloChannel(id: ID) {
  const chs = store.project.channels;
  const me = findCh(store.project, id);
  if (!me) return;
  const soloed = !me.mute && chs.every((c) => c.id === id || c.mute);
  store.commit(soloed ? 'Unsolo channels' : 'Solo channel', (p) => {
    for (const c of p.channels) c.mute = soloed ? false : c.id !== id;
  });
}

export function isSoloed(id: ID) {
  const chs = store.project.channels;
  return chs.length > 1 && chs.every((c) => (c.id === id ? !c.mute : c.mute));
}

// ---------------------------------------------------------------------------
// ordering / grouping / naming / color
// ---------------------------------------------------------------------------
/** Move channels up (-1) or down (+1) among the visible (group-filtered) channels. */
export function moveChannels(ids: ID[], dir: -1 | 1) {
  const sel = new Set(ids);
  const vis = visibleChannels().map((c) => c.id);
  const order = vis.slice();
  let moved = false;
  if (dir < 0) {
    for (let i = 1; i < order.length; i++)
      if (sel.has(order[i]) && !sel.has(order[i - 1])) {
        [order[i - 1], order[i]] = [order[i], order[i - 1]];
        moved = true;
      }
  } else {
    for (let i = order.length - 2; i >= 0; i--)
      if (sel.has(order[i]) && !sel.has(order[i + 1])) {
        [order[i + 1], order[i]] = [order[i], order[i + 1]];
        moved = true;
      }
  }
  if (!moved) return;
  const visSet = new Set(vis);
  store.commit(dir < 0 ? 'Move channel up' : 'Move channel down', (p) => {
    const byId = new Map(p.channels.map((c) => [c.id, c]));
    let k = 0;
    p.channels = p.channels.map((c) => (visSet.has(c.id) ? byId.get(order[k++])! : c));
  });
}

export function setGroup(ids: ID[], group: string) {
  if (!ids.length) return;
  const g = group.trim() || 'Unsorted';
  store.commit('Group channels', (p) => {
    for (const id of ids) {
      const c = findCh(p, id);
      if (c) c.group = g;
    }
  });
  // keep the channels in view: follow them into their new group when a filter is active
  if (store.ui.channelGroup !== 'All' && store.ui.channelGroup !== g) store.setUI({ channelGroup: g });
}

export async function promptGroup(ids: ID[]) {
  if (!ids.length) return;
  const cur = findCh(store.project, ids[0]);
  const g = await promptDialog('Group channels', `Group name for ${ids.length} channel${ids.length === 1 ? '' : 's'}`, cur && groupOf(cur) !== 'Unsorted' ? groupOf(cur) : '');
  if (g !== null && g.trim()) setGroup(ids, g.trim());
}

export async function renameChannel(id: ID | undefined) {
  const c = findCh(store.project, id ?? '');
  if (!c) return;
  const name = await promptDialog('Rename channel', 'Channel name', c.name);
  if (name !== null && name.trim()) setName(c.id, name.trim());
}

export function setName(id: ID, name: string) {
  store.commit('Rename channel', (p) => {
    const c = findCh(p, id);
    if (c) c.name = name;
  });
}

export function colorChannels(ids: ID[], x: number, y: number) {
  if (!ids.length) return;
  colorMenu(
    PALETTE,
    (col) =>
      store.commit('Channel color', (p) => {
        for (const id of ids) {
          const c = findCh(p, id);
          if (c) c.color = col;
        }
      }),
    x,
    y,
  );
}

export function setMixerTrack(id: ID, track: number) {
  store.commit('Route channel', (p) => {
    const c = findCh(p, id);
    if (c) c.mixer = Math.max(0, Math.min(p.mixer.length - 1, track));
  });
}

export async function confirmDelete(ids: ID[]) {
  if (!ids.length) return;
  const names = ids.map((id) => findCh(store.project, id)?.name ?? '?');
  const what = names.length <= 3 ? names.map((n) => `“${n}”`).join(', ') : `${names.length} channels`;
  const r = await confirmDialog('Delete channels', `Delete ${what}?\nTheir notes in every pattern are removed too (Ctrl+Z restores them).`, [
    { label: 'Cancel', value: 'no' },
    { label: 'Delete', value: 'yes', primary: true },
  ], 'no');
  if (r === 'yes') deleteChannels(ids);
}

// ---------------------------------------------------------------------------
// instruments: samples & presets
// ---------------------------------------------------------------------------
export function groupForSample(ref: string): string {
  const cur = store.ui.channelGroup;
  if (cur && cur !== 'All') return cur;
  const b = ref.startsWith('builtin:') ? BUILTIN_BY_ID.get(ref.slice(8)) : undefined;
  if (!b) return 'Unsorted';
  if (b.category === '808s') return 'Bass';
  if (b.category === 'FX') return 'Unsorted';
  return 'Drums';
}

function groupForSynth(): string {
  const cur = store.ui.channelGroup;
  return cur && cur !== 'All' ? cur : 'Synths';
}

export function addSamplerChannel(s: DragSample): ID {
  return addChannel('sampler', { sampleRef: s.ref, name: s.name || samples.displayName(s.ref), group: groupForSample(s.ref) });
}

export function addSynthChannel(preset: string): ID {
  const known = SYNTH_PRESETS.some((p) => p.name === preset) ? preset : 'Init';
  return addChannel('synth', { name: known === 'Init' ? 'Tri-Osc' : known, preset: known, group: groupForSynth() });
}

/** Replace a channel's sample, keeping its other settings. A synth is converted after confirmation. */
export async function replaceSample(chId: ID, s: DragSample): Promise<boolean> {
  const ch = findCh(store.project, chId);
  if (!ch) return false;
  const name = s.name || samples.displayName(s.ref);
  if (ch.type !== 'sampler') {
    const r = await confirmDialog('Replace instrument', `“${ch.name}” is a Tri-Osc synth. Turn it into a sampler playing “${name}”?\nIts notes, mixer routing, volume and pan are kept.`, [
      { label: 'Cancel', value: 'no' },
      { label: 'Make sampler', value: 'yes', primary: true },
    ], 'no');
    if (r !== 'yes') return false;
    store.commit('Convert to sampler', (p) => {
      const c = findCh(p, chId);
      if (!c) return;
      c.type = 'sampler';
      c.sampler = defaultSampler(s.ref, name);
      c.sampler.sampleName = name;
      delete c.synth;
      c.name = name;
    });
    return true;
  }
  store.commit('Replace sample', (p) => {
    const c = findCh(p, chId);
    if (!c?.sampler) return;
    const old = c.sampler.sampleName;
    c.sampler.sampleRef = s.ref;
    c.sampler.sampleName = name;
    if (c.name === old || c.name === 'Sampler' || c.name === '(empty)') c.name = name;
  });
  return true;
}

/** Apply a Tri-Osc preset to a synth channel (replaces its synth parameters). */
export function applyPreset(chId: ID, preset: string) {
  const ch = findCh(store.project, chId);
  if (!ch || ch.type !== 'synth') return;
  const presetNames = new Set(SYNTH_PRESETS.map((p) => p.name));
  store.commit('Synth preset', (p) => {
    const c = findCh(p, chId);
    if (!c) return;
    c.synth = synthPreset(preset);
    if (c.name === 'Tri-Osc' || presetNames.has(c.name)) c.name = preset === 'Init' ? 'Tri-Osc' : preset;
  });
}

/** Name of the preset whose parameters match the synth exactly, or null when edited. */
let presetCache = { json: '', name: null as string | null };
export function matchingPreset(c: Channel): string | null {
  if (!c.synth) return null;
  const json = JSON.stringify(c.synth);
  if (json === presetCache.json) return presetCache.name;
  let found: string | null = null;
  for (const p of SYNTH_PRESETS)
    if (JSON.stringify(synthPreset(p.name)) === json) {
      found = p.name;
      break;
    }
  presetCache = { json, name: found };
  return found;
}
