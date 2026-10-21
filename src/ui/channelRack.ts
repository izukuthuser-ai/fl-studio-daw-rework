// Channel Rack (F6), FL 21 layout: one DOM row per channel — mute LED, pan + volume knobs, mixer
// track box, the channel button (channel coloured, instrument icon), the select bar and the step
// strip. Rows are keyed by channel id and updated in place; the row list is only restructured when
// the visible channel list changes, and a row's step strip only when its mode (steps / mini piano
// roll / waveform) or the step count changes. Optional graph editor (velocity / pan per step) and
// piano-roll view, like FL's header toggles.
import './channelRack.css';
import { store } from '../core/store';
import { commands, Command } from '../core/commands';
import { engine } from '../audio/engine';
import { samples } from '../audio/samples';
import { BUILTIN_SOUNDS, BuiltinSound } from '../audio/sounds';
import { getInstrument } from '../audio/plugins/registry';
import { Channel, ID, Note, Pattern, STEP } from '../core/types';
import { CHANNEL_PARAMS, ParamDef } from '../core/params';
import { SYNTH_PRESETS } from '../core/project';
import { clamp, el, hexToRgb, rgba } from '../core/util';
import { KnobEl, MenuItem, drag, knob, lockHint, showMenu, toast } from './widgets';
import { addChannel, cloneChannels, createAutomation, routeToFreeTracks } from './ops';
import { hooks, patternMenu } from './actions';
import { DT_PRESET, DT_SAMPLE, hasType, pickSamples, readDrag, samplesFromDrop } from './dnd';
import { ICONS } from './icons';
import { wm } from './wm';
import type { PanelDef } from './panel';
import { openPluginWindow } from './pluginWindow';
import {
  BASE_GROUPS,
  DT_PLUGIN,
  InstrumentChoice,
  addInstrumentChannel,
  addSamplerChannel,
  addSynthChannel,
  applyPreset,
  clearSteps,
  colorChannels,
  confirmDelete,
  confirmReplace,
  copySteps,
  cutSteps,
  fillSteps,
  groupOf,
  groupOptions,
  instrumentChoices,
  isStepNote,
  moveChannels,
  orderedSelection,
  pasteSteps,
  promptGroup,
  renameChannel,
  replaceInstrument,
  replaceSample,
  resolveInstrument,
  setGroup,
  setMixerTrack,
  soloChannel,
  stepCount,
  toggleMute,
  visibleChannels,
  writeStep,
} from './channelRack-ops';

// geometry of the step strip (kept in sync with channelRack.css through CSS variables)
const SW = 16; // step width
const SG = 2; // gap between steps
const GG = 6; // gap between groups of 4
const ROW_H = 24; // step / preview height
const GRAPH_H = 66; // graph editor height

const stepX = (i: number) => i * (SW + SG) + Math.floor(i / 4) * (GG - SG);
const stripW = (n: number) => (n ? stepX(n - 1) + SW : 0);
/** Step index under x (strip-local), tolerant of the gaps. */
function stepAt(x: number, n: number): number {
  const group = SW * 4 + SG * 3 + GG;
  const g = Math.floor(x / group);
  const within = x - g * group;
  const k = clamp(Math.floor(within / (SW + SG)), 0, 3);
  return clamp(g * 4 + k, 0, Math.max(0, n - 1));
}

const SWING_DEF: ParamDef = { key: 'swing', label: 'Swing', min: 0, max: 1, def: 0, fmt: (v) => Math.round(v * 100) + '%' };

const svg = (d: string, sw = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  plus: svg('<path d="M12 5v14M5 12h14"/>', 2.4),
  caret: svg('<path d="M6 9l6 6 6-6"/>'),
  arrow: `<svg viewBox="0 0 24 24"><path d="M8 5l9 7-9 7z" fill="currentColor"/></svg>`,
  steps: svg('<rect x="3" y="7" width="4" height="10" rx="1"/><rect x="10" y="7" width="4" height="10" rx="1"/><rect x="17" y="7" width="4" height="10" rx="1"/>'),
  graph: svg('<path d="M4 20V13M9 20V6M14 20v-9M19 20V9"/><path d="M2.5 20.5h19"/>', 2.2),
  roll: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18"/><path d="M7 6.5h5M12 12h6M6 17.5h4" stroke-width="2.6"/>', 1.6),
  filter: svg('<path d="M4 5h16l-6 7v6l-4 2v-8z"/>'),
  target: svg('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>', 1.8),
};

const keyFor = (id: string) => commands.keysFor(id)[0] ?? '';
function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}
function setHint(e: HTMLElement, s: string) {
  if (e.dataset.hint !== s) e.dataset.hint = s;
}
function mixRgb(a: string, b: string, t: number, lift = 0): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  const f = (i: number) => {
    let v = A[i] + (B[i] - A[i]) * t;
    v = lift >= 0 ? v + (255 - v) * lift : v * (1 + lift);
    return Math.round(clamp(v, 0, 255));
  };
  return `rgb(${f(0)},${f(1)},${f(2)})`;
}

// view prefs (FL header toggles)
const PREF = 'lf.cr.view';
function loadView(): { graph: boolean; roll: boolean; graphMode: 'vel' | 'pan' } {
  try {
    const v = JSON.parse(localStorage.getItem(PREF) ?? '{}') ?? {};
    return { graph: !!v.graph, roll: !!v.roll, graphMode: v.graphMode === 'pan' ? 'pan' : 'vel' };
  } catch {
    return { graph: false, roll: false, graphMode: 'vel' };
  }
}
const view = loadView();
function saveView() {
  try {
    localStorage.setItem(PREF, JSON.stringify(view));
  } catch {}
}

