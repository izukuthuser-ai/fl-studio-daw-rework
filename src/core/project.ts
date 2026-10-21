import {
  Automation, Channel, Clip, FxSlot, FxType, MixerTrack, Note, Pattern, PlaylistTrack, Project, SamplerParams, STEP, SynthParams,
} from './types';
import { UIState } from './store';
import { deepClone, paletteColor, uid } from './util';
import { FX_DEFS, fxDefaults, toNorm, FX_DEFS as D } from './params';
import { BUILTIN_BY_ID } from '../audio/sounds';
import { samples } from '../audio/samples';
import { getInstrument } from '../audio/plugins/registry';
import { FACTORY as RS_FACTORY, presetParams as rsPresetParams } from '../audio/plugins/riffstack/presets';

export function defaultSampler(ref: string | null = null, name = '(empty)'): SamplerParams {
  const b = ref?.startsWith('builtin:') ? BUILTIN_BY_ID.get(ref.slice(8)) : undefined;
  return {
    sampleRef: ref,
    sampleName: b?.name ?? name,
    rootKey: b?.rootKey ?? 60,
    reverse: false,
    startOffset: 0,
    envEnabled: false,
    env: { a: 0.002, d: 0.3, s: 1, r: 0.08 },
    cutoff: 20000,
    reso: 0.7,
    cutGroup: b?.cutGroup ?? 0,
  };
}

export function defaultSynth(): SynthParams {
  return {
    osc: [
      { wave: 'sawtooth', level: 0.8, coarse: 0, fine: 0 },
      { wave: 'square', level: 0.4, coarse: -12, fine: 0 },
      { wave: 'sine', level: 0, coarse: 12, fine: 0 },
    ],
    unison: 1,
    detune: 12,
    env: { a: 0.005, d: 0.3, s: 0.7, r: 0.25 },
    filterType: 'lowpass',
    cutoff: 6000,
    reso: 1,
    filterEnvAmt: 0.2,
    filterEnv: { a: 0.002, d: 0.4, s: 0.2, r: 0.3 },
    mono: false,
    glide: 0.05,
  };
}

