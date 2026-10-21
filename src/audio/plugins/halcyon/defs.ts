// Halcyon — shared definitions: patch state (v1), defaults, parameter ranges and the modulation
// source / destination tables. Imported by the AudioWorklet processor AND the main-thread UI, so it
// must stay DOM-free and allocation-light.

export const N_OSC = 3;
export const N_FILT = 2;
export const N_ENV = 3;
export const N_LFO = 4;
export const N_MACRO = 4;
export const MAX_MOD = 16;
export const MAX_UNI = 16;
export const MAX_POLY = 32;
export const LFO_MAX_PTS = 16;

export const WT_NAMES = [
  'Basic Shapes',
  'PWM',
  'Harmonic Sweep',
  'Formant Vowels',
  'Supersaw Stack',
  'Digital Growl',
  'Glass Bells',
  'Hollow Pulse',
  'Noise to Tone',
  'Spectral Ramp',
  'Sync Sweep',
  'Drawbar Organ',
];

export const WARP_MODES = ['None', 'Bend +', 'Bend −', 'Squeeze', 'Sync', 'Mirror', 'Quantize', 'FM ←', 'RM ←'];
export const W_NONE = 0, W_BENDP = 1, W_BENDM = 2, W_SQUEEZE = 3, W_SYNC = 4, W_MIRROR = 5, W_QUANT = 6, W_FM = 7, W_RM = 8;

export const FILTER_TYPES = ['LP 12', 'LP 24', 'HP 12', 'HP 24', 'BP 12', 'BP 24', 'Notch 12', 'Notch 24', 'Ladder 24', 'Comb', 'Formant'];
export const FT_LP12 = 0, FT_LP24 = 1, FT_HP12 = 2, FT_HP24 = 3, FT_BP12 = 4, FT_BP24 = 5, FT_N12 = 6, FT_N24 = 7, FT_LADDER = 8, FT_COMB = 9, FT_FORMANT = 10;

export const ROUTES = ['Filter 1', 'Filter 2', 'Both filters', 'Direct (no filter)'];
export const ROUTES_SHORT = ['F1', 'F2', 'F1+2', 'DRY'];
export const SUB_SHAPES = ['Sine', 'Triangle', 'Square'];
export const NOISE_TYPES = ['White', 'Pink'];
export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw Up', 'Saw Down', 'Square', 'S&H', 'Smooth Rand', 'Custom'];
export const LFO_SH = 5, LFO_SMOOTH = 6, LFO_CUSTOM = 7;
export const LFO_MODES = ['Retrig', 'Free', 'Once'];
export const VOICE_MODES = ['Poly', 'Mono', 'Legato'];
export const GLIDE_MODES = ['Always', 'Legato only'];
export const DIST_TYPES = ['Soft', 'Hard', 'Fold'];

/** Tempo-synced LFO divisions: [label, length in beats]. */
export const SYNC_DIVS: [string, number][] = [
  ['8 bars', 32], ['4 bars', 16], ['2 bars', 8], ['1 bar', 4], ['1/2 D', 3], ['1/2', 2], ['1/2 T', 4 / 3], ['1/4 D', 1.5], ['1/4', 1],
  ['1/4 T', 2 / 3], ['1/8 D', 0.75], ['1/8', 0.5], ['1/8 T', 1 / 3], ['1/16 D', 0.375], ['1/16', 0.25], ['1/16 T', 1 / 6], ['1/32', 0.125],
];
/** Delay divisions: [label, beats]. */
export const DELAY_DIVS: [string, number][] = [
  ['1/32', 0.125], ['1/16 T', 1 / 6], ['1/16', 0.25], ['1/16 D', 0.375], ['1/8 T', 1 / 3], ['1/8', 0.5], ['1/8 D', 0.75], ['1/4 T', 2 / 3], ['1/4', 1], ['1/4 D', 1.5], ['1/2', 2], ['1 bar', 4],
];

