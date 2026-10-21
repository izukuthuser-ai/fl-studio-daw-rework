// Shared project operations used by several windows (channels, mixer, playlist, automation).
import { store } from '../core/store';
import { AutoTarget, Channel, ID, MixerTrack } from '../core/types';
import { newChannel, newMixerTrack, newTrack, newFx } from '../core/project';
import { paletteColor, uid, deepClone } from '../core/util';
import { CHANNEL_PARAMS, FX_DEFS, MIXER_PARAMS, ParamDef, toNorm } from '../core/params';
import { toast } from './widgets';
import { samples } from '../audio/samples';
import { BUILTIN_BY_ID } from '../audio/sounds';
import { FxType } from '../core/types';

export function addChannel(type: 'sampler' | 'synth' | 'plugin', opts: Partial<Channel> & { sampleRef?: string; preset?: string; pluginType?: string } = {}, select = true): ID {
  const idx = store.project.channels.length;
  const ch = newChannel(type, { color: paletteColor(idx * 3 + 1), ...opts }, idx);
  if (ch.type === 'sampler' && ch.sampler?.sampleRef && !opts.name) ch.name = samples.displayName(ch.sampler.sampleRef);
  if (ch.sampler?.sampleRef?.startsWith('builtin:')) {
    const b = BUILTIN_BY_ID.get(ch.sampler.sampleRef.slice(8));
    if (b) {
      ch.sampler.rootKey = b.rootKey;
      ch.sampler.cutGroup = b.cutGroup ?? 0;
    }
  }
  // insert after the selected channel like FL
  const after = store.project.channels.findIndex((c) => c.id === store.ui.selectedChannels[0]);
  store.commit('Add channel', (p) => {
    if (after >= 0 && !opts.audioClip) p.channels.splice(after + 1, 0, ch);
    else p.channels.push(ch);
  });
  if (select) store.setUI({ selectedChannels: [ch.id], pianoRollChannel: ch.id });
  return ch.id;
}

export function deleteChannels(ids: ID[]) {
  if (!ids.length) return;
  store.commit('Delete channel', (p) => {
    p.channels = p.channels.filter((c) => !ids.includes(c.id));
    for (const pt of p.patterns) for (const id of ids) delete pt.notes[id];
    p.playlist.clips = p.playlist.clips.filter((c) => !(c.kind === 'audio' && ids.includes(c.ref)));
    const gone = new Set(p.automations.filter((a) => a.target.scope === 'channel' && ids.includes(a.target.id)).map((a) => a.id));
    p.automations = p.automations.filter((a) => !gone.has(a.id));
    p.playlist.clips = p.playlist.clips.filter((c) => !(c.kind === 'automation' && gone.has(c.ref)));
  });
  store.validateUI();
  store.emit('ui', ['selectedChannels']);
}

export function cloneChannels(ids: ID[]) {
  const newIds: ID[] = [];
  store.commit('Clone channel', (p) => {
    for (const id of ids) {
      const i = p.channels.findIndex((c) => c.id === id);
      if (i < 0) continue;
      const c: Channel = deepClone(p.channels[i]);
      c.id = uid('c');
      c.name = p.channels[i].name + ' #2';
      p.channels.splice(i + 1, 0, c);
      newIds.push(c.id);
    }
  });
  if (newIds.length) store.setUI({ selectedChannels: newIds });
}

/** First mixer insert that no channel uses (adds one if needed). */
export function freeMixerTrack(): number {
  const used = new Set(store.project.channels.map((c) => c.mixer));
  for (let i = 1; i < store.project.mixer.length; i++) {
    const m = store.project.mixer[i];
    if (!used.has(i) && !m.fx.length && m.name === `Insert ${i}`) return i;
  }
  return -1;
}

/** Ctrl+L in channel rack: route selected channels to free mixer tracks. */
export function routeToFreeTracks(ids: ID[] = store.ui.selectedChannels) {
  store.commit('Route to mixer', (p) => {
    for (const id of ids) {
      const ch = p.channels.find((c) => c.id === id);
      if (!ch) continue;
      const used = new Set(p.channels.map((c) => c.mixer));
      let idx = -1;
      for (let i = 1; i < p.mixer.length; i++) if (!used.has(i) && !p.mixer[i].fx.length && p.mixer[i].name === `Insert ${i}`) { idx = i; break; }
      if (idx < 0) {
        p.mixer.push(newMixerTrack(p.mixer.length));
        idx = p.mixer.length - 1;
      }
      ch.mixer = idx;
      p.mixer[idx].name = ch.name;
      p.mixer[idx].color = ch.color;
    }
  });
  const ch = store.channel(ids[0]);
  if (ch) store.setUI({ selectedMixer: ch.mixer, selectedMixerTracks: [ch.mixer] });
  toast('Routed to mixer track ' + (ch?.mixer ?? ''), 'ok', 1200);
}

/** Mixer Ctrl+L: link selected channels to the selected mixer track. */
export function linkChannelsToTrack(track = store.ui.selectedMixer, ids: ID[] = store.ui.selectedChannels) {
  store.commit('Link channels to mixer', (p) => {
    for (const id of ids) {
      const ch = p.channels.find((c) => c.id === id);
      if (ch) ch.mixer = track;
    }
  });
  toast(`Linked ${ids.length} channel(s) to ${store.project.mixer[track]?.name}`, 'ok', 1200);
}

export function addMixerTrack(): number {
  store.commit('Add mixer track', (p) => p.mixer.push(newMixerTrack(p.mixer.length)));
  return store.project.mixer.length - 1;
}