type Preset = { name: string; desc: string; p: (s: SynthParams) => void };
export const SYNTH_PRESETS: Preset[] = [
  { name: 'Init', desc: 'Default patch', p: () => {} },
  {
    name: 'Saw Lead', desc: 'Bright detuned lead',
    p: (s) => {
      s.osc = [{ wave: 'sawtooth', level: 0.8, coarse: 0, fine: 0 }, { wave: 'sawtooth', level: 0.6, coarse: 0, fine: 9 }, { wave: 'square', level: 0.25, coarse: -12, fine: 0 }];
      s.unison = 3; s.detune = 16; s.env = { a: 0.005, d: 0.3, s: 0.75, r: 0.25 }; s.cutoff = 4500; s.reso = 1.5; s.filterEnvAmt = 0.3;
    },
  },
  {
    name: 'Square Pluck', desc: 'Short plucky square',
    p: (s) => {
      s.osc = [{ wave: 'square', level: 0.7, coarse: 0, fine: 0 }, { wave: 'sawtooth', level: 0.4, coarse: 12, fine: 4 }, { wave: 'sine', level: 0.3, coarse: -12, fine: 0 }];
      s.env = { a: 0.002, d: 0.32, s: 0, r: 0.25 }; s.cutoff = 900; s.reso = 2; s.filterEnvAmt = 0.65; s.filterEnv = { a: 0.001, d: 0.22, s: 0, r: 0.2 };
    },
  },
  {
    name: 'Warm Pad', desc: 'Slow evolving pad',
    p: (s) => {
      s.osc = [{ wave: 'sawtooth', level: 0.6, coarse: 0, fine: -6 }, { wave: 'sawtooth', level: 0.6, coarse: 0, fine: 7 }, { wave: 'triangle', level: 0.5, coarse: -12, fine: 0 }];
      s.unison = 3; s.detune = 22; s.env = { a: 0.9, d: 1, s: 0.85, r: 1.6 }; s.cutoff = 1600; s.reso = 0.8; s.filterEnvAmt = 0.15; s.filterEnv = { a: 1.2, d: 1.5, s: 0.5, r: 1.5 };
    },
  },
  {
    name: 'Sub Bass', desc: 'Clean mono sub',
    p: (s) => {
      s.osc = [{ wave: 'sine', level: 1, coarse: 0, fine: 0 }, { wave: 'triangle', level: 0.25, coarse: 0, fine: 0 }, { wave: 'sine', level: 0, coarse: 12, fine: 0 }];
      s.env = { a: 0.004, d: 0.2, s: 1, r: 0.08 }; s.cutoff = 500; s.reso = 0.7; s.filterEnvAmt = 0; s.mono = true; s.glide = 0.04;
    },
  },
  {
    name: 'Supersaw', desc: 'Huge unison chords',
    p: (s) => {
      s.osc = [{ wave: 'sawtooth', level: 0.8, coarse: 0, fine: 0 }, { wave: 'sawtooth', level: 0.5, coarse: 12, fine: 3 }, { wave: 'sine', level: 0.2, coarse: -12, fine: 0 }];
      s.unison = 6; s.detune = 30; s.env = { a: 0.01, d: 0.4, s: 0.8, r: 0.4 }; s.cutoff = 9000; s.reso = 0.8; s.filterEnvAmt = 0.1;
    },
  },
  {
    name: 'Glass Bell', desc: 'FM-ish bell tone',
    p: (s) => {
      s.osc = [{ wave: 'sine', level: 0.8, coarse: 0, fine: 0 }, { wave: 'sine', level: 0.35, coarse: 19, fine: 0 }, { wave: 'triangle', level: 0.25, coarse: 24, fine: 5 }];
      s.env = { a: 0.001, d: 1.6, s: 0, r: 1.2 }; s.cutoff = 12000; s.reso = 0.7; s.filterEnvAmt = 0;
    },
  },
  {
    name: 'Reese Bass', desc: 'Dark detuned bass',
    p: (s) => {
      s.osc = [{ wave: 'sawtooth', level: 0.8, coarse: -12, fine: -14 }, { wave: 'sawtooth', level: 0.8, coarse: -12, fine: 14 }, { wave: 'sine', level: 0.5, coarse: -24, fine: 0 }];
      s.unison = 2; s.detune = 10; s.env = { a: 0.01, d: 0.3, s: 0.9, r: 0.15 }; s.cutoff = 850; s.reso = 2.5; s.filterEnvAmt = 0.15; s.mono = true; s.glide = 0.06;
    },
  },
  {
    name: 'Chip Lead', desc: '8-bit square lead',
    p: (s) => {
      s.osc = [{ wave: 'square', level: 0.7, coarse: 0, fine: 0 }, { wave: 'square', level: 0, coarse: 12, fine: 0 }, { wave: 'noise', level: 0, coarse: 0, fine: 0 }];
      s.env = { a: 0.001, d: 0.1, s: 0.8, r: 0.05 }; s.cutoff = 20000; s.reso = 0.7; s.filterEnvAmt = 0;
    },
  },
];

export function synthPreset(name: string): SynthParams {
  const s = defaultSynth();
  SYNTH_PRESETS.find((p) => p.name === name)?.p(s);
  return s;
}

export function newChannel(type: 'sampler' | 'synth' | 'plugin', opts: Partial<Channel> & { sampleRef?: string; preset?: string; pluginType?: string } = {}, index = 0): Channel {
  const { sampleRef, preset, pluginType, ...rest } = opts;
  const plug = type === 'plugin' ? getInstrument(pluginType ?? opts.plugin?.type) : undefined;
  const ch: Channel = {
    id: uid('c'),
    name: type === 'synth' ? preset ?? 'Tri-Osc' : type === 'plugin' ? (preset && preset !== 'Init' ? preset : plug?.name ?? 'Plugin') : 'Sampler',
    type,
    color: paletteColor(index + 6),
    vol: 0.78,
    pan: 0,
    pitch: 0,
    mute: false,
    mixer: 0,
    group: 'Unsorted',
    ...rest,
  };
  if (type === 'sampler') {
    ch.sampler = defaultSampler(sampleRef ?? null, sampleRef ? samples.displayName(sampleRef) : undefined);
    if (!opts.name && ch.sampler.sampleRef) ch.name = ch.sampler.sampleName;
  } else if (type === 'plugin') {
    if (!ch.plugin) {
      const pr = preset ? plug?.presets().find((x) => x.name === preset) : undefined;
      ch.plugin = { type: plug?.id ?? pluginType ?? 'unknown', state: deepClone(pr?.state ?? plug?.defaultState() ?? {}), preset: pr?.name ?? 'Init' };
    }
  } else ch.synth = synthPreset(preset ?? 'Init');
  return ch;
}

export function newPattern(index: number, name?: string): Pattern {
  return { id: uid('p'), name: name ?? `Pattern ${index + 1}`, color: paletteColor(index), notes: {}, length: 0 };
}