/** Small instrument glyph shown on the right of a channel button. */
function instrumentIcon(c: Channel): string {
  if (c.type === 'plugin') return getInstrument(c.plugin?.type)?.icon ?? ICONS.plugin;
  if (c.audioClip) return ICONS.wave;
  if (c.type === 'synth') return ICONS.synth;
  return '';
}
function instrumentName(c: Channel): string {
  if (c.type === 'plugin') return getInstrument(c.plugin?.type)?.name ?? c.plugin?.type ?? 'Plugin';
  if (c.type === 'synth') return 'Tri-Osc synth';
  return c.audioClip ? 'Audio clip' : `Sampler · ${c.sampler?.sampleName || 'empty'}`;
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------
let anchorId: ID | null = null;
let cursorId: ID | null = null;

function selectOnly(id: ID) {
  anchorId = cursorId = id;
  store.setUI({ selectedChannels: [id], pianoRollChannel: id });
}

function clickSelect(id: ID, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  const cur = store.ui.selectedChannels;
  if (e.ctrlKey || e.metaKey) {
    if (cur.includes(id)) {
      if (cur.length > 1) store.setUI({ selectedChannels: cur.filter((x) => x !== id) });
    } else store.setUI({ selectedChannels: [id, ...cur] });
    anchorId = cursorId = id;
  } else if (e.shiftKey) {
    const vis = visibleChannels().map((c) => c.id);
    const a = vis.indexOf(anchorId && vis.includes(anchorId) ? anchorId : cur.find((x) => vis.includes(x)) ?? id);
    const b = vis.indexOf(id);
    const range = vis.slice(Math.min(a, b), Math.max(a, b) + 1);
    cursorId = id;
    store.setUI({ selectedChannels: [id, ...range.filter((x) => x !== id)] });
  } else selectOnly(id);
}

function toggleSelected(id: ID) {
  clickSelect(id, { ctrlKey: true, metaKey: false, shiftKey: false });
}

function openSettings(id: ID) {
  openPluginWindow(id, 'show');
}

/** The window a channel button opens: its plugin window, or Channel settings for Sampler / Tri-Osc. */
function windowOpenFor(id: ID): string | null {
  const c = store.channel(id);
  if (!c) return null;
  if (c.type === 'plugin') return wm.get('plugin:' + id)?.visible ? 'plugin:' + id : null;
  return wm.get('channelsettings')?.visible && store.ui.settingsChannel === id ? 'channelsettings' : null;
}

/** FL: clicking a channel button opens its window, clicking again closes it. */
function toggleChannelWindow(id: ID) {
  const open = windowOpenFor(id);
  if (open) wm.hide(open);
  else openPluginWindow(id, 'show');
}

function openPianoRoll(id: ID) {
  store.setUI({ pianoRollChannel: id, selectedChannels: store.ui.selectedChannels.includes(id) ? store.ui.selectedChannels : [id] });
  wm.show('pianoroll');
}

/** Ids an action on `id` applies to: the whole selection when `id` is part of it. */
function targetsFor(id: ID): ID[] {
  return store.ui.selectedChannels.includes(id) ? orderedSelection() : [id];
}

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------
function groupItems(ids: ID[]): MenuItem[] {
  const cur = store.channel(ids[0]);
  const names = [...BASE_GROUPS];
  for (const c of store.project.channels) if (!names.includes(groupOf(c))) names.splice(names.length - 1, 0, groupOf(c));
  return [
    ...names.map((g) => ({ label: g, checked: !!cur && groupOf(cur) === g, action: () => setGroup(ids, g) })),
    { sep: true },
    { label: 'New group…', shortcut: keyFor('cr.group'), action: () => promptGroup(ids) },
  ];
}

function replaceItems(id: ID): MenuItem[] {
  const ch = store.channel(id);
  const cur = ch?.type === 'plugin' ? ch.plugin?.type : ch?.type;
  return instrumentChoices().map((c: InstrumentChoice) => ({
    label: c.name,
    checked: (c.kind === 'plugin' ? c.pluginType : c.kind) === cur,
    action: () => {
      const nid = replaceInstrument(id, c);
      if (nid) toast(`${store.channel(nid)?.name ?? 'Channel'} now uses ${c.name}`, 'ok', 1400);
    },
  }));
}

function channelMenu(id: ID, x: number, y: number) {
  const ch = store.channel(id);
  if (!ch) return;
  const ids = targetsFor(id);
  const many = ids.length > 1 ? ` (${ids.length})` : '';
  const vis = visibleChannels();
  const vi = vis.findIndex((c) => c.id === id);
  const items: MenuItem[] = [
    { label: 'Piano roll', shortcut: 'F7', action: () => openPianoRoll(id) },
    { label: ch.type === 'plugin' ? 'Plugin window…' : 'Channel settings…', shortcut: keyFor('cr.settings'), action: () => openSettings(id) },
    { label: 'Replace with', disabled: !!ch.audioClip, submenu: replaceItems(id) },
    { sep: true },
    { label: 'Rename…', shortcut: keyFor('cr.rename'), action: () => renameChannel(id) },
    { label: 'Color…' + many, action: () => colorChannels(ids, x, y) },
    { label: 'Clone' + many, shortcut: keyFor('cr.clone'), action: () => cloneChannels(ids) },
    { label: 'Delete' + many + '…', shortcut: keyFor('cr.delete'), action: () => confirmDelete(ids) },
    { label: 'Route to free mixer track' + many, shortcut: keyFor('cr.route'), action: () => routeToFreeTracks(ids) },
    { sep: true },
    { label: 'Fill each 2 steps', action: () => fillSteps(ids, 2) },
    { label: 'Fill each 4 steps', shortcut: keyFor('cr.fill4'), action: () => fillSteps(ids, 4) },
    { label: 'Fill each 8 steps', action: () => fillSteps(ids, 8) },
    { label: 'Clear', action: () => clearSteps(ids) },
    { sep: true },
    { label: 'Move up', shortcut: keyFor('cr.moveUp'), disabled: vi <= 0, action: () => moveChannels(ids, -1) },
    { label: 'Move down', shortcut: keyFor('cr.moveDown'), disabled: vi < 0 || vi >= vis.length - 1, action: () => moveChannels(ids, 1) },
    { label: 'Group', submenu: groupItems(ids) },
  ];
  showMenu(items, Math.max(0, Math.min(x, innerWidth - 440)), y);
}

function addMenuItems(): MenuItem[] {
  const cats = new Map<string, BuiltinSound[]>();
  for (const s of BUILTIN_SOUNDS) {
    const arr = cats.get(s.category) ?? [];
    arr.push(s);
    cats.set(s.category, arr);
  }
  const plugins = instrumentChoices().filter((c) => c.kind === 'plugin');
  return [
    ...plugins.map((c) => ({ label: c.name, action: () => addInstrumentChannel(c) })),
    {
      label: 'Tri-Osc Synth',
      submenu: SYNTH_PRESETS.map((p) => ({ label: p.name === 'Init' ? 'Init (empty patch)' : p.name, action: () => addSynthChannel(p.name) })),
    },
    {
      label: 'Sampler',
      submenu: [
        { label: 'Empty sampler', action: () => addSamplerChannelEmpty() },
        { sep: true },
        ...[...cats].map(([cat, list]) => ({
          label: cat,
          submenu: list.map((s) => ({ label: s.name, action: () => addSamplerChannel({ ref: 'builtin:' + s.id, name: s.name }) })),
        })),
      ],
    },
    { sep: true },
    {
      label: 'Load audio file…',
      action: async () => {
        const list = await pickSamples();
        for (const s of list) addSamplerChannel(s);
        if (list.length > 1) toast(`Added ${list.length} sampler channels`, 'ok', 1400);
      },
    },
    { label: 'More plugins…', shortcut: 'F8', action: () => hooks.openPluginPicker() },
  ];
}

function addSamplerChannelEmpty() {
  const g = store.ui.channelGroup;
  addChannel('sampler', { name: 'Sampler', group: g && g !== 'All' ? g : 'Unsorted' });
}

// ---------------------------------------------------------------------------
// row
// ---------------------------------------------------------------------------
type Mode = 'steps' | 'preview' | 'wave';

interface Ctx {
  pattern: Pattern;
  n: number;
  spb: number; // steps per bar
  sel: Set<ID>;
  primary: ID | undefined;
  mixerNames: string[];
}

class Row {
  readonly root: HTMLElement;
  private led: HTMLElement;
  private pan: KnobEl;
  private vol: KnobEl;
  private mix: HTMLElement;
  private btn: HTMLElement;
  private btnTxt: HTMLElement;
  private btnIcon: HTMLElement;
  private area: HTMLElement;
  private selEl: HTMLElement;
  mode: Mode | '' = '';
  private n = 0;
  private spb = 16;
  private steps: HTMLElement[] = [];
  private stepState: number[] = []; // -1 = off, -2 = muted note, else velocity
  private canvas: HTMLCanvasElement | null = null;
  private ph: HTMLElement | null = null;
  private drawSig = '';
  private playIdx = -1;
  private last: Record<string, unknown> = {};
  private knobOpts: { name?: string }[] = [];

  constructor(readonly id: ID) {
    this.led = el('div', { class: 'led cr-led' });
    this.led.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.led.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) soloChannel(this.id);
      else toggleMute([this.id]);
    });
    this.led.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      soloChannel(this.id);
    });

    const knobOpts = (key: 'pan' | 'vol') => ({
      def: CHANNEL_PARAMS[key],
      size: 19,
      bipolar: key === 'pan',
      name: '',
      get: () => (this.ch()?.[key] as number) ?? CHANNEL_PARAMS[key].def,
      set: (v: number) =>
        store.live((p) => {
          const c = p.channels.find((x) => x.id === this.id);
          if (c) c[key] = v;
        }),
      begin: () => store.begin(key === 'pan' ? 'Channel pan' : 'Channel volume'),
      end: () => store.end(),
      onAutomate: () => createAutomation({ scope: 'channel', id: this.id, param: key }),
    });
    const panOpts = knobOpts('pan');
    const volOpts = knobOpts('vol');
    this.pan = knob(panOpts);
    this.vol = knob(volOpts);
    this.pan.classList.add('cr-pan');
    this.vol.classList.add('cr-vol');
    this.knobOpts = [panOpts, volOpts];

    this.mix = el('div', { class: 'cr-mix' });
    this.mix.addEventListener('pointerdown', (e) => this.mixDrag(e));
    this.mix.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const c = this.ch();
        if (c) setMixerTrack(this.id, c.mixer + (e.deltaY < 0 ? 1 : -1));
      },
      { passive: false },
    );

    // channel button: click = select + open / close its window (FL), Ctrl = add to selection, Shift = range
    this.btnTxt = el('span', { class: 'cr-btn-t' });
    this.btnIcon = el('span', { class: 'cr-btn-i' });
    this.btn = el('div', { class: 'cr-btn' }, this.btnTxt, this.btnIcon);
    let plain = false;
    this.btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      plain = !(e.ctrlKey || e.metaKey || e.shiftKey);
      clickSelect(this.id, e);
    });
    this.btn.addEventListener('click', (e) => {
      if (e.button !== 0 || !plain) return;
      plain = false;
      toggleChannelWindow(this.id);
    });
    this.btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!store.ui.selectedChannels.includes(this.id)) selectOnly(this.id);
      channelMenu(this.id, e.clientX, e.clientY);
    });

    // select bar (right of the button): toggles this channel in the selection
    this.selEl = el('div', { class: 'cr-sel' }, el('i'));
    this.selEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      toggleSelected(this.id);
    });

    this.area = el('div', { class: 'cr-area' });
    this.area.addEventListener('pointerdown', (e) => this.areaDown(e));
    this.area.addEventListener('dblclick', () => {
      if (this.mode === 'wave') openSettings(this.id);
    });
    this.area.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const left = el('div', { class: 'cr-left' }, this.led, this.pan, this.vol, this.mix, this.btn, this.selEl);
    this.root = el('div', { class: 'cr-row', 'data-id': this.id }, left, this.area);
  }

  ch(): Channel | undefined {
    return store.channel(this.id);
  }

  // ---- mixer number: drag up/down, click selects that mixer track ----
  private mixDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = this.ch();
    if (!c) return;
    const start = c.mixer;
    let began = false;
    let moved = false;
    drag(
      e,
      (_dx, dy) => {
        if (!moved && Math.abs(dy) < 3) return;
        moved = true;
        if (!began) {
          store.begin('Route channel');
          began = true;
          this.mix.classList.add('active');
        }
        const v = clamp(start - Math.round(dy / 7), 0, store.project.mixer.length - 1);
        store.live((p) => {
          const x = p.channels.find((k) => k.id === this.id);
          if (x && x.mixer !== v) x.mixer = v;
        });
        lockHint(`Mixer track: ${v === 0 ? 'Master' : `${v} · ${store.project.mixer[v]?.name ?? ''}`}`);
      },
      () => {
        this.mix.classList.remove('active');
        lockHint(null);
        if (began) store.end();
        if (!moved) {
          const m = this.ch()?.mixer ?? 0;
          store.setUI({ selectedMixer: m, selectedMixerTracks: [m] });
        }
      },
    );
  }

  // ---- steps: click toggles, drag paints, right-drag erases ----
  private areaDown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 2) return;
    if (this.mode === 'preview') {
      if (e.button === 0) {
        e.preventDefault();
        openPianoRoll(this.id);
      }
      return;
    }
    if (this.mode === 'wave') {
      if (e.button === 0) clickSelect(this.id, e);
      return;
    }
    const t = (e.target as HTMLElement).closest('.cr-step') as HTMLElement | null;
    if (!t) return;
    e.preventDefault();
    const i = Number(t.dataset.i);
    const on = e.button === 0 ? this.stepState[i] === -1 : false; // -2 = muted note (still "on")
    const pid = store.currentPattern.id;
    store.begin(on ? 'Add steps' : 'Remove steps');
    const apply = (j: number) => {
      if (j < 0 || j >= this.n) return;
      if ((this.stepState[j] !== -1) === on) return;
      this.paintStep(j, on ? 0.78 : -1);
      store.live((p) => {
        const pt = p.patterns.find((x) => x.id === pid);
        if (pt) writeStep(pt, this.id, j, on);
      });
    };
    apply(i);
    let last = i;
    drag(
      e,
      (_dx, _dy, ev) => {
        const r = this.area.getBoundingClientRect();
        const j = stepAt(ev.clientX - r.left, this.n);
        if (j === last) return;
        const a = Math.min(last, j), b = Math.max(last, j);
        for (let k = a; k <= b; k++) apply(k);
        last = j;
      },
      () => store.end(),
    );
  }

  private paintStep(i: number, v: number) {
    const s = this.steps[i];
    if (!s) return;
    this.stepState[i] = v;
    s.classList.toggle('on', v >= 0);
    if (v >= 0) s.style.setProperty('--v', v.toFixed(2));
  }

  // ---- structure of the step strip ----
  private buildArea(mode: Mode, n: number, spb: number) {
    this.mode = mode;
    this.n = n;
    this.spb = spb;
    this.area.textContent = '';
    this.steps = [];
    this.stepState = [];
    this.canvas = null;
    this.ph = null;
    this.drawSig = '';
    this.playIdx = -1;
    this.area.className = 'cr-area ' + mode;
    this.area.style.width = stripW(n) + 'px';
    this.area.dataset.hint =
      mode === 'steps'
        ? 'Steps — click toggles a step, drag paints, right-click / right-drag erases (Ctrl+Shift+F fills every 4 steps)'
        : mode === 'preview'
          ? 'Piano roll preview — click to edit these notes in the Piano roll (F7)'
          : 'Audio clip channel — its audio plays from the Playlist · double-click for settings';
    if (mode === 'steps') {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < n; i++) {
        const s = el('div', { class: 'cr-step' + (Math.floor(i / 4) % 2 ? ' alt' : '') + (i % 4 === 0 && i ? ' gs' : '') + (i % spb === 0 && i ? ' bar' : ''), 'data-i': String(i) });
        this.steps.push(s);
        this.stepState.push(-1);
        frag.append(s);
      }
      this.area.append(frag);
    } else {
      this.canvas = el('canvas', { class: 'cr-canvas' }) as HTMLCanvasElement;
      this.ph = el('div', { class: 'cr-ph' });
      this.area.append(this.canvas, this.ph);
    }
  }

  update(u: Ctx) {
    const c = this.ch();
    if (!c) return;
    const L = this.last;
    const root = this.root;
    if (L.color !== c.color) {
      L.color = c.color;
      // FL channel button: the channel colour, a little muted, with a soft vertical gradient
      root.style.setProperty('--cc', c.color);
      root.style.setProperty('--b1', mixRgb(c.color, '#7d8a84', 0.28, 0.06));
      root.style.setProperty('--b2', mixRgb(c.color, '#5a6660', 0.32, -0.14));
      root.style.setProperty('--b3', mixRgb(c.color, '#8e9b95', 0.18, 0.22));
      root.style.setProperty('--ccs', rgba(c.color, 0.22));
      this.drawSig = '';
    }
    const icon = instrumentIcon(c);
    if (L.icon !== icon) {
      L.icon = icon;
      this.btnIcon.innerHTML = icon;
      this.btn.classList.toggle('has-icon', !!icon);
    }
    const nameChanged = L.name !== c.name;
    if (nameChanged) {
      L.name = c.name;
      setText(this.btnTxt, c.name);
      for (const o of this.knobOpts) o.name = c.name;
    }
    const sel = u.sel.has(c.id);
    root.classList.toggle('sel', sel);
    root.classList.toggle('primary', sel && u.primary === c.id);
    root.classList.toggle('muted', c.mute);
    this.led.classList.toggle('on', !c.mute);
    this.selEl.classList.toggle('on', sel);
    if (nameChanged || L.mute !== c.mute) {
      L.mute = c.mute;
      setHint(this.led, `${c.name}: ${c.mute ? 'muted' : 'active'} — click to ${c.mute ? 'unmute' : 'mute'} · right-click (or Ctrl+click) to solo, again to unmute all`);
    }
    if (nameChanged || L.pan !== c.pan) {
      L.pan = c.pan;
      this.pan.update();
    }
    if (nameChanged || L.vol !== c.vol) {
      L.vol = c.vol;
      this.vol.update();
    }
    const mname = u.mixerNames[c.mixer] ?? '?';
    if (nameChanged || L.mixer !== c.mixer || L.mname !== mname) {
      L.mixer = c.mixer;
      L.mname = mname;
      setText(this.mix, c.mixer === 0 ? '—' : String(c.mixer));
      this.mix.classList.toggle('master', c.mixer === 0);
      setHint(this.mix, `Mixer track: ${c.mixer === 0 ? 'Master' : `${c.mixer} · ${mname}`} — drag up/down or scroll to change, click to select it in the mixer (Ctrl+L routes to a free track)`);
    }
    const win = c.type === 'plugin' ? 'plugin window' : 'channel settings';
    setHint(this.btn, `${c.name} (${instrumentName(c)}, group ${groupOf(c)}) — click: select + open / close the ${win} · Ctrl+click: add to selection · Shift+click: range · right-click: menu (replace instrument…) · F2: rename`);
    setHint(this.selEl, sel ? `${c.name} is selected — click to deselect` : `Select ${c.name} (adds it to the selection)`);
    root.classList.toggle('synth', c.type !== 'sampler');

    // ---- step strip ----
    const notes = u.pattern.notes[c.id] ?? [];
    const mode: Mode = c.audioClip ? 'wave' : view.roll || !notes.every(isStepNote) ? 'preview' : 'steps';
    if (mode !== this.mode || u.n !== this.n || u.spb !== this.spb) this.buildArea(mode, u.n, u.spb);
    if (mode === 'steps') this.updateSteps(notes);
    else if (mode === 'preview') this.drawPreview(notes, c);
    else this.drawWave(c);
  }

  private updateSteps(notes: Note[]) {
    const n = this.n;
    const st: number[] = new Array(n).fill(-1);
    for (const x of notes) {
      const i = x.start / STEP;
      if (i >= 0 && i < n) st[i] = x.muted ? -2 : x.vel;
    }
    for (let i = 0; i < n; i++) {
      const v = st[i];
      if (v === this.stepState[i]) continue;
      this.stepState[i] = v;
      const s = this.steps[i];
      s.classList.toggle('on', v >= 0 || v === -2);
      s.classList.toggle('nmute', v === -2);
      if (v >= 0) s.style.setProperty('--v', v.toFixed(2));
    }
  }

  private prepCanvas(): CanvasRenderingContext2D | null {
    const cv = this.canvas;
    if (!cv) return null;
    const w = stripW(this.n);
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w * dpr), H = Math.round(ROW_H * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
      cv.style.width = w + 'px';
      cv.style.height = ROW_H + 'px';
    }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, ROW_H);
    return g;
  }

  private drawPreview(notes: Note[], c: Channel) {
    let sig = this.n + '|' + c.color + '|' + (window.devicePixelRatio || 1);
    for (const x of notes) sig += `|${x.start},${x.len},${x.key},${x.vel.toFixed(2)},${x.muted ? 1 : 0}`;
    if (sig === this.drawSig) return;
    this.drawSig = sig;
    const g = this.prepCanvas();
    if (!g) return;
    const w = stripW(this.n);
    const total = this.n * STEP;
    // beat grid
    for (let b = 0; b < this.n; b += 4) {
      const x = Math.round((b * STEP * w) / total) + 0.5;
      g.fillStyle = b % this.spb === 0 ? 'rgba(0,0,0,0.32)' : 'rgba(0,0,0,0.14)';
      g.fillRect(x, 0, 1, ROW_H);
    }
    if (!notes.length) return;
    let lo = 127, hi = 0;
    for (const x of notes) {
      lo = Math.min(lo, x.key);
      hi = Math.max(hi, x.key);
    }
    lo -= 1;
    hi += 1;
    const span = Math.max(hi - lo, 8);
    const mid = (lo + hi) / 2;
    lo = mid - span / 2;
    const pad = 3;
    const nh = clamp((ROW_H - pad * 2) / span, 2, 4);
    // FL draws the mini piano roll in light green, like the Piano roll notes
    for (const x of notes) {
      const x0 = (x.start / total) * w;
      const x1 = Math.min(w, ((x.start + x.len) / total) * w);
      const y = pad + (1 - (x.key - lo) / span) * (ROW_H - pad * 2 - nh);
      g.globalAlpha = x.muted ? 0.3 : 0.6 + x.vel * 0.4;
      g.fillStyle = '#9fe08f';
      g.fillRect(x0, Math.round(y), Math.max(2, x1 - x0 - 1), nh);
    }
    g.globalAlpha = 1;
  }

  private drawWave(c: Channel) {
    const ref = c.sampler?.sampleRef ?? '';
    const loaded = !!samples.get(ref);
    const sig = `${this.n}|${c.color}|${ref}|${c.sampler?.reverse ? 1 : 0}|${loaded ? 1 : 0}|${window.devicePixelRatio || 1}`;
    if (sig === this.drawSig) return;
    this.drawSig = sig;
    const g = this.prepCanvas();
    if (!g) return;
    const w = stripW(this.n);
    const pk = loaded ? samples.peaks(ref, Math.max(16, Math.min(1024, Math.round(w)))) : null;
    const mid = ROW_H / 2;
    if (!pk) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '10px sans-serif';
      g.fillText(ref ? 'Loading audio…' : 'No sample', 6, mid + 3);
      return;
    }
    const nb = pk.length / 2;
    const rev = !!c.sampler?.reverse;
    let m = 0.0001;
    for (let i = 0; i < pk.length; i++) m = Math.max(m, Math.abs(pk[i]));
    const amp = (mid - 2) / m;
    g.fillStyle = mixRgb(c.color, '#ffffff', 0.45);
    g.beginPath();
    for (let i = 0; i < nb; i++) {
      const k = rev ? nb - 1 - i : i;
      const x = (i / nb) * w;
      g.lineTo(x, mid - pk[k * 2 + 1] * amp);
    }
    for (let i = nb - 1; i >= 0; i--) {
      const k = rev ? nb - 1 - i : i;
      const x = (i / nb) * w;
      g.lineTo(x, mid - pk[k * 2] * amp);
    }
    g.closePath();
    g.fill();
  }

  invalidateDrawing() {
    this.drawSig = '';
  }

  // ---- playhead ----
  setPlay(pos: number) {
    if (this.mode === 'steps') {
      const i = pos < 0 ? -1 : Math.floor(pos / STEP);
      if (i === this.playIdx) return;
      this.steps[this.playIdx]?.classList.remove('play');
      this.steps[i]?.classList.add('play');
      this.playIdx = i;
    } else if (this.ph) {
      if (pos < 0) {
        if (this.playIdx !== -1) this.ph.style.display = 'none';
        this.playIdx = -1;
        return;
      }
      this.playIdx = 0;
      this.ph.style.display = 'block';
      this.ph.style.transform = `translateX(${((pos / (this.n * STEP)) * stripW(this.n)).toFixed(1)}px)`;
    }
  }
}