// ---------------- parameter mappings (shared by DSP and UI) ----------------
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const CUT_MIN = 20;
export const CUT_MAX = 20000;
export const CUT_OCT = Math.log2(CUT_MAX / CUT_MIN);
export const cutToNorm = (hz: number) => clamp01(Math.log2(Math.max(CUT_MIN, hz) / CUT_MIN) / CUT_OCT);
export const normToCut = (n: number) => CUT_MIN * Math.pow(2, clamp01(n) * CUT_OCT);
/** Envelope times (seconds), log-mapped for modulation. */
export const T_MIN = 0.0005;
export const T_MAX = 20;
export const T_LN = Math.log(T_MAX / T_MIN);
export const timeToNorm = (t: number) => clamp01(Math.log(Math.max(T_MIN, t) / T_MIN) / T_LN);
export const normToTime = (n: number) => T_MIN * Math.exp(clamp01(n) * T_LN);
export const LFO_HZ_MIN = 0.02;
export const LFO_HZ_MAX = 40;
/** A pitch modulation amount of 1.0 = ±48 semitones (0.25 = one octave). */
export const PITCH_MOD_RANGE = 48;

/** SVF damping (k = 1/Q) from resonance 0..1, 12 dB types. */
export const svfK = (r: number) => 2 * (1 - 0.97 * Math.pow(clamp01(r), 0.85)); // Q ≤ ~17 (+24 dB peak)
/** 24 dB types: two cascaded stages — Butterworth-ish at r=0, resonance on the 2nd stage. */
export const svfK24a = (r: number) => 1.848 - 0.6 * clamp01(r);
export const svfK24b = (r: number) => 0.765 * (1 - 0.92 * Math.pow(clamp01(r), 0.85));
export const ladderK = (r: number) => 3.95 * Math.pow(clamp01(r), 0.9);
export const combFb = (r: number) => 0.985 * Math.pow(clamp01(r), 0.6);
export const formantQ = (r: number) => 3 + 17 * clamp01(r);
/** Formant filter: cutoff norm 0.5 = no shift, ±1.5 octaves. */
export const formantShift = (cutNorm: number) => Math.pow(2, (clamp01(cutNorm) - 0.5) * 3);
/** Vowel formants a-e-i-o-u: [F1, F2, F3, g1, g2, g3] (typical adult values). */
export const VOWELS: number[][] = [
  [730, 1090, 2440, 1, 0.5, 0.28],
  [530, 1840, 2480, 1, 0.42, 0.3],
  [290, 2250, 3000, 1, 0.26, 0.24],
  [570, 840, 2410, 1, 0.62, 0.2],
  [320, 870, 2240, 1, 0.38, 0.14],
];
/** Interpolated formant set for a vowel morph 0..1 → out[0..5]. */
export function formantSet(morph: number, out: Float64Array | number[]) {
  const x = clamp01(morph) * (VOWELS.length - 1);
  const i = Math.min(VOWELS.length - 2, Math.floor(x));
  const t = x - i;
  const a = VOWELS[i], b = VOWELS[i + 1];
  for (let k = 0; k < 6; k++) out[k] = a[k] + (b[k] - a[k]) * t;
}

/** Bipolar value (−1..1) of a basic LFO shape at phase 0..1 (shapes 0..4). */
export function lfoBasic(shape: number, ph: number): number {
  switch (shape) {
    case 0:
      return Math.sin(ph * 2 * Math.PI);
    case 1: {
      let p = ph + 0.25;
      p -= Math.floor(p);
      return 1 - 4 * Math.abs(p - 0.5);
    }
    case 2:
      return 2 * ph - 1;
    case 3:
      return 1 - 2 * ph;
    case 4:
      return ph < 0.5 ? 1 : -1;
  }
  return 0;
}

/** Envelope segment curve: x 0..1 → 0..1; c in −1..1 (0 = linear, >0 fast-then-slow). */
export function envCurve(x: number, c: number): number {
  if (c > -0.01 && c < 0.01) return x;
  const k = c * 6;
  return (1 - Math.exp(-k * x)) / (1 - Math.exp(-k));
}