export function newFx(type: FxType): FxSlot {
  return { id: uid('fx'), type, enabled: true, mix: FX_DEFS[type].defaultMix, params: fxDefaults(type) };
}

export function newMixerTrack(i: number): MixerTrack {
  return {
    id: uid('m'),
    name: i === 0 ? 'Master' : `Insert ${i}`,
    color: i === 0 ? '#9aa7b0' : '#6b7a86',
    volDb: 0,
    pan: 0,
    width: 1,
    mute: false,
    armed: false,
    route: i === 0 ? -1 : 0,
    fx: [],
  };
}

export function newTrack(i: number): PlaylistTrack {
  return { id: uid('t'), name: `Track ${i + 1}`, color: '#5b6872', mute: false, height: 56 };
}

export function note(key: number, startStep: number, lenSteps = 1, vel = 0.78): Note {
  return { id: uid('n'), key, start: Math.round(startStep * STEP), len: Math.round(lenSteps * STEP), vel, pan: 0 };
}

export function emptyProject(): Project {
  const mixer = Array.from({ length: 21 }, (_, i) => newMixerTrack(i));
  return {
    format: 'loopforge',
    version: 1,
    info: { title: 'Untitled', author: '', genre: '', comments: '' },
    bpm: 140,
    timeSig: [4, 4],
    swing: 0,
    masterPitch: 0,
    channels: [],
    patterns: [newPattern(0)],
    playlist: { tracks: Array.from({ length: 24 }, (_, i) => newTrack(i)), clips: [] },
    automations: [],
    mixer,
  };
}

/** Basic empty template: 4 drum channels routed to inserts, like FL's default template. */
export function basicProject(): Project {
  const p = emptyProject();
  const kit: [string, string][] = [['kick-punch', 'Kick'], ['clap', 'Clap'], ['hat-closed', 'Hat'], ['snare-crisp', 'Snare']];
  kit.forEach(([id, name], i) => {
    p.channels.push(newChannel('sampler', { name, sampleRef: 'builtin:' + id, mixer: i + 1, color: paletteColor(i * 2) }, i));
    p.mixer[i + 1].name = name;
  });
  return p;
}

