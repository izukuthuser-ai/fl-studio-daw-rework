// PLACEHOLDER Halcyon plugin (replaced by the real wavetable synth).
import workletUrl from './halcyon.worklet.ts?worker&url';
import { registerInstrument } from '../registry';
import { el } from '../../../core/util';
import { knob } from '../../../ui/widgets';

registerInstrument({
  id: 'halcyon',
  name: 'Halcyon',
  desc: 'Wavetable synthesizer',
  category: 'Synth',
  color: '#5aa6e8',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 15c3-8 5-8 9 0s6 8 9 0"/></svg>',
  workletUrl,
  processor: 'lf-halcyon',
  size: { w: 720, h: 460 },
  defaultState: () => ({ cutoff: 0.5 }),
  presets: () => [{ name: 'Init', category: 'Basic', state: { cutoff: 0.5 } }],
  createUI(api) {
    const k = knob({ def: { key: 'cutoff', label: 'Cutoff', min: 0, max: 1, def: 0.5 }, get: () => api.getState().cutoff, set: (v) => api.live((s) => (s.cutoff = v)), begin: () => api.begin('Cutoff'), end: () => api.end(), size: 40, label: 'Cutoff' });
    const off = api.onExternalChange(() => k.update());
    return { el: el('div', { style: { padding: '20px' } }, k), destroy: off };
  },
});
