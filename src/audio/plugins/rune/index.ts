// Rune — analog-style semi-modular poly synth (original instrument).
// 3 oscillators (analog / multi / FM / PM / chip / noise / vector), 2 filters (ladder, SVF, SEM morph, K-35,
// diode, comb, formant, ring), amp + distortion, 3 envelopes, 4 LFOs, 16-slot mod matrix, arpeggiator /
// step sequencer, poly / mono / legato with glide and unison, and a chorus → phaser → flanger → delay →
// reverb chain. DSP: ./rune.worklet.ts (processor 'lf-rune'); patch model: ./defs.ts.
import workletUrl from './rune.worklet.ts?worker&url';
import { registerInstrument } from '../registry';
import { defaultState } from './defs';
import { runePresets } from './presets';
import { createRuneUI } from './ui';

registerInstrument({
  id: 'rune',
  name: 'Rune',
  desc: 'Analog-style semi-modular poly synth',
  category: 'Synth',
  color: '#f4a83a',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v18M7 4l8 4.5L7 13M7 13l9 8"/></svg>',
  workletUrl,
  processor: 'lf-rune',
  size: { w: 960, h: 600 },
  defaultState,
  presets: runePresets,
  createUI: createRuneUI,
});