// ---------------- modulation ----------------
export interface SrcDef {
  id: string;
  label: string;
  bipolar: boolean;
}
export const SOURCES: SrcDef[] = [
  { id: 'env1', label: 'Env 1 (Amp)', bipolar: false },
  { id: 'env2', label: 'Env 2', bipolar: false },
  { id: 'env3', label: 'Env 3', bipolar: false },
  { id: 'lfo1', label: 'LFO 1', bipolar: true },
  { id: 'lfo2', label: 'LFO 2', bipolar: true },
  { id: 'lfo3', label: 'LFO 3', bipolar: true },
  { id: 'lfo4', label: 'LFO 4', bipolar: true },
  { id: 'vel', label: 'Velocity', bipolar: false },
  { id: 'note', label: 'Note (key track)', bipolar: true },
  { id: 'mw', label: 'Mod wheel', bipolar: false },
  { id: 'rand', label: 'Random / note', bipolar: true },
  { id: 'm1', label: 'Macro 1', bipolar: false },
  { id: 'm2', label: 'Macro 2', bipolar: false },
  { id: 'm3', label: 'Macro 3', bipolar: false },
  { id: 'm4', label: 'Macro 4', bipolar: false },
];
export const S_ENV = 0, S_LFO = 3, S_VEL = 7, S_NOTE = 8, S_MW = 9, S_RAND = 10, S_MACRO = 11;
export const N_SRC = SOURCES.length;

export interface DstDef {
  id: string;
  label: string;
  group: string;
}
export const DESTS: DstDef[] = [];
const OSC_D = ['pitch', 'level', 'frame', 'pan', 'detune', 'warp'];
const OSC_DL = ['Pitch', 'Level', 'Frame', 'Pan', 'Unison detune', 'Warp amount'];
for (let o = 0; o < N_OSC; o++) OSC_D.forEach((k, i) => DESTS.push({ id: `o${o + 1}.${k}`, label: `Osc ${o + 1} ${OSC_DL[i]}`, group: `Osc ${o + 1}` }));
DESTS.push({ id: 'sub.level', label: 'Sub level', group: 'Sub / Noise' }, { id: 'noise.level', label: 'Noise level', group: 'Sub / Noise' });
const F_D = ['cutoff', 'reso', 'drive', 'mix', 'morph'];
const F_DL = ['Cutoff', 'Resonance', 'Drive', 'Mix', 'Morph / Vowel'];
for (let f = 0; f < N_FILT; f++) F_D.forEach((k, i) => DESTS.push({ id: `f${f + 1}.${k}`, label: `Filter ${f + 1} ${F_DL[i]}`, group: `Filter ${f + 1}` }));
for (let l = 0; l < N_LFO; l++) DESTS.push({ id: `lfo${l + 1}.rate`, label: `LFO ${l + 1} Rate`, group: 'LFOs' });
for (let e = 0; e < N_ENV; e++)
  ['attack', 'decay', 'release'].forEach((k) => DESTS.push({ id: `env${e + 1}.${k}`, label: `Env ${e + 1} ${k[0].toUpperCase() + k.slice(1)}`, group: 'Envelopes' }));
DESTS.push(
  { id: 'fx.dist', label: 'Distortion mix', group: 'FX' },
  { id: 'fx.chorus', label: 'Chorus mix', group: 'FX' },
  { id: 'fx.delay', label: 'Delay mix', group: 'FX' },
  { id: 'fx.reverb', label: 'Reverb mix', group: 'FX' },
  { id: 'pitch', label: 'Global pitch', group: 'Master' },
  { id: 'master', label: 'Master level', group: 'Master' },
);
export const D_OSC = 0; // + o*6 + (0 pitch,1 level,2 frame,3 pan,4 detune,5 warp)
export const D_SUB = 18, D_NOISE = 19;
export const D_FILT = 20; // + f*5 + (0 cutoff,1 reso,2 drive,3 mix,4 morph)
export const D_LFO_RATE = 30;
export const D_ENV = 34; // + e*3 + (0 a,1 d,2 r)
export const D_FX = 43; // + (0 dist,1 chorus,2 delay,3 reverb)
export const D_PITCH = 47, D_MASTER = 48;
export const N_DST = DESTS.length;

export const srcIndex = (id: string) => SOURCES.findIndex((s) => s.id === id);
export const dstIndex = (id: string) => DESTS.findIndex((d) => d.id === id);

