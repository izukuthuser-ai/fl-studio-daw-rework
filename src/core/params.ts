// Parameter definitions shared by UI knobs, effects and automation.
import { FxType } from './types';
import { fmtHz } from './util';

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
  curve?: 'lin' | 'log';
  step?: number; // for discrete params
  unit?: string;
  fmt?: (v: number) => string;
  options?: string[]; // discrete labelled values (index)
}

export function toNorm(d: ParamDef, v: number): number {
  if (d.curve === 'log') {
    const lo = Math.max(d.min, 1e-4);
    return Math.log(Math.max(v, lo) / lo) / Math.log(d.max / lo);
  }
  return (v - d.min) / (d.max - d.min);
}
export function fromNorm(d: ParamDef, n: number): number {
  n = Math.min(1, Math.max(0, n));
  let v: number;
  if (d.curve === 'log') {
    const lo = Math.max(d.min, 1e-4);
    v = lo * Math.pow(d.max / lo, n);
  } else v = d.min + (d.max - d.min) * n;
  if (d.step) v = Math.round(v / d.step) * d.step;
  return v;
}
export function fmtParam(d: ParamDef, v: number): string {
  if (d.options) return d.options[Math.round(v)] ?? String(v);
  if (d.fmt) return d.fmt(v);
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return v.toFixed(digits) + (d.unit ? ' ' + d.unit : '');
}

const pct = (v: number) => Math.round(v * 100) + '%';
const ms = (v: number) => (v >= 1 ? v.toFixed(2) + ' s' : Math.round(v * 1000) + ' ms');
const db = (v: number) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
const hz = (v: number) => fmtHz(v);

export const DELAY_DIVS = ['1/32', '1/16', '1/16 D', '1/8 T', '1/8', '1/8 D', '1/4 T', '1/4', '1/4 D', '1/2', '1 bar'];
export const DELAY_BEATS = [1 / 8, 1 / 4, 3 / 8, 1 / 3, 1 / 2, 3 / 4, 2 / 3, 1, 1.5, 2, 4];

export interface FxDef {
  type: FxType;
  name: string;
  desc: string;
  params: ParamDef[];
  defaultMix: number;
}