// ---------------------------------------------------------------------------
// graph editor (FL: velocity / pan of each step of the selected channel)
// ---------------------------------------------------------------------------
class GraphEditor {
  readonly root: HTMLElement;
  private area: HTMLElement;
  private title: HTMLElement;
  private msg: HTMLElement;
  private tabs: HTMLElement[] = [];
  private bars: HTMLElement[] = [];
  private n = 0;
  private sig = '';
  private chId: ID | null = null;

  constructor() {
    this.title = el('div', { class: 'cr-g-ch' });
    const tabs = el('div', { class: 'cr-g-tabs' });
    for (const m of ['vel', 'pan'] as const) {
      const b = el('button', { class: 'cr-g-tab', text: m === 'vel' ? 'Velocity' : 'Panning', 'data-hint': m === 'vel' ? 'Graph editor: step velocities' : 'Graph editor: step panning' });
      b.addEventListener('click', () => {
        view.graphMode = m;
        saveView();
        this.sig = '';
        this.sync();
      });
      (b as any)._m = m;
      this.tabs.push(b);
      tabs.append(b);
    }
    const left = el('div', { class: 'cr-g-left' }, tabs, this.title);
    this.msg = el('div', { class: 'cr-g-msg' });
    this.area = el('div', { class: 'cr-g-area', 'data-hint': 'Graph editor — drag to draw the value of each step of the selected channel · right-drag resets' }, this.msg);
    this.root = el('div', { class: 'cr-graph' }, left, this.area);
    this.area.addEventListener('contextmenu', (e) => e.preventDefault());
    this.area.addEventListener('pointerdown', (e) => this.down(e));
  }

