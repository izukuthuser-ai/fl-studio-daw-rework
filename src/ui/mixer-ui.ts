// Shared helpers for the Mixer window modules: icons, selection, routing / track / effect / input menus.
import { store } from '../core/store';
import { commands } from '../core/commands';
import { engine } from '../audio/engine';
import { FxType, MixerTrack } from '../core/types';
import { FX_DEFS, FX_ORDER } from '../core/params';
import { PALETTE, clamp } from '../core/util';
import { MenuItem, colorMenu, showMenu, toast } from './widgets';
import { createAutomation, createsLoop, linkChannelsToTrack } from './ops';
import { exportAudio } from './fileops';
import { DT_FX } from './dnd';
import {
  deleteTracks,
  destOf,
  insertTrackAfter,
  moveTrack,
  renameTrack,
  routeTracks,
  setArmed,
  setColor,
  setInput,
  soloTrack,
  targetsFor,
  trackLabel,
  unmuteAll,
} from './mixer-ops';

/** Drag type for reordering effect slots inside the rack. */
export const DT_FXSLOT = 'application/x-loopforge-fxslot';

const svg = (d: string, vb = '0 0 24 24') => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const IC = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  unmute: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10"/>'),
  render: svg('<path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 17v2.5h14V17"/>'),
  panel: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/>'),
  more: svg('<circle cx="12" cy="6" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/>'),
  tri: `<svg viewBox="0 0 8 10"><path d="M1.5 1l5 4-5 4z" fill="currentColor"/></svg>`,
  left: `<svg viewBox="0 0 8 10"><path d="M6.5 1l-5 4 5 4z" fill="currentColor"/></svg>`,
  send: `<svg viewBox="0 0 12 9"><path d="M6 1.2L11 7.8H1z" fill="currentColor"/></svg>`,
  sendIn: `<svg viewBox="0 0 12 9"><path d="M6 1.9L10.2 7.4H1.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  out: `<svg viewBox="0 0 12 12"><path d="M4.2 1.5h3.6v4.2h2.7L6 10.8 1.5 5.7h2.7z" fill="currentColor"/></svg>`,
  arm: `<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6" r="2.3" fill="currentColor"/></svg>`,
  jackIn: svg('<path d="M3 12h9"/><path d="M9 8.5L12.5 12 9 15.5"/><rect x="13.5" y="6" width="7" height="12" rx="2"/>'),
  jackOut: svg('<rect x="3.5" y="6" width="7" height="12" rx="2"/><path d="M12 12h9"/><path d="M18 8.5L21.5 12 18 15.5"/>'),
  menu: `<svg viewBox="0 0 10 10"><path d="M3 1.5l4 3.5-4 3.5z" fill="currentColor"/></svg>`,
};

export function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}
export function setHint(e: HTMLElement, s: string) {
  if (e.dataset.hint !== s) e.dataset.hint = s;
}
export function keyFor(id: string): string {
  return commands.keysFor(id)[0] ?? '';
}
/** Keep a root menu inside the window with room for a submenu on its right. */
export function fitX(x: number, need: number) {
  return Math.max(0, Math.min(x, innerWidth - need));
}

/** Hooks the window installs so menus can scroll the strip area. */
export const mxHooks = {
  ensureVisible: (_i: number) => {},
};

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------
export function selectTrack(i: number, multi: number[] = [i]) {
  store.setUI({ selectedMixer: i, selectedMixerTracks: multi });
}

export function clickSelect(i: number, e: PointerEvent | MouseEvent) {
  const ui = store.ui;
  if (e.ctrlKey || e.metaKey) {
    const set = new Set(ui.selectedMixerTracks.length ? ui.selectedMixerTracks : [ui.selectedMixer]);
    if (set.has(i) && set.size > 1) {
      set.delete(i);
      const rest = [...set].sort((a, b) => a - b);
      selectTrack(ui.selectedMixer === i ? rest[rest.length - 1] : ui.selectedMixer, rest);
    } else {
      set.add(i);
      selectTrack(i, [...set].sort((a, b) => a - b));
    }
  } else if (e.shiftKey) {
    const a = Math.min(ui.selectedMixer, i), b = Math.max(ui.selectedMixer, i);
    selectTrack(i, Array.from({ length: b - a + 1 }, (_, k) => a + k));
  } else selectTrack(i);
}

export function selIndex() {
  return clamp(store.ui.selectedMixer, 0, store.project.mixer.length - 1);
}

export function automateTrack(trackId: string, param: 'volDb' | 'pan' | 'width') {
  const isMaster = store.project.mixer[0]?.id === trackId;
  createAutomation({ scope: isMaster ? 'master' : 'mixer', id: trackId, param });
}

// ---------------------------------------------------------------------------
// live input state
// ---------------------------------------------------------------------------
export type InputState = 'none' | 'live' | 'pending' | 'error';

export function inputState(t: MixerTrack | undefined): InputState {
  if (!t?.input) return 'none';
  const inp = engine.ready ? engine.inputs : null;
  if (!inp) return 'pending';
  if (inp.isLive(t.id)) return 'live';
  if (inp.error) return 'error';
  return 'pending';
}

