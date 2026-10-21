// Original glyphs for the main toolbar (24×24, currentColor). Drawn for LoopForge — bold, filled
// shapes so they read at toolbar size on the slate buttons.
const S = (d: string, sw = 1.9) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const F = (d: string) => `<svg viewBox="0 0 24 24" fill="currentColor">${d}</svg>`;

export const TB = {
  // transport
  play: F('<path d="M7.5 4.8v14.4c0 .6.7 1 1.2.7l11-7.2c.5-.3.5-1 0-1.4l-11-7.2c-.5-.3-1.2.1-1.2.7z"/>'),
  pause: F('<rect x="6" y="5" width="4.4" height="14" rx="1"/><rect x="13.6" y="5" width="4.4" height="14" rx="1"/>'),
  stop: F('<rect x="6.2" y="6.2" width="11.6" height="11.6" rx="1.4"/>'),
  record: F('<circle cx="12" cy="12" r="6.6"/>'),

  // recording options (row 1)
  metronome: S('<path d="M9.4 3.6h5.2l4.1 16.4H5.3z"/><path d="M12 15.6l5.6-9.4"/><circle cx="16" cy="8.9" r="1.5" fill="currentColor"/><path d="M8 15.8h8"/>'),
  waitInput: S('<rect x="2.6" y="9.2" width="11.4" height="10.2" rx="1.2"/><path d="M6.4 9.2v6M10.2 9.2v6"/><circle cx="17.6" cy="8.2" r="4.4"/><path d="M17.6 6.2v2.3l1.6 1"/>', 1.7),
  countdown: `<svg viewBox="0 0 24 24"><text x="12" y="16.4" text-anchor="middle" font-size="11.5" font-weight="700" font-style="italic" font-family="Arial, Helvetica, sans-serif" letter-spacing="-0.6" fill="currentColor">3.2.1</text></svg>`,
  stepEdit: S('<rect x="2.6" y="6" width="12.6" height="12.4" rx="1.2"/><path d="M6.8 6v8M11 6v8"/><path d="M19.4 8.6v6.8M16 12h6.8"/>', 1.8),
  blend: S('<rect x="2.6" y="6" width="11" height="12.4" rx="1.2"/><path d="M6.3 6v8M9.9 6v8"/><path d="M17.3 8.2a4 4 0 1 1-1.7 7.4"/><path d="M18.9 5.6l-1.8 2.7 2.9 1"/>', 1.8),

  // row 2 options
  typing: S('<rect x="2" y="6.6" width="20" height="11.4" rx="1.8"/><path d="M5.6 10.3h.01M8.8 10.3h.01M12 10.3h.01M15.2 10.3h.01M18.4 10.3h.01" stroke-width="2.4"/><path d="M7.2 14.4h9.6"/>', 1.8),
  toStart: F('<rect x="4.4" y="5" width="2.6" height="14" rx=".8"/><path d="M19.6 6.2v11.6c0 .7-.8 1.1-1.3.7l-8.7-5.8c-.5-.3-.5-1.1 0-1.4l8.7-5.8c.5-.4 1.3 0 1.3.7z"/>'),
  ghost: S('<path d="M5.6 20.2V10.4a6.4 6.4 0 0 1 12.8 0v9.8l-2.1-1.9-2.1 1.9-2.2-1.9-2.2 1.9-2.1-1.9z"/><circle cx="9.7" cy="10.6" r="1.1" fill="currentColor"/><circle cx="14.3" cy="10.6" r="1.1" fill="currentColor"/>', 1.7),
  link: S('<path d="M10.3 13.7a4 4 0 0 0 5.7 0l3.2-3.2a4 4 0 0 0-5.7-5.7l-1.1 1.1"/><path d="M13.7 10.3a4 4 0 0 0-5.7 0l-3.2 3.2a4 4 0 0 0 5.7 5.7l1.1-1.1"/>', 2.1),
  panic: S('<path d="M3.4 9.4h3.4l5-4.1v13.4l-5-4.1H3.4z" fill="currentColor"/><path d="M15.2 9.2l5.4 5.6M20.6 9.2l-5.4 5.6"/>', 2),
  magnet: S('<path d="M5.4 3.8h4.2v8.4a2.4 2.4 0 0 0 4.8 0V3.8h4.2v8.6a6.6 6.6 0 0 1-13.2 0z"/><path d="M5.4 7.8h4.2M14.4 7.8h4.2"/>', 1.6),

  // window shortcuts (row 2)
  playlist: S('<rect x="2.8" y="3.6" width="18.4" height="16.8" rx="1.6"/><rect x="5.4" y="6.6" width="6.6" height="2.8" rx=".7" fill="currentColor" stroke="none"/><rect x="10.8" y="10.6" width="7.8" height="2.8" rx=".7" fill="currentColor" stroke="none"/><rect x="6.6" y="14.6" width="6" height="2.8" rx=".7" fill="currentColor" stroke="none"/>', 1.6),
  pianoRoll: S('<rect x="2.8" y="3.6" width="18.4" height="16.8" rx="1.6"/><path d="M8 3.6v16.8"/><path d="M2.8 8h3M2.8 12h3M2.8 16h3"/><rect x="10.4" y="6.6" width="4.4" height="2.4" rx=".6" fill="currentColor" stroke="none"/><rect x="13.4" y="10.8" width="5.4" height="2.4" rx=".6" fill="currentColor" stroke="none"/><rect x="10" y="15" width="3.6" height="2.4" rx=".6" fill="currentColor" stroke="none"/>', 1.6),
  channelRack: S('<rect x="2.8" y="3.6" width="18.4" height="16.8" rx="1.6"/><path d="M7.6 3.6v16.8"/><rect x="9.6" y="6.4" width="2.6" height="2.6" rx=".5" fill="currentColor" stroke="none"/><rect x="14.4" y="6.4" width="2.6" height="2.6" rx=".5" fill="currentColor" stroke="none"/><rect x="12" y="10.7" width="2.6" height="2.6" rx=".5" fill="currentColor" stroke="none"/><rect x="16.6" y="10.7" width="2.6" height="2.6" rx=".5" fill="currentColor" stroke="none"/><rect x="9.6" y="15" width="2.6" height="2.6" rx=".5" fill="currentColor" stroke="none"/><rect x="14.4" y="15" width="2.6" height="2.6" rx=".5" fill="currentColor" stroke="none"/>', 1.6),
  mixer: S('<path d="M6 3.6v16.8M12 3.6v16.8M18 3.6v16.8"/><rect x="3.8" y="12.6" width="4.4" height="3.4" rx=".8" fill="currentColor"/><rect x="9.8" y="6.4" width="4.4" height="3.4" rx=".8" fill="currentColor"/><rect x="15.8" y="10.2" width="4.4" height="3.4" rx=".8" fill="currentColor"/>', 1.6),
  browser: S('<path d="M3 4.6h5.2l1.6 1.8H14v4.4H3z"/><path d="M6 10.8v7.6h4M6 14.6h4"/><rect x="10.4" y="12.6" width="10.6" height="3.8" rx=".8"/><rect x="10.4" y="16.6" width="10.6" height="3.8" rx=".8"/>', 1.5),
  plugin: S('<path d="M9 2.8v4.4M15 2.8v4.4"/><path d="M6 7.2h12v3.6a6 6 0 0 1-12 0z" fill="currentColor"/><path d="M12 16.8v4.4"/>', 1.9),
  instrument: S('<rect x="2.8" y="4.4" width="18.4" height="15.2" rx="1.6"/><path d="M5.6 8.6c1.4-3 2.6-3 4 0s2.6 3 4 0"/><path d="M2.8 13.4h18.4M7.4 13.4v6.2M12 13.4v6.2M16.6 13.4v6.2"/>', 1.6),
  info: S('<path d="M5.6 2.8h8.6l4.2 4.2v14.2H5.6z"/><path d="M14 2.8v4.4h4.4"/><path d="M8.6 11h6.8M8.6 14.2h6.8M8.6 17.4h4.4"/>', 1.6),
  settings: S('<path d="M4 6.6h9.4M17.6 6.6H20M4 12h3M11.2 12H20M4 17.4h7.4M15.6 17.4H20"/><circle cx="15.4" cy="6.6" r="2.1"/><circle cx="9.1" cy="12" r="2.1"/><circle cx="13.5" cy="17.4" r="2.1"/>', 1.7),
  arrange: S('<rect x="3" y="3.6" width="8.2" height="7.6" rx="1.2"/><rect x="12.8" y="3.6" width="8.2" height="7.6" rx="1.2"/><rect x="3" y="12.8" width="18" height="7.6" rx="1.2"/>', 1.6),

  // utilities (row 1, right)
  history: S('<path d="M4.4 12a7.6 7.6 0 1 0 2.3-5.4"/><path d="M4 3.8v4.4h4.4"/><path d="M12 8v4.4l2.8 1.8"/>', 2),
  undo: S('<path d="M9 14.4L4 9.4l5-5"/><path d="M4 9.4h10.4a5.6 5.6 0 0 1 0 11.2H11"/>', 2.1),
  mic: S('<rect x="9" y="2.8" width="6" height="11.2" rx="3" fill="currentColor"/><path d="M5.6 11.2a6.4 6.4 0 0 0 12.8 0M12 17.6v3.6M8.6 21.2h6.8"/>', 1.9),
  help: S('<path d="M8.4 8.6a3.7 3.7 0 1 1 5.4 3.2c-1.1.6-1.8 1.3-1.8 2.6v.6"/><circle cx="12" cy="18.8" r="1.3" fill="currentColor" stroke="none"/>', 2.4),
  save: S('<path d="M4 3.8h12.4L20.2 7.6v12.6H4z"/><path d="M7.6 3.8v5h8v-5"/><rect x="7.6" y="13.2" width="8.8" height="7" rx=".6" fill="currentColor"/>', 1.7),
  render: S('<path d="M4 3.8h12.4L20.2 7.6v12.6H4z"/><path d="M7.6 3.8v4.4h7.6V3.8"/><path d="M6.6 15h1.6l1.4-3.2 2 6.4 2-8.2 1.6 5h2.2"/>', 1.6),
  palette: S('<path d="M4 4.6h16a1 1 0 0 1 1 1v9.6a1 1 0 0 1-1 1h-9.4l-4.8 3.8v-3.8H4a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1z"/><path d="M7.4 9h9.2M7.4 12.2h6"/>', 1.7),
  open: S('<path d="M3.6 13.6v6.2h16.8v-6.2"/><path d="M12 3.4v11M7.4 9.8l4.6 4.6 4.6-4.6"/>', 2.1),

  // misc
  eye: S('<path d="M2.4 12s3.6-6.2 9.6-6.2 9.6 6.2 9.6 6.2-3.6 6.2-9.6 6.2S2.4 12 2.4 12z"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>', 1.6),
  bulb: S('<path d="M9.2 17.4h5.6M10.2 20.6h3.6"/><path d="M8.4 14.4a6 6 0 1 1 7.2 0c-.8.6-1 1.4-1 2.4H9.4c0-1-.2-1.8-1-2.4z"/>', 1.6),
  caret: `<svg viewBox="0 0 10 10"><path d="M3.4 2l3.6 3-3.6 3z" fill="currentColor"/></svg>`,
  spinUp: `<svg viewBox="0 0 10 6"><path d="M1.5 5L5 1.5 8.5 5z" fill="currentColor"/></svg>`,
  spinDown: `<svg viewBox="0 0 10 6"><path d="M1.5 1L5 4.5 8.5 1z" fill="currentColor"/></svg>`,
  plus: S('<path d="M12 5v14M5 12h14"/>', 2.4),
};

export type TbIcon = keyof typeof TB;