export function addFx(track: number, type: FxType) {
  const m = store.project.mixer[track];
  if (!m) return;
  if (m.fx.length >= 10) {
    toast('All 10 effect slots are in use on this track', 'warn');
    return;
  }
  store.commit('Add effect', (p) => p.mixer[track].fx.push(newFx(type)));
  toast(`${FX_DEFS[type].name} added to ${m.name}`, 'ok', 1200);
}

export function addPlaylistTrack() {
  store.commit('Add track', (p) => p.playlist.tracks.push(newTrack(p.playlist.tracks.length)));
}

/** Would routing `from` -> `to` create a feedback loop? */
export function createsLoop(mixer: MixerTrack[], from: number, to: number): boolean {
  let cur = to;
  const seen = new Set<number>();
  while (cur > 0 && !seen.has(cur)) {
    if (cur === from) return true;
    seen.add(cur);
    cur = mixer[cur]?.route ?? 0;
  }
  return false;
}

export function describeTarget(t: AutoTarget): { name: string; def: ParamDef | null; value: number } {
  const p = store.project;
  if (t.scope === 'channel') {
    const ch = p.channels.find((c) => c.id === t.id);
    const def = CHANNEL_PARAMS[t.param] ?? null;
    let value = def?.def ?? 0;
    if (ch && t.param === 'vol') value = ch.vol;
    else if (ch && t.param === 'pan') value = ch.pan;
    else if (ch && t.param === 'cutoff') value = ch.sampler?.cutoff ?? 20000;
    return { name: `${ch?.name ?? '?'} ${def?.label ?? t.param}`, def, value };
  }
  if (t.scope === 'mixer' || t.scope === 'master') {
    const m = p.mixer.find((x) => x.id === t.id);
    const def = MIXER_PARAMS[t.param] ?? null;
    const value = m ? (m as any)[t.param] ?? def?.def ?? 0 : 0;
    return { name: `${m?.name ?? '?'} ${def?.label ?? t.param}`, def, value };
  }
  for (const m of p.mixer)
    for (const f of m.fx)
      if (f.id === t.id) {
        const def = FX_DEFS[f.type]?.params.find((d) => d.key === t.param) ?? null;
        return { name: `${m.name} ${FX_DEFS[f.type]?.name ?? f.type} ${def?.label ?? t.param}`, def, value: f.params[t.param] ?? def?.def ?? 0 };
      }
  return { name: 'Unknown', def: null, value: 0 };
}

export const AUTOMATABLE_CHANNEL = ['vol', 'pan', 'cutoff'];

/** Create an automation clip for a parameter (right-click knob → Create automation clip). */
export function createAutomation(t: AutoTarget) {
  const d = describeTarget(t);
  if (!d.def) {
    toast("This parameter can't be automated", 'warn');
    return;
  }
  const bar = store.barTicks;
  const loop = store.ui.loop;
  const start = loop ? loop.start : 0;
  const len = loop ? loop.end - loop.start : Math.max(4 * bar, store.songLength());
  const v = toNorm(d.def, d.value);
  const id = uid('a');
  const p = store.project;
  // first track with no clips overlapping
  let track = p.playlist.tracks.findIndex((_, i) => !p.playlist.clips.some((c) => c.track === i && c.start < start + len && c.start + c.len > start));
  store.commit('Create automation clip', (pr) => {
    if (track < 0) {
      pr.playlist.tracks.push(newTrack(pr.playlist.tracks.length));
      track = pr.playlist.tracks.length - 1;
    }
    pr.automations.push({ id, name: d.name, color: '#d86bd8', target: t, points: [{ t: 0, v }, { t: len, v }], length: len });
    pr.playlist.clips.push({ id: uid('k'), kind: 'automation', ref: id, track, start, len, offset: 0 });
  });
  store.setUI({ plSource: { kind: 'automation', ref: id } });
  toast(`Automation clip "${d.name}" created on track ${track + 1} — drag points in the Playlist (Song mode plays it)`, 'ok', 4000);
}

/** Turn recorded input takes into audio-clip channels + playlist clips (FL: routed to the recording insert). */
export function placeRecordedAudio(takes: import('../audio/input').RecordedTake[]) {
  if (!takes.length) return;
  const p = store.project;
  const spt = 60 / (p.bpm * 96);
  // one undo step for the whole take: audio-clip channels + playlist clips together
  store.commit(takes.length > 1 ? 'Record audio (' + takes.length + ' tracks)' : 'Record audio', (pr) => {
    for (const t of takes) {
      const len = Math.max(1, Math.round(t.seconds / spt));
      const ch = newChannel('sampler', { sampleRef: t.ref, name: t.name, audioClip: true, group: 'Audio', mixer: t.track, color: paletteColor(pr.channels.length * 3 + 1) }, pr.channels.length);
      pr.channels.push(ch);
      // like FL: the take goes on the first playlist track that is completely empty (a new one if none)
      let track = pr.playlist.tracks.findIndex((_, i) => !pr.playlist.clips.some((c) => c.track === i));
      if (track < 0) {
        pr.playlist.tracks.push(newTrack(pr.playlist.tracks.length));
        track = pr.playlist.tracks.length - 1;
      }
      pr.playlist.clips.push({ id: uid('k'), kind: 'audio', ref: ch.id, track, start: t.startTick, len, offset: 0 });
    }
  });
  if (takes.length) toast(`Recorded ${takes.length} audio clip${takes.length > 1 ? 's' : ''} into the Playlist`, 'ok');
}
