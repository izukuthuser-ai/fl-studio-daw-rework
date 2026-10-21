// Rune — factory presets (original patches). Each is built from the init patch plus edits.
import type { PluginPreset } from '../api';
import { defaultState, RuneEnv, RuneFilter, RuneFx, RuneLfo, RuneOsc, RuneState, RuneVoice, RuneArp } from './defs';

type Mut = (s: RuneState) => void;

const osc = (k: number, o: Partial<RuneOsc>): Mut => (s) => void Object.assign(s.osc[k], o);
const flt = (j: number, f: Partial<RuneFilter>): Mut => (s) => void Object.assign(s.flt[j], f);
const env = (e: number, a: number, d: number, su: number, r: number, loop = false): Mut => (s) => void (s.env[e] = { a, d, s: su, r, loop } as RuneEnv);
const lfo = (l: number, o: Partial<RuneLfo>): Mut => (s) => void Object.assign(s.lfo[l], o);
const amp = (o: Partial<RuneState['amp']>): Mut => (s) => void Object.assign(s.amp, o);
const voice = (o: Partial<RuneVoice>): Mut => (s) => void Object.assign(s.voice, o);
const arp = (o: Partial<RuneArp>): Mut => (s) => void Object.assign(s.arp, { on: true }, o);
const master = (db: number): Mut => (s) => void (s.master = db);
const parallel: Mut = (s) => void (s.serial = false);
/** Effects: listed ones are switched on with the given settings. */
const fx = (o: { [K in keyof RuneFx]?: Partial<RuneFx[K]> }): Mut => (s) => {
  for (const k of Object.keys(o) as (keyof RuneFx)[]) Object.assign(s.fx[k], { on: true }, o[k]);
};
/** Matrix slots, filled from slot 1: [source, destination, amount, via?] */
const mods = (...m: [string, string, number, string?][]): Mut => (s) => {
  let i = 0;
  for (const [src, dst, amt, via] of m) {
    while (i < s.mod.length && s.mod[i].src !== 'none') i++;
    if (i >= s.mod.length) return;
    s.mod[i] = { src, dst, amt, via: via ?? 'none' };
  }
};
const steps = (pat: string) => pat.replace(/\s/g, '').split('').map((c) => (c === 'x' ? 1 : 0));
const vals = (...v: number[]) => Array.from({ length: 16 }, (_, i) => v[i % v.length]);

/** Standard macro layout: M1 brightness, M2 resonance, M3 osc 1 timbre, M4 space (reverb send). */
const macros: Mut = (s) => {
  if (!s.fx.reverb.on) Object.assign(s.fx.reverb, { on: true, mix: 0 });
  mods(['macro1', 'f1.cutoff', 0.4], ['macro2', 'f1.res', 0.45], ['macro3', 'o1.shape', 0.5], ['macro4', 'fx.reverb', 0.5])(s);
};

/** Loudness trims (dB) measured offline so presets sit at a similar level (≈ -19 dBFS RMS, peaks ≤ -4 dBFS). */
const TRIM: Record<string, number> = {
  'Ladder Sub': 3.5, 'Acid Line': 6, 'Reese Bass': 1, 'Rubber Bass': 0.5, 'Fold Bass': 3.5, 'Sync Growl': 2,
  'Sync Lead': 6, 'Chip Lead': 7, Screamer: 4, 'Soft Square': 3, 'Vowel Lead': 2,
  'Polar Pad': 2, 'Glass Pad': -0.5, 'Dusk Strings': 5, 'Sand Choir': -2, 'Warm Analog Pad': 1.5,
  'Velvet EP': 0.5, 'Drawbar Organ': 0.5, 'Poly Keys': 5.5,
  'Comb Pluck': 6, 'Glass Pluck': -3, Kalimba: -4.5,
  'Arp Runner': 9, 'Seq Bassline': 14, 'Chord Stabber': 2, 'Bubble Seq': 12.5,
  'Brass Stab': 2.5, 'Horn Section': -2.5,
  'Ring Bells': 2.5, 'Crackle Drone': 3, Riser: 1.5, 'Bitcrush Zap': 9,
};

