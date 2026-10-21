// Rune — shared patch model (state shape, defaults, normalisation, enumerations).
// Imported by the worklet (DSP), the UI and the presets, so it must stay free of DOM / worklet globals.

export const OSC_TYPES = ['off', 'analog', 'multi', 'fm', 'pm', 'chip', 'noise', 'vector'] as const;
export type OscType = (typeof OSC_TYPES)[number];
export const OSC_LABELS: Record<OscType, string> = { off: 'Off', analog: 'Analog', multi: 'Multi', fm: 'FM', pm: 'PM', chip: 'Chip', noise: 'Noise', vector: 'Vector' };

export const FILTER_TYPES = ['off', 'ladder', 'svf', 'sem', 'k35', 'diode', 'comb', 'formant', 'ring'] as const;
export type FilterType = (typeof FILTER_TYPES)[number];
export const FILTER_LABELS: Record<FilterType, string> = { off: 'Off', ladder: 'Ladder 24', svf: 'SVF 12', sem: 'SEM Morph', k35: 'K-35', diode: 'Diode 24', comb: 'Comb', formant: 'Formant', ring: 'Ring Mod' };
/** Discrete sub-modes (empty = the filter has none). */
export const FILTER_MODES: Record<FilterType, string[]> = { off: [], ladder: [], svf: ['LP', 'BP', 'HP'], sem: [], k35: ['LP', 'HP'], diode: [], comb: ['+', '−'], formant: [], ring: [] };

export const DIST_TYPES = ['off', 'tube', 'fold', 'rect', 'crush'] as const;
export type DistType = (typeof DIST_TYPES)[number];
export const DIST_LABELS: Record<DistType, string> = { off: 'Off', tube: 'Tube', fold: 'Fold', rect: 'Rectify', crush: 'Crush' };

export const LFO_SHAPES = ['sine', 'tri', 'saw', 'square', 'sh', 'smooth'] as const;
export type LfoShape = (typeof LFO_SHAPES)[number];
export const LFO_LABELS: Record<LfoShape, string> = { sine: 'Sine', tri: 'Triangle', saw: 'Saw', square: 'Square', sh: 'S & H', smooth: 'Smooth Rnd' };

