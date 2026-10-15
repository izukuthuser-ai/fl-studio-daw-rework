// Scales and chord stamps for the Piano Roll (scale highlight, snap-to-scale, chord stamp tool).
import { NOTE_NAMES, clamp } from '../core/util';

export interface ScaleDef {
  id: string;
  name: string;
  steps: number[];
}

export const SCALES: ScaleDef[] = [
  { id: 'major', name: 'Major (Ionian)', steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: 'Minor (Aeolian)', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonicMinor', name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodicMinor', name: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian', name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian', name: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'phrygianDominant', name: 'Phrygian dominant', steps: [0, 1, 4, 5, 7, 8, 10] },
  { id: 'majorPentatonic', name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  { id: 'minorPentatonic', name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  { id: 'wholeTone', name: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
];

export const ROOT_NAMES = NOTE_NAMES;

/** 12-entry membership mask for a root + scale type. */
export function scaleMask(root: number, type: string): boolean[] {
  const def = SCALES.find((s) => s.id === type) ?? SCALES[0];
  const m = new Array<boolean>(12).fill(false);
  for (const s of def.steps) m[(((root + s) % 12) + 12) % 12] = true;
  return m;
}

export const pc = (key: number) => ((key % 12) + 12) % 12;
export const inScale = (key: number, mask: boolean[]) => mask[pc(key)];

/** Nearest in-scale key (ties go up unless dir < 0). dir forces the search direction. */
export function snapToScale(key: number, mask: boolean[], dir: -1 | 0 | 1 = 0): number {
  key = clamp(Math.round(key), 0, 127);
  if (inScale(key, mask)) return key;
  for (let d = 1; d < 12; d++) {
    const up = key + d, dn = key - d;
    if (dir >= 0 && up <= 127 && inScale(up, mask)) return up;
    if (dir <= 0 && dn >= 0 && inScale(dn, mask)) return dn;
  }
  return key;
}

/** Next in-scale key strictly above (dir 1) or below (dir -1). */
export function stepInScale(key: number, mask: boolean[], dir: 1 | -1): number {
  for (let k = key + dir; k >= 0 && k <= 127; k += dir) if (inScale(k, mask)) return k;
  return key;
}

/** Move `degrees` scale degrees from `key` (key is first snapped onto the scale). */
export function scaleDegree(key: number, mask: boolean[], degrees: number): number {
  let k = snapToScale(key, mask);
  const dir = degrees >= 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(degrees); i++) k = stepInScale(k, mask, dir as 1 | -1);
  return k;
}

export interface ChordDef {
  id: string;
  name: string;
  intervals?: number[]; // semitones from root (root included)
  degrees?: number[]; // scale degrees from root (diatonic chords)
}

export const CHORDS: ChordDef[] = [
  { id: 'off', name: 'No chord' },
  { id: 'maj', name: 'Major', intervals: [0, 4, 7] },
  { id: 'min', name: 'Minor', intervals: [0, 3, 7] },
  { id: '7', name: 'Dominant 7', intervals: [0, 4, 7, 10] },
  { id: 'maj7', name: 'Major 7', intervals: [0, 4, 7, 11] },
  { id: 'min7', name: 'Minor 7', intervals: [0, 3, 7, 10] },
  { id: 'sus2', name: 'Sus2', intervals: [0, 2, 7] },
  { id: 'sus4', name: 'Sus4', intervals: [0, 5, 7] },
  { id: 'dim', name: 'Diminished', intervals: [0, 3, 6] },
  { id: 'aug', name: 'Augmented', intervals: [0, 4, 8] },
  { id: 'power', name: 'Power (5th + oct)', intervals: [0, 7, 12] },
  { id: 'add9', name: 'Add 9', intervals: [0, 4, 7, 14] },
  { id: 'triad', name: 'Triad in scale', degrees: [0, 2, 4] },
  { id: 'seventh', name: '7th in scale', degrees: [0, 2, 4, 6] },
];

/** All keys of a chord stamp built on `root` (root first). */
export function chordKeys(root: number, chordId: string, mask: boolean[]): number[] {
  const c = CHORDS.find((x) => x.id === chordId);
  if (!c || c.id === 'off') return [root];
  let keys: number[];
  if (c.degrees) {
    const r = snapToScale(root, mask);
    keys = c.degrees.map((d) => scaleDegree(r, mask, d));
  } else keys = c.intervals!.map((i) => root + i);
  return [...new Set(keys.filter((k) => k >= 0 && k <= 127))];
}
