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
  riffstack: '#e8634a',
};

export const FX_ICON: Record<FxType, string> = {
  riffstack: s('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="2.2"/><circle cx="16" cy="12" r="2.2"/><path d="M3 9h18"/>'),
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

const f = (d: string) => `<svg viewBox="0 0 24 24" fill="currentColor">${d}</svg>`;

/** FL-style colour coding of the browser's top-level entries (text + icon). */
export const BR_TINT = {
  project: '#dcae95',
  recent: '#9fc679',
  plugins: '#b4d3f0',
  pluginsDim: '#8eabcb',
  library: '#cdd6dc',
  user: '#cdd6dc',
  starred: '#ecd36a',
  leaf: '#cfd3d6',
};

/** Browser tree glyphs (filled where FL uses solid icons). */
export const BI = {
  page: f('<path d="M5 2.5h9.2L19 7.3V21.5H5z" opacity=".95"/><path d="M14 2.5v5h5" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="1.2"/>'),
  recent: s('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M9 13.2a3.2 3.2 0 1 0 1-2.3"/><path d="M9.6 9.4v2h2"/>'),
  plugDb: f('<path d="M3 9h4.2L13 4.2v15.6L7.2 15H3z"/><path d="M16 8.6c1.2 1 1.8 2.2 1.8 3.4s-.6 2.4-1.8 3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.6 6c2 1.6 3 3.6 3 6s-1 4.4-3 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity=".6"/>'),
  plug: f('<rect x="8.2" y="2.5" width="2" height="5" rx=".8"/><rect x="13.8" y="2.5" width="2" height="5" rx=".8"/><path d="M6.5 7.5h11v3.2a5.5 5.5 0 0 1-4.4 5.4V21.5h-2.2v-5.4a5.5 5.5 0 0 1-4.4-5.4z"/>'),
  presets: f('<path d="M4 3.5h11l4 4V20.5H4z" opacity=".9"/><path d="M7 11h9M7 14h9M7 17h6" stroke="#000" stroke-opacity=".4" stroke-width="1.4"/>'),
  packs: f('<path d="M12 2.8l8.4 4.2L12 11.2 3.6 7z"/><path d="M3.6 9.6l7.6 3.8v8.2l-7.6-3.8z" opacity=".75"/><path d="M20.4 9.6l-7.6 3.8v8.2l7.6-3.8z" opacity=".55"/>'),
  folder: f('<path d="M2.8 6.2A1.4 1.4 0 0 1 4.2 4.8h4.6l2 2h9a1.4 1.4 0 0 1 1.4 1.4v10.4a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4z"/>'),
  folderOpen: f('<path d="M2.8 6.2A1.4 1.4 0 0 1 4.2 4.8h4.6l2 2h7.6a1.4 1.4 0 0 1 1.4 1.4V10H7.2a1.6 1.6 0 0 0-1.5 1.1L2.8 19z" opacity=".7"/><path d="M6.4 11.2h15.4L18.6 20H3.6z"/>'),
  tray: f('<path d="M3 13.5h5l1.2 2.2h5.6l1.2-2.2h5V20H3z"/><path d="M12 3.2v8.2M8.6 8.2L12 11.6l3.4-3.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  star: f('<path d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/>'),
  keys: f('<rect x="2.5" y="5" width="19" height="14" rx="1.6" opacity=".95"/><path d="M8.2 12v7M12 12v7M15.8 12v7" stroke="#000" stroke-opacity=".45" stroke-width="1.2"/><rect x="6.6" y="5" width="2.8" height="7" fill="#000" fill-opacity=".55"/><rect x="14.6" y="5" width="2.8" height="7" fill="#000" fill-opacity=".55"/>'),
  knob: f('<circle cx="12" cy="12" r="8.6" opacity=".95"/><path d="M12 12L7.2 7.2" stroke="#000" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round"/>'),
  gear: f('<path d="M10.4 2.6h3.2l.5 2.4 1.7.8 2.1-1.3 2.3 2.3-1.3 2.1.8 1.7 2.4.5v3.2l-2.4.5-.8 1.7 1.3 2.1-2.3 2.3-2.1-1.3-1.7.8-.5 2.4h-3.2l-.5-2.4-1.7-.8-2.1 1.3-2.3-2.3 1.3-2.1-.8-1.7-2.4-.5v-3.2l2.4-.5.8-1.7-1.3-2.1 2.3-2.3 2.1 1.3 1.7-.8z"/><circle cx="12" cy="12" r="3.2" fill="#000" fill-opacity=".5"/>'),
  rack: s('<rect x="3" y="4" width="18" height="16" rx="1.6"/><path d="M3 9.3h18M3 14.6h18M8 4v16"/>'),
  pattern: f('<rect x="3" y="4" width="18" height="16" rx="2" opacity=".35"/><rect x="5.5" y="7" width="4" height="3" rx=".6"/><rect x="11" y="7" width="4" height="3" rx=".6"/><rect x="8" y="11" width="4" height="3" rx=".6"/><rect x="14" y="14.5" width="4" height="3" rx=".6"/>'),
  mixer: s('<path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1" fill="currentColor"/><rect x="10" y="7" width="4" height="3" rx="1" fill="currentColor"/><rect x="16" y="11" width="4" height="3" rx="1" fill="currentColor"/>'),
  project: f('<path d="M5 2.5h9.2L19 7.3V21.5H5z" opacity=".95"/><path d="M8.5 16.5V10l7-1.4v6.4" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="1.5"/><circle cx="7.6" cy="16.6" r="1.4" fill="#000" fill-opacity=".45"/><circle cx="14.6" cy="15.2" r="1.4" fill="#000" fill-opacity=".45"/>'),
  locate: s('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>'),
  up: s('<path d="M12 19.5V5M6 10.5l6-6 6 6"/>'),
  menu: `<svg viewBox="0 0 16 16"><path d="M5.5 3.5l5 4.5-5 4.5z" fill="currentColor"/></svg>`,
  caretDown: `<svg viewBox="0 0 16 16"><path d="M4 6l4 4.5L12 6z" fill="currentColor"/></svg>`,
  caretRight: `<svg viewBox="0 0 16 16"><path d="M6 4l4.5 4L6 12z" fill="currentColor"/></svg>`,
  search: s('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>'),
  folderSmall: s('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>'),
};

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