  private target(): { ch: Channel; notes: Note[]; steps: boolean } | null {
    const ch = store.channel(store.ui.selectedChannels[0]);
    if (!ch) return null;
    const notes = store.currentPattern.notes[ch.id] ?? [];
    return { ch, notes, steps: !ch.audioClip && notes.every(isStepNote) };
  }

  private valAt(y: number): number {
    const r = this.area.getBoundingClientRect();
    const f = clamp(1 - (y - r.top - 4) / Math.max(1, r.height - 8), 0, 1);
    return view.graphMode === 'vel' ? Math.max(0.01, f) : f * 2 - 1;
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 2) return;
    const t = this.target();
    if (!t || !t.steps || !t.notes.length) return;
    e.preventDefault();
    const reset = e.button === 2;
    const mode = view.graphMode;
    const pid = store.currentPattern.id, cid = t.ch.id;
    const r0 = this.area.getBoundingClientRect();
    let lastI = stepAt(e.clientX - r0.left, this.n);
    let lastV = reset ? (mode === 'vel' ? 0.78 : 0) : this.valAt(e.clientY);
    store.begin(mode === 'vel' ? 'Step velocity' : 'Step panning');
    const apply = (i0: number, v0: number, i1: number, v1: number) => {
      const a = Math.min(i0, i1), b = Math.max(i0, i1);
      store.live((p) => {
        const pt = p.patterns.find((x) => x.id === pid);
        const arr = pt?.notes[cid];
        if (!arr) return;
        for (const nt of arr) {
          const i = nt.start / STEP;
          if (i < a || i > b) continue;
          const f = i1 === i0 ? 1 : (i - i0) / (i1 - i0);
          const v = Math.round((v0 + (v1 - v0) * f) * 1000) / 1000;
          if (mode === 'vel') nt.vel = clamp(v, 0.01, 1);
          else nt.pan = clamp(v, -1, 1);
        }
      });
      lockHint(mode === 'vel' ? `Velocity ${Math.round(v1 * 100)}%` : `Pan ${Math.round(v1 * 100)}`);
    };
    apply(lastI, lastV, lastI, lastV);
    drag(
      e,
      (_dx, _dy, ev) => {
        const r = this.area.getBoundingClientRect();
        const i = stepAt(ev.clientX - r.left, this.n);
        const v = reset ? lastV : this.valAt(ev.clientY);
        apply(lastI, lastV, i, v);
        lastI = i;
        lastV = v;
      },
      () => {
        lockHint(null);
        store.end();
      },
    );
  }

  sync(n = this.n) {
    this.root.style.display = view.graph ? '' : 'none';
    for (const b of this.tabs) b.classList.toggle('on', (b as any)._m === view.graphMode);
    if (!view.graph) return;
    const t = this.target();
    if (n !== this.n || t?.ch.id !== this.chId) {
      this.n = n;
      this.chId = t?.ch.id ?? null;
      this.area.style.width = stripW(n) + 'px';
      for (const b of this.bars) b.remove();
      this.bars = [];
      for (let i = 0; i < n; i++) {
        const b = el('div', { class: 'cr-g-bar', style: { left: stepX(i) + 'px', width: SW + 'px' } });
        this.bars.push(b);
        this.area.append(b);
      }
      this.sig = '';
    }
    setText(this.title, t ? t.ch.name : '—');
    this.title.style.setProperty('--cc', t?.ch.color ?? '#7a8287');
    const mode = view.graphMode;
    let sig = mode + '|' + (t?.ch.id ?? '') + '|' + (t?.steps ? 1 : 0);
    if (t) for (const x of t.notes) sig += `|${x.start},${mode === 'vel' ? x.vel : x.pan},${x.muted ? 1 : 0}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const H = GRAPH_H - 8;
    const vals: (number | null)[] = new Array(n).fill(null);
    if (t?.steps) for (const x of t.notes) if (x.start / STEP < n) vals[x.start / STEP] = mode === 'vel' ? x.vel : x.pan;
    this.msg.textContent = !t ? '' : t.ch.audioClip ? 'Audio clip channel' : !t.steps ? 'This channel uses the Piano roll — edit its notes there (F7)' : !t.notes.length ? 'No steps' : '';
    this.root.classList.toggle('pan', mode === 'pan');
    for (let i = 0; i < n; i++) {
      const b = this.bars[i];
      const v = vals[i];
      if (v === null) {
        b.style.display = 'none';
        continue;
      }
      b.style.display = '';
      if (mode === 'vel') {
        b.style.top = 4 + Math.round((1 - v) * H) + 'px';
        b.style.height = Math.max(2, Math.round(v * H)) + 'px';
      } else {
        const mid = 4 + H / 2;
        const y = 4 + (1 - (v + 1) / 2) * H;
        b.style.top = Math.round(Math.min(mid, y)) + 'px';
        b.style.height = Math.max(2, Math.round(Math.abs(y - mid))) + 'px';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------
export function createChannelRack(): PanelDef {
  const rows = new Map<ID, Row>();
  let order: Row[] = [];
  let idSig = '';
  let dirty = false;
  const visible = () => !!wm?.get('channelrack')?.visible;

  const list = el('div', { class: 'cr-rows' });
  const filler = el('div', { class: 'cr-filler', 'data-hint': 'Drop samples, synth presets or plugins here to add channels · right-click for the add menu' }, el('div', { class: 'cr-filler-t' }));
  const graph = new GraphEditor();
  const scroll = el('div', { class: 'cr-scroll' }, list, filler, graph.root);
  const addBtn = el('button', { class: 'cr-add', 'data-hint': 'Add a channel: plugins, Tri-Osc synth presets, sampler sounds, audio files' }, el('span', { class: 'cr-add-i', html: IC.plus }));
  const footInfo = el('div', { class: 'cr-foot-i' });
  const foot = el('div', { class: 'cr-foot' }, el('div', { class: 'cr-foot-l' }), addBtn, footInfo);
  const root = el('div', { class: 'cr' }, scroll, foot);
  root.style.setProperty('--sw', SW + 'px');
  root.style.setProperty('--sg', SG + 'px');
  root.style.setProperty('--gg', GG + 'px');
  root.style.setProperty('--rh', ROW_H + 'px');
  root.style.setProperty('--gh', GRAPH_H + 'px');

  const showAdd = (x: number, y: number) => showMenu(addMenuItems(), Math.max(0, Math.min(x, innerWidth - 560)), y);
  addBtn.addEventListener('click', () => {
    const r = addBtn.getBoundingClientRect();
    showAdd(r.left, r.top - 4);
  });
  filler.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showAdd(e.clientX, e.clientY);
  });
  filler.addEventListener('dblclick', () => {
    const r = addBtn.getBoundingClientRect();
    showAdd(r.left, r.top - 4);
  });

  // ---- header extra (FL: ▸ menu · group filter · swing · view toggles · step count) ----
  const menuBtn = el('button', { class: 'cr-hbtn cr-menu', html: IC.arrow, 'data-hint': 'Channel rack options — add, clone, group, fill, views, step count' });
  menuBtn.addEventListener('click', () => {
    const r = menuBtn.getBoundingClientRect();
    showMenu(rackMenu(), r.left, r.bottom + 2);
  });
  const groupSel = el('select', { class: 'cr-groupsel', 'data-hint': 'Channel group filter — PageUp / PageDown cycle groups, Alt+G groups the selected channels' }) as HTMLSelectElement;
  groupSel.addEventListener('change', () => {
    store.setUI({ channelGroup: groupSel.value });
    groupSel.blur();
  });
  groupSel.addEventListener('keydown', (e) => e.stopPropagation());
  const groupBox = el('div', { class: 'cr-group' }, el('span', { class: 'cr-group-i', html: IC.filter }), groupSel);
  const patSw = el('span', { class: 'cr-pat-sw' });
  const patName = el('span', { class: 'cr-pat-name' });
  const patBtn = el('button', { class: 'cr-pat', 'data-hint': 'Current pattern — click for the pattern menu (1–9 select when the rack is not focused, F4 new, F2 rename)' }, patSw, patName, el('span', { class: 'cr-caret', html: IC.caret }));
  patBtn.addEventListener('click', () => {
    const r = patBtn.getBoundingClientRect();
    patternMenu(r.left, r.bottom + 2);
  });
  const swingVal = el('span', { class: 'cr-swing-v' });
  const swing = knob({
    def: SWING_DEF,
    size: 19,
    name: 'Project',
    get: () => store.project.swing,
    set: (v) => store.live((p) => (p.swing = v)),
    begin: () => store.begin('Swing'),
    end: () => store.end(),
  });
  const swingBox = el('div', { class: 'cr-swing', 'data-hint': 'Swing — delays every second 16th step (drag, scroll, double-click resets)' }, el('span', { class: 'cr-hlbl', text: 'Swing' }), swing, swingVal);
  const graphBtn = el('button', { class: 'cr-hbtn cr-tg', html: IC.graph, 'data-hint': 'Graph editor — draw step velocity / panning of the selected channel' });
  graphBtn.addEventListener('click', () => {
    view.graph = !view.graph;
    saveView();
    sync(true);
  });
  const rollBtn = el('button', { class: 'cr-hbtn cr-tg', html: IC.roll, 'data-hint': 'Piano roll view — show every channel as a mini piano roll (click a row to edit it)' });
  rollBtn.addEventListener('click', () => {
    view.roll = !view.roll;
    saveView();
    sync(true);
  });
  const stepsBtn = el('button', { class: 'cr-stepsbtn', 'data-hint': 'Step count / pattern length — click to choose (Auto grows with the notes)' }, el('span', { class: 'cr-hi', html: IC.steps }), el('span', { class: 'cr-steps-t' }));
  stepsBtn.addEventListener('click', () => {
    const r = stepsBtn.getBoundingClientRect();
    showMenu(stepItems(), r.left, r.bottom + 2);
  });
  const headerExtra = el('div', { class: 'cr-hx' }, menuBtn, groupBox, el('div', { class: 'cr-hx-sp' }), patBtn, swingBox, el('div', { class: 'cr-hx-sep' }), graphBtn, rollBtn, stepsBtn);

  function stepItems(): MenuItem[] {
    const pt = store.currentPattern;
    const bar = store.barTicks;
    const setLen = (len: number) =>
      store.commit('Pattern length', (p) => {
        const x = p.patterns.find((q) => q.id === pt.id);
        if (x) x.length = len;
      });
    const counts = [16, 32, 48, 64, 96, 128, 256];
    return [
      { label: 'Auto (fit notes)', checked: pt.length === 0, action: () => setLen(0) },
      { sep: true },
      ...counts.map((n) => {
        const bars = (n * STEP) / bar;
        return { label: `${n} steps · ${+bars.toFixed(2)} bar${bars === 1 ? '' : 's'}`, checked: pt.length === n * STEP, action: () => setLen(n * STEP) };
      }),
    ];
  }

  function rackMenu(): MenuItem[] {
    const ids = orderedSelection();
    const n = ids.length;
    return [
      { label: 'Add one', submenu: addMenuItems() },
      { label: 'Select all channels', action: () => store.setUI({ selectedChannels: visibleChannels().map((c) => c.id) }) },
      { sep: true },
      { label: `Clone selected (${n})`, shortcut: keyFor('cr.clone'), disabled: !n, action: () => cloneChannels(ids) },
      { label: `Delete selected (${n})…`, shortcut: keyFor('cr.delete'), disabled: !n, action: () => confirmDelete(ids) },
      { label: 'Group selected…', shortcut: keyFor('cr.group'), disabled: !n, action: () => promptGroup(ids) },
      { label: 'Route selected to free mixer tracks', shortcut: keyFor('cr.route'), disabled: !n, action: () => routeToFreeTracks(ids) },
      { label: 'Fill each 4 steps', shortcut: keyFor('cr.fill4'), disabled: !n, action: () => fillSteps(ids, 4) },
      { label: 'Clear steps', disabled: !n, action: () => clearSteps(ids) },
      { sep: true },
      { label: 'Graph editor', checked: view.graph, action: () => graphBtn.click() },
      { label: 'Piano roll view', checked: view.roll, action: () => rollBtn.click() },
      { label: 'Step count', submenu: stepItems() },
    ];
  }

  let groupSig = '';
  function updateHeader(n: number) {
    const pt = store.currentPattern;
    const i = store.project.patterns.indexOf(pt);
    setText(patName, pt ? `${i + 1}. ${pt.name}` : '—');
    patSw.style.background = pt?.color ?? '#7a8287';
    swing.update();
    setText(swingVal, Math.round(store.project.swing * 100) + '%');
    setText(stepsBtn.lastChild as HTMLElement, `${n}${pt?.length ? '' : ' auto'}`);
    graphBtn.classList.toggle('on', view.graph);
    rollBtn.classList.toggle('on', view.roll);
    const opts = groupOptions();
    const gs = opts.join('|');
    if (gs !== groupSig) {
      groupSig = gs;
      groupSel.textContent = '';
      for (const g of opts) groupSel.append(el('option', { value: g, text: g }));
    }
    const v = opts.includes(store.ui.channelGroup) ? store.ui.channelGroup : 'All';
    if (groupSel.value !== v) groupSel.value = v;
  }

  // ---- structure ----
  function reconcile(vis: Channel[]) {
    const next = new Map<ID, Row>();
    const newOrder: Row[] = [];
    for (const c of vis) {
      const r = rows.get(c.id) ?? new Row(c.id);
      next.set(c.id, r);
      newOrder.push(r);
    }
    for (const [id, r] of rows) if (!next.has(id)) r.root.remove();
    rows.clear();
    for (const [k, r] of next) rows.set(k, r);
    order = newOrder;
    // only move nodes that are out of place (keeps a dragged knob alive)
    let prev: ChildNode | null = null;
    for (const r of order) {
      const expected: ChildNode | null = prev ? prev.nextSibling : list.firstChild;
      if (expected !== r.root) list.insertBefore(r.root, expected);
      prev = r.root;
    }
    while (prev && prev.nextSibling) prev.nextSibling.remove();
    if (!prev) list.textContent = '';
  }

  function sync(force = false) {
    if (!store.project) return;
    const vis = visibleChannels();
    const ids = vis.map((c) => c.id).join(',');
    if (ids !== idSig) {
      idSig = ids;
      reconcile(vis);
    }
    if (!force && !visible()) {
      dirty = true;
      return;
    }
    dirty = false;
    const pattern = store.currentPattern;
    const n = stepCount(pattern);
    const u: Ctx = {
      pattern,
      n,
      spb: Math.max(1, Math.round(store.barTicks / STEP)),
      sel: new Set(store.ui.selectedChannels),
      primary: store.ui.selectedChannels[0],
      mixerNames: store.project.mixer.map((m) => m.name),
    };
    for (const r of order) r.update(u);
    graph.sync(n);
    updateHeader(n);
    const total = store.project.channels.length;
    const g = store.ui.channelGroup;
    const filt = g && g !== 'All';
    setText(footInfo, filt ? `${vis.length} of ${total} · ${g}` : `${total} channel${total === 1 ? '' : 's'}`);
    setText(filler.firstChild as HTMLElement, vis.length ? '' : filt ? `No channels in “${g}” — drop sounds here or pick another group` : 'No channels yet — click + or drop sounds / plugins here');
    root.classList.toggle('empty', !vis.length);
  }

  function ensureRowVisible(id: ID) {
    const r = rows.get(id);
    if (!r) return;
    const top = r.root.offsetTop - list.offsetTop;
    const bottom = top + r.root.offsetHeight;
    const gh = view.graph ? GRAPH_H : 0;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (bottom > scroll.scrollTop + scroll.clientHeight - gh) scroll.scrollTop = bottom - scroll.clientHeight + gh;
  }

  // ---- playhead (pattern mode) ----
  let raf = 0;
  let playShown = false;
  const frame = () => {
    raf = 0;
    const on = visible() && engine.playing && engine.mode === 'pattern';
    if (!on) {
      if (playShown) for (const r of order) r.setPlay(-1);
      playShown = false;
      return;
    }
    const pos = engine.position;
    for (const r of order) r.setPlay(pos);
    playShown = true;
    raf = requestAnimationFrame(frame);
  };
  const startPlayhead = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  engine.on('state', startPlayhead);

  // ---- drag & drop: samples, synth presets, instrument plugins ----
  type DropKind = 'sample' | 'preset' | 'plugin';
  const dropKind = (e: DragEvent): DropKind | null =>
    hasType(e, DT_PLUGIN) ? 'plugin' : hasType(e, DT_PRESET) ? 'preset' : hasType(e, DT_SAMPLE) || hasType(e, 'Files') ? 'sample' : null;
  const rowAt = (t: EventTarget | null): Row | undefined => {
    const r = (t as HTMLElement | null)?.closest?.('.cr-row') as HTMLElement | null;
    return r ? rows.get(r.dataset.id ?? '') : undefined;
  };
  let dropRow: Row | null = null;
  const clearDrop = () => {
    dropRow?.root.classList.remove('drop');
    dropRow = null;
    root.classList.remove('drop-new');
  };
  scroll.addEventListener('dragover', (e) => {
    const kind = dropKind(e);
    if (!kind) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    let r = rowAt(e.target) ?? null;
    const ch = r?.ch();
    if (r && kind === 'preset' && ch?.type !== 'synth') r = null; // presets on a sampler row add a new synth
    if (r && kind === 'plugin' && ch?.audioClip) r = null;
    if (r !== dropRow) {
      dropRow?.root.classList.remove('drop');
      r?.root.classList.add('drop');
      dropRow = r;
    }
    root.classList.toggle('drop-new', !r);
  });
  scroll.addEventListener('dragleave', (e) => {
    if (!scroll.contains(e.relatedTarget as Node | null)) clearDrop();
  });
  scroll.addEventListener('drop', async (e) => {
    const kind = dropKind(e);
    if (!kind) return;
    e.preventDefault();
    const r = dropRow;
    clearDrop();
    const ch = r?.ch();
    if (kind === 'plugin') {
      e.stopPropagation();
      const d = readDrag<{ pluginType?: string; type?: string; id?: string }>(e, DT_PLUGIN);
      const choice = resolveInstrument(d?.pluginType ?? d?.type ?? d?.id);
      if (!choice) {
        toast('That plugin is not an instrument', 'warn', 1600);
        return;
      }
      if (ch) {
        const nid = await confirmReplace(ch.id, choice);
        if (nid) toast(`${store.channel(nid)?.name ?? 'Channel'} now uses ${choice.name}`, 'ok', 1400);
      } else addInstrumentChannel(choice);
      return;
    }
    if (kind === 'preset') {
      const d = readDrag<{ preset: string }>(e, DT_PRESET);
      if (!d?.preset) return;
      if (ch && ch.type === 'synth') {
        applyPreset(ch.id, d.preset);
        toast(`Preset “${d.preset}” applied to ${ch.name}`, 'ok', 1400);
      } else addSynthChannel(d.preset);
      return;
    }
    const files = await samplesFromDrop(e);
    if (!files.length) return;
    if (ch) {
      if (await replaceSample(ch.id, files[0])) {
        if (store.channel(ch.id)) selectOnly(ch.id); // (a converted synth / plugin got a new id and keeps its selection)
        toast(`${store.channel(ch.id)?.name ?? 'Sampler'} now plays “${files[0].name}”`, 'ok', 1400);
      }
      return;
    }
    for (const s of files) addSamplerChannel(s);
    if (files.length > 1) toast(`Added ${files.length} sampler channels`, 'ok', 1400);
  });

  // ---- store wiring ----
  store.on('project', () => sync());
  store.on('loaded', () => {
    idSig = '';
    for (const r of rows.values()) r.root.remove();
    rows.clear();
    order = [];
    anchorId = cursorId = null;
    sync(true);
  });
  store.on('ui', (keys) => {
    if (keys.includes('currentPattern') || keys.includes('selectedChannels') || keys.includes('channelGroup')) sync();
  });
  samples.on('loaded', () => {
    for (const r of order) if (r.mode === 'wave') r.invalidateDrawing();
    sync();
  });

  registerRackCommands({ ensureRowVisible });
  sync(true);

  return {
    body: root,
    headerExtra,
    onShow: () => {
      sync(true);
      startPlayhead();
    },
    onResize: () => {
      if (dirty && visible()) sync(true);
    },
  };
}

// ---------------------------------------------------------------------------
// keyboard commands (ctx 'channelrack')
// ---------------------------------------------------------------------------
let registered = false;
function registerRackCommands(api: { ensureRowVisible: (id: ID) => void }) {
  if (registered) return;
  registered = true;
  const sel = () => orderedSelection();
  const nth = (i: number) => visibleChannels()[i];

  const stepSel = (dir: -1 | 1, extend: boolean) => {
    const vis = visibleChannels().map((c) => c.id);
    if (!vis.length) return;
    const cur = store.ui.selectedChannels;
    let from = cursorId && vis.includes(cursorId) && cur.includes(cursorId) ? cursorId : cur.find((x) => vis.includes(x));
    if (!from) from = dir > 0 ? vis[0] : vis[vis.length - 1];
    else from = vis[clamp(vis.indexOf(from) + dir, 0, vis.length - 1)];
    const to = from;
    if (extend) {
      const a = anchorId && vis.includes(anchorId) ? vis.indexOf(anchorId) : vis.indexOf(to);
      const b = vis.indexOf(to);
      const range = vis.slice(Math.min(a, b), Math.max(a, b) + 1);
      cursorId = to;
      store.setUI({ selectedChannels: [to, ...range.filter((x) => x !== to)] });
    } else selectOnly(to);
    api.ensureRowVisible(to);
  };

  const cycleGroup = (dir: 1 | -1) => {
    const opts = groupOptions();
    const i = Math.max(0, opts.indexOf(store.ui.channelGroup));
    const g = opts[(i + dir + opts.length) % opts.length];
    store.setUI({ channelGroup: g });
    toast('Channel group: ' + (g === 'All' ? 'All channels' : g), 'info', 900);
  };

  const c = (id: string, label: string, keys: string[], run: () => void, extra: Partial<Command> = {}): Command => ({ id, label, category: 'Channel Rack', ctx: 'channelrack', keys, run, ...extra });
  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  const list: Command[] = [
    c('cr.up', 'Select channel above', ['Up'], () => stepSel(-1, false), { repeat: true }),
    c('cr.down', 'Select channel below', ['Down'], () => stepSel(1, false), { repeat: true }),
    c('cr.upExtend', 'Extend selection up', ['Shift+Up'], () => stepSel(-1, true), { repeat: true }),
    c('cr.downExtend', 'Extend selection down', ['Shift+Down'], () => stepSel(1, true), { repeat: true }),
    ...digits.map((d, i) =>
      c('cr.mute' + (i + 1), `Mute / unmute channel ${i + 1}`, [d], () => {
        const ch = nth(i);
        if (ch) toggleMute([ch.id]);
      }, { hidden: true }),
    ),
    ...digits.map((d, i) =>
      c('cr.solo' + (i + 1), `Solo channel ${i + 1}`, ['Ctrl+' + d], () => {
        const ch = nth(i);
        if (ch) soloChannel(ch.id);
      }, { hidden: true }),
    ),
    c('cr.clone', 'Clone selected channels', ['Alt+C'], () => cloneChannels(sel())),
    c('cr.delete', 'Delete selected channels…', ['Alt+Del'], () => confirmDelete(sel())),
    c('cr.group', 'Group selected channels…', ['Alt+G'], () => promptGroup(sel())),
    c('cr.moveUp', 'Move selected channels up', ['Alt+Up'], () => {
      moveChannels(sel(), -1);
      if (store.ui.selectedChannels[0]) api.ensureRowVisible(store.ui.selectedChannels[0]);
    }, { repeat: true }),
    c('cr.moveDown', 'Move selected channels down', ['Alt+Down'], () => {
      moveChannels(sel(), 1);
      if (store.ui.selectedChannels[0]) api.ensureRowVisible(store.ui.selectedChannels[0]);
    }, { repeat: true }),
    c('cr.copy', 'Copy steps of selected channels', ['Ctrl+C'], () => copySteps()),
    c('cr.paste', 'Paste steps into selected channels', ['Ctrl+V'], () => pasteSteps()),
    c('cr.cut', 'Cut steps of selected channels', ['Ctrl+X'], () => cutSteps()),
    c('cr.route', 'Route selected channels to free mixer tracks', ['Ctrl+L'], () => {
      const ids = sel();
      if (ids.length) routeToFreeTracks(ids);
    }),
    c('cr.focusPlaylist', 'Focus playlist', ['Ctrl+Enter'], () => wm.show('playlist')),
    c('cr.nextGroup', 'Next channel group', ['PageUp'], () => cycleGroup(1)),
    c('cr.prevGroup', 'Previous channel group', ['PageDown'], () => cycleGroup(-1)),
    c('cr.rename', 'Rename selected channel…', ['F2'], () => renameChannel(store.ui.selectedChannels[0])),
    c('cr.settings', 'Open channel settings / plugin window', [], () => {
      const id = store.ui.selectedChannels[0];
      if (id) openSettings(id);
    }),
    c('cr.fill4', 'Fill each 4 steps', ['Ctrl+Shift+F'], () => fillSteps(sel(), 4)),
    c('cr.add', 'Add channel…', [], () => {
      const b = document.querySelector('.cr-add') as HTMLElement | null;
      const r = b?.getBoundingClientRect();
      showMenu(addMenuItems(), r ? r.left : 200, r ? r.top - 4 : 200);
    }),
  ];
  commands.register(list);
}
