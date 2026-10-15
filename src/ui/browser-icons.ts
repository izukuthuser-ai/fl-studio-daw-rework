// Original vector glyphs + colour coding shared by the Browser and the Plugin picker.
// All icons are 24×24 line drawings using currentColor (no third-party artwork).
import type { BuiltinSound } from '../audio/sounds';
import type { FxType, Wave } from '../core/types';

const s = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export type SoundCategory = BuiltinSound['category'];

export const CAT_COLOR: Record<SoundCategory, string> = {
  Kicks: '#e8634a',
  '808s': '#f0a03c',
  Snares: '#e8d24a',
  Claps: '#8fd14f',
  Hats: '#3cc6c4',
  Cymbals: '#4aa3e8',
  Percussion: '#a06bf0',
  FX: '#d86bd8',
};

export const CAT_ICON: Record<SoundCategory, string> = {
  Kicks: s('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2"/>'),
  '808s': s('<path d="M3 12h1.5c1.2-7 2.6-7 3.8 0s2.4 6 3.4 0 2-4.5 2.9 0 1.6 3 2.3 0 1.3-2 1.9 0H21"/>'),
  Snares: s('<ellipse cx="12" cy="10" rx="8" ry="2.6"/><path d="M4 10v5.6c0 1.5 3.6 2.6 8 2.6s8-1.1 8-2.6V10"/><path d="M14.5 7.4L19.5 3M9.5 7.4L4.5 3"/>'),
  Claps: s('<circle cx="12" cy="12" r="2.4"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9L18 18M6 18l2.1-2.1M15.9 8.1L18 6"/>'),
  Hats: s('<ellipse cx="12" cy="8" rx="8.5" ry="1.8"/><ellipse cx="12" cy="11.5" rx="8.5" ry="1.8"/><path d="M12 6.2V4M12 13.3V21M8.5 21h7"/>'),
  Cymbals: s('<ellipse cx="12" cy="8.5" rx="9" ry="2.4" transform="rotate(-10 12 8.5)"/><path d="M12 6.3V4.3M12 10.9V21M8.5 21h7"/>'),
  Percussion: s('<ellipse cx="12" cy="5.5" rx="5.5" ry="1.8"/><path d="M6.5 5.5l1.8 13.5c.2 1 1.8 1.8 3.7 1.8s3.5-.8 3.7-1.8L17.5 5.5"/>'),
  FX: s('<path d="M11 3.5l1.9 6.1L19 11.5l-6.1 1.9L11 19.5l-1.9-6.1L3 11.5l6.1-1.9z"/><path d="M19 3v3.4M17.3 4.7h3.4"/>'),
};

export const FX_COLOR: Record<FxType, string> = {
  eq: '#f0a03c',
  compressor: '#f0a03c',
  limiter: '#f0a03c',
  reverb: '#6b7bf0',
  delay: '#4aa3e8',
  chorus: '#a06bf0',
  width: '#3cc6c4',
  filter: '#e8d24a',
  distortion: '#e8634a',
  bitcrusher: '#f06b9a',
};

export const FX_ICON: Record<FxType, string> = {
  eq: s('<path d="M3 15c2.5 0 3.5-7 6-7s3 9 6 9 3-6 6-6"/><circle cx="9" cy="8" r="1.5" fill="currentColor"/><circle cx="15" cy="17" r="1.5" fill="currentColor"/>'),
  compressor: s('<path d="M4 4v16h16" opacity=".45"/><path d="M4 20l8-8c1.5-1.4 3-2 8-3.5"/>'),
  limiter: s('<path d="M3 5.5h18" stroke-dasharray="2 2.4"/><path d="M3 15l2.5-7.5h3l3 10 3-10h3L21 15"/>'),
  reverb: s('<path d="M4 6v12M8 8v8M12 9.5v5M16 10.5v3M20 11.5v1"/>'),
  delay: s('<circle cx="5" cy="12" r="2.8" fill="currentColor" stroke="none"/><circle cx="11" cy="12" r="2.1" fill="currentColor" stroke="none" opacity=".75"/><circle cx="16.3" cy="12" r="1.5" fill="currentColor" stroke="none" opacity=".5"/><circle cx="20.5" cy="12" r="1" fill="currentColor" stroke="none" opacity=".3"/>'),
  filter: s('<path d="M3 9h9c2.4 0 3.2-2.5 4.6-1.6 1.6 1 1.9 6.6 4.4 12.6"/>'),
  distortion: s('<path d="M3 12l2.2-6h4.6l2.2 6 2.2 6h4.6L21 12"/>'),
  bitcrusher: s('<path d="M3 18h3.5v-4H10v-4h3.5V6H17v6h4"/>'),
  chorus: s('<path d="M3 10c2-4.5 4-4.5 6 0s4 4.5 6 0 4-4.5 6 0"/><path d="M3 15c2-4.5 4-4.5 6 0s4 4.5 6 0 4-4.5 6 0" opacity=".5"/>'),
  width: s('<path d="M12 5v14" opacity=".45"/><path d="M9.5 12h-6M6.5 9l-3 3 3 3M14.5 12h6M17.5 9l3 3-3 3"/>'),
};

export const WAVE_ICON: Record<Wave, string> = {
  sawtooth: s('<path d="M3 16L9 7v9l6-9v9l6-9"/>'),
  square: s('<path d="M3 16V8h4.5v8H12V8h4.5v8H21"/>'),
  sine: s('<path d="M3 12c1.5-6 4.5-6 6 0s4.5 6 6 0 4.5-6 6 0"/>'),
  triangle: s('<path d="M3 12l4.5-6 9 12L21 12"/>'),
  noise: s('<path d="M3 12l1.5-4 1.5 7 1.5-9 1.5 11 1.5-8 1.5 5 1.5-6 1.5 9 1.5-7 1.5 4 1.5-2"/>'),
};

export const SYNTH_COLOR = '#4fc6e6';
export const SAMPLER_COLOR = '#79d85a';
export const SAMPLER_ICON = s('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M6 12h1.5l1.5-3 2 6 2-8 2 7 1.5-2H18"/>');

/** Small glyphs used by tree rows. */
export const BR = {
  chevron: `<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  folder: s('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>'),
  folderOpen: s('<path d="M3.5 18V6.5A1.5 1.5 0 0 1 5 5h4l2 2h6.5A1.5 1.5 0 0 1 19 8.5V10"/><path d="M3.5 18l3-8H22l-3 8z"/>'),
  sample: s('<path d="M2.5 12h2l1.5-4 2 8 2.5-12 2.5 13 2-9 1.5 4H21.5"/>'),
  tray: s('<path d="M4 13v5.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V13"/><path d="M12 3.5v10.5M8 10l4 4 4-4"/>'),
  project: s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18"/><rect x="6" y="5.5" width="5" height="2.5" fill="currentColor" stroke="none"/><rect x="12" y="10.5" width="6" height="2.5" fill="currentColor" stroke="none"/><rect x="7" y="15.5" width="7" height="2.5" fill="currentColor" stroke="none"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  play: `<svg viewBox="0 0 16 16"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>`,
  collapse: s('<path d="M7 9l5-5 5 5M7 20l5-5 5 5"/>'),
  addFolder: s('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 10.5v5M9.5 13h5"/>'),
};
