// Riffstack factory presets (params on top of the defaults) + user presets in localStorage.
import { rsDefaults, RS_PARAMS } from './params';

export interface RsPreset {
  name: string;
  category: string;
  params: Record<string, number>;
  user?: boolean;
}

const P = (name: string, category: string, params: Record<string, number>): RsPreset => ({ name, category, params });

// model indices: 0 Glass, 1 Amberglow, 2 Hot Lead, 3 Molten Core, 4 Razor, 5 Subterra
// cab indices: 0 1x12 Open, 1 2x12 Combo, 2 4x12 Vintage, 3 4x12 Modern, 4 1x15 Bass
export const FACTORY: RsPreset[] = [
  P('Clean Sparkle', 'Clean', {
    ampModel: 0, gain: 4, bass: 5, middle: 4, treble: 6.5, presence: 6, depth: 5, master: 5, bright: 1,
    compOn: 1, compSus: 0.35, compAtk: 12, compLevel: 0.5,
    cabType: 1, micType: 2, micPos: 0.25, micDist: 6,
    rvbOn: 1, rvbType: 2, rvbDecay: 1.8, rvbTone: 0.6, rvbMix: 0.18,
    gateThr: -70, gateRel: 160, outLevel: -4,
  }),
  P('Funk Glass', 'Clean', {
    ampModel: 0, gain: 3.5, bass: 4, middle: 5.5, treble: 7, presence: 6.5, master: 5, bright: 1,
    compOn: 1, compSus: 0.62, compAtk: 4, compLevel: 0.52,
    wahOn: 1, wahAuto: 1, wahPos: 0.25, wahSens: 0.65,
    cabType: 0, micType: 0, micPos: 0.2, micDist: 3,
    rvbOn: 1, rvbType: 0, rvbDecay: 0.7, rvbTone: 0.6, rvbMix: 0.12,
    gateThr: -68, gateRel: 80, outLevel: 1,
  }),
  P('Blues Edge', 'Crunch', {
    ampModel: 1, gain: 3, bass: 5, middle: 6.5, treble: 5.5, presence: 5, master: 6,
    odOn: 1, odDrive: 0.3, odTone: 0.45, odLevel: 0.55,
    cabType: 1, micType: 1, micPos: 0.35, micDist: 8,
    rvbOn: 1, rvbType: 0, rvbDecay: 1.1, rvbTone: 0.45, rvbMix: 0.15,
    gateThr: -72, gateRel: 200, outLevel: -1,
  }),
  P('Classic Crunch', 'Crunch', {
    ampModel: 1, gain: 6.5, bass: 5, middle: 6.5, treble: 6, presence: 5.5, depth: 5, master: 6,
    cabType: 2, micType: 0, micPos: 0.3, micDist: 3,
    rvbOn: 1, rvbType: 0, rvbDecay: 0.9, rvbMix: 0.1,
    gateThr: -66, gateRel: 120, outLevel: -2,
  }),
  P('Hot Lead', 'Lead', {
    ampModel: 2, gain: 7, bass: 5, middle: 6.5, treble: 5.5, presence: 5.5, depth: 5, master: 5.5,
    cabType: 2, micType: 0, micPos: 0.35, micDist: 4,
    dlyOn: 1, dlySync: 1, dlyDiv: 5, dlyFb: 0.3, dlyTone: 0.45, dlyMix: 0.18,
    rvbOn: 1, rvbType: 1, rvbDecay: 2.2, rvbTone: 0.45, rvbMix: 0.14,
    gateThr: -66, gateRel: 160, outLevel: -3.5,
  }),
  P('Molten Core Rhythm', 'High Gain', {
    ampModel: 3, gain: 6.5, bass: 5.5, middle: 4.5, treble: 6, presence: 6, depth: 6, master: 5.5, tight: 1,
    odOn: 1, odDrive: 0, odTone: 0.6, odLevel: 0.85,
    cabType: 3, micType: 0, micPos: 0.25, micDist: 3,
    gateOn: 1, gateThr: -58, gateRel: 60, gateHyst: 8, outLevel: -2,
  }),
  P('Molten Core Lead', 'High Gain', {
    ampModel: 3, gain: 7.5, bass: 5, middle: 6, treble: 5.5, presence: 5.5, depth: 5.5, master: 5.5, tight: 1,
    odOn: 1, odDrive: 0.1, odTone: 0.5, odLevel: 0.8,
    cabType: 3, micType: 0, micPos: 0.35, micDist: 4,
    dlyOn: 1, dlySync: 1, dlyDiv: 7, dlyFb: 0.3, dlyTone: 0.4, dlyMix: 0.2, dlyPing: 1,
    rvbOn: 1, rvbType: 1, rvbDecay: 2.6, rvbTone: 0.4, rvbMix: 0.16,
    gateThr: -64, gateRel: 140, gateHyst: 6, outLevel: -3,
  }),
  P('Razor Djent', 'High Gain', {
    ampModel: 4, gain: 6, bass: 6, middle: 5.5, treble: 6.5, presence: 6.5, depth: 7, master: 5.5, tight: 1,
    odOn: 1, odDrive: 0, odTone: 0.65, odLevel: 0.9,
    cabType: 3, micType: 0, micPos: 0.15, micDist: 2,
    eqOn: 1, eq1: 1, eq2: -2, eq3: -1, eq4: 1.5, eq5: 0,
    gateOn: 1, gateThr: -52, gateRel: 35, gateHyst: 10, outLevel: -3,
  }),
  P('Doom Fuzz', 'High Gain', {
    ampModel: 1, gain: 4, bass: 6.5, middle: 4.5, treble: 5.5, presence: 5, depth: 6, master: 6.5,
    fzOn: 1, fzGain: 0.85, fzTone: 0.42, fzLevel: 0.55,
    cabType: 2, micType: 0, micPos: 0.4, micDist: 5,
    rvbOn: 1, rvbType: 0, rvbDecay: 1.4, rvbTone: 0.35, rvbMix: 0.12,
    gateThr: -70, gateRel: 220, outLevel: -7.5,
  }),
  P('Thrash Tight', 'High Gain', {
    ampModel: 3, gain: 5.5, bass: 4.5, middle: 6.5, treble: 6.5, presence: 6.5, depth: 5, master: 5.5, tight: 1,
    odOn: 1, odDrive: 0.1, odTone: 0.55, odLevel: 0.8,
    cabType: 2, micType: 0, micPos: 0.2, micDist: 3,
    gateOn: 1, gateThr: -56, gateRel: 40, gateHyst: 8, outLevel: -1.5,
  }),
  P('Ambient Clean (delay+verb)', 'Ambient', {
    ampModel: 0, gain: 3.5, bass: 4.5, middle: 5, treble: 6, presence: 5.5, master: 5,
    compOn: 1, compSus: 0.3, compAtk: 15, compLevel: 0.5,
    cabType: 1, micType: 2, micPos: 0.3, micDist: 10,
    dlyOn: 1, dlySync: 1, dlyDiv: 8, dlyFb: 0.5, dlyTone: 0.4, dlyMix: 0.32, dlyPing: 1,
    rvbOn: 1, rvbType: 1, rvbDecay: 5.5, rvbTone: 0.55, rvbMix: 0.34,
    gateThr: -74, gateRel: 300, outLevel: 1.5,
  }),
  P('80s Solo', 'Lead', {
    ampModel: 2, gain: 8, bass: 5, middle: 7, treble: 6, presence: 6, depth: 5, master: 6,
    compOn: 1, compSus: 0.4, compAtk: 10, compLevel: 0.5,
    cabType: 2, micType: 0, micPos: 0.3, micDist: 4,
    eqOn: 1, eq1: 0, eq2: -1, eq3: 2, eq4: 1, eq5: -1,
    dlyOn: 1, dlySync: 1, dlyDiv: 5, dlyFb: 0.35, dlyTone: 0.5, dlyMix: 0.24, dlyPing: 1,
    rvbOn: 1, rvbType: 2, rvbDecay: 2.2, rvbTone: 0.55, rvbMix: 0.2,
    gateThr: -66, gateRel: 180, outLevel: -6.5,
  }),
  P('DI Bass Grit', 'Bass', {
    ampModel: 5, gain: 6, bass: 6, middle: 5.5, treble: 5, presence: 5, depth: 6, master: 5,
    compOn: 1, compSus: 0.5, compAtk: 6, compLevel: 0.5,
    cabType: 4, micType: 0, micPos: 0.3, micDist: 6,
    gateThr: -70, gateRel: 150, outLevel: -4,
  }),
  P('Direct (amp only, no cab)', 'Utility', {
    ampModel: 1, gain: 5, bass: 5, middle: 5, treble: 5, presence: 5, depth: 5, master: 5,
    cabOn: 0, gateThr: -66, outLevel: 2,
  }),
  P('Edge of Breakup', 'Clean', {
    ampModel: 0, gain: 8, bass: 5, middle: 5, treble: 5.5, presence: 5, master: 6.5,
    cabType: 0, micType: 1, micPos: 0.4, micDist: 5,
    rvbOn: 1, rvbType: 0, rvbDecay: 1.2, rvbMix: 0.14,
    gateThr: -72, gateRel: 200, outLevel: -8,
  }),
  P('Wah Fuzz Lead', 'Lead', {
    ampModel: 1, gain: 5, bass: 5, middle: 6, treble: 5, master: 6,
    wahOn: 1, wahAuto: 0, wahPos: 0.6,
    fzOn: 1, fzGain: 0.7, fzTone: 0.55, fzLevel: 0.5,
    cabType: 2, micType: 0, micPos: 0.35, micDist: 4,
    dlyOn: 1, dlySync: 1, dlyDiv: 4, dlyFb: 0.25, dlyMix: 0.15,
    gateThr: -68, gateRel: 160, outLevel: -3,
  }),
];