export function demoProject(): Project {
  const p = emptyProject();
  p.info.title = 'LoopForge Demo';
  p.info.comments = 'Demo song generated by LoopForge Studio. Press L for Song mode, then Space.';
  const ch = (name: string, ref: string, mixer: number, vol: number, color: number, extra: Partial<Channel> = {}) => {
    const c = newChannel('sampler', { name, sampleRef: 'builtin:' + ref, mixer, vol, color: paletteColor(color), group: 'Drums', ...extra });
    p.channels.push(c);
    return c;
  };
  const kick = ch('Kick', 'kick-punch', 1, 0.82, 0);
  const clap = ch('Clap', 'clap', 2, 0.68, 1);
  const hat = ch('Hat', 'hat-closed', 3, 0.5, 2);
  const ohat = ch('Open Hat', 'hat-open', 3, 0.42, 2);
  const bass = ch('808', '808-long', 4, 0.74, 4, { group: 'Bass' });
  bass.sampler!.envEnabled = true;
  bass.sampler!.env = { a: 0.002, d: 0.3, s: 1, r: 0.12 };
  bass.sampler!.cutGroup = 2;
  // showcase the bundled plugins when they're registered (falls back to Tri-Osc otherwise)
  const pluck = getInstrument('halcyon')
    ? newChannel('plugin', { name: 'Pluck', pluginType: 'halcyon', preset: 'Shimmer Pluck', mixer: 5, vol: 0.8, color: paletteColor(6), group: 'Synths' })
    : newChannel('synth', { name: 'Pluck', preset: 'Square Pluck', mixer: 5, vol: 0.62, color: paletteColor(6), group: 'Synths' });
  const pad = getInstrument('rune')
    ? newChannel('plugin', { name: 'Pad', pluginType: 'rune', preset: 'Polar Pad', mixer: 6, vol: 0.62, color: paletteColor(8), group: 'Synths' })
    : newChannel('synth', { name: 'Pad', preset: 'Warm Pad', mixer: 6, vol: 0.5, color: paletteColor(8), group: 'Synths' });
  p.channels.push(pluck, pad);
  const riser = ch('Noise Riser', 'riser', 7, 0.5, 10, { audioClip: true, group: 'Audio' });
  const impact = ch('Impact', 'impact', 7, 0.6, 10, { audioClip: true, group: 'Audio' });

  const names = ['Master', 'Kick', 'Clap', 'Hats', '808', 'Pluck', 'Pad', 'FX'];
  names.forEach((n, i) => (p.mixer[i].name = n));
  p.mixer[0].fx.push(newFx('limiter'));
  const clapVerb = newFx('reverb');
  clapVerb.mix = 0.18;
  p.mixer[2].fx.push(clapVerb);
  const hatEq = newFx('eq');
  hatEq.params.lowCut = 300;
  p.mixer[3].fx.push(hatEq);
  p.mixer[3].pan = 0.1;
  const sat = newFx('distortion');
  sat.params.drive = 6;
  sat.params.output = -4;
  sat.mix = 0.5;
  p.mixer[4].fx.push(sat);
  const plFilter = newFx('filter');
  plFilter.params.cutoff = 20000;
  plFilter.params.reso = 2;
  const plDelay = newFx('delay');
  plDelay.mix = 0.22;
  const plVerb = newFx('reverb');
  plVerb.mix = 0.2;
  p.mixer[5].fx.push(plFilter, plDelay, plVerb);
  const padVerb = newFx('reverb');
  padVerb.mix = 0.35;
  padVerb.params.decay = 4;
  p.mixer[6].fx.push(padVerb);
  p.mixer[6].volDb = -3;
  const fxVerb = newFx('reverb');
  fxVerb.mix = 0.3;
  p.mixer[7].fx.push(fxVerb);
  p.mixer[7].volDb = -4;
  // a guitar insert with the amp rack ready: pick an input on it in the Mixer, arm, and play
  if (FX_DEFS.riffstack) {
    const amp = newFx('riffstack');
    const pr = RS_FACTORY.find((x) => x.name === 'Molten Core Rhythm');
    if (pr) {
      amp.params = { ...amp.params, ...rsPresetParams(pr) };
      amp.data = { preset: pr.name };
    }
    p.mixer[8].name = 'Guitar';
    p.mixer[8].color = '#c95f4f';
    p.mixer[8].fx.push(amp);
  }

  // Patterns
  const beat = newPattern(0, 'Beat');
  beat.notes[kick.id] = [0, 7, 10].map((s) => note(60, s, 1, 0.85));
  beat.notes[clap.id] = [4, 12].map((s) => note(60, s, 1, 0.8));
  beat.notes[hat.id] = [0, 2, 4, 6, 8, 10, 12, 14, 15].map((s) => note(60, s, 1, s % 4 === 0 ? 0.78 : 0.55));
  beat.notes[ohat.id] = [note(60, 11, 1, 0.6)];

  const bassPat = newPattern(1, '808');
  bassPat.notes[bass.id] = [
    note(36, 0, 6.5, 0.85), note(36, 7, 2.5, 0.8), note(39, 10, 5.5, 0.82),
    note(32, 16, 6.5, 0.85), note(32, 23, 2.5, 0.8), note(34, 26, 5.5, 0.82),
  ];

  const mel = newPattern(2, 'Melody');
  const arp1 = [72, 67, 63, 67, 70, 67, 63, 67];
  const arp2 = [72, 68, 63, 68, 70, 68, 65, 68];
  mel.notes[pluck.id] = [
    ...arp1.map((k, i) => note(k, i * 2, 1.5, i % 2 ? 0.62 : 0.85)),
    ...arp2.map((k, i) => note(k, 16 + i * 2, 1.5, i % 2 ? 0.62 : 0.85)),
  ];

  const chords = newPattern(3, 'Chords');
  chords.notes[pad.id] = [
    ...[48, 60, 63, 67].map((k) => note(k, 0, 16, 0.7)),
    ...[44, 60, 63, 68].map((k) => note(k, 16, 16, 0.7)),
  ];
  p.patterns = [beat, bassPat, mel, chords];

  // Automation: open the pluck filter over the intro
  const cutoffDef = D.filter.params.find((x) => x.key === 'cutoff')!;
  const auto: Automation = {
    id: uid('a'),
    name: 'Pluck Filter',
    color: '#d86bd8',
    target: { scope: 'fx', id: plFilter.id, param: 'cutoff' },
    points: [
      { t: 0, v: toNorm(cutoffDef, 400) },
      { t: 384 * 4, v: 1 },
    ],
    length: 384 * 4,
  };
  p.automations.push(auto);

  // Playlist arrangement (16 bars)
  const bar = 384;
  const t = p.playlist.tracks;
  ['Beat', '808', 'Melody', 'Chords', 'Pluck Filter', 'FX'].forEach((n, i) => (t[i].name = n));
  const clip = (kind: Clip['kind'], ref: string, track: number, start: number, len: number): Clip => ({ id: uid('k'), kind, ref, track, start, len, offset: 0 });
  const clips: Clip[] = [];
  for (let b = 4; b < 16; b++) clips.push(clip('pattern', beat.id, 0, b * bar, bar));
  for (let b = 4; b < 16; b += 2) clips.push(clip('pattern', bassPat.id, 1, b * bar, 2 * bar));
  for (let b = 0; b < 16; b += 2) clips.push(clip('pattern', mel.id, 2, b * bar, 2 * bar));
  for (let b = 0; b < 16; b += 2) clips.push(clip('pattern', chords.id, 3, b * bar, 2 * bar));
  clips.push(clip('automation', auto.id, 4, 0, 4 * bar));
  const riserTicks = Math.round((4 * p.bpm * 96) / 60);
  clips.push(clip('audio', riser.id, 5, 4 * bar - riserTicks, riserTicks));
  clips.push(clip('audio', impact.id, 5, 4 * bar, Math.round((2.5 * p.bpm * 96) / 60)));
  p.playlist.clips = clips;
  return p;
}

