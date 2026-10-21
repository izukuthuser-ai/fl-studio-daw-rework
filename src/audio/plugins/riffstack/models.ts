// Amp model voicings for the Riffstack preamp/power-amp simulation (original voicings; the numbers
// describe generic circuit behaviour: stage gains, clipping asymmetry, coupling/Miller filters…).
//
// Units: the signal is normalised so that ±1 ≈ the grid-conduction point of a triode stage and a
// DI guitar peaks around 0.25–0.4. Each stage computes  y = −g · shaper(pre · x)  then low-pass
// (Miller capacitance) and high-pass (coupling capacitor).

export interface StageDef {
  pre: number; // attenuation in front of the stage (interstage divider)
  g: number; // voltage gain after the nonlinearity
  cp: number; // positive-swing ceiling (grid conduction, soft)
  cn: number; // negative-swing ceiling (cut-off)
  hp: number; // coupling high-pass, Hz
  lp: number; // Miller / interstage low-pass, Hz
}

/** Passive treble/middle/bass stack: C1, C2, C3 (farads), R1 (treble pot), R2 (bass pot), R3 (mid pot), R4. */
export type StackDef = [number, number, number, number, number, number, number];

export interface AmpModelDef {
  inHp: number; // input coupling high-pass, Hz
  tightHz: number; // 2nd-order HPF in front of the preamp when "tight" is on
  fixedHpHz: number; // always-on 2nd-order pre-HPF (0 = none) — modern tight voicings
  preMid?: [number, number, number]; // optional pre-gain mid hump: [Hz, dB, Q]
  brightDb: number; // bright-cap treble boost at low gain settings
  brightHz: number;
  gainDb: [number, number]; // gain pot range (dB) applied in front of stage `gainAt`
  gainAt: number;
  stages: StageDef[];
  stackAt: number; // tone stack after this stage
  stack: StackDef;
  stackMakeupDb: number;
  blend: number; // clean blend after the preamp (bass amp)
  presHz: number;
  presRange: number; // ±dB
  depthHz: number;
  depthRange: number; // ±dB
  paDrive: number; // power-amp drive at master 10
  sag: number; // supply sag amount
  paCp: number;
  paCn: number;
  otHp: number; // output transformer
  otLp: number;
  trimDb: number; // output calibration
}

const nF = 1e-9;
const pF = 1e-12;
const k = 1e3;