export const FX_DEFS: Record<FxType, FxDef> = {
  eq: {
    type: 'eq',
    name: 'Parametric EQ',
    desc: '4-band EQ with low & high cut',
    defaultMix: 1,
    params: [
      { key: 'lowCut', label: 'Low cut', min: 20, max: 1000, def: 20, curve: 'log', fmt: hz },
      { key: 'lowFreq', label: 'Low freq', min: 30, max: 500, def: 100, curve: 'log', fmt: hz },
      { key: 'lowGain', label: 'Low gain', min: -18, max: 18, def: 0, fmt: db },
      { key: 'midFreq', label: 'Mid freq', min: 150, max: 6000, def: 1000, curve: 'log', fmt: hz },
      { key: 'midGain', label: 'Mid gain', min: -18, max: 18, def: 0, fmt: db },
      { key: 'midQ', label: 'Mid Q', min: 0.2, max: 12, def: 1, curve: 'log' },
      { key: 'presFreq', label: 'Hi-mid freq', min: 800, max: 12000, def: 3500, curve: 'log', fmt: hz },
      { key: 'presGain', label: 'Hi-mid gain', min: -18, max: 18, def: 0, fmt: db },
      { key: 'highFreq', label: 'High freq', min: 2000, max: 16000, def: 8000, curve: 'log', fmt: hz },
      { key: 'highGain', label: 'High gain', min: -18, max: 18, def: 0, fmt: db },
      { key: 'highCut', label: 'High cut', min: 1000, max: 20000, def: 20000, curve: 'log', fmt: hz },
    ],
  },
  compressor: {
    type: 'compressor',
    name: 'Compressor',
    desc: 'Smooth dynamics compressor with makeup gain',
    defaultMix: 1,
    params: [
      { key: 'threshold', label: 'Threshold', min: -60, max: 0, def: -18, fmt: db },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, fmt: (v) => v.toFixed(1) + ':1' },
      { key: 'attack', label: 'Attack', min: 0.0005, max: 0.5, def: 0.01, curve: 'log', fmt: ms },
      { key: 'release', label: 'Release', min: 0.01, max: 1.5, def: 0.15, curve: 'log', fmt: ms },
      { key: 'knee', label: 'Knee', min: 0, max: 40, def: 6, fmt: db },
      { key: 'makeup', label: 'Makeup', min: -12, max: 24, def: 0, fmt: db },
    ],
  },
  limiter: {
    type: 'limiter',
    name: 'Limiter',
    desc: 'Brickwall-style peak limiter',
    defaultMix: 1,
    params: [
      { key: 'gain', label: 'Input gain', min: -12, max: 18, def: 0, fmt: db },
      { key: 'threshold', label: 'Threshold', min: -24, max: 0, def: -1, fmt: db },
      { key: 'release', label: 'Release', min: 0.01, max: 1, def: 0.1, curve: 'log', fmt: ms },
      { key: 'ceiling', label: 'Ceiling', min: -12, max: 0, def: -0.3, fmt: db },
    ],
  },
  reverb: {
    type: 'reverb',
    name: 'Reverb',
    desc: 'Algorithmic hall/room reverb',
    defaultMix: 0.25,
    params: [
      { key: 'decay', label: 'Decay', min: 0.2, max: 12, def: 2.2, curve: 'log', fmt: ms },
      { key: 'predelay', label: 'Pre-delay', min: 0, max: 0.2, def: 0.02, fmt: ms },
      { key: 'damp', label: 'Damping', min: 1000, max: 20000, def: 7000, curve: 'log', fmt: hz },
      { key: 'lowcut', label: 'Low cut', min: 20, max: 1000, def: 150, curve: 'log', fmt: hz },
      { key: 'size', label: 'Size', min: 0, max: 1, def: 0.6, fmt: pct },
    ],
  },
  delay: {
    type: 'delay',
    name: 'Delay',
    desc: 'Tempo-synced stereo / ping-pong delay',
    defaultMix: 0.25,
    params: [
      { key: 'time', label: 'Time', min: 0, max: DELAY_DIVS.length - 1, def: 5, step: 1, options: DELAY_DIVS },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, def: 0.4, fmt: pct },
      { key: 'pingpong', label: 'Ping-pong', min: 0, max: 1, def: 1, step: 1, options: ['Off', 'On'] },
      { key: 'damp', label: 'Damping', min: 500, max: 20000, def: 6000, curve: 'log', fmt: hz },
      { key: 'lowcut', label: 'Low cut', min: 20, max: 2000, def: 200, curve: 'log', fmt: hz },
    ],
  },
  filter: {
    type: 'filter',
    name: 'Filter',
    desc: 'Resonant LP/HP/BP filter with LFO',
    defaultMix: 1,
    params: [
      { key: 'type', label: 'Type', min: 0, max: 2, def: 0, step: 1, options: ['Low pass', 'High pass', 'Band pass'] },
      { key: 'cutoff', label: 'Cutoff', min: 20, max: 20000, def: 2000, curve: 'log', fmt: hz },
      { key: 'reso', label: 'Resonance', min: 0.1, max: 20, def: 1, curve: 'log' },
      { key: 'lfoRate', label: 'LFO rate', min: 0.05, max: 20, def: 1, curve: 'log', unit: 'Hz' },
      { key: 'lfoDepth', label: 'LFO depth', min: 0, max: 1, def: 0, fmt: pct },
    ],
  },
  distortion: {
    type: 'distortion',
    name: 'Distortion',
    desc: 'Soft clip / hard clip / wavefold saturation',
    defaultMix: 1,
    params: [
      { key: 'mode', label: 'Mode', min: 0, max: 2, def: 0, step: 1, options: ['Soft', 'Hard', 'Fold'] },
      { key: 'drive', label: 'Drive', min: 0, max: 40, def: 12, fmt: db },
      { key: 'tone', label: 'Tone', min: 500, max: 20000, def: 9000, curve: 'log', fmt: hz },
      { key: 'output', label: 'Output', min: -24, max: 6, def: -6, fmt: db },
    ],
  },
  bitcrusher: {
    type: 'bitcrusher',
    name: 'Bitcrusher',
    desc: 'Bit-depth reduction with drive',
    defaultMix: 1,
    params: [
      { key: 'bits', label: 'Bits', min: 1, max: 16, def: 6, step: 1, unit: 'bit' },
      { key: 'drive', label: 'Drive', min: 0, max: 24, def: 0, fmt: db },
      { key: 'tone', label: 'Tone', min: 500, max: 20000, def: 20000, curve: 'log', fmt: hz },
    ],
  },
  chorus: {
    type: 'chorus',
    name: 'Chorus',
    desc: 'Stereo chorus',
    defaultMix: 0.5,
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 8, def: 0.8, curve: 'log', unit: 'Hz' },
      { key: 'depth', label: 'Depth', min: 0, max: 1, def: 0.5, fmt: pct },
      { key: 'delay', label: 'Delay', min: 0.002, max: 0.04, def: 0.015, fmt: ms },
    ],
  },
  width: {
    type: 'width',
    name: 'Stereo Width',
    desc: 'Mid/side stereo width control',
    defaultMix: 1,
    params: [
      { key: 'width', label: 'Width', min: 0, max: 2, def: 1.3, fmt: pct },
      { key: 'monoBass', label: 'Mono bass', min: 0, max: 1, def: 0, step: 1, options: ['Off', 'On'] },
    ],
  },
};