// ---------------- patch state ----------------
export interface OscS {
  on: boolean;
  wt: number;
  frame: number; // 0..1
  level: number; // 0..1
  pan: number; // −1..1
  semi: number; // −24..24
  fine: number; // cents −100..100
  uni: number; // 1..16
  detune: number; // 0..1
  spread: number; // 0..1
  blend: number; // 0..1 (side voice level)
  phase: number; // 0..1
  rand: number; // phase randomness 0..1
  warp: number; // WARP_MODES index
  warpAmt: number; // 0..1
  warpSrc: number; // osc index for FM / RM
  dest: number; // ROUTES index
}
export interface SubS { on: boolean; shape: number; oct: number; level: number; pan: number; dest: number }
export interface NoiseS { on: boolean; type: number; level: number; pan: number; dest: number }
export interface FiltS { on: boolean; type: number; cutoff: number; reso: number; drive: number; key: number; mix: number; morph: number }
export interface EnvS { a: number; h: number; d: number; s: number; r: number; ac: number; dc: number; rc: number }
export interface LfoS { shape: number; sync: boolean; rate: number; div: number; mode: number; phase: number; delay: number; fade: number; pts: number[][] }
export interface ModS { src: string; dst: string; amt: number }
export interface VoiceS { mode: number; poly: number; glide: number; glideMode: number; vel: number; vol: number }
export interface FxS {
  dist: { on: boolean; type: number; drive: number; tone: number; mix: number };
  chorus: { on: boolean; rate: number; depth: number; fb: number; mix: number };
  delay: { on: boolean; div: number; fb: number; tone: number; ping: boolean; mix: number };
  reverb: { on: boolean; size: number; damp: number; width: number; mix: number };
}
export interface HState {
  v: 1;
  osc: OscS[];
  sub: SubS;
  noise: NoiseS;
  filt: FiltS[];
  filtMode: number; // 0 serial, 1 parallel
  env: EnvS[];
  lfo: LfoS[];
  mod: ModS[];
  voice: VoiceS;
  fx: FxS;
  macros: number[];
}

export const defaultOsc = (i: number): OscS => ({
  on: i === 0,
  wt: 0,
  frame: i === 0 ? 2 / 3 : 0,
  level: 0.75,
  pan: 0,
  semi: 0,
  fine: 0,
  uni: 1,
  detune: 0.3,
  spread: 0.7,
  blend: 0.8,
  phase: 0,
  rand: 1,
  warp: 0,
  warpAmt: 0.5,
  warpSrc: (i + 1) % N_OSC,
  dest: 0,
});
export const defaultEnv = (i: number): EnvS =>
  i === 0 ? { a: 0.003, h: 0, d: 0.6, s: 0.8, r: 0.22, ac: 0.25, dc: 0.6, rc: 0.6 } : { a: 0.003, h: 0, d: 0.45, s: 0, r: 0.3, ac: 0.25, dc: 0.6, rc: 0.6 };
export const defaultLfo = (i: number): LfoS => ({
  shape: 0,
  sync: true,
  rate: 2,
  div: [8, 11, 5, 3][i] ?? 8,
  mode: 0,
  phase: 0,
  delay: 0,
  fade: 0,
  pts: [
    [0, 0.5],
    [0.25, 1],
    [0.5, 0.5],
    [0.75, 0],
    [1, 0.5],
  ],
});
export const defaultFilt = (i: number): FiltS =>
  i === 0 ? { on: true, type: FT_LP24, cutoff: 20000, reso: 0.1, drive: 0, key: 0, mix: 1, morph: 0 } : { on: false, type: FT_HP12, cutoff: 60, reso: 0.1, drive: 0, key: 0, mix: 1, morph: 0 };