/** Tempo divisions in beats (quarter notes). */
export const LFO_DIVS: { label: string; beats: number }[] = [
  { label: '8 bars', beats: 32 }, { label: '4 bars', beats: 16 }, { label: '2 bars', beats: 8 }, { label: '1 bar', beats: 4 },
  { label: '1/2', beats: 2 }, { label: '1/2 T', beats: 4 / 3 }, { label: '1/4', beats: 1 }, { label: '1/4 T', beats: 2 / 3 },
  { label: '1/8', beats: 0.5 }, { label: '1/8 T', beats: 1 / 3 }, { label: '1/16', beats: 0.25 }, { label: '1/16 T', beats: 1 / 6 },
  { label: '1/32', beats: 0.125 },
];
export const ARP_RATES: { label: string; beats: number }[] = [
  { label: '1/4', beats: 1 }, { label: '1/4 T', beats: 2 / 3 }, { label: '1/8 D', beats: 0.75 }, { label: '1/8', beats: 0.5 },
  { label: '1/8 T', beats: 1 / 3 }, { label: '1/16 D', beats: 0.375 }, { label: '1/16', beats: 0.25 }, { label: '1/16 T', beats: 1 / 6 },
  { label: '1/32', beats: 0.125 }, { label: '1/32 T', beats: 1 / 12 },
];
export const DELAY_DIVS: { label: string; beats: number }[] = [
  { label: '1/16', beats: 0.25 }, { label: '1/8 T', beats: 1 / 3 }, { label: '1/16 D', beats: 0.375 }, { label: '1/8', beats: 0.5 },
  { label: '1/4 T', beats: 2 / 3 }, { label: '1/8 D', beats: 0.75 }, { label: '1/4', beats: 1 }, { label: '1/4 D', beats: 1.5 }, { label: '1/2', beats: 2 },
];
export const ARP_MODES = ['up', 'down', 'updown', 'random', 'played', 'chord'] as const;
export type ArpMode = (typeof ARP_MODES)[number];
export const ARP_LABELS: Record<ArpMode, string> = { up: 'Up', down: 'Down', updown: 'Up / Down', random: 'Random', played: 'As played', chord: 'Chord' };
export const VOICE_MODES = ['poly', 'mono', 'legato'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

// ---------------- modulation matrix ----------------
export interface ModSourceDef { id: string; label: string; short: string }
export const MOD_SOURCES: ModSourceDef[] = [
  { id: 'none', label: '—', short: '—' },
  { id: 'env1', label: 'Amp Env', short: 'ENV1' },
  { id: 'env2', label: 'Filter Env', short: 'ENV2' },
  { id: 'env3', label: 'Mod Env', short: 'ENV3' },
  { id: 'lfo1', label: 'LFO 1', short: 'LFO1' },
  { id: 'lfo2', label: 'LFO 2', short: 'LFO2' },
  { id: 'lfo3', label: 'LFO 3', short: 'LFO3' },
  { id: 'lfo4', label: 'LFO 4', short: 'LFO4' },
  { id: 'vel', label: 'Velocity', short: 'VEL' },
  { id: 'key', label: 'Key track', short: 'KEY' },
  { id: 'wheel', label: 'Mod wheel', short: 'WHL' },
  { id: 'rand', label: 'Random (per note)', short: 'RND' },
  { id: 'uni', label: 'Unison position', short: 'UNI' },
  { id: 'seq', label: 'Arp step value', short: 'SEQ' },
  { id: 'macro1', label: 'Macro 1', short: 'M1' },
  { id: 'macro2', label: 'Macro 2', short: 'M2' },
  { id: 'macro3', label: 'Macro 3', short: 'M3' },
  { id: 'macro4', label: 'Macro 4', short: 'M4' },
];
export const SRC_INDEX: Record<string, number> = Object.fromEntries(MOD_SOURCES.map((s, i) => [s.id, i]));

export interface ModDestDef {
  id: string;
  label: string;
  /** Display scale for the amount (e.g. 24 semitones for pitch at amount 1). */
  scale: number;
  unit: string;
  /** Global destinations (FX) are evaluated once per block from non-voice sources. */
  global?: boolean;
  group: string;
}
const oscDests = (i: number): ModDestDef[] => [
  { id: `o${i}.pitch`, label: `Osc ${i} pitch`, scale: 24, unit: 'st', group: `Osc ${i}` },
  { id: `o${i}.level`, label: `Osc ${i} level`, scale: 100, unit: '%', group: `Osc ${i}` },
  { id: `o${i}.shape`, label: `Osc ${i} shape`, scale: 100, unit: '%', group: `Osc ${i}` },
  { id: `o${i}.pw`, label: `Osc ${i} pulse width / Y`, scale: 50, unit: '%', group: `Osc ${i}` },
  { id: `o${i}.fm`, label: `Osc ${i} FM amount`, scale: 100, unit: '%', group: `Osc ${i}` },
  { id: `o${i}.pan`, label: `Osc ${i} pan`, scale: 100, unit: '%', group: `Osc ${i}` },
];
const fltDests = (i: number): ModDestDef[] => [
  { id: `f${i}.cutoff`, label: `Filter ${i} cutoff`, scale: 96, unit: 'st', group: `Filter ${i}` },
  { id: `f${i}.res`, label: `Filter ${i} resonance`, scale: 100, unit: '%', group: `Filter ${i}` },
  { id: `f${i}.drive`, label: `Filter ${i} drive`, scale: 100, unit: '%', group: `Filter ${i}` },
  { id: `f${i}.morph`, label: `Filter ${i} morph / vowel`, scale: 100, unit: '%', group: `Filter ${i}` },
];
export const MOD_DESTS: ModDestDef[] = [
  { id: 'none', label: '—', scale: 1, unit: '', group: '' },
  ...oscDests(1), ...oscDests(2), ...oscDests(3),
  { id: 'pitch', label: 'All osc pitch', scale: 24, unit: 'st', group: 'Voice' },
  { id: 'uni.detune', label: 'Unison detune', scale: 100, unit: '%', group: 'Voice' },
  ...fltDests(1), ...fltDests(2),
  { id: 'amp.gain', label: 'Amp gain', scale: 100, unit: '%', group: 'Amp' },
  { id: 'amp.pan', label: 'Amp pan', scale: 100, unit: '%', group: 'Amp' },
  { id: 'dist.drive', label: 'Distortion drive', scale: 100, unit: '%', group: 'Amp' },
  { id: 'dist.mix', label: 'Distortion mix', scale: 100, unit: '%', group: 'Amp' },
  { id: 'lfo1.rate', label: 'LFO 1 rate', scale: 4, unit: 'oct', group: 'LFO' },
  { id: 'lfo2.rate', label: 'LFO 2 rate', scale: 4, unit: 'oct', group: 'LFO' },
  { id: 'lfo3.rate', label: 'LFO 3 rate', scale: 4, unit: 'oct', group: 'LFO' },
  { id: 'lfo4.rate', label: 'LFO 4 rate', scale: 4, unit: 'oct', group: 'LFO' },
  { id: 'fx.chorus', label: 'Chorus mix', scale: 100, unit: '%', global: true, group: 'FX' },
  { id: 'fx.phaser', label: 'Phaser mix', scale: 100, unit: '%', global: true, group: 'FX' },
  { id: 'fx.flanger', label: 'Flanger mix', scale: 100, unit: '%', global: true, group: 'FX' },
  { id: 'fx.delay', label: 'Delay mix', scale: 100, unit: '%', global: true, group: 'FX' },
  { id: 'fx.reverb', label: 'Reverb mix', scale: 100, unit: '%', global: true, group: 'FX' },
];
export const DST_INDEX: Record<string, number> = Object.fromEntries(MOD_DESTS.map((d, i) => [d.id, i]));
export const MOD_SLOTS = 16;

// ---------------- state ----------------
export interface RuneOsc {
  type: OscType;
  oct: number; // -3..3
  semi: number; // -12..12
  fine: number; // cents -100..100
  level: number; // 0..1
  pan: number; // -1..1
  sync: boolean; // hard sync to osc 1 (osc 2/3)
  fm: number; // 0..1 FM from the previous oscillator (osc 2/3)
  reset: boolean; // reset phase on note-on
  route: number; // 0 = filter 1, 1 = filter 2, 2 = both
  wave: number; // analog: 0 saw → 1 pulse → 2 tri → 3 sine; multi: 0 saw → 1 pulse; PM: modulator shape 0..3
  pw: number; // 0.05..0.95
  voices: number; // multi: 2..8
  detune: number; // multi: 0..1
  spread: number; // multi: stereo 0..1
  ratio: number; // fm / pm: 0.5..16
  index: number; // fm / pm: 0..10
  fb: number; // fm / pm modulator feedback 0..1
  duty: number; // chip: 0 = 12.5%, 1 = 25%, 2 = 50%, 3 = 4-bit triangle
  noise: number; // 0 = white, 1 = pink, 2 = crackle
  color: number; // noise colour 0 (dark) .. 1 (bright); crackle density
  x: number; // vector X 0..1
  y: number; // vector Y 0..1
}
export interface RuneFilter {
  type: FilterType;
  mode: number;
  cutoff: number; // Hz 20..20000
  res: number; // 0..1
  drive: number; // 0..1
  key: number; // 0..1 key tracking
  env: number; // -1..1 (ENV2 amount, ±6 octaves)
  vel: number; // 0..1 (velocity → cutoff, up to +4 octaves)
  level: number; // 0..1
  morph: number; // SEM: LP → BP → HP → notch; formant: vowel A E I O U
}
export interface RuneEnv { a: number; d: number; s: number; r: number; loop: boolean }
export interface RuneLfo { shape: LfoShape; rate: number; sync: boolean; div: number; retrig: boolean; fade: number }
export interface RuneMod { src: string; dst: string; amt: number; via: string }
export interface RuneArp {
  on: boolean;
  mode: ArpMode;
  oct: number; // 1..4
  rate: number; // index into ARP_RATES
  gate: number; // 0.05..1
  swing: number; // 0..1
  latch: boolean;
  len: number; // 1..16 steps
  steps: number[]; // 16 × 0/1 (rest)
  vals: number[]; // 16 × 0..1 (mod source "seq")
}
export interface RuneVoice { mode: VoiceMode; voices: number; glide: number; unison: number; detune: number; spread: number; drift: number }
export interface RuneFx {
  chorus: { on: boolean; mix: number; rate: number; depth: number };
  phaser: { on: boolean; mix: number; rate: number; depth: number; fb: number };
  flanger: { on: boolean; mix: number; rate: number; depth: number; fb: number };
  delay: { on: boolean; mix: number; div: number; fb: number; tone: number; pingpong: boolean };
  reverb: { on: boolean; mix: number; size: number; damp: number; pre: number };
}
export interface RuneState {
  v: 1;
  osc: RuneOsc[];
  flt: RuneFilter[];
  serial: boolean; // filter 1 → filter 2 (else parallel)
  amp: { gain: number; pan: number; vel: number; dist: DistType; drive: number; mix: number };
  env: RuneEnv[];
  lfo: RuneLfo[];
  mod: RuneMod[];
  arp: RuneArp;
  voice: RuneVoice;
  fx: RuneFx;
  /** Macro knob values 0..1 (playlist automation of macro1..4 is added on top). */
  macros: number[];
  master: number; // dB -24..+6
}

export const defaultOsc = (type: OscType = 'off'): RuneOsc => ({
  type, oct: 0, semi: 0, fine: 0, level: 0.8, pan: 0, sync: false, fm: 0, reset: false, route: 0,
  wave: 0, pw: 0.5, voices: 7, detune: 0.3, spread: 0.6, ratio: 2, index: 1.5, fb: 0, duty: 2, noise: 0, color: 0.5, x: 0.5, y: 0.5,
});
export const defaultFilter = (type: FilterType = 'off'): RuneFilter => ({ type, mode: 0, cutoff: 6000, res: 0.15, drive: 0, key: 0.3, env: 0, vel: 0, level: 1, morph: 0 });
export const defaultMod = (): RuneMod => ({ src: 'none', dst: 'none', amt: 0, via: 'none' });

export function defaultState(): RuneState {
  const osc1 = defaultOsc('analog');
  osc1.level = 1;
  return {
    v: 1,
    osc: [osc1, defaultOsc('off'), defaultOsc('off')],
    flt: [defaultFilter('ladder'), { ...defaultFilter('off'), cutoff: 2000 }],
    serial: true,
    amp: { gain: 0, pan: 0, vel: 0.5, dist: 'off', drive: 0.3, mix: 1 },
    env: [
      { a: 0.004, d: 0.3, s: 0.8, r: 0.25, loop: false },
      { a: 0.004, d: 0.45, s: 0.35, r: 0.3, loop: false },
      { a: 0.01, d: 0.6, s: 0.5, r: 0.5, loop: false },
    ],
    lfo: [0, 1, 2, 3].map(() => ({ shape: 'sine' as LfoShape, rate: 2, sync: false, div: 6, retrig: false, fade: 0 })),
    mod: Array.from({ length: MOD_SLOTS }, defaultMod),
    arp: { on: false, mode: 'up', oct: 1, rate: 6, gate: 0.6, swing: 0, latch: false, len: 16, steps: new Array(16).fill(1), vals: new Array(16).fill(0.5) },
    voice: { mode: 'poly', voices: 12, glide: 0, unison: 1, detune: 0.25, spread: 0.6, drift: 0.15 },
    fx: {
      chorus: { on: false, mix: 0.4, rate: 0.5, depth: 0.5 },
      phaser: { on: false, mix: 0.6, rate: 0.25, depth: 0.7, fb: 0.5 },
      flanger: { on: false, mix: 0.5, rate: 0.15, depth: 0.6, fb: 0.5 },
      delay: { on: false, mix: 0.25, div: 5, fb: 0.35, tone: 0.6, pingpong: true },
      reverb: { on: false, mix: 0.22, size: 0.6, damp: 0.4, pre: 0.01 },
    },
    macros: [0, 0, 0, 0],
    master: 0,
  };
}

// ---------------- normalisation (tolerant onState / old or partial patches) ----------------
const num = (v: any, d: number, lo: number, hi: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const int = (v: any, d: number, lo: number, hi: number) => Math.round(num(v, d, lo, hi));
const bool = (v: any, d: boolean) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : d);
const pick = <T extends string>(v: any, list: readonly T[], d: T): T => (list.includes(v) ? v : d);

function normOsc(o: any, d: RuneOsc): RuneOsc {
  o = o && typeof o === 'object' ? o : {};
  return {
    type: pick(o.type, OSC_TYPES, d.type),
    oct: int(o.oct, d.oct, -3, 3), semi: int(o.semi, d.semi, -12, 12), fine: num(o.fine, d.fine, -100, 100),
    level: num(o.level, d.level, 0, 1), pan: num(o.pan, d.pan, -1, 1), sync: bool(o.sync, d.sync), fm: num(o.fm, d.fm, 0, 1),
    reset: bool(o.reset, d.reset), route: int(o.route, d.route, 0, 2),
    wave: num(o.wave, d.wave, 0, 3), pw: num(o.pw, d.pw, 0.05, 0.95), voices: int(o.voices, d.voices, 2, 8),
    detune: num(o.detune, d.detune, 0, 1), spread: num(o.spread, d.spread, 0, 1), ratio: num(o.ratio, d.ratio, 0.5, 16),
    index: num(o.index, d.index, 0, 10), fb: num(o.fb, d.fb, 0, 1), duty: int(o.duty, d.duty, 0, 3), noise: int(o.noise, d.noise, 0, 2),
    color: num(o.color, d.color, 0, 1), x: num(o.x, d.x, 0, 1), y: num(o.y, d.y, 0, 1),
  };
}
function normFilter(f: any, d: RuneFilter): RuneFilter {
  f = f && typeof f === 'object' ? f : {};
  const type = pick(f.type, FILTER_TYPES, d.type);
  return {
    type, mode: int(f.mode, 0, 0, Math.max(0, FILTER_MODES[type].length - 1)),
    cutoff: num(f.cutoff, d.cutoff, 20, 20000), res: num(f.res, d.res, 0, 1), drive: num(f.drive, d.drive, 0, 1),
    key: num(f.key, d.key, 0, 1), env: num(f.env, d.env, -1, 1), vel: num(f.vel, d.vel, 0, 1), level: num(f.level, d.level, 0, 1),
    morph: num(f.morph, d.morph, 0, 1),
  };
}
function normEnv(e: any, d: RuneEnv): RuneEnv {
  e = e && typeof e === 'object' ? e : {};
  return { a: num(e.a, d.a, 0.0005, 20), d: num(e.d, d.d, 0.001, 20), s: num(e.s, d.s, 0, 1), r: num(e.r, d.r, 0.001, 20), loop: bool(e.loop, d.loop) };
}
function normLfo(l: any, d: RuneLfo): RuneLfo {
  l = l && typeof l === 'object' ? l : {};
  return { shape: pick(l.shape, LFO_SHAPES, d.shape), rate: num(l.rate, d.rate, 0.01, 50), sync: bool(l.sync, d.sync), div: int(l.div, d.div, 0, LFO_DIVS.length - 1), retrig: bool(l.retrig, d.retrig), fade: num(l.fade, d.fade, 0, 10) };
}
function normMod(m: any): RuneMod {
  m = m && typeof m === 'object' ? m : {};
  return {
    src: SRC_INDEX[m.src] !== undefined ? m.src : 'none',
    dst: DST_INDEX[m.dst] !== undefined ? m.dst : 'none',
    amt: num(m.amt, 0, -1, 1),
    via: SRC_INDEX[m.via] !== undefined ? m.via : 'none',
  };
}
const arr16 = (a: any, d: number, lo: number, hi: number) => Array.from({ length: 16 }, (_, i) => num(Array.isArray(a) ? a[i] : undefined, d, lo, hi));

/** Returns a complete, clamped copy of any (possibly partial / older) Rune patch. */
export function normalize(s: any): RuneState {
  const d = defaultState();
  s = s && typeof s === 'object' ? s : {};
  const osc = [0, 1, 2].map((i) => normOsc(s.osc?.[i], d.osc[i]));
  const flt = [0, 1].map((i) => normFilter(s.flt?.[i], d.flt[i]));
  const a = s.amp ?? {};
  const arp = s.arp ?? {};
  const vo = s.voice ?? {};
  const fx = s.fx ?? {};
  const fxo = (k: keyof RuneFx) => (fx[k] && typeof fx[k] === 'object' ? fx[k] : {});
  const ch = fxo('chorus'), ph = fxo('phaser'), fl = fxo('flanger'), dl = fxo('delay'), rv = fxo('reverb');
  return {
    v: 1,
    osc,
    flt,
    serial: bool(s.serial, d.serial),
    amp: { gain: num(a.gain, 0, -24, 12), pan: num(a.pan, 0, -1, 1), vel: num(a.vel, d.amp.vel, 0, 1), dist: pick(a.dist, DIST_TYPES, 'off'), drive: num(a.drive, d.amp.drive, 0, 1), mix: num(a.mix, 1, 0, 1) },
    env: [0, 1, 2].map((i) => normEnv(s.env?.[i], d.env[i])),
    lfo: [0, 1, 2, 3].map((i) => normLfo(s.lfo?.[i], d.lfo[i])),
    mod: Array.from({ length: MOD_SLOTS }, (_, i) => normMod(s.mod?.[i])),
    arp: {
      on: bool(arp.on, false), mode: pick(arp.mode, ARP_MODES, 'up'), oct: int(arp.oct, 1, 1, 4), rate: int(arp.rate, d.arp.rate, 0, ARP_RATES.length - 1),
      gate: num(arp.gate, d.arp.gate, 0.05, 1), swing: num(arp.swing, 0, 0, 1), latch: bool(arp.latch, false), len: int(arp.len, 16, 1, 16),
      steps: arr16(arp.steps, 1, 0, 1).map((x) => (x >= 0.5 ? 1 : 0)), vals: arr16(arp.vals, 0.5, 0, 1),
    },
    voice: {
      mode: pick(vo.mode, VOICE_MODES, 'poly'), voices: int(vo.voices, d.voice.voices, 1, 24), glide: num(vo.glide, 0, 0, 5),
      unison: int(vo.unison, 1, 1, 4), detune: num(vo.detune, d.voice.detune, 0, 1), spread: num(vo.spread, d.voice.spread, 0, 1), drift: num(vo.drift, d.voice.drift, 0, 1),
    },
    fx: {
      chorus: { on: bool(ch.on, false), mix: num(ch.mix, d.fx.chorus.mix, 0, 1), rate: num(ch.rate, d.fx.chorus.rate, 0.05, 5), depth: num(ch.depth, d.fx.chorus.depth, 0, 1) },
      phaser: { on: bool(ph.on, false), mix: num(ph.mix, d.fx.phaser.mix, 0, 1), rate: num(ph.rate, d.fx.phaser.rate, 0.02, 5), depth: num(ph.depth, d.fx.phaser.depth, 0, 1), fb: num(ph.fb, d.fx.phaser.fb, 0, 0.95) },
      flanger: { on: bool(fl.on, false), mix: num(fl.mix, d.fx.flanger.mix, 0, 1), rate: num(fl.rate, d.fx.flanger.rate, 0.02, 5), depth: num(fl.depth, d.fx.flanger.depth, 0, 1), fb: num(fl.fb, d.fx.flanger.fb, -0.95, 0.95) },
      delay: { on: bool(dl.on, false), mix: num(dl.mix, d.fx.delay.mix, 0, 1), div: int(dl.div, d.fx.delay.div, 0, DELAY_DIVS.length - 1), fb: num(dl.fb, d.fx.delay.fb, 0, 0.95), tone: num(dl.tone, d.fx.delay.tone, 0, 1), pingpong: bool(dl.pingpong, true) },
      reverb: { on: bool(rv.on, false), mix: num(rv.mix, d.fx.reverb.mix, 0, 1), size: num(rv.size, d.fx.reverb.size, 0, 1), damp: num(rv.damp, d.fx.reverb.damp, 0, 1), pre: num(rv.pre, d.fx.reverb.pre, 0, 0.2) },
    },
    macros: [0, 1, 2, 3].map((i) => num(Array.isArray(s.macros) ? s.macros[i] : undefined, 0, 0, 1)),
    master: num(s.master, 0, -24, 6),
  };
}

/** In-place repair of a raw state object (used by UI edits so paths always exist). */
export function repair(s: any): RuneState {
  const n = normalize(s);
  for (const k of Object.keys(n) as (keyof RuneState)[]) {
    const cur = s[k];
    const want = (n as any)[k];
    if (cur === undefined || cur === null || typeof cur !== typeof want || Array.isArray(want) !== Array.isArray(cur)) s[k] = want;
    else if (Array.isArray(want)) {
      for (let i = 0; i < want.length; i++) {
        if (cur[i] === undefined || cur[i] === null || typeof cur[i] !== 'object') cur[i] = want[i];
        else for (const kk of Object.keys(want[i])) if (cur[i][kk] === undefined) cur[i][kk] = want[i][kk];
      }
    } else if (typeof want === 'object') {
      for (const kk of Object.keys(want)) {
        if (cur[kk] === undefined) cur[kk] = want[kk];
        else if (typeof want[kk] === 'object' && want[kk] && !Array.isArray(want[kk])) for (const k3 of Object.keys(want[kk])) if (cur[kk][k3] === undefined) cur[kk][k3] = want[kk][k3];
      }
    }
  }
  s.v = 1;
  return s as RuneState;
}