export const FX_ORDER: FxType[] = ['eq', 'compressor', 'limiter', 'reverb', 'delay', 'filter', 'distortion', 'bitcrusher', 'chorus', 'width'];

export function fxDefaults(type: FxType): Record<string, number> {
  const o: Record<string, number> = {};
  for (const p of FX_DEFS[type].params) o[p.key] = p.def;
  return o;
}

// Automatable channel / mixer params
export const CHANNEL_PARAMS: Record<string, ParamDef> = {
  vol: { key: 'vol', label: 'Volume', min: 0, max: 1.25, def: 0.8, fmt: pct },
  pan: { key: 'pan', label: 'Panning', min: -1, max: 1, def: 0, fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : Math.round(Math.abs(v) * 100) + (v < 0 ? 'L' : 'R')) },
  pitch: { key: 'pitch', label: 'Pitch', min: -24, max: 24, def: 0, unit: 'st' },
  cutoff: { key: 'cutoff', label: 'Filter cutoff', min: 40, max: 20000, def: 20000, curve: 'log', fmt: hz },
};
export const MIXER_PARAMS: Record<string, ParamDef> = {
  volDb: { key: 'volDb', label: 'Volume', min: -60, max: 5.6, def: 0, fmt: (v) => (v <= -60 ? '-inf dB' : db(v)) },
  pan: { key: 'pan', label: 'Panning', min: -1, max: 1, def: 0, fmt: CHANNEL_PARAMS.pan.fmt },
  width: { key: 'width', label: 'Stereo width', min: 0, max: 2, def: 1, fmt: pct },
};
export const FX_MIX_PARAM: ParamDef = { key: 'mix', label: 'Mix', min: 0, max: 1, def: 1, fmt: pct };

export const ENV_PARAMS = {
  a: { key: 'a', label: 'Attack', min: 0.001, max: 5, def: 0.002, curve: 'log', fmt: ms } as ParamDef,
  d: { key: 'd', label: 'Decay', min: 0.005, max: 5, def: 0.3, curve: 'log', fmt: ms } as ParamDef,
  s: { key: 's', label: 'Sustain', min: 0, max: 1, def: 0.7, fmt: pct } as ParamDef,
  r: { key: 'r', label: 'Release', min: 0.005, max: 8, def: 0.2, curve: 'log', fmt: ms } as ParamDef,
};