export function defaultUI(p: Project): UIState {
  return {
    currentPattern: p.patterns[0]?.id ?? '',
    selectedChannels: p.channels[0] ? [p.channels[0].id] : [],
    pianoRollChannel: p.channels.find((c) => c.type === 'synth')?.id ?? p.channels[0]?.id ?? null,
    songMode: false,
    recording: false,
    metronome: false,
    typingPiano: false,
    stepEdit: false,
    blend: false,
    precount: false,
    waitInput: false,
    snap: 'line',
    prTool: 'draw',
    plTool: 'draw',
    selectedMixer: 1,
    selectedMixerTracks: [1],
    pianoOctave: 5,
    loop: null,
    timeDisplay: 'bst',
    channelGroup: 'All',
    ghost: true,
    scale: { root: 0, type: 'minor', highlight: true, snap: false },
    plSource: p.patterns[0] ? { kind: 'pattern', ref: p.patterns[0].id } : null,
    masterVol: 0.8,
    focused: 'playlist',
    editAutomation: null,
    settingsChannel: null,
  };
}

/** Validate & fill defaults for a loaded project file. Throws on unrecognized data. */
export function sanitizeProject(raw: any): Project {
  if (!raw || typeof raw !== 'object' || raw.format !== 'loopforge') throw new Error('Not a LoopForge project file');
  const base = emptyProject();
  const p: Project = { ...base, ...deepClone(raw) };
  p.info = { ...base.info, ...(raw.info ?? {}) };
  p.bpm = Number(p.bpm) || 140;
  if (!Array.isArray(p.timeSig) || p.timeSig.length !== 2) p.timeSig = [4, 4];
  p.channels = (p.channels ?? []).map((c: Channel) => {
    if (c.type === 'plugin') {
      const plug = getInstrument(c.plugin?.type);
      const d = newChannel('plugin', { pluginType: c.plugin?.type });
      return { ...d, ...c, plugin: { type: c.plugin?.type ?? 'unknown', state: { ...(plug?.defaultState() ?? {}), ...(c.plugin?.state ?? {}) }, preset: c.plugin?.preset } };
    }
    const d = newChannel(c.type === 'synth' ? 'synth' : 'sampler');
    const out: Channel = { ...d, ...c };
    if (out.type === 'sampler') out.sampler = { ...defaultSampler(), ...(c.sampler ?? {}) };
    else out.synth = { ...defaultSynth(), ...(c.synth ?? {}) };
    return out;
  });
  if (!p.patterns?.length) p.patterns = [newPattern(0)];
  p.patterns = p.patterns.map((pt: Pattern, i: number) => ({ ...newPattern(i), ...pt, notes: pt.notes ?? {} }));
  p.playlist = { tracks: raw.playlist?.tracks ?? base.playlist.tracks, clips: raw.playlist?.clips ?? [] };
  p.automations = p.automations ?? [];
  if (!p.mixer?.length) p.mixer = base.mixer;
  // effects this build doesn't know (newer version / missing plugin) are kept as-is and pass audio through
  p.mixer = p.mixer.map((m: MixerTrack, i: number) => ({
    ...newMixerTrack(i),
    ...m,
    fx: (Array.isArray(m.fx) ? m.fx : []).filter((f) => f && typeof f.type === 'string' && typeof f.id === 'string').map((f) => ({ ...f, enabled: f.enabled !== false, mix: typeof f.mix === 'number' ? f.mix : 1, params: f.params && typeof f.params === 'object' ? f.params : {} })),
  }));
  return p;
}
