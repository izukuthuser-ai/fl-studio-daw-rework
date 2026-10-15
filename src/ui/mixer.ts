// placeholder — replaced by the real implementation
import { el } from '../core/util';
import type { PanelDef } from './panel';
export function createMixer(): PanelDef {
  return { body: el('div', { class: 'empty-hint', text: 'Mixer' }) };
}