export const INIT_PRESET: RsPreset = { name: 'Init', category: 'Utility', params: {} };

/** Full param set for a preset (defaults + overrides). */
export function presetParams(p: RsPreset): Record<string, number> {
  return { ...rsDefaults(), ...p.params };
}

const KEY = 'lf.riffstack.presets';
export function userPresets(): RsPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.name === 'string' && x.params).map((x) => ({ name: x.name, category: 'User', params: x.params, user: true })) : [];
  } catch {
    return [];
  }
}
export function saveUserPreset(name: string, params: Record<string, number>) {
  const keys = new Set(RS_PARAMS.map((d) => d.key));
  const clean: Record<string, number> = {};
  for (const k in params) if (keys.has(k) && typeof params[k] === 'number') clean[k] = params[k];
  try {
    const list = userPresets().filter((p) => p.name !== name);
    list.push({ name, category: 'User', params: clean });
    localStorage.setItem(KEY, JSON.stringify(list.map(({ name, params }) => ({ name, params }))));
    return true;
  } catch {
    return false;
  }
}
export function deleteUserPreset(name: string) {
  try {
    const list = userPresets().filter((p) => p.name !== name);
    localStorage.setItem(KEY, JSON.stringify(list.map(({ name, params }) => ({ name, params }))));
  } catch {}
}
export function allPresets(): RsPreset[] {
  return [INIT_PRESET, ...FACTORY, ...userPresets()];
}