function P(name: string, category: string, ...muts: Mut[]): PluginPreset {
  const s = defaultState();
  for (const m of muts) m(s);
  macros(s);
  // master holds up to +6 dB, the rest goes to the amp gain (after the distortion, so tone is unchanged)
  let total = s.master + (TRIM[name] ?? 0);
  if (total > 6) {
    s.amp.gain = Math.min(12, s.amp.gain + total - 6);
    total = 6;
  }
  s.master = total;
  return { name, category, state: s };
}

export function runePresets(): PluginPreset[] {
  return [
    { name: 'Init', category: 'Init', state: defaultState() },

    // ---------------- Bass ----------------
    P('Ladder Sub', 'Bass',
      osc(0, { type: 'analog', wave: 0, oct: -1, level: 0.85 }),
      osc(1, { type: 'analog', wave: 1, pw: 0.5, oct: -2, level: 0.55 }),
      flt(0, { type: 'ladder', cutoff: 240, res: 0.3, drive: 0.25, env: 0.32, key: 0.25 }),
      env(0, 0.002, 0.4, 0.85, 0.12), env(1, 0.001, 0.28, 0.15, 0.15),
      voice({ mode: 'legato', glide: 0.04, drift: 0.1 })),
    P('Acid Line', 'Bass',
      osc(0, { type: 'analog', wave: 0, oct: -1, level: 0.95 }),
      flt(0, { type: 'diode', cutoff: 330, res: 0.8, drive: 0.35, env: 0.5, key: 0.2, vel: 0.25 }),
      env(0, 0.002, 0.25, 0.75, 0.05), env(1, 0.001, 0.22, 0, 0.1),
      amp({ dist: 'tube', drive: 0.35, mix: 0.45 }),
      voice({ mode: 'legato', glide: 0.07, drift: 0.05 }),
      fx({ delay: { div: 5, mix: 0.16, fb: 0.35, tone: 0.45 } })),
    P('Reese Bass', 'Bass',
      osc(0, { type: 'analog', wave: 0, oct: -1, level: 0.75 }),
      osc(1, { type: 'analog', wave: 0, oct: -1, fine: 16, level: 0.75 }),
      osc(2, { type: 'analog', wave: 2.3, oct: -2, level: 0.45 }),
      flt(0, { type: 'ladder', cutoff: 650, res: 0.15, drive: 0.3, env: 0.1, key: 0.3 }),
      lfo(0, { shape: 'sine', rate: 0.18 }),
      mods(['lfo1', 'f1.cutoff', 0.05]),
      env(0, 0.003, 0.5, 1, 0.2),
      amp({ dist: 'tube', drive: 0.2, mix: 0.35 }),
      voice({ mode: 'legato', glide: 0.03 })),
    P('Rubber Bass', 'Bass',
      osc(0, { type: 'analog', wave: 2.6, oct: -1, level: 0.9 }),
      osc(1, { type: 'fm', ratio: 1, index: 1.2, oct: -1, level: 0.5 }),
      flt(0, { type: 'svf', mode: 0, cutoff: 480, res: 0.35, env: 0.35, key: 0.4 }),
      env(0, 0.001, 0.35, 0.6, 0.08), env(1, 0.001, 0.2, 0.05, 0.1), env(2, 0.001, 0.18, 0, 0.1),
      mods(['env3', 'o2.shape', 0.25]),
      voice({ mode: 'mono', glide: 0.02 })),
    P('Fold Bass', 'Bass',
      osc(0, { type: 'analog', wave: 2, oct: -1, level: 0.85 }),
      flt(0, { type: 'ladder', cutoff: 1400, res: 0.25, env: 0.12 }),
      amp({ dist: 'fold', drive: 0.3, mix: 0.9 }),
      env(0, 0.002, 0.3, 0.8, 0.1), env(2, 0.001, 0.25, 0.1, 0.1),
      mods(['env3', 'dist.drive', 0.35]),
      voice({ mode: 'mono', glide: 0.02 }), master(-2)),
    P('Sync Growl', 'Bass',
      osc(0, { type: 'analog', wave: 0, oct: -1, level: 0.3 }),
      osc(1, { type: 'analog', wave: 0, oct: -1, semi: 7, sync: true, level: 0.85 }),
      osc(2, { type: 'analog', wave: 3, oct: -2, level: 0.45 }),
      flt(0, { type: 'ladder', cutoff: 1500, res: 0.3, drive: 0.4, env: 0.15, key: 0.3 }),
      env(0, 0.002, 0.4, 0.85, 0.12), env(2, 0.001, 0.35, 0.1, 0.2),
      lfo(0, { shape: 'tri', sync: true, div: 8 }),
      mods(['env3', 'o2.pitch', 0.45], ['lfo1', 'o2.pitch', 0.12]),
      amp({ dist: 'tube', drive: 0.3, mix: 0.4 }),
      voice({ mode: 'legato', glide: 0.03 })),

    // ---------------- Lead ----------------
    P('Sync Lead', 'Lead',
      osc(0, { type: 'analog', wave: 0, level: 0.45 }),
      osc(1, { type: 'analog', wave: 0, semi: 12, sync: true, level: 0.85 }),
      osc(2, { type: 'analog', wave: 1, pw: 0.35, fine: 7, level: 0.3 }),
      flt(0, { type: 'k35', mode: 0, cutoff: 4200, res: 0.35, drive: 0.25, env: 0.15, key: 0.3 }),
      env(0, 0.003, 0.4, 0.85, 0.25), env(2, 0.001, 0.6, 0.3, 0.4),
      lfo(0, { shape: 'tri', rate: 5.2, fade: 0.45, retrig: true }),
      mods(['env3', 'o2.pitch', 0.25], ['lfo1', 'pitch', 0.015]),
      voice({ mode: 'legato', glide: 0.045 }),
      fx({ delay: { div: 5, mix: 0.2, fb: 0.3 }, reverb: { mix: 0.12, size: 0.55 } }), master(-1)),
    P('Chip Lead', 'Lead',
      osc(0, { type: 'chip', duty: 1, level: 0.9 }),
      osc(1, { type: 'chip', duty: 0, oct: 1, level: 0.22 }),
      flt(0, { type: 'off' }),
      env(0, 0.001, 0.15, 0.75, 0.06),
      lfo(0, { shape: 'sine', rate: 6, fade: 0.25, retrig: true }),
      mods(['lfo1', 'pitch', 0.02]),
      voice({ mode: 'mono', glide: 0.015, drift: 0 }),
      fx({ delay: { div: 3, mix: 0.18, fb: 0.25, pingpong: true } }), master(-3)),
    P('Screamer', 'Lead',
      osc(0, { type: 'multi', voices: 5, detune: 0.25, spread: 0.5, level: 0.8 }),
      osc(1, { type: 'analog', wave: 0, oct: 1, level: 0.35 }),
      flt(0, { type: 'k35', mode: 0, cutoff: 2600, res: 0.6, drive: 0.55, env: 0.2, key: 0.35 }),
      env(0, 0.004, 0.5, 0.9, 0.2), env(1, 0.002, 0.5, 0.4, 0.3),
      lfo(0, { shape: 'sine', rate: 5.5, fade: 0.5, retrig: true }),
      mods(['lfo1', 'pitch', 0.012]),
      amp({ dist: 'tube', drive: 0.45, mix: 0.6 }),
      voice({ mode: 'legato', glide: 0.06 }),
      fx({ delay: { div: 5, mix: 0.15, fb: 0.3 }, reverb: { mix: 0.15, size: 0.6 } }), master(-2)),
    P('Soft Square', 'Lead',
      osc(0, { type: 'analog', wave: 1, pw: 0.38, level: 0.9 }),
      osc(1, { type: 'analog', wave: 3, oct: -1, level: 0.3 }),
      flt(0, { type: 'ladder', cutoff: 2600, res: 0.12, env: 0.12, key: 0.3 }),
      env(0, 0.01, 0.5, 0.85, 0.3),
      lfo(0, { shape: 'sine', rate: 5, fade: 0.5, retrig: true }), lfo(1, { shape: 'tri', rate: 0.35 }),
      mods(['lfo1', 'pitch', 0.012], ['lfo2', 'o1.pw', 0.35]),
      voice({ mode: 'legato', glide: 0.03 }),
      fx({ chorus: { mix: 0.35 }, delay: { div: 6, mix: 0.18, fb: 0.3 } })),
    P('Vowel Lead', 'Lead',
      osc(0, { type: 'analog', wave: 0, level: 0.8 }),
      osc(1, { type: 'analog', wave: 1, pw: 0.3, fine: 6, level: 0.5 }),
      flt(0, { type: 'formant', cutoff: 1100, res: 0.45, morph: 0.2, key: 0.2 }),
      flt(1, { type: 'svf', mode: 0, cutoff: 6500, res: 0.05, key: 0 }),
      lfo(0, { shape: 'smooth', rate: 0.7 }), lfo(1, { shape: 'sine', rate: 5.2, fade: 0.6, retrig: true }),
      mods(['lfo1', 'f1.morph', 0.35], ['lfo2', 'pitch', 0.01]),
      env(0, 0.01, 0.4, 0.9, 0.25),
      voice({ mode: 'legato', glide: 0.05 }),
      fx({ reverb: { mix: 0.2, size: 0.65 } }), master(2)),

    // ---------------- Pad ----------------
    P('Polar Pad', 'Pad',
      osc(0, { type: 'multi', voices: 7, detune: 0.38, spread: 0.85, level: 0.8 }),
      osc(1, { type: 'analog', wave: 2, oct: 1, level: 0.25 }),
      flt(0, { type: 'ladder', cutoff: 1500, res: 0.18, env: 0.12, key: 0.4 }),
      env(0, 1.1, 1.2, 0.85, 2.2), env(1, 0.6, 1.5, 0.6, 1.5),
      lfo(0, { shape: 'sine', rate: 0.12 }), lfo(1, { shape: 'tri', rate: 0.3 }),
      mods(['lfo1', 'f1.cutoff', 0.07], ['lfo2', 'o1.shape', 0.1]),
      fx({ chorus: { mix: 0.3, rate: 0.3 }, reverb: { mix: 0.38, size: 0.82, damp: 0.45 } }), master(-2)),
    P('Glass Pad', 'Pad',
      osc(0, { type: 'vector', x: 0.25, y: 0.75, level: 0.8 }),
      osc(1, { type: 'fm', ratio: 3, index: 0.7, level: 0.3 }),
      flt(0, { type: 'svf', mode: 0, cutoff: 4200, res: 0.2, key: 0.3 }),
      env(0, 0.9, 1, 0.9, 2.5),
      lfo(0, { shape: 'smooth', rate: 0.15 }), lfo(1, { shape: 'tri', rate: 0.09 }),
      mods(['lfo1', 'o1.shape', 0.25], ['lfo2', 'o1.pw', 0.2]),
      voice({ drift: 0.2 }),
      fx({ delay: { div: 7, mix: 0.15, fb: 0.35 }, reverb: { mix: 0.4, size: 0.9 } })),
    P('Dusk Strings', 'Pad',
      osc(0, { type: 'multi', voices: 6, detune: 0.22, spread: 0.7, level: 0.8 }),
      osc(1, { type: 'multi', voices: 4, detune: 0.3, spread: 0.9, oct: 1, level: 0.3 }),
      flt(0, { type: 'sem', cutoff: 2200, res: 0.15, morph: 0.12, env: 0.18, key: 0.35 }),
      env(0, 0.35, 0.8, 0.85, 1.3), env(1, 0.4, 1.2, 0.5, 1.2),
      lfo(0, { shape: 'sine', rate: 4.8, fade: 1, retrig: true }),
      mods(['lfo1', 'pitch', 0.006]),
      fx({ phaser: { mix: 0.35, rate: 0.12, depth: 0.6, fb: 0.3 }, reverb: { mix: 0.3, size: 0.75 } }), master(-2)),
    P('Sand Choir', 'Pad',
      osc(0, { type: 'analog', wave: 0, level: 0.7 }),
      osc(1, { type: 'noise', noise: 1, color: 0.55, level: 0.2 }),
      osc(2, { type: 'analog', wave: 1, pw: 0.4, fine: 8, level: 0.5 }),
      flt(0, { type: 'formant', cutoff: 1000, res: 0.55, morph: 0.25, key: 0.15 }),
      env(0, 0.7, 1, 0.9, 1.8),
      lfo(0, { shape: 'smooth', rate: 0.25 }), lfo(1, { shape: 'sine', rate: 4.5, fade: 1, retrig: true }),
      mods(['lfo1', 'f1.morph', 0.3], ['lfo2', 'pitch', 0.006]),
      voice({ unison: 2, detune: 0.2, spread: 0.8 }),
      fx({ chorus: { mix: 0.4 }, reverb: { mix: 0.45, size: 0.85 } }), master(2)),
    P('Warm Analog Pad', 'Pad',
      osc(0, { type: 'analog', wave: 0, level: 0.75 }),
      osc(1, { type: 'analog', wave: 0, fine: 9, level: 0.75 }),
      osc(2, { type: 'analog', wave: 3, oct: -1, level: 0.3 }),
      flt(0, { type: 'ladder', cutoff: 900, res: 0.22, env: 0.25, key: 0.35 }),
      env(0, 0.6, 1, 0.9, 1.6), env(1, 0.8, 1.5, 0.45, 1.5),
      voice({ unison: 2, detune: 0.3, spread: 0.7 }),
      fx({ chorus: { mix: 0.4 }, reverb: { mix: 0.3, size: 0.7 } }), master(-3)),

    // ---------------- Keys ----------------
    P('Velvet EP', 'Keys',
      osc(0, { type: 'fm', ratio: 1, index: 0.9, level: 0.9 }),
      osc(1, { type: 'fm', ratio: 14, index: 0.35, level: 0 }),
      flt(0, { type: 'svf', mode: 0, cutoff: 6000, res: 0, key: 0.2 }),
      env(0, 0.001, 1.8, 0.25, 0.45), env(2, 0.001, 0.9, 0, 0.4),
      mods(['env3', 'o1.shape', 0.15], ['vel', 'o1.shape', 0.12], ['env3', 'o2.level', 0.3]),
      amp({ vel: 0.7 }),
      fx({ chorus: { mix: 0.3, rate: 0.4 }, reverb: { mix: 0.15, size: 0.5 } }), master(2)),
    P('Drawbar Organ', 'Keys',
      osc(0, { type: 'vector', x: 0, y: 1, level: 0.9 }),
      osc(1, { type: 'analog', wave: 3, oct: 1, level: 0.25 }),
      flt(0, { type: 'ladder', cutoff: 9000, res: 0, key: 0 }),
      env(0, 0.004, 0.1, 1, 0.06),
      lfo(0, { shape: 'sine', rate: 6.2 }),
      mods(['lfo1', 'amp.pan', 0.25], ['lfo1', 'o1.pitch', 0.002]),
      voice({ drift: 0.05 }),
      fx({ chorus: { mix: 0.5, rate: 4.5, depth: 0.3 }, reverb: { mix: 0.12, size: 0.5 } }), master(-3)),
    P('Poly Keys', 'Keys',
      osc(0, { type: 'analog', wave: 0, level: 0.7 }),
      osc(1, { type: 'analog', wave: 1, pw: 0.42, fine: 5, level: 0.55 }),
      flt(0, { type: 'ladder', cutoff: 700, res: 0.25, env: 0.38, key: 0.5, vel: 0.2 }),
      env(0, 0.002, 0.9, 0.45, 0.35), env(1, 0.001, 0.55, 0.2, 0.35),
      fx({ chorus: { mix: 0.35 }, reverb: { mix: 0.15 } })),

    // ---------------- Pluck ----------------
    P('Comb Pluck', 'Pluck',
      osc(0, { type: 'noise', noise: 0, color: 0.6, level: 0 }),
      osc(1, { type: 'analog', wave: 0, level: 0.12 }),
      flt(0, { type: 'comb', mode: 0, cutoff: 261.6, key: 1, res: 0.93, drive: 0.1 }),
      flt(1, { type: 'svf', mode: 0, cutoff: 5000, res: 0, key: 0.3 }),
      env(0, 0.001, 1.2, 0, 0.4), env(2, 0.0005, 0.025, 0, 0.02),
      mods(['env3', 'o1.level', 1]),
      fx({ reverb: { mix: 0.2, size: 0.55 } }), master(3)),
    P('Glass Pluck', 'Pluck',
      osc(0, { type: 'fm', ratio: 3.5, index: 2.2, level: 0.8 }),
      osc(1, { type: 'analog', wave: 3, level: 0.4 }),
      flt(0, { type: 'svf', mode: 0, cutoff: 3500, res: 0.1, env: 0.25, key: 0.5 }),
      env(0, 0.001, 0.7, 0, 0.5), env(1, 0.001, 0.3, 0, 0.2), env(2, 0.001, 0.3, 0, 0.2),
      mods(['env3', 'o1.shape', 0.3]),
      fx({ delay: { div: 5, mix: 0.25, fb: 0.35 }, reverb: { mix: 0.2 } })),
    P('Kalimba', 'Pluck',
      osc(0, { type: 'pm', ratio: 2, index: 1.2, wave: 0, level: 0.9 }),
      osc(1, { type: 'analog', wave: 3, oct: 2, level: 0 }),
      flt(0, { type: 'svf', mode: 0, cutoff: 4000, res: 0, key: 0.3 }),
      env(0, 0.001, 0.9, 0, 0.6), env(2, 0.001, 0.12, 0, 0.1),
      mods(['env3', 'o1.shape', 0.2], ['env3', 'o2.level', 0.25]),
      fx({ reverb: { mix: 0.25, size: 0.5 } }), master(2)),

    // ---------------- Arp ----------------
    P('Arp Runner', 'Arp',
      osc(0, { type: 'analog', wave: 0, level: 0.8 }),
      osc(1, { type: 'analog', wave: 1, pw: 0.3, oct: 1, level: 0.3 }),
      flt(0, { type: 'ladder', cutoff: 900, res: 0.35, env: 0.4, key: 0.4 }),
      env(0, 0.001, 0.25, 0.2, 0.12), env(1, 0.001, 0.18, 0.05, 0.1),
      arp({ mode: 'up', oct: 2, rate: 6, gate: 0.45 }),
      voice({ voices: 8 }),
      fx({ delay: { div: 5, mix: 0.25, fb: 0.4 }, reverb: { mix: 0.18 } })),
    P('Seq Bassline', 'Arp',
      osc(0, { type: 'analog', wave: 0, oct: -1, level: 0.85 }),
      osc(1, { type: 'analog', wave: 1, oct: -1, fine: 5, level: 0.45 }),
      flt(0, { type: 'diode', cutoff: 380, res: 0.7, drive: 0.3, env: 0.45, key: 0.2 }),
      env(0, 0.002, 0.2, 0.6, 0.06), env(1, 0.001, 0.18, 0, 0.1),
      arp({ mode: 'up', oct: 1, rate: 6, gate: 0.55, steps: steps('xx.x x.xx xx.x .xxx'), vals: vals(0.2, 0.5, 0.9, 0.3, 0.6, 1, 0.4, 0.75) }),
      mods(['seq', 'f1.cutoff', 0.3]),
      voice({ mode: 'mono' }),
      fx({ delay: { div: 5, mix: 0.12, fb: 0.3 } })),
    P('Chord Stabber', 'Arp',
      osc(0, { type: 'multi', voices: 5, detune: 0.2, spread: 0.6, level: 0.8 }),
      flt(0, { type: 'ladder', cutoff: 1200, res: 0.2, env: 0.3, key: 0.4 }),
      env(0, 0.001, 0.25, 0, 0.1), env(1, 0.001, 0.2, 0, 0.1),
      arp({ mode: 'chord', oct: 1, rate: 3, gate: 0.3, steps: steps('x..x ..x. x.x. .x..') }),
      fx({ delay: { div: 7, mix: 0.2, fb: 0.35 }, reverb: { mix: 0.2 } }), master(-3)),
    P('Bubble Seq', 'Arp',
      osc(0, { type: 'analog', wave: 2.5, level: 0.9 }),
      flt(0, { type: 'svf', mode: 1, cutoff: 1200, res: 0.7, env: 0.2, key: 0.5 }),
      env(0, 0.001, 0.18, 0, 0.1), env(1, 0.001, 0.12, 0, 0.1),
      lfo(0, { shape: 'sh', sync: true, div: 10 }),
      mods(['lfo1', 'f1.cutoff', 0.15]),
      arp({ mode: 'random', oct: 3, rate: 7, gate: 0.3 }),
      fx({ delay: { div: 1, mix: 0.3, fb: 0.45, pingpong: true }, reverb: { mix: 0.25 } }), master(3)),

    // ---------------- Brass ----------------
    P('Brass Stab', 'Brass',
      osc(0, { type: 'analog', wave: 0, level: 0.8 }),
      osc(1, { type: 'analog', wave: 0, fine: 11, level: 0.7 }),
      osc(2, { type: 'analog', wave: 0, fine: -9, level: 0.5 }),
      flt(0, { type: 'ladder', cutoff: 600, res: 0.12, env: 0.5, key: 0.45, vel: 0.3 }),
      env(0, 0.012, 0.5, 0.75, 0.18), env(1, 0.045, 0.32, 0.35, 0.2),
      amp({ vel: 0.6 }),
      fx({ reverb: { mix: 0.15, size: 0.45 } }), master(-3)),
    P('Horn Section', 'Brass',
      osc(0, { type: 'multi', voices: 4, detune: 0.18, spread: 0.4, level: 0.8 }),
      osc(1, { type: 'analog', wave: 1, pw: 0.45, level: 0.45 }),
      flt(0, { type: 'sem', cutoff: 900, res: 0.1, morph: 0, env: 0.4, key: 0.4 }),
      env(0, 0.06, 0.4, 0.85, 0.25), env(1, 0.08, 0.5, 0.5, 0.3),
      lfo(0, { shape: 'sine', rate: 5, fade: 0.6, retrig: true }),
      mods(['lfo1', 'pitch', 0.01]),
      fx({ chorus: { mix: 0.2 }, reverb: { mix: 0.2 } }), master(-2)),

    // ---------------- FX ----------------
    P('Ring Bells', 'FX',
      osc(0, { type: 'analog', wave: 3, level: 0.9 }),
      osc(1, { type: 'fm', ratio: 2.75, index: 1.2, level: 0.4 }),
      flt(0, { type: 'ring', cutoff: 760, key: 1, res: 0.7 }),
      flt(1, { type: 'svf', mode: 2, cutoff: 200, res: 0, key: 0 }),
      env(0, 0.001, 2.5, 0, 2),
      fx({ delay: { div: 5, mix: 0.2, fb: 0.4 }, reverb: { mix: 0.35, size: 0.8 } })),
    P('Crackle Drone', 'FX',
      osc(0, { type: 'noise', noise: 2, color: 0.4, level: 0.8, route: 0 }),
      osc(1, { type: 'analog', wave: 3, oct: -1, level: 0.35, route: 1 }),
      osc(2, { type: 'analog', wave: 0, oct: -2, level: 0.25, route: 1 }),
      flt(0, { type: 'comb', mode: 1, cutoff: 110, key: 0.5, res: 0.8 }),
      flt(1, { type: 'ladder', cutoff: 400, res: 0.3, key: 0.2 }),
      parallel,
      env(0, 1.5, 1, 1, 3),
      lfo(0, { shape: 'smooth', rate: 0.1 }), lfo(1, { shape: 'sine', rate: 0.07 }),
      mods(['lfo1', 'f1.cutoff', 0.1], ['lfo2', 'f2.cutoff', 0.15]),
      fx({ flanger: { mix: 0.3, rate: 0.05 }, reverb: { mix: 0.45, size: 0.95 } })),
    P('Riser', 'FX',
      osc(0, { type: 'noise', noise: 0, color: 0.6, level: 0.55 }),
      osc(1, { type: 'multi', voices: 7, detune: 0.5, spread: 0.9, level: 0.6 }),
      flt(0, { type: 'svf', mode: 0, cutoff: 300, res: 0.45, key: 0.2 }),
      env(0, 0.5, 0.1, 1, 1.5), env(2, 6, 0.1, 1, 0.5),
      lfo(0, { shape: 'square', sync: true, div: 10 }),
      mods(['env3', 'f1.cutoff', 0.5], ['env3', 'pitch', 0.25], ['lfo1', 'amp.gain', -0.35, 'env3']),
      fx({ flanger: { mix: 0.4, rate: 0.1 }, reverb: { mix: 0.35, size: 0.85 } }), master(-2)),
    P('Bitcrush Zap', 'FX',
      osc(0, { type: 'chip', duty: 0, level: 0.9 }),
      flt(0, { type: 'off' }),
      env(0, 0.001, 0.25, 0, 0.1), env(2, 0.001, 0.09, 0, 0.05),
      mods(['env3', 'pitch', 0.9]),
      amp({ dist: 'crush', drive: 0.55, mix: 0.8 }),
      fx({ delay: { div: 0, mix: 0.2, fb: 0.3 } }), master(-3)),
  ];
}