export function defaultState(): HState {
  return {
    v: 1,
    osc: [0, 1, 2].map(defaultOsc),
    sub: { on: false, shape: 0, oct: -1, level: 0.5, pan: 0, dest: 0 },
    noise: { on: false, type: 0, level: 0.25, pan: 0, dest: 0 },
    filt: [0, 1].map(defaultFilt),
    filtMode: 0,
    env: [0, 1, 2].map(defaultEnv),
    lfo: [0, 1, 2, 3].map(defaultLfo),
    mod: [],
    voice: { mode: 0, poly: 16, glide: 0, glideMode: 0, vel: 0.6, vol: 0.7 },
    fx: {
      dist: { on: false, type: 0, drive: 0.35, tone: 0.75, mix: 1 },
      chorus: { on: false, rate: 0.6, depth: 0.5, fb: 0.15, mix: 0.5 },
      delay: { on: false, div: 6, fb: 0.35, tone: 0.6, ping: true, mix: 0.22 },
      reverb: { on: false, size: 0.6, damp: 0.45, width: 1, mix: 0.25 },
    },
    macros: [0, 0, 0, 0],
  };
}

const isObj = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
function fill(t: any, d: any) {
  for (const k of Object.keys(d)) {
    const dv = d[k];
    const tv = t[k];
    if (Array.isArray(dv)) {
      if (!Array.isArray(tv)) t[k] = JSON.parse(JSON.stringify(dv));
    } else if (isObj(dv)) {
      if (!isObj(tv)) t[k] = JSON.parse(JSON.stringify(dv));
      else fill(tv, dv);
    } else if (typeof tv !== typeof dv || (typeof tv === 'number' && !isFinite(tv))) t[k] = dv;
  }
}
function fixArr(s: any, key: string, n: number, mk: (i: number) => any) {
  if (!Array.isArray(s[key])) s[key] = [];
  const a = s[key] as any[];
  for (let i = 0; i < n; i++) {
    if (!isObj(a[i])) a[i] = mk(i);
    else fill(a[i], mk(i));
  }
  a.length = n;
}

/** Fill every missing / invalid field of a (possibly older or partial) state in place and return it. */
export function ensureState(s: any): HState {
  if (!isObj(s)) s = {};
  const d = defaultState();
  fixArr(s, 'osc', N_OSC, defaultOsc);
  fixArr(s, 'filt', N_FILT, defaultFilt);
  fixArr(s, 'env', N_ENV, defaultEnv);
  fixArr(s, 'lfo', N_LFO, defaultLfo);
  for (const k of ['sub', 'noise', 'voice', 'fx'] as const) {
    if (!isObj(s[k])) s[k] = (d as any)[k];
    else fill(s[k], (d as any)[k]);
  }
  if (typeof s.filtMode !== 'number') s.filtMode = 0;
  if (!Array.isArray(s.mod)) s.mod = [];
  s.mod = s.mod.filter((m: any) => isObj(m) && typeof m.src === 'string' && typeof m.dst === 'string' && typeof m.amt === 'number' && isFinite(m.amt)).slice(0, MAX_MOD);
  if (!Array.isArray(s.macros)) s.macros = [0, 0, 0, 0];
  for (let i = 0; i < N_MACRO; i++) if (typeof s.macros[i] !== 'number' || !isFinite(s.macros[i])) s.macros[i] = 0;
  s.macros.length = N_MACRO;
  for (const l of s.lfo as LfoS[]) {
    let pts = Array.isArray(l.pts) ? l.pts.filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) : [];
    if (pts.length < 2) pts = defaultLfo(0).pts;
    pts = pts.slice(0, LFO_MAX_PTS).map((p) => [clamp01(p[0]), clamp01(p[1])]).sort((a, b) => a[0] - b[0]);
    pts[0][0] = 0;
    pts[pts.length - 1][0] = 1;
    l.pts = pts;
  }
  s.v = 1;
  return s as HState;
}

/** Fill a 256-entry lookup table (bipolar) for a custom LFO shape. */
export function customTable(pts: number[][], out: Float32Array) {
  const n = out.length;
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    while (seg < pts.length - 2 && x > pts[seg + 1][0]) seg++;
    const a = pts[seg], b = pts[seg + 1] ?? a;
    const w = b[0] - a[0];
    const t = w > 1e-6 ? clamp01((x - a[0]) / w) : 1;
    out[i] = (a[1] + (b[1] - a[1]) * t) * 2 - 1;
  }
}
