// Halcyon — wavetable synthesizer (3 morphing wavetable oscillators with unison + warp, sub, noise,
// 2 routable filters, 3 envelopes, 4 LFOs, 16-slot mod matrix, macros and an FX chain).
import workletUrl from './halcyon.worklet.ts?worker&url';
import { registerInstrument } from '../registry';
import { defaultState } from './defs';
import { factoryPresets } from './presets';
import { createHalcyonUI } from './ui';

registerInstrument({
  id: 'halcyon',
  name: 'Halcyon',
  desc: 'Wavetable synthesizer — morphing tables, unison, warps, mod matrix, FX',
  category: 'Synth',
  color: '#4fc3f0',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14c2-6 4-6 6 0s4 6 6 0 4-6 6 0"/><path d="M6 8.5c1.6-3 3.2-3 4.8 0" opacity=".55"/><path d="M13.2 8.5c1.6-3 3.2-3 4.8 0" opacity=".55"/></svg>',
  workletUrl,
  processor: 'lf-halcyon',
  size: { w: 940, h: 628 },
  defaultState,
  presets: () => factoryPresets(),
  createUI: createHalcyonUI,
});
