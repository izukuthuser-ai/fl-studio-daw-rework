// Halcyon factory presets (all original). Each preset starts from the init patch and changes what it needs.
// Wavetables: 0 Basic Shapes (0 sine, ⅓ tri, ⅔ saw, 1 square) · 1 PWM · 2 Harmonic Sweep · 3 Formant Vowels
// 4 Supersaw Stack · 5 Digital Growl · 6 Glass Bells · 7 Hollow Pulse · 8 Noise to Tone · 9 Spectral Ramp
// 10 Sync Sweep · 11 Drawbar Organ.
import { defaultState, EnvS, FiltS, HState, LfoS, OscS } from './defs';

export interface HPreset {
  name: string;
  category: string;
  state: HState;
}

type Edit = (s: HState) => void;
const SAW = 2 / 3;
const TRI = 1 / 3;

function P(name: string, category: string, f: Edit): HPreset {
  const s = defaultState();
  f(s);
  return { name, category, state: s };
}
const osc = (s: HState, i: number, o: Partial<OscS>) => Object.assign(s.osc[i], { on: true }, o);
const env = (s: HState, i: number, e: Partial<EnvS>) => Object.assign(s.env[i], e);
const filt = (s: HState, i: number, f: Partial<FiltS>) => Object.assign(s.filt[i], { on: true }, f);
const lfo = (s: HState, i: number, l: Partial<LfoS>) => Object.assign(s.lfo[i], l);
const mod = (s: HState, src: string, dst: string, amt: number) => s.mod.push({ src, dst, amt });
const vol = (s: HState, v: number) => (s.voice.vol = v);
const mono = (s: HState, legato: boolean, glide: number) => Object.assign(s.voice, { mode: legato ? 2 : 1, glide, glideMode: legato ? 1 : 0 });
/** Common macro layout: M1 brightness, M2 timbre, M3 space. */
const macros = (s: HState, timbre = 'o1.frame') => {
  mod(s, 'm1', 'f1.cutoff', 0.35);
  mod(s, 'm2', timbre, 0.5);
  mod(s, 'm3', 'fx.reverb', 0.6);
};