export function inputOptions(): { value: string; label: string }[] {
  const inp = engine.ready ? engine.inputs : null;
  return inp ? inp.options() : [{ value: '', label: '(none)' }, { value: 'default', label: 'Default input' }];
}

export function inputLabel(dev: string | undefined): string {
  if (!dev) return '(none)';
  return inputOptions().find((o) => o.value === dev)?.label ?? 'Unavailable input';
}

export function inputItems(i: number): MenuItem[] {
  const cur = store.project.mixer[i]?.input ?? '';
  return inputOptions().map((o) => ({ label: o.label, checked: o.value === cur, action: () => setInput([i], o.value) }));
}

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------
export function routeItems(i: number): MenuItem[] {
  const m = store.project.mixer;
  const tg = targetsFor(i).filter((k) => k > 0);
  const dest = destOf(m, i);
  const items: MenuItem[] = [];
  m.forEach((t, j) => {
    if (j === i) return;
    items.push({
      label: trackLabel(j),
      color: t.color,
      checked: dest === j,
      disabled: createsLoop(m, i, j),
      action: () => routeTracks(tg.length ? tg : [i], j),
    });
  });
  return items;
}

/** FL send switch: route the selected track(s) to `j`; clicking an active send routes back to the master. */
export function sendSelectedTo(j: number) {
  const m = store.project.mixer;
  const sel = store.ui.selectedMixer;
  if (sel <= 0 || sel === j) {
    if (sel === 0) toast('Select an insert track first, then click the arrow under its destination', 'info');
    return;
  }
  const from = targetsFor(sel).filter((k) => k > 0 && k !== j);
  if (j > 0 && from.every((k) => destOf(m, k) === j)) routeTracks(from, 0);
  else routeTracks(from, j);
}

export function stripMenu(i: number, x: number, y: number) {
  const m = store.project.mixer;
  const t = m[i];
  if (!t) return;
  const M = i === 0;
  const tg = targetsFor(i);
  const nCh = store.ui.selectedChannels.length;
  const items: MenuItem[] = [
    { label: 'Rename…', shortcut: keyFor('mixer.rename'), action: () => renameTrack(i) },
    { label: tg.length > 1 ? `Color (${tg.length} tracks)…` : 'Color…', action: () => colorMenu(PALETTE, (c) => setColor(tg, c), x, y) },
    M ? { label: 'Route to (master feeds the output)', disabled: true } : { label: tg.length > 1 ? `Route ${tg.length} tracks to` : 'Route to', submenu: routeItems(i) },
    { label: 'Audio input', submenu: inputItems(i) },
    {
      label: nCh ? `Link ${nCh} selected channel${nCh > 1 ? 's' : ''} to this track` : 'Link selected channels to this track',
      shortcut: keyFor('mixer.link'),
      disabled: !nCh,
      action: () => linkChannelsToTrack(i, store.ui.selectedChannels),
    },
    { sep: true },
    { label: 'Insert track after', action: () => mxHooks.ensureVisible(insertTrackAfter(i)) },
    { label: M ? 'Delete track (master can’t be deleted)' : tg.length > 1 ? `Delete ${tg.length} tracks` : 'Delete track', disabled: M || !tg.some((k) => k > 0), action: () => deleteTracks(tg) },
    { label: 'Move left', shortcut: keyFor('mixer.moveLeft'), disabled: i <= 1, action: () => mxHooks.ensureVisible(moveTrack(i, -1)) },
    { label: 'Move right', shortcut: keyFor('mixer.moveRight'), disabled: M || i >= m.length - 1, action: () => mxHooks.ensureVisible(moveTrack(i, 1)) },
    { sep: true },
    { label: 'Arm for recording / render', checked: t.armed, disabled: M, action: () => setArmed(tg, !t.armed) },
    { label: 'Solo', shortcut: keyFor('mixer.solo'), disabled: M, action: () => soloTrack(i) },
    { label: 'Solo with routing', shortcut: keyFor('mixer.soloRouting'), disabled: M, action: () => soloTrack(i, true) },
    { label: 'Unmute all tracks', action: unmuteAll },
  ];
  showMenu(items, fitX(x, 460), y);
}

export function fxPickItems(onPick: (type: FxType) => void, current?: FxType): MenuItem[] {
  return FX_ORDER.filter((type) => FX_DEFS[type]).map((type) => ({ label: FX_DEFS[type].name, checked: current === type, action: () => onPick(type) }));
}

export function readFxDrop(e: DragEvent): FxType | null {
  try {
    const s = e.dataTransfer?.getData(DT_FX);
    if (!s) return null;
    const d = JSON.parse(s);
    const type = (typeof d === 'string' ? d : d?.type) as FxType;
    return FX_DEFS[type] ? type : null;
  } catch {
    return null;
  }
}

export function renderArmed() {
  const armed = store.project.mixer.map((t, i) => (i > 0 && t.armed ? i : -1)).filter((i) => i > 0);
  if (!armed.length) {
    toast('No tracks are armed — click the arm button on a strip (or right-click → Arm)', 'warn', 3200);
    return;
  }
  exportAudio('wav', armed);
}