export const MODELS: AmpModelDef[] = [
  // 0 — Glass: two stages, stack between them, lots of headroom, scooped and sparkly.
  {
    inHp: 22, tightHz: 120, fixedHpHz: 0, brightDb: 7, brightHz: 1600,
    gainDb: [-34, 4], gainAt: 1,
    stages: [
      { pre: 1, g: 22, cp: 1.0, cn: 1.9, hp: 18, lp: 20000 },
      { pre: 0.32, g: 14, cp: 1.0, cn: 1.6, hp: 28, lp: 13000 },
    ],
    stackAt: 0, stack: [220 * pF, 47 * nF, 22 * nF, 250 * k, 1000 * k, 25 * k, 68 * k], stackMakeupDb: 0,
    blend: 0, presHz: 3800, presRange: 7, depthHz: 85, depthRange: 6,
    paDrive: 0.42, sag: 0.18, paCp: 1, paCn: 1.12, otHp: 40, otLp: 12500, trimDb: 4,
  },
  // 1 — Amberglow: classic crunch, mid-forward, cathode-follower squish before the stack.
  {
    inHp: 30, tightHz: 140, fixedHpHz: 0, brightDb: 5, brightHz: 2200,
    gainDb: [-38, 2], gainAt: 1,
    stages: [
      { pre: 1, g: 30, cp: 1.0, cn: 2.0, hp: 26, lp: 16000 },
      { pre: 1.0, g: 30, cp: 1.0, cn: 1.7, hp: 75, lp: 9000 },
      { pre: 1 / 22, g: 22, cp: 0.8, cn: 3.0, hp: 12, lp: 20000 },
    ],
    stackAt: 2, stack: [470 * pF, 22 * nF, 22 * nF, 220 * k, 1000 * k, 22 * k, 33 * k], stackMakeupDb: 0,
    blend: 0, presHz: 3500, presRange: 7, depthHz: 95, depthRange: 6,
    paDrive: 0.36, sag: 0.3, paCp: 1, paCn: 1.1, otHp: 55, otLp: 9500, trimDb: -5,
  },
  // 2 — Hot Lead: four cascaded stages, smooth singing saturation.
  {
    inHp: 35, tightHz: 150, fixedHpHz: 0, brightDb: 4, brightHz: 2600, preMid: [760, 7, 0.75],
    gainDb: [-40, 0], gainAt: 1,
    stages: [
      { pre: 1, g: 35, cp: 1.0, cn: 2.0, hp: 30, lp: 13000 },
      { pre: 0.6, g: 30, cp: 1.0, cn: 1.8, hp: 60, lp: 7500 },
      { pre: 0.15, g: 28, cp: 1.0, cn: 1.6, hp: 80, lp: 6000 },
      { pre: 1 / 20, g: 20, cp: 0.85, cn: 2.6, hp: 15, lp: 6500 },
    ],
    stackAt: 3, stack: [680 * pF, 10 * nF, 47 * nF, 250 * k, 1000 * k, 50 * k, 100 * k], stackMakeupDb: 0,
    blend: 0, presHz: 3300, presRange: 6, depthHz: 100, depthRange: 6,
    paDrive: 0.3, sag: 0.26, paCp: 1, paCn: 1.08, otHp: 70, otLp: 6800, trimDb: -5.5,
  },
  // 3 — Molten Core: five stages, high coupling HPFs (tight), saturated, aggressive presence.
  {
    inHp: 35, tightHz: 135, fixedHpHz: 0, brightDb: 3, brightHz: 3000,
    gainDb: [-40, 0], gainAt: 1,
    stages: [
      { pre: 1, g: 40, cp: 1.0, cn: 2.2, hp: 35, lp: 12000 },
      { pre: 0.6, g: 34, cp: 1.0, cn: 1.8, hp: 100, lp: 8000 },
      { pre: 0.14, g: 30, cp: 1.0, cn: 1.6, hp: 140, lp: 6500 },
      { pre: 0.14, g: 28, cp: 1.0, cn: 1.5, hp: 100, lp: 5000 },
      { pre: 1 / 18, g: 18, cp: 0.85, cn: 2.4, hp: 25, lp: 6500 },
    ],
    stackAt: 4, stack: [250 * pF, 22 * nF, 22 * nF, 250 * k, 1000 * k, 10 * k, 33 * k], stackMakeupDb: 0,
    blend: 0, presHz: 3600, presRange: 8, depthHz: 90, depthRange: 9,
    paDrive: 0.34, sag: 0.12, paCp: 1, paCn: 1.06, otHp: 55, otLp: 7500, trimDb: -6.5,
  },
  // 4 — Razor: djent voicing — fixed pre-HPF, very high coupling HPFs, big post-distortion depth.
  {
    inHp: 50, tightHz: 200, fixedHpHz: 80, brightDb: 4, brightHz: 3400,
    gainDb: [-40, 0], gainAt: 1,
    stages: [
      { pre: 1, g: 45, cp: 1.0, cn: 2.0, hp: 70, lp: 12000 },
      { pre: 0.6, g: 34, cp: 1.0, cn: 1.7, hp: 170, lp: 8500 },
      { pre: 0.14, g: 30, cp: 1.0, cn: 1.5, hp: 210, lp: 7000 },
      { pre: 0.14, g: 26, cp: 1.0, cn: 1.5, hp: 160, lp: 5500 },
      { pre: 1 / 18, g: 18, cp: 0.85, cn: 2.2, hp: 40, lp: 7000 },
    ],
    stackAt: 4, stack: [500 * pF, 22 * nF, 22 * nF, 250 * k, 1000 * k, 25 * k, 56 * k], stackMakeupDb: 0,
    blend: 0, presHz: 4200, presRange: 8, depthHz: 80, depthRange: 11,
    paDrive: 0.3, sag: 0.06, paCp: 1, paCn: 1.04, otHp: 40, otLp: 8000, trimDb: -5.5,
  },
  // 5 — Subterra: bass amp, clean stage + stack, gritty second stage blended with the clean path.
  {
    inHp: 16, tightHz: 70, fixedHpHz: 0, brightDb: 4, brightHz: 2500,
    gainDb: [-30, 8], gainAt: 1,
    stages: [
      { pre: 1, g: 14, cp: 1.2, cn: 2.4, hp: 14, lp: 16000 },
      { pre: 0.8, g: 12, cp: 1.0, cn: 1.5, hp: 25, lp: 7000 },
    ],
    stackAt: 0, stack: [250 * pF, 47 * nF, 47 * nF, 250 * k, 1000 * k, 25 * k, 56 * k], stackMakeupDb: 2,
    blend: 0.8, presHz: 3000, presRange: 6, depthHz: 60, depthRange: 7,
    paDrive: 0.32, sag: 0.2, paCp: 1, paCn: 1.08, otHp: 28, otLp: 8000, trimDb: 0,
  },
];