let cache: HPreset[] | null = null;
export function factoryPresets(): HPreset[] {
  if (cache) return cache;
  cache = [
    P('Init', 'Init', () => {}),

    // ---------------- Bass ----------------
    P('Neon Sub', 'Bass', (s) => {
      osc(s, 0, { frame: 0.12, level: 0.7 });
      s.sub = { on: true, shape: 0, oct: -1, level: 0.65, pan: 0, dest: 3 };
      filt(s, 0, { type: 1, cutoff: 900, reso: 0.12, key: 0.3 });
      env(s, 0, { a: 0.002, d: 0.5, s: 0.9, r: 0.12 });
      env(s, 1, { a: 0.001, d: 0.18, s: 0.1, r: 0.1 });
      mod(s, 'env2', 'f1.cutoff', 0.25);
      Object.assign(s.fx.dist, { on: true, type: 0, drive: 0.25, tone: 0.5, mix: 0.4 });
      mono(s, true, 0.04);
      macros(s);
      vol(s, 0.62);
    }),
    P('Growl Bass', 'Bass', (s) => {
      osc(s, 0, { wt: 5, frame: 0.3, level: 0.75 });
      osc(s, 1, { wt: 0, frame: SAW, semi: -12, level: 0.45, uni: 2, detune: 0.2 });
      s.sub = { on: true, shape: 0, oct: -1, level: 0.45, pan: 0, dest: 3 };
      filt(s, 0, { type: 8, cutoff: 1600, reso: 0.35, drive: 0.4, key: 0.2 });
      lfo(s, 0, { shape: 1, sync: true, div: 11 });
      mod(s, 'lfo1', 'o1.frame', 0.35);
      mod(s, 'lfo1', 'f1.cutoff', 0.18);
      env(s, 0, { a: 0.003, d: 0.3, s: 0.85, r: 0.1 });
      Object.assign(s.fx.dist, { on: true, type: 0, drive: 0.45, tone: 0.6, mix: 0.6 });
      mono(s, true, 0.03);
      mod(s, 'm1', 'f1.cutoff', 0.35);
      mod(s, 'm2', 'lfo1.rate', 0.17);
      mod(s, 'm3', 'fx.dist', 0.4);
      vol(s, 0.66);
    }),
    P('Reese Drift', 'Bass', (s) => {
      osc(s, 0, { frame: SAW, uni: 5, detune: 0.33, spread: 0.45, level: 0.7 });
      osc(s, 1, { frame: SAW, fine: 9, uni: 3, detune: 0.25, spread: 0.3, level: 0.55 });
      filt(s, 0, { type: 1, cutoff: 1100, reso: 0.15 });
      lfo(s, 1, { shape: 0, sync: true, div: 2 });
      mod(s, 'lfo2', 'f1.cutoff', 0.12);
      mod(s, 'lfo2', 'o2.detune', 0.2);
      env(s, 0, { a: 0.004, d: 0.5, s: 0.9, r: 0.18 });
      Object.assign(s.fx.dist, { on: true, type: 0, drive: 0.3, tone: 0.55, mix: 0.45 });
      mono(s, true, 0.05);
      macros(s, 'o1.detune');
      vol(s, 0.62);
    }),
    P('Rubber Bass', 'Bass', (s) => {
      osc(s, 0, { frame: 0.5, level: 0.8 });
      s.sub = { on: true, shape: 2, oct: -1, level: 0.3, pan: 0, dest: 0 };
      filt(s, 0, { type: 1, cutoff: 160, reso: 0.45, key: 0.4 });
      env(s, 0, { a: 0.001, d: 0.45, s: 0.6, r: 0.08 });
      env(s, 1, { a: 0.001, d: 0.22, s: 0, r: 0.1, dc: 0.7 });
      mod(s, 'env2', 'f1.cutoff', 0.42);
      mod(s, 'env2', 'o1.frame', 0.15);
      mod(s, 'vel', 'f1.cutoff', 0.12);
      mono(s, false, 0);
      macros(s);
      vol(s, 0.66);
    }),
    P('Wobble Unit', 'Bass', (s) => {
      osc(s, 0, { wt: 7, frame: 0.4, level: 0.75 });
      osc(s, 1, { wt: 4, frame: 0.2, uni: 3, detune: 0.2, level: 0.5 });
      s.sub = { on: true, shape: 0, oct: -1, level: 0.5, pan: 0, dest: 3 };
      filt(s, 0, { type: 1, cutoff: 380, reso: 0.55 });
      lfo(s, 0, { shape: 0, sync: true, div: 11, mode: 0 });
      mod(s, 'lfo1', 'f1.cutoff', 0.42);
      mod(s, 'lfo1', 'o1.frame', 0.3);
      env(s, 0, { a: 0.003, d: 0.4, s: 0.9, r: 0.1 });
      Object.assign(s.fx.dist, { on: true, type: 2, drive: 0.22, tone: 0.65, mix: 0.35 });
      mono(s, true, 0.02);
      mod(s, 'm1', 'lfo1.rate', 0.17);
      mod(s, 'm2', 'f1.reso', 0.3);
      mod(s, 'm3', 'fx.dist', 0.5);
      vol(s, 0.58);
    }),
    P('FM Thump', 'Bass', (s) => {
      osc(s, 0, { frame: 0, level: 0.85, warp: 7, warpSrc: 1, warpAmt: 0.25 });
      osc(s, 1, { frame: 0, semi: 12, level: 0, dest: 3 });
      s.sub = { on: true, shape: 0, oct: -1, level: 0.4, pan: 0, dest: 3 };
      filt(s, 0, { type: 0, cutoff: 3500, reso: 0.05 });
      env(s, 0, { a: 0.001, d: 0.6, s: 0.5, r: 0.1 });
      env(s, 1, { a: 0.001, d: 0.12, s: 0.1, r: 0.1 });
      mod(s, 'env2', 'o1.warp', 0.45);
      mod(s, 'vel', 'o1.warp', 0.2);
      mono(s, false, 0);
      macros(s, 'o1.warp');
      vol(s, 0.7);
    }),

    // ---------------- Lead ----------------
    P('Saw Anthem', 'Lead', (s) => {
      osc(s, 0, { frame: SAW, uni: 7, detune: 0.36, spread: 0.85, level: 0.7 });
      osc(s, 1, { frame: SAW, semi: 12, uni: 5, detune: 0.3, spread: 0.7, level: 0.4 });
      filt(s, 0, { type: 1, cutoff: 5200, reso: 0.15, key: 0.3 });
      env(s, 0, { a: 0.005, d: 0.8, s: 0.85, r: 0.35 });
      env(s, 1, { a: 0.001, d: 0.5, s: 0.2, r: 0.3 });
      mod(s, 'env2', 'f1.cutoff', 0.15);
      Object.assign(s.fx.delay, { on: true, div: 6, fb: 0.32, mix: 0.18, ping: true });
      Object.assign(s.fx.reverb, { on: true, size: 0.65, mix: 0.18 });
      s.voice.poly = 8;
      macros(s, 'o1.detune');
      vol(s, 0.6);
    }),
    P('Vowel Lead', 'Lead', (s) => {
      osc(s, 0, { wt: 3, frame: 0, level: 0.8 });
      osc(s, 1, { frame: SAW, fine: 7, level: 0.25 });
      filt(s, 0, { type: 1, cutoff: 7000, reso: 0.1 });
      lfo(s, 0, { shape: 1, sync: true, div: 5 });
      lfo(s, 1, { shape: 0, sync: false, rate: 5.5, mode: 0, delay: 0.25, fade: 0.4 });
      mod(s, 'lfo1', 'o1.frame', 0.5);
      mod(s, 'lfo2', 'pitch', 0.004);
      env(s, 0, { a: 0.01, d: 0.6, s: 0.85, r: 0.25 });
      Object.assign(s.fx.delay, { on: true, div: 6, fb: 0.3, mix: 0.2 });
      Object.assign(s.fx.reverb, { on: true, size: 0.55, mix: 0.15 });
      mono(s, true, 0.07);
      macros(s);
      vol(s, 0.7);
    }),
    P('Sync Screamer', 'Lead', (s) => {
      osc(s, 0, { wt: 10, frame: 0.15, level: 0.75, uni: 2, detune: 0.12 });
      osc(s, 1, { frame: 1, semi: -12, level: 0.3 });
      filt(s, 0, { type: 1, cutoff: 9000, reso: 0.1 });
      env(s, 0, { a: 0.003, d: 0.5, s: 0.9, r: 0.2 });
      env(s, 1, { a: 0.001, d: 0.9, s: 0.25, r: 0.3, dc: 0.4 });
      mod(s, 'env2', 'o1.frame', 0.55);
      lfo(s, 1, { shape: 0, sync: false, rate: 6, delay: 0.3, fade: 0.3 });
      mod(s, 'lfo2', 'pitch', 0.003);
      Object.assign(s.fx.dist, { on: true, type: 0, drive: 0.35, tone: 0.7, mix: 0.45 });
      Object.assign(s.fx.delay, { on: true, div: 5, fb: 0.28, mix: 0.16 });
      mono(s, true, 0.05);
      macros(s);
      vol(s, 0.66);
    }),
    P('Chip Hero', 'Lead', (s) => {
      osc(s, 0, { wt: 1, frame: 0.3, level: 0.7, warp: 6, warpAmt: 0.55 });
      osc(s, 1, { frame: 1, semi: 12, level: 0.2 });
      s.filt[0].on = false;
      lfo(s, 0, { shape: 1, sync: true, div: 8 });
      mod(s, 'lfo1', 'o1.frame', 0.45);
      env(s, 0, { a: 0.001, d: 0.3, s: 0.75, r: 0.08 });
      Object.assign(s.fx.delay, { on: true, div: 2, fb: 0.25, mix: 0.15, ping: true });
      mono(s, false, 0);
      mod(s, 'm1', 'o1.warp', 0.4);
      mod(s, 'm2', 'o1.frame', 0.5);
      mod(s, 'm3', 'fx.delay', 0.5);
      vol(s, 0.74);
    }),
    P('Glide Mono', 'Lead', (s) => {
      osc(s, 0, { frame: SAW, level: 0.75 });
      osc(s, 1, { frame: 1, semi: -12, level: 0.45, fine: -5 });
      filt(s, 0, { type: 8, cutoff: 2200, reso: 0.4, drive: 0.3, key: 0.4 });
      env(s, 0, { a: 0.002, d: 0.7, s: 0.8, r: 0.15 });
      env(s, 1, { a: 0.001, d: 0.35, s: 0.3, r: 0.2 });
      mod(s, 'env2', 'f1.cutoff', 0.28);
      lfo(s, 1, { shape: 0, sync: false, rate: 5, delay: 0.35, fade: 0.5 });
      mod(s, 'lfo2', 'pitch', 0.004);
      Object.assign(s.fx.reverb, { on: true, size: 0.5, mix: 0.12 });
      Object.assign(s.voice, { mode: 2, glide: 0.12, glideMode: 0 });
      macros(s);
      vol(s, 0.72);
    }),

    // ---------------- Pad ----------------
    P('Aurora Pad', 'Pad', (s) => {
      osc(s, 0, { wt: 2, frame: 0.2, level: 0.6, uni: 3, detune: 0.15 });
      osc(s, 1, { wt: 6, frame: 0.4, uni: 4, detune: 0.2, level: 0.35 });
      osc(s, 2, { frame: SAW, uni: 6, detune: 0.3, level: 0.3 });
      filt(s, 0, { type: 1, cutoff: 3000, reso: 0.2 });
      lfo(s, 0, { shape: 1, sync: true, div: 1, mode: 1 });
      lfo(s, 1, { shape: 6, sync: true, div: 3, mode: 1 });
      mod(s, 'lfo1', 'o1.frame', 0.4);
      mod(s, 'lfo2', 'f1.cutoff', 0.08);
      env(s, 0, { a: 1.2, d: 2, s: 0.8, r: 2.5, ac: -0.2 });
      Object.assign(s.fx.chorus, { on: true, rate: 0.4, depth: 0.5, mix: 0.4 });
      Object.assign(s.fx.reverb, { on: true, size: 0.85, damp: 0.4, mix: 0.35 });
      macros(s);
      vol(s, 0.66);
    }),
    P('Glass Cathedral', 'Pad', (s) => {
      osc(s, 0, { wt: 6, frame: 0.6, uni: 3, detune: 0.14, level: 0.65 });
      osc(s, 1, { wt: 11, frame: 0.3, semi: 12, level: 0.25 });
      filt(s, 0, { type: 1, cutoff: 6500, reso: 0.1 });
      lfo(s, 0, { shape: 0, sync: true, div: 2, mode: 1 });
      mod(s, 'lfo1', 'o1.frame', 0.25);
      env(s, 0, { a: 0.8, d: 2.5, s: 0.7, r: 3 });
      Object.assign(s.fx.reverb, { on: true, size: 0.92, damp: 0.3, mix: 0.45 });
      Object.assign(s.fx.delay, { on: true, div: 9, fb: 0.35, mix: 0.12 });
      macros(s);
      vol(s, 0.6);
    }),
    P('Warm Strings', 'Pad', (s) => {
      osc(s, 0, { frame: SAW, uni: 8, detune: 0.28, spread: 0.9, level: 0.65 });
      osc(s, 1, { frame: SAW, uni: 6, detune: 0.22, semi: -12, level: 0.3 });
      filt(s, 0, { type: 0, cutoff: 2600, reso: 0.05, key: 0.3 });
      env(s, 0, { a: 0.45, d: 1, s: 0.9, r: 1.2 });
      lfo(s, 0, { shape: 0, sync: false, rate: 4.5, delay: 0.5, fade: 1 });
      mod(s, 'lfo1', 'pitch', 0.002);
      mod(s, 'vel', 'f1.cutoff', 0.12);
      Object.assign(s.fx.chorus, { on: true, rate: 0.35, depth: 0.45, mix: 0.4 });
      Object.assign(s.fx.reverb, { on: true, size: 0.7, mix: 0.25 });
      macros(s, 'o1.detune');
      vol(s, 0.64);
    }),
    P('Vowel Choir', 'Pad', (s) => {
      osc(s, 0, { wt: 3, frame: 0.5, uni: 5, detune: 0.15, spread: 0.8, level: 0.7 });
      osc(s, 1, { wt: 3, frame: 0.1, semi: 12, uni: 3, detune: 0.12, level: 0.25 });
      filt(s, 0, { type: 1, cutoff: 5000, reso: 0.1 });
      lfo(s, 0, { shape: 6, sync: true, div: 2, mode: 1 });
      mod(s, 'lfo1', 'o1.frame', 0.45);
      mod(s, 'lfo1', 'o2.frame', -0.3);
      env(s, 0, { a: 0.6, d: 1.5, s: 0.85, r: 1.5 });
      Object.assign(s.fx.chorus, { on: true, rate: 0.3, depth: 0.4, mix: 0.3 });
      Object.assign(s.fx.reverb, { on: true, size: 0.8, mix: 0.38 });
      macros(s);
      vol(s, 0.64);
    }),
    P('Noise Drift', 'Pad', (s) => {
      osc(s, 0, { wt: 8, frame: 0.15, uni: 3, detune: 0.1, level: 0.65 });
      osc(s, 1, { frame: 0, semi: -12, level: 0.35 });
      filt(s, 0, { type: 0, cutoff: 2400, reso: 0.25 });
      env(s, 0, { a: 1.5, d: 2, s: 0.85, r: 2.5 });
      env(s, 1, { a: 3, d: 1, s: 1, r: 2 });
      mod(s, 'env2', 'o1.frame', 0.75);
      lfo(s, 1, { shape: 0, sync: true, div: 3, mode: 1 });
      mod(s, 'lfo2', 'f1.cutoff', 0.15);
      Object.assign(s.fx.reverb, { on: true, size: 0.85, mix: 0.45 });
      Object.assign(s.fx.chorus, { on: true, rate: 0.25, depth: 0.6, mix: 0.3 });
      macros(s);
      vol(s, 0.52);
    }),

    // ---------------- Pluck ----------------
    P('Shimmer Pluck', 'Pluck', (s) => {
      osc(s, 0, { wt: 6, frame: 0.8, uni: 3, detune: 0.12, level: 0.7 });
      osc(s, 1, { frame: SAW, level: 0.35, uni: 2, detune: 0.15 });
      filt(s, 0, { type: 1, cutoff: 500, reso: 0.25, key: 0.4 });
      env(s, 0, { a: 0.001, d: 0.7, s: 0, r: 0.45 });
      env(s, 1, { a: 0.001, d: 0.28, s: 0, r: 0.3 });
      mod(s, 'env2', 'f1.cutoff', 0.5);
      mod(s, 'vel', 'f1.cutoff', 0.12);
      Object.assign(s.fx.delay, { on: true, div: 6, fb: 0.38, mix: 0.25, ping: true });
      Object.assign(s.fx.reverb, { on: true, size: 0.7, mix: 0.3 });
      macros(s);
      vol(s, 0.7);
    }),
    P('Pizzicato Glass', 'Pluck', (s) => {
      osc(s, 0, { frame: TRI, level: 0.8 });
      osc(s, 1, { wt: 6, frame: 0.5, semi: 12, level: 0.3 });
      filt(s, 0, { type: 0, cutoff: 3800, reso: 0.1, key: 0.5 });
      env(s, 0, { a: 0.001, d: 0.38, s: 0, r: 0.3, dc: 0.7 });
      mod(s, 'vel', 'f1.cutoff', 0.2);
      Object.assign(s.fx.reverb, { on: true, size: 0.6, mix: 0.22 });
      macros(s);
      vol(s, 0.64);
    }),
    P('Comb Harp', 'Pluck', (s) => {
      osc(s, 0, { frame: SAW, level: 0.2 });
      s.noise = { on: true, type: 0, level: 0.05, pan: 0, dest: 0 };
      filt(s, 0, { type: 9, cutoff: 261.6, reso: 0.9, key: 1, morph: 0 });
      filt(s, 1, { type: 1, cutoff: 6000, reso: 0.05 });
      env(s, 0, { a: 0.001, d: 1.6, s: 0, r: 0.9 });
      env(s, 2, { a: 0.001, d: 0.05, s: 0, r: 0.03 });
      mod(s, 'env3', 'noise.level', 0.95);
      mod(s, 'vel', 'f1.reso', 0.08);
      Object.assign(s.fx.reverb, { on: true, size: 0.6, mix: 0.25 });
      mod(s, 'm1', 'f2.cutoff', 0.3);
      mod(s, 'm2', 'f1.morph', 0.5);
      mod(s, 'm3', 'fx.reverb', 0.6);
      vol(s, 1.0);
    }),
    P('Bell Drops', 'Pluck', (s) => {
      osc(s, 0, { wt: 6, frame: 1, level: 0.6 });
      osc(s, 1, { frame: 0, semi: 24, level: 0.25, warp: 7, warpSrc: 0, warpAmt: 0.2 });
      filt(s, 0, { type: 1, cutoff: 9000, reso: 0.05 });
      env(s, 0, { a: 0.001, d: 1.1, s: 0, r: 0.9 });
      Object.assign(s.fx.delay, { on: true, div: 5, fb: 0.4, mix: 0.3, ping: true });
      Object.assign(s.fx.reverb, { on: true, size: 0.75, mix: 0.35 });
      macros(s);
      vol(s, 0.7);
    }),

    // ---------------- Keys ----------------
    P('Glass Keys', 'Keys', (s) => {
      osc(s, 0, { frame: 0.05, level: 0.75, warp: 7, warpSrc: 1, warpAmt: 0.12 });
      osc(s, 1, { frame: 0, semi: 12, level: 0, dest: 3 });
      osc(s, 2, { wt: 6, frame: 0.3, semi: 12, level: 0.18 });
      filt(s, 0, { type: 0, cutoff: 7000, reso: 0.05 });
      env(s, 0, { a: 0.002, d: 1.8, s: 0.3, r: 0.5 });
      env(s, 1, { a: 0.001, d: 0.9, s: 0.15, r: 0.4 });
      mod(s, 'env2', 'o1.warp', 0.3);
      mod(s, 'vel', 'o1.warp', 0.15);
      Object.assign(s.fx.chorus, { on: true, rate: 0.45, depth: 0.35, mix: 0.3 });
      Object.assign(s.fx.reverb, { on: true, size: 0.55, mix: 0.18 });
      macros(s, 'o1.warp');
      vol(s, 0.62);
    }),
    P('Drawbar Organ', 'Keys', (s) => {
      osc(s, 0, { wt: 11, frame: 0.55, level: 0.7 });
      s.filt[0].on = false;
      env(s, 0, { a: 0.006, d: 0.1, s: 1, r: 0.07 });
      Object.assign(s.fx.chorus, { on: true, rate: 0.75, depth: 0.35, fb: 0.1, mix: 0.4 });
      Object.assign(s.fx.dist, { on: true, type: 0, drive: 0.2, tone: 0.6, mix: 0.3 });
      Object.assign(s.fx.reverb, { on: true, size: 0.45, mix: 0.12 });
      mod(s, 'm1', 'fx.dist', 0.6);
      mod(s, 'm2', 'o1.frame', 0.45);
      mod(s, 'm3', 'fx.reverb', 0.6);
      vol(s, 0.62);
    }),
    P('Velvet EP', 'Keys', (s) => {
      osc(s, 0, { frame: 0.25, level: 0.75 });
      osc(s, 1, { wt: 7, frame: 0.3, semi: 12, level: 0.2 });
      filt(s, 0, { type: 0, cutoff: 1500, reso: 0.05, key: 0.5 });
      env(s, 0, { a: 0.002, d: 1.8, s: 0.25, r: 0.4 });
      env(s, 1, { a: 0.001, d: 0.6, s: 0.2, r: 0.3 });
      mod(s, 'env2', 'f1.cutoff', 0.15);
      mod(s, 'vel', 'f1.cutoff', 0.25);
      lfo(s, 0, { shape: 0, sync: false, rate: 4.2, mode: 1 });
      mod(s, 'lfo1', 'master', -0.08);
      Object.assign(s.fx.chorus, { on: true, rate: 0.4, depth: 0.4, mix: 0.35 });
      Object.assign(s.fx.reverb, { on: true, size: 0.5, mix: 0.15 });
      macros(s);
      vol(s, 0.64);
    }),
    P('Hollow Clav', 'Keys', (s) => {
      osc(s, 0, { wt: 7, frame: 0.7, level: 0.75 });
      filt(s, 0, { type: 0, cutoff: 1600, reso: 0.3, key: 0.4 });
      filt(s, 1, { type: 2, cutoff: 220, reso: 0.1 });
      env(s, 0, { a: 0.001, d: 0.5, s: 0.2, r: 0.08 });
      env(s, 1, { a: 0.001, d: 0.2, s: 0, r: 0.1 });
      mod(s, 'env2', 'f1.cutoff', 0.3);
      mod(s, 'vel', 'f1.cutoff', 0.15);
      Object.assign(s.fx.dist, { on: true, type: 0, drive: 0.15, tone: 0.7, mix: 0.3 });
      macros(s);
      vol(s, 0.72);
    }),

    // ---------------- Arp / Seq ----------------
    P('Pulse Arp', 'Arp/Seq', (s) => {
      osc(s, 0, { wt: 1, frame: 0.5, level: 0.75, uni: 2, detune: 0.1 });
      filt(s, 0, { type: 1, cutoff: 900, reso: 0.35, key: 0.3 });
      lfo(s, 0, { shape: 5, sync: true, div: 14, mode: 1 });
      mod(s, 'lfo1', 'o1.frame', 0.35);
      env(s, 0, { a: 0.001, d: 0.28, s: 0, r: 0.15 });
      env(s, 1, { a: 0.001, d: 0.16, s: 0, r: 0.1 });
      mod(s, 'env2', 'f1.cutoff', 0.38);
      Object.assign(s.fx.delay, { on: true, div: 6, fb: 0.38, mix: 0.25, ping: true });
      Object.assign(s.fx.reverb, { on: true, size: 0.5, mix: 0.15 });
      macros(s);
      vol(s, 0.78);
    }),
    P('Step Sequence', 'Arp/Seq', (s) => {
      osc(s, 0, { frame: SAW, uni: 3, detune: 0.15, level: 0.7 });
      osc(s, 1, { frame: 1, semi: -12, level: 0.3 });
      filt(s, 0, { type: 1, cutoff: 420, reso: 0.5 });
      const steps = [0.3, 0.9, 0.5, 1, 0.2, 0.8, 0.6, 0.95];
      const pts: number[][] = [];
      steps.forEach((v, i) => pts.push([i / 8, v], [(i + 1) / 8 - (i < 7 ? 0.001 : 0), v]));
      lfo(s, 0, { shape: 7, sync: true, div: 5, mode: 1, pts });
      mod(s, 'lfo1', 'f1.cutoff', 0.32);
      env(s, 0, { a: 0.003, d: 0.4, s: 0.85, r: 0.12 });
      Object.assign(s.fx.delay, { on: true, div: 3, fb: 0.3, mix: 0.18, ping: true });
      Object.assign(s.fx.dist, { on: true, type: 0, drive: 0.2, tone: 0.6, mix: 0.35 });
      macros(s);
      vol(s, 0.55);
    }),
    P('Digital Rain', 'Arp/Seq', (s) => {
      osc(s, 0, { wt: 9, frame: 0.3, level: 0.7 });
      osc(s, 1, { wt: 6, frame: 0.7, semi: 12, level: 0.25 });
      filt(s, 0, { type: 1, cutoff: 6000, reso: 0.15 });
      env(s, 0, { a: 0.001, d: 0.32, s: 0, r: 0.25 });
      env(s, 1, { a: 0.001, d: 0.25, s: 0, r: 0.2 });
      mod(s, 'env2', 'o1.frame', 0.45);
      mod(s, 'rand', 'o1.pan', 0.6);
      mod(s, 'rand', 'o1.frame', 0.15);
      Object.assign(s.fx.delay, { on: true, div: 4, fb: 0.42, mix: 0.3, ping: true });
      Object.assign(s.fx.reverb, { on: true, size: 0.7, mix: 0.3 });
      macros(s);
      vol(s, 0.88);
    }),

    // ---------------- FX ----------------
    P('Riser Sweep', 'FX', (s) => {
      osc(s, 0, { frame: SAW, uni: 7, detune: 0.45, spread: 1, level: 0.55 });
      s.noise = { on: true, type: 0, level: 0.45, pan: 0, dest: 0 };
      filt(s, 0, { type: 1, cutoff: 1500, reso: 0.45 });
      lfo(s, 0, { shape: 2, sync: true, div: 2, mode: 2 });
      mod(s, 'lfo1', 'f1.cutoff', 0.3);
      mod(s, 'lfo1', 'pitch', 0.125);
      mod(s, 'lfo1', 'o1.detune', 0.25);
      env(s, 0, { a: 1.5, d: 1, s: 1, r: 1.5, ac: -0.3 });
      Object.assign(s.fx.reverb, { on: true, size: 0.8, mix: 0.4 });
      Object.assign(s.fx.delay, { on: true, div: 6, fb: 0.4, mix: 0.2 });
      macros(s);
      vol(s, 0.68);
    }),
    P('Impact Drop', 'FX', (s) => {
      osc(s, 0, { frame: 0, level: 0.85 });
      s.noise = { on: true, type: 1, level: 0.2, pan: 0, dest: 0 };
      filt(s, 0, { type: 1, cutoff: 2500, reso: 0.15 });
      env(s, 0, { a: 0.001, d: 2.5, s: 0, r: 1.5, dc: 0.3 });
      env(s, 1, { a: 0.001, d: 1.6, s: 0, r: 0.5, dc: 0.5 });
      mod(s, 'env2', 'o1.pitch', 0.4);
      mod(s, 'env2', 'f1.cutoff', 0.3);
      Object.assign(s.fx.dist, { on: true, type: 0, drive: 0.3, tone: 0.5, mix: 0.4 });
      Object.assign(s.fx.reverb, { on: true, size: 0.85, mix: 0.4 });
      macros(s);
      vol(s, 0.5);
    }),
    P('Laser Zap', 'FX', (s) => {
      osc(s, 0, { wt: 10, frame: 0.8, level: 0.7 });
      filt(s, 0, { type: 1, cutoff: 8000, reso: 0.2 });
      env(s, 0, { a: 0.001, d: 0.35, s: 0, r: 0.2 });
      env(s, 1, { a: 0.001, d: 0.22, s: 0, r: 0.1, dc: 0.6 });
      mod(s, 'env2', 'o1.pitch', 0.6);
      mod(s, 'env2', 'o1.frame', -0.6);
      Object.assign(s.fx.delay, { on: true, div: 2, fb: 0.45, mix: 0.3, ping: true });
      macros(s);
      vol(s, 0.82);
    }),
    P('Space Wind', 'FX', (s) => {
      s.osc[0].on = false;
      s.noise = { on: true, type: 1, level: 0.8, pan: 0, dest: 0 };
      filt(s, 0, { type: 4, cutoff: 900, reso: 0.6 });
      lfo(s, 0, { shape: 6, sync: false, rate: 0.35, mode: 1 });
      lfo(s, 1, { shape: 0, sync: false, rate: 0.13, mode: 1 });
      mod(s, 'lfo1', 'f1.cutoff', 0.3);
      mod(s, 'lfo2', 'noise.level', 0.15);
      mod(s, 'note', 'f1.cutoff', 0.5);
      env(s, 0, { a: 2, d: 1, s: 1, r: 3, ac: -0.3 });
      Object.assign(s.fx.chorus, { on: true, rate: 0.2, depth: 0.7, mix: 0.4 });
      Object.assign(s.fx.reverb, { on: true, size: 0.9, mix: 0.5 });
      macros(s);
      vol(s, 1.12);
    }),
  ];
  return cache;
}
