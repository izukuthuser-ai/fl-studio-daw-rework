// Core data model for LoopForge Studio projects.
// Timing: PPQ = 96 ticks per quarter note, 1 step (1/16) = 24 ticks, 1 bar (4/4) = 384 ticks.
// Note numbers are MIDI numbers; display uses FL convention where MIDI 60 = "C5".

export const PPQ = 96;
export const STEP = 24;
export const BEAT = PPQ;

export type ID = string;

export interface Note {
  id: ID;
  key: number; // MIDI note number
  start: number; // ticks from pattern start
  len: number; // ticks
  vel: number; // 0..1
  pan: number; // -1..1
  muted?: boolean;
}

export interface Envelope {
  a: number; // seconds
  d: number; // seconds
  s: number; // 0..1
  r: number; // seconds
}

export interface SamplerParams {
  sampleRef: string | null; // "builtin:<id>" | "file:<abs path>" | "embed:<id>"
  sampleName: string;
  rootKey: number;
  reverse: boolean;
  startOffset: number; // 0..1 of sample length
  envEnabled: boolean; // false = one-shot (plays whole sample like FL default)
  env: Envelope;
  cutoff: number; // Hz
  reso: number; // Q
  cutGroup: number; // 0 = none; voices in the same group choke each other
}

export type Wave = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'noise';

export interface OscParams {
  wave: Wave;
  level: number; // 0..1
  coarse: number; // semitones
  fine: number; // cents
}

export type FilterType = 'lowpass' | 'highpass' | 'bandpass';

export interface SynthParams {
  osc: OscParams[]; // always 3
  unison: number; // 1..6
  detune: number; // cents spread for unison
  env: Envelope;
  filterType: FilterType;
  cutoff: number; // Hz
  reso: number; // Q
  filterEnvAmt: number; // 0..1 (octaves*6 of sweep)
  filterEnv: Envelope;
  mono: boolean;
  glide: number; // seconds (mono only)
}

export type InstrumentType = 'sampler' | 'synth';

export interface Channel {
  id: ID;
  name: string;
  type: InstrumentType;
  color: string;
  vol: number; // 0..1.25, 0.8 = unity
  pan: number; // -1..1
  pitch: number; // semitones -24..24 (fractional allowed)
  mute: boolean;
  mixer: number; // mixer track index (0 = master)
  group: string; // channel rack filter group
  sampler?: SamplerParams;
  synth?: SynthParams;
  audioClip?: boolean; // created from an audio clip dropped on the playlist
}

export interface Pattern {
  id: ID;
  name: string;
  color: string;
  notes: Record<ID, Note[]>; // channelId -> notes
  length: number; // ticks; 0 = auto (fit notes, min 1 bar)
}

export interface PlaylistTrack {
  id: ID;
  name: string;
  color: string;
  mute: boolean;
  height: number; // px at zoom 1
}

export type ClipKind = 'pattern' | 'audio' | 'automation';

export interface Clip {
  id: ID;
  kind: ClipKind;
  ref: ID; // pattern id | channel id | automation id
  track: number; // playlist track index
  start: number; // ticks
  len: number; // ticks
  offset: number; // ticks into source
  muted?: boolean;
  group?: string;
}

export interface AutoPoint {
  t: number; // ticks relative to automation start
  v: number; // normalized 0..1
}

export interface AutoTarget {
  scope: 'channel' | 'mixer' | 'fx' | 'master';
  id: ID; // channel id | mixer track id | fx slot id
  param: string;
}

export interface Automation {
  id: ID;
  name: string;
  color: string;
  target: AutoTarget;
  points: AutoPoint[];
  length: number; // ticks
}

export type FxType =
  | 'eq'
  | 'compressor'
  | 'limiter'
  | 'reverb'
  | 'delay'
  | 'filter'
  | 'distortion'
  | 'bitcrusher'
  | 'chorus'
  | 'width';

export interface FxSlot {
  id: ID;
  type: FxType;
  enabled: boolean;
  mix: number; // 0..1 dry/wet
  params: Record<string, number>;
}

export interface MixerTrack {
  id: ID;
  name: string;
  color: string;
  volDb: number; // -60 (=-inf) .. +5.6
  pan: number; // -1..1
  width: number; // 0..2 stereo width
  mute: boolean;
  armed: boolean;
  route: number; // destination track index; master = -1
  fx: FxSlot[];
}

export interface SongInfo {
  title: string;
  author: string;
  genre: string;
  comments: string;
}

export interface Project {
  format: 'loopforge';
  version: 1;
  info: SongInfo;
  bpm: number;
  timeSig: [number, number];
  swing: number; // 0..1
  masterPitch: number; // semitones
  channels: Channel[];
  patterns: Pattern[];
  playlist: { tracks: PlaylistTrack[]; clips: Clip[] };
  automations: Automation[];
  mixer: MixerTrack[]; // [0] = master
}

export type WindowId =
  | 'playlist'
  | 'channelrack'
  | 'pianoroll'
  | 'mixer'
  | 'browser'
  | 'channelsettings'
  | 'automation';

export type ToolId = 'draw' | 'paint' | 'delete' | 'mute' | 'slice' | 'select' | 'zoom' | 'playback' | 'slip';

export type Snap =
  | 'line'
  | 'cell'
  | 'none'
  | '1/6step'
  | '1/4step'
  | '1/3step'
  | '1/2step'
  | 'step'
  | '1/3beat'
  | '1/2beat'
  | 'beat'
  | 'bar';
