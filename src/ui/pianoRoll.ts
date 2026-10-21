// Piano Roll window (F7): canvas note editor with FL Studio mouse semantics and shortcuts.
// Layout: toolbar · ruler · piano keyboard · note grid · velocity/pan lane · scrollbars.
// The canvases are never rebuilt; everything redraws on requestAnimationFrame only when dirty,
// and the playhead is a DOM line moved with a transform (no full redraw while playing).
import './pianoRoll.css';
import { store } from '../core/store';
import { commands, Command } from '../core/commands';
import { engine } from '../audio/engine';
import { Channel, Note, Pattern, Project, STEP, Snap, ToolId } from '../core/types';
import { SNAP_LABELS, clamp, deepClone, el, fmtBST, noteName, snapDown, snapRound, snapTicks, uid } from '../core/util';
import { MenuItem, setHint, showMenu, toast } from './widgets';
import { ICONS, TOOL_ICONS } from './icons';
import { wm } from './wm';
import { exportMidi, importMidi } from './fileops';
import type { PanelDef } from './panel';
import * as ops from './pianoRoll-ops';
import { CHORDS, ROOT_NAMES, SCALES, chordKeys, scaleMask, snapToScale } from './pianoRoll-theory';
import { View, drawGrid, drawKeys, drawLane, drawOverview, drawRuler, lineSpacing, overviewSpan, tickX, xTick, yKey } from './pianoRoll-render';

const FL_NOTE = '#86d66d';
import { Field, formDialog } from './pianoRoll-dialogs';

// ------------------------------------------------------------------ prefs
const LS = { lane: 'lf.pr.lane', laneH: 'lf.pr.laneH', laneMode: 'lf.pr.laneMode', follow: 'lf.pr.follow', names: 'lf.pr.names' };
function lsGet(k: string, d: string) {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

const TOOLS: { id: ToolId; key: string; label: string; help: string }[] = [
  { id: 'draw', key: 'P', label: 'Draw', help: 'click to add a note (last-used length), drag to move, drag the right edge to resize, right-click deletes, Shift+drag duplicates, Ctrl+drag box-selects, Alt bypasses snap' },
  { id: 'paint', key: 'B', label: 'Paint', help: 'drag to paint a run of notes at the snap interval, right-click deletes' },
  { id: 'delete', key: 'D', label: 'Delete', help: 'click or drag over notes to delete them' },
  { id: 'mute', key: 'T', label: 'Mute', help: 'click or drag over notes to toggle mute' },
  { id: 'slice', key: 'C', label: 'Slice', help: 'drag a vertical line across notes — they are cut there on release' },
  { id: 'select', key: 'E', label: 'Select', help: 'drag to box-select (Shift adds), click a note to select it, drag selected notes to move them' },
  { id: 'zoom', key: 'Z', label: 'Zoom', help: 'drag a box to zoom to it, click to zoom in, right-click to zoom out' },
  { id: 'playback', key: 'Y', label: 'Playback', help: 'drag to scrub — notes under the cursor are auditioned' },
];

const SNAP_ORDER: Snap[] = ['line', 'cell', 'none', '1/6step', '1/4step', '1/3step', '1/2step', 'step', '1/3beat', '1/2beat', 'beat', 'bar'];
const GRID_CHOICES: Snap[] = ['1/6step', '1/4step', '1/3step', '1/2step', 'step', '1/3beat', '1/2beat', 'beat', 'bar'];

const svgI = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  arrow: `<svg viewBox="0 0 24 24"><path d="M8 5l9 7-9 7z" fill="currentColor"/></svg>`,
  left: `<svg viewBox="0 0 24 24"><path d="M15 6l-7 6 7 6z" fill="currentColor"/></svg>`,
  right: `<svg viewBox="0 0 24 24"><path d="M9 6l7 6-7 6z" fill="currentColor"/></svg>`,
  stamp: svgI('<path d="M9 3h6v6l3 3H6l3-3z"/><path d="M5 15h14v3H5z"/><path d="M8 21h8"/>'),
  lane: svgI('<path d="M5 20v-7M10 20V6M15 20v-9M20 20V9"/><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="10" cy="5" r="1.4" fill="currentColor"/><circle cx="15" cy="10" r="1.4" fill="currentColor"/><circle cx="20" cy="8" r="1.4" fill="currentColor"/>'),
  zoomIn: svgI('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5"/>'),
  zoomOut: svgI('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5"/>'),
  lock: svgI('<path d="M7 3v7a5 5 0 0 0 10 0V3"/><path d="M7 7h4M13 7h4"/><path d="M12 19v2"/>'),
};

/** Tool cursors built from the toolbar icons (white glyph with a dark outline). */
function toolCursor(id: string, hx: number, hy: number, fallback: string): string {
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(TOOL_ICONS[id] ?? '')?.[1] ?? '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="-1 -1 26 26" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#202426" stroke-width="4.4">${inner}</g><g stroke="#ffffff" stroke-width="1.9">${inner}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
}
const CURSORS: Record<string, string> = {
  draw: toolCursor('draw', 4, 18, 'crosshair'),
  paint: toolCursor('paint', 3, 18, 'crosshair'),
  delete: toolCursor('delete', 11, 11, 'not-allowed'),
  mute: toolCursor('mute', 11, 11, 'pointer'),
  slice: 'crosshair',
  select: 'crosshair',
  zoom: toolCursor('zoom', 10, 10, 'zoom-in'),
  playback: toolCursor('playback', 5, 11, 'col-resize'),
};

// ------------------------------------------------------------------ canvas surface
class Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  dpr = 1;
  constructor(public wrap: HTMLElement) {
    this.canvas = el('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    wrap.append(this.canvas);
  }
  /** Match the backing store to the element size × devicePixelRatio. Returns true when resized. */
  fit(): boolean {
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight, dpr = window.devicePixelRatio || 1;
    if (w === this.w && h === this.h && dpr === this.dpr) return false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
}

interface DragOpts {
  threshold?: number;
  autoScroll?: boolean;
}

type Hit = { n: Note; edge: boolean };
interface BarApi {
  root: HTMLElement;
  sync(): void;
  syncChannel(): void;
  setChord(id: string): void;
}

// ------------------------------------------------------------------ module state
let inst: PianoRoll | null = null;
let clipboard: Note[] = [];

// remembered tool-dialog settings (FL keeps the last-used values)
const DLG = {
  quantize: { grid: 'current', strength: 100, starts: true, ends: false },
  articulate: { pct: 50, mode: 'length' },
  chop: { grid: 'current', gate: 100 },
  arp: { pattern: 'up', grid: 'step', octaves: 1, gate: 90 },
  strum: { amount: 8, unit: 'ticks', dir: 'up', curve: 0, keepEnds: true },
  flam: { count: 1, spacing: 6, vel: 60, after: false },
  limit: { lo: 48, hi: 72 },
  flip: { axis: 'h' },
  randomize: { vel: 15, timing: 0, length: 0, pan: 0, pitch: 0 },
  levels: { param: 'vel', from: 40, to: 100 },
};

class PianoRoll {
  // view
  zx = 0.8;
  rowH = 15;
  sx = 0;
  sy = 0;
  private needCenter = true;
  private needFit = true;
  // selection & edit state
  sel = new Set<string>();
  timeSel: { start: number; end: number } | null = null;
  lastLen = 0; // 0 = follow the snap
  lastVel = 0.78;
  lastPan = 0;
  chord = 'off';
  showLane = lsGet(LS.lane, '1') !== '0';
  laneMode: 'vel' | 'pan' = lsGet(LS.laneMode, 'vel') === 'pan' ? 'pan' : 'vel';
  laneH = clamp(parseInt(lsGet(LS.laneH, '92')) || 92, 40, 400);
  follow = lsGet(LS.follow, '1') !== '0';
  showNames = lsGet(LS.names, '1') !== '0';
  // hover / overlays
  private hoverKey: number | null = null;
  private hoverNote: string | null = null;
  private hoverEdge = false;
  private laneHover: string | null = null;
  private rulerHover: number | null = null;
  private box: { t0: number; c0: number; t1: number; c1: number; kind: 'select' | 'zoom' } | null = null;
  private slice: { t: number; lo: number; hi: number } | null = null;
  private scrub: number | null = null;
  private dragging = false;
  private justCreated: string | null = null;
  private kbdKey: number | null = null;
  private lastClient = { x: -1, y: -1 };
  private wheelLive = false;
  private wheelTimer: any = null;
  // render state
  private dirty = { grid: true, keys: true, ruler: true, lane: true };
  private raf = 0;
  private phRaf = 0;
  private litSig = '';
  private lit = new Map<number, string>();
  private litTimer: any = null;
  private targetKey = '';
  private historyJump = false;
  private statusText = '';

  // DOM
  root: HTMLElement;
  private body: HTMLElement;
  private grid: Surface;
  private keys: Surface;
  private ruler: Surface;
  private lane: Surface;
  private ovw: Surface;
  private chBox: HTMLElement;
  private chName: HTMLElement;
  private chKey: HTMLElement;
  private laneName: HTMLElement;
  private phGrid: HTMLElement;
  private phLane: HTMLElement;
  private phTri: HTMLElement;
  private hs: HTMLElement;
  private hThumb: HTMLElement;
  private vs: HTMLElement;
  private vThumb: HTMLElement;
  private status: HTMLElement;
  bar: BarApi;

  constructor() {
    const gridWrap = el('div', { class: 'pr-cv pr-grid' });
    const keysWrap = el('div', { class: 'pr-cv pr-keys', 'data-hint': 'Piano keyboard — click or drag to audition (further right = louder) · Ctrl+click selects every note of that key' });
    const rulerWrap = el('div', { class: 'pr-cv pr-ruler', 'data-hint': 'Timeline — click / drag to set the playback position · Ctrl+drag selects a time range (and the notes in it) · wheel zooms' });
    const laneWrap = el('div', { class: 'pr-cv pr-lane' });
    const ovwWrap = el('div', { class: 'pr-cv pr-ovw', 'data-hint': 'Overview of every note — drag the box to scroll, click to jump there · wheel zooms' });
    this.grid = new Surface(gridWrap);
    this.keys = new Surface(keysWrap);
    this.ruler = new Surface(rulerWrap);
    this.lane = new Surface(laneWrap);
    this.ovw = new Surface(ovwWrap);
    this.phGrid = el('div', { class: 'pr-ph' });
    this.phLane = el('div', { class: 'pr-ph' });
    this.phTri = el('div', { class: 'pr-ph-tri' });
    gridWrap.append(this.phGrid);
    laneWrap.append(this.phLane);
    rulerWrap.append(this.phTri);
    // FL: the overview strip has page arrows on both ends
    const ovL = el('button', { class: 'pr-ovw-btn l', html: IC.left, 'data-hint': 'Scroll left one page' });
    const ovR = el('button', { class: 'pr-ovw-btn r', html: IC.right, 'data-hint': 'Scroll right one page' });
    ovL.addEventListener('click', () => this.scrollBy((-this.grid.w * 0.9) / this.zx, 0));
    ovR.addEventListener('click', () => this.scrollBy((this.grid.w * 0.9) / this.zx, 0));
    const ovwBox = el('div', { class: 'pr-ovw-box' }, ovL, ovwWrap, ovR);
    // top-left: the channel being edited (click for the channel list) + key under the mouse
    this.chName = el('span', { class: 'pr-chbox-name' });
    this.chKey = el('span', { class: 'pr-chbox-key' });
    this.chBox = el('div', { class: 'pr-chbox', 'data-hint': 'Channel being edited — click to pick another channel · shows the key under the mouse' }, el('span', { class: 'pr-chbox-wedge' }), el('div', { class: 'pr-chbox-t' }, this.chName, this.chKey));
    this.chBox.addEventListener('click', () => {
      const r = this.chBox.getBoundingClientRect();
      this.channelMenu(r.left, r.bottom + 2);
    });
    this.hThumb = el('div', { class: 'pr-thumb' });
    this.vThumb = el('div', { class: 'pr-thumb' });
    this.hs = el('div', { class: 'pr-hs', 'data-hint': 'Scroll horizontally (Shift+wheel) · Ctrl+wheel zooms' }, this.hThumb);
    this.vs = el('div', { class: 'pr-vs', 'data-hint': 'Scroll vertically (wheel) · Ctrl+Alt+wheel zooms' }, this.vThumb);
    const split = el('div', { class: 'pr-split', 'data-hint': 'Drag to resize the Control lane' });
    // bottom-left: FL's "Control ▸" lane selector
    this.laneName = el('span', { class: 'pr-lane-name' });
    const laneBtn = el('button', { class: 'pr-lane-btn', 'data-hint': 'Control lane — choose what the lane shows and edits (Velocity / Panning)' }, el('span', { text: 'Control' }), el('span', { class: 'pr-lane-arrow', html: IC.arrow }));
    laneBtn.addEventListener('click', () => {
      const r = laneBtn.getBoundingClientRect();
      showMenu(this.laneItems(), r.left, r.bottom + 2);
    });
    const laneSide = el('div', { class: 'pr-lane-side' }, laneBtn, this.laneName);
    this.body = el(
      'div',
      { class: 'pr-body' },
      this.chBox,
      ovwBox,
      el('div', { class: 'pr-fill a-o3' }),
      rulerWrap,
      el('div', { class: 'pr-fill a-r3' }),
      keysWrap,
      gridWrap,
      this.vs,
      split,
      laneSide,
      laneWrap,
      el('div', { class: 'pr-fill a-l3' }),
      el('div', { class: 'pr-fill a-c4' }),
      this.hs,
      el('div', { class: 'pr-fill a-c5' }),
    );
    this.status = el('div', { class: 'pr-status' });
    this.bar = this.buildBar();
    this.root = el('div', { class: 'pr' }, this.body);
    Object.defineProperty(this.root, '__pr', { value: this }); // debug / test handle
    this.applyLaneLayout();
    this.syncLaneTabs();

    this.wireGrid(gridWrap);
    this.wireKeys(keysWrap);
    this.wireRuler(rulerWrap);
    this.wireLane(laneWrap);
    this.wireScrollbars();
    this.wireOverview(ovwWrap);
    this.wireSplit(split);
    this.root.addEventListener('pointermove', (e) => (this.lastClient = { x: e.clientX, y: e.clientY }), true);

    new ResizeObserver(() => {
      if (!this.visible()) return;
      this.dirty = { grid: true, keys: true, ruler: true, lane: true };
      this.render(); // synchronous: avoids a blank frame after the canvas backing store is reset
    }).observe(this.body);

    store.on('project', (label) => {
      if (label === 'history') {
        this.historyJump = true;
        queueMicrotask(() => (this.historyJump = false));
      }
      this.onProject();
    });
    store.on('loaded', () => {
      this.sel.clear();
      this.timeSel = null;
      this.needCenter = true;
      this.needFit = true;
      this.targetKey = '';
      this.onTarget();
    });
    store.on('ui', (keys) => this.onUI(keys));
    engine.on('state', () => {
      this.startPlayhead();
      this.invalidate('ruler');
    });
  }

  // ================================================================ data access
  ch(): Channel | undefined {
    return store.pianoChannel;
  }
  pat(): Pattern {
    return store.currentPattern;
  }
  notes(): Note[] {
    const c = this.ch();
    const p = this.pat();
    return c && p ? p.notes[c.id] ?? [] : [];
  }
  selected(): Note[] {
    return this.notes().filter((n) => this.sel.has(n.id));
  }
  private targetOf(arr: Note[]): Note[] {
    if (this.sel.size) {
      const t = arr.filter((n) => this.sel.has(n.id));
      if (t.length) return t;
    }
    return arr.slice();
  }
  private patLen() {
    return store.patternLength(this.pat());
  }
  private get barT() {
    return store.barTicks;
  }
  private fullMask() {
    return scaleMask(store.ui.scale.root, store.ui.scale.type);
  }
  private hiMask() {
    return store.ui.scale.highlight ? this.fullMask() : null;
  }
  snapMask() {
    return store.ui.scale.snap ? this.fullMask() : null;
  }
  /** Snap grid in ticks. "Line" follows the visible grid (never finer than a step, never coarser than a bar). */
  gridTicks(alt = false): number {
    if (alt) return 1;
    const s = store.ui.snap;
    if (s === 'none') return 1;
    if (s === 'line') return clamp(lineSpacing(this.zx, this.barT), STEP, this.barT);
    return Math.max(1, snapTicks(s, store.project.timeSig));
  }
  private newLen() {
    if (this.lastLen > 0) return this.lastLen;
    const g = this.gridTicks();
    return g >= 6 ? g : STEP;
  }
  visible() {
    return !!wm?.get('pianoroll')?.visible;
  }

  // ================================================================ editing plumbing
  /** Run fn on the live note array of the current pattern/channel (commit = one undo step). */
  private apply<R>(label: string, fn: (arr: Note[]) => R, live = false): R | undefined {
    const c = this.ch();
    if (!c) return undefined;
    const patId = this.pat().id, chId = c.id;
    let out: R | undefined;
    const run = (p: Project) => {
      const pt = p.patterns.find((x) => x.id === patId);
      if (!pt) return;
      const had = !!pt.notes[chId];
      const arr = pt.notes[chId] ?? [];
      out = fn(arr);
      if (had || arr.length) pt.notes[chId] = arr;
    };
    if (live) store.live(run, label);
    else {
      this.flushWheel();
      store.commit(label, run);
    }
    return out;
  }

  /** Apply an operation to the selection (or every note when nothing is selected). */
  edit(label: string, fn: (arr: Note[], target: Note[]) => string[] | void, select: 'always' | 'ifSel' | 'never' = 'ifSel') {
    if (!this.ch()) return;
    const hadSel = this.selected().length > 0;
    const res = this.apply(label, (arr) => {
      const t = this.targetOf(arr);
      if (!t.length) return undefined;
      return fn(arr, t);
    });
    if (res && (select === 'always' || (select === 'ifSel' && hadSel))) this.setSel(res);
  }

  private flushWheel() {
    if (!this.wheelLive) return;
    clearTimeout(this.wheelTimer);
    this.wheelLive = false;
    store.end();
  }

  setSel(ids: Iterable<string>) {
    this.sel = new Set(ids);
    this.invalidate('grid', 'lane');
  }

  private audition(key: number, vel = this.lastVel, lenTicks = STEP * 2) {
    const c = this.ch();
    if (!c) return;
    engine.preview(c.id, key, vel, clamp(lenTicks * engine.spt, 0.08, 0.6));
  }

  // ================================================================ store wiring
  private onProject() {
    const ids = new Set(this.notes().map((n) => n.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.updateTitle();
    this.bar.syncChannel();
    this.invalidate();
  }

  private onUI(keys: string[]) {
    if (keys.includes('selectedChannels') && !keys.includes('pianoRollChannel') && !this.historyJump) {
      // follow a single-channel selection made elsewhere (FL behaviour); undo jumps and loads don't count
      const s = store.ui.selectedChannels;
      const first = s[0];
      if (s.length === 1 && first && first !== store.ui.pianoRollChannel && store.channel(first)) store.setUI({ pianoRollChannel: first });
    }
    if (keys.some((k) => k === 'currentPattern' || k === 'pianoRollChannel' || k === 'selectedChannels')) this.onTarget();
    if (keys.some((k) => k === 'prTool' || k === 'snap' || k === 'scale' || k === 'ghost')) {
      this.bar.sync();
      this.updateCursor();
      this.invalidate();
    }
  }

  private onTarget() {
    const c = this.ch();
    const key = this.pat()?.id + '|' + (c?.id ?? '');
    this.updateTitle();
    this.bar.syncChannel();
    if (key !== this.targetKey) {
      const first = !this.targetKey;
      this.targetKey = key;
      this.sel.clear();
      this.timeSel = null;
      if (!first && !this.notesInView()) this.needCenter = true;
    }
    this.invalidate();
  }

  updateTitle() {
    const c = this.ch();
    const p = this.pat();
    wm?.get('pianoroll')?.setTitle(`Piano roll — ${c?.name ?? '(no channel)'} · ${p?.name ?? ''}`);
  }

  private notesInView() {
    const v = this.v;
    if (!v.gh) return true;
    const kTop = yKey(v, 0), kBot = yKey(v, v.gh);
    return this.notes().some((n) => n.key <= kTop && n.key >= kBot);
  }

  // ================================================================ view math
  get v(): View {
    return { zx: this.zx, rowH: this.rowH, sx: this.sx, sy: this.sy, gw: this.grid.w, gh: this.grid.h };
  }
  private contentEnd() {
    let end = this.patLen();
    for (const n of this.notes()) end = Math.max(end, n.start + n.len);
    const bar = this.barT;
    return Math.ceil(end / bar) * bar + 4 * bar;
  }
  private clampScroll() {
    const gw = this.grid.w, gh = this.grid.h;
    this.zx = clamp(this.zx, 0.01, 24);
    this.rowH = clamp(this.rowH, 5, 48);
    const viewT = gw / this.zx;
    this.sx = clamp(this.sx, 0, Math.max(0, this.contentEnd() - viewT));
    this.sy = clamp(this.sy, 0, Math.max(0, 128 * this.rowH - gh));
  }
  scrollBy(dTicks: number, dPx: number) {
    this.sx += dTicks;
    this.sy += dPx;
    this.invalidate();
  }
  zoomH(factor: number, x = this.grid.w / 2) {
    const t = xTick(this.v, x);
    this.zx = clamp(this.zx * factor, 0.01, 24);
    this.sx = t - x / this.zx;
    this.invalidate();
  }
  zoomV(factor: number, y = this.grid.h / 2) {
    const c = (y + this.sy) / this.rowH;
    this.rowH = clamp(this.rowH * factor, 5, 48);
    this.sy = c * this.rowH - y;
    this.invalidate();
  }
  centerKeys(mid: number) {
    this.sy = (127 - mid + 0.5) * this.rowH - this.grid.h / 2;
    this.invalidate();
  }
  centerOnNotes() {
    const ns = this.notes();
    if (!ns.length) return this.centerKeys(60);
    const s = ops.span(ns);
    this.centerKeys((s.lo + s.hi) / 2);
  }
  fitH() {
    const L = Math.max(this.patLen(), this.barT);
    if (this.grid.w > 0) this.zx = clamp(this.grid.w / (L * 1.04), 0.08, 1.0);
    this.sx = 0;
    this.invalidate();
  }
  /** Quick zoom presets (Shift+1..4); 4 fits the whole pattern and its notes. */
  quickZoom(n: number) {
    const t = this.playTick() ?? xTick(this.v, this.grid.w / 2);
    if (n === 4) {
      const L = Math.max(this.patLen(), this.barT);
      this.zx = clamp(this.grid.w / (L * 1.02), 0.01, 24);
      this.sx = 0;
      const ns = this.notes();
      if (ns.length) {
        const s = ops.span(ns);
        this.rowH = clamp(this.grid.h / (s.hi - s.lo + 5), 5, 30);
        this.centerKeys((s.lo + s.hi) / 2);
      }
    } else {
      const pxPerStep = [0, 48, 24, 12][n];
      this.zx = pxPerStep / STEP;
      this.sx = t - this.grid.w / 2 / this.zx;
    }
    this.invalidate();
  }
  centerOnPlayhead() {
    const t = this.playTick() ?? this.localTick(engine.position) ?? 0;
    this.sx = t - this.grid.w / 2 / this.zx;
    this.invalidate();
  }

  // ================================================================ rendering
  invalidate(...parts: ('grid' | 'keys' | 'ruler' | 'lane')[]) {
    if (!parts.length) this.dirty = { grid: true, keys: true, ruler: true, lane: true };
    else for (const p of parts) this.dirty[p] = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  private render() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!this.visible() || !store.project) return;
    if (this.grid.fit()) this.dirty.grid = true;
    if (this.keys.fit()) this.dirty.keys = true;
    if (this.ruler.fit()) this.dirty.ruler = true;
    if (this.showLane && this.lane.fit()) this.dirty.lane = true;
    if (this.ovw.fit()) this.dirty.ruler = true;
    if (!this.grid.w || !this.grid.h) return;
    if (this.needFit) {
      this.needFit = false;
      this.fitH();
    }
    if (this.needCenter) {
      this.needCenter = false;
      this.centerOnNotes();
    }
    const bx = this.sx, by = this.sy, bz = this.zx, br = this.rowH;
    this.clampScroll();
    if (bx !== this.sx || bz !== this.zx) this.dirty.grid = this.dirty.ruler = this.dirty.lane = true;
    if (by !== this.sy || br !== this.rowH) this.dirty.grid = this.dirty.keys = true;
    const v = this.v;
    const c = this.ch();
    const pat = this.pat();
    const notes = this.notes();
    const color = FL_NOTE; // FL-style green notes (selected notes turn red)
    const patLen = this.patLen();
    const bar = this.barT;
    const sc = store.ui.scale;
    const mask = this.hiMask();
    if (this.dirty.grid) {
      const ghosts: { notes: Note[]; color: string }[] = [];
      if (store.ui.ghost && pat) {
        for (const [cid, arr] of Object.entries(pat.notes)) {
          if (cid === c?.id || !arr.length) continue;
          const gc = store.channel(cid);
          if (gc) ghosts.push({ notes: arr, color: gc.color }); // FL: dim outlines in the other channels' colours
        }
      }
      const snap = store.ui.snap;
      drawGrid(this.grid.ctx, v, {
        notes,
        color,
        sel: this.sel,
        ghosts,
        patLen,
        bar,
        snapGrid: snap === 'line' || snap === 'none' || snap === 'cell' ? 0 : snapTicks(snap, store.project.timeSig),
        mask,
        root: sc.root,
        hoverKey: this.hoverKey,
        hoverNote: this.hoverNote,
        hoverEdge: this.hoverEdge,
        timeSel: this.timeSel,
        box: this.box
          ? { kind: this.box.kind, x0: tickX(v, this.box.t0), x1: tickX(v, this.box.t1), y0: this.box.c0 - this.sy, y1: this.box.c1 - this.sy }
          : null,
        slice: this.slice,
        scrub: this.scrub,
        showNames: this.showNames,
      });
    }
    if (this.dirty.keys) drawKeys(this.keys.ctx, v, this.keys.w, { lit: this.lit, hoverKey: this.hoverKey, mask, root: sc.root });
    if (this.dirty.ruler) drawRuler(this.ruler.ctx, v, this.ruler.h, { patLen, bar, timeSig: store.project.timeSig, timeSel: this.timeSel, hoverTick: this.rulerHover });
    if ((this.dirty.ruler || this.dirty.grid) && this.ovw.w) drawOverview(this.ovw.ctx, v, this.ovw.w, this.ovw.h, { notes, total: this.contentEnd(), patLen, sel: this.sel, play: null });
    if (this.dirty.lane && this.showLane && this.lane.w) drawLane(this.lane.ctx, v, this.lane.h, { notes, color, sel: this.sel, mode: this.laneMode, patLen, bar, hoverNote: this.laneHover ?? this.hoverNote });
    this.dirty = { grid: false, keys: false, ruler: false, lane: false };
    this.updateScrollbars();
    this.placePlayhead();
    this.updateStatus(notes.length);
    this.chKey.textContent = this.hoverKey !== null ? noteName(this.hoverKey) : '';
  }

  private updateStatus(count: number) {
    const k = this.sel.size;
    const s = count ? `${count} note${count === 1 ? '' : 's'}${k ? ` · ${k} selected` : ''}` : 'empty — click to draw';
    if (s !== this.statusText) {
      this.statusText = s;
      this.status.textContent = s;
    }
  }

  private updateScrollbars() {
    const tw = this.hs.clientWidth, th = this.vs.clientHeight;
    const total = this.contentEnd(), viewT = this.grid.w / this.zx;
    const hw = clamp((viewT / total) * tw, 24, tw);
    const hl = total > viewT ? ((tw - hw) * this.sx) / (total - viewT) : 0;
    this.hThumb.style.width = hw + 'px';
    this.hThumb.style.transform = `translateX(${hl}px)`;
    const totalH = 128 * this.rowH, viewH = this.grid.h;
    const vh = clamp((viewH / totalH) * th, 24, th);
    const vt = totalH > viewH ? ((th - vh) * this.sy) / (totalH - viewH) : 0;
    this.vThumb.style.height = vh + 'px';
    this.vThumb.style.transform = `translateY(${vt}px)`;
  }

  // ================================================================ playhead
  /** Pattern-local playhead tick, or null when the current pattern isn't playing. */
  playTick(): number | null {
    if (!engine.ready || (!engine.playing && !engine.paused)) return null;
    return this.localTick(engine.position);
  }
  private localTick(pos: number): number | null {
    const song = engine.playing || engine.paused ? engine.mode === 'song' : store.ui.songMode;
    if (!song) return pos;
    const pat = this.pat();
    const plen = this.patLen();
    for (const c of store.project.playlist.clips) {
      if (c.kind !== 'pattern' || c.ref !== pat.id || c.muted) continue;
      if (pos >= c.start && pos < c.start + c.len) return (((pos - c.start + c.offset) % plen) + plen) % plen;
    }
    return null;
  }

  private placePlayhead() {
    const t = this.playTick();
    const show = t !== null;
    let x = 0;
    if (show) x = tickX(this.v, t!);
    const inView = show && x >= -1 && x <= this.grid.w + 1;
    for (const e of [this.phGrid, this.phLane, this.phTri]) {
      e.style.display = inView ? 'block' : 'none';
      if (inView) e.style.transform = `translateX(${Math.round(x)}px)`;
    }
    return t;
  }

  private startPlayhead() {
    if (this.phRaf || !engine.playing || !this.visible()) {
      this.placePlayhead();
      return;
    }
    const loop = () => {
      this.phRaf = 0;
      if (!this.visible()) return;
      const t = this.placePlayhead();
      if (t !== null && this.follow && engine.playing && !this.dragging) {
        const x = tickX(this.v, t);
        if (x > this.grid.w - 6 || x < 0) {
          this.sx = Math.max(0, t - (this.grid.w * 0.04) / this.zx);
          this.invalidate();
        }
      }
      if (engine.playing) this.phRaf = requestAnimationFrame(loop);
    };
    this.phRaf = requestAnimationFrame(loop);
  }

  /** Lit piano keys: auditioned key, typing keyboard / MIDI held notes, notes under the playhead. */
  private pollLit() {
    const c = this.ch();
    const lit = new Map<number, string>();
    if (c) {
      const t = engine.playing ? this.playTick() : null;
      if (t !== null) for (const n of this.notes()) if (!n.muted && n.start <= t && n.start + n.len > t) lit.set(n.key, c.color);
      for (const h of engine.heldKeys()) if (h.channelId === c.id) lit.set(h.key, '#f6a432');
    }
    if (this.kbdKey !== null) lit.set(this.kbdKey, '#f6a432');
    let sig = '';
    for (const [k, col] of lit) sig += k + col;
    if (sig !== this.litSig) {
      this.litSig = sig;
      this.lit = lit;
      this.invalidate('keys');
    }
  }

  onShow() {
    this.updateTitle();
    this.bar.sync();
    this.bar.syncChannel();
    this.updateCursor();
    this.invalidate();
    this.startPlayhead();
    if (!this.litTimer) this.litTimer = setInterval(() => this.pollLit(), 50);
  }
  onHide() {
    clearInterval(this.litTimer);
    this.litTimer = null;
    if (this.phRaf) cancelAnimationFrame(this.phRaf);
    this.phRaf = 0;
  }

  // ================================================================ hit testing
  local(e: { clientX: number; clientY: number }, wrap: HTMLElement = this.grid.wrap) {
    const r = wrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hit(x: number, y: number): Hit | null {
    const v = this.v;
    const key = yKey(v, y);
    let best: Hit | null = null;
    const ns = this.notes();
    for (let pass = 0; pass < 2 && !best; pass++) {
      for (let i = ns.length - 1; i >= 0; i--) {
        const n = ns[i];
        if (n.key !== key) continue;
        if ((pass === 0) !== this.sel.has(n.id)) continue;
        const nx = tickX(v, n.start);
        const w = Math.max(3, n.len * v.zx);
        if (x < nx || x >= nx + w) continue;
        const zone = Math.min(8, Math.max(3, w / 4));
        best = { n, edge: x >= nx + w - zone };
        break;
      }
    }
    return best;
  }

  /** Notes touched along a mouse segment (for delete / mute drags). */
  private touched(x0: number, y0: number, x1: number, y1: number): Note[] {
    const out = new Map<string, Note>();
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
    for (let i = 0; i <= steps; i++) {
      const h = this.hit(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      if (h) out.set(h.n.id, h.n);
    }
    return [...out.values()];
  }

  // ================================================================ drag helper
  private drag(e: PointerEvent, wrap: HTMLElement, move: (ev: PointerEvent, p: { x: number; y: number }) => void, up: (ev: PointerEvent, moved: boolean) => void, o: DragOpts = {}) {
    const target = e.target as Element;
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {}
    const thr = o.threshold ?? 0;
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    let last = e;
    let raf = 0;
    this.dragging = true;
    this.flushWheel();
    const autoTick = () => {
      raf = 0;
      const p = this.local(last, wrap);
      let dx = 0, dy = 0;
      if (p.x < 0) dx = p.x;
      else if (p.x > wrap.clientWidth) dx = p.x - wrap.clientWidth;
      if (p.y < 0) dy = p.y;
      else if (p.y > wrap.clientHeight) dy = p.y - wrap.clientHeight;
      if (!dx && !dy) return;
      this.sx += (clamp(dx, -60, 60) * 0.35) / this.zx;
      this.sy += clamp(dy, -60, 60) * 0.35;
      this.clampScroll();
      this.invalidate();
      move(last, this.local(last, wrap));
      raf = requestAnimationFrame(autoTick);
    };
    const mv = (ev: PointerEvent) => {
      last = ev;
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) > thr) moved = true;
      if (!moved) return;
      move(ev, this.local(ev, wrap));
      if (o.autoScroll && !raf) raf = requestAnimationFrame(autoTick);
    };
    const fin = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', fin);
      window.removeEventListener('pointercancel', fin);
      if (raf) cancelAnimationFrame(raf);
      this.dragging = false;
      up(ev, moved);
      this.invalidate();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', fin);
    window.addEventListener('pointercancel', fin);
  }

  /** Pressing a canvas must hand keyboard focus back to the shortcuts (toolbar selects keep it otherwise). */
  private releaseFocus() {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && this.root.contains(a)) a.blur();
  }

  // ================================================================ grid mouse
  private wireGrid(wrap: HTMLElement) {
    const cv = this.grid.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      this.releaseFocus();
      this.gridDown(e);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.dragging) this.hover(e);
    });
    cv.addEventListener('pointerleave', () => {
      if (this.dragging) return;
      this.hoverKey = this.hoverNote = null;
      this.hoverEdge = false;
      this.invalidate('grid', 'keys', 'lane');
    });
    cv.addEventListener('dblclick', (e) => {
      const p = this.local(e);
      const h = this.hit(p.x, p.y);
      if (h && h.n.id !== this.justCreated && !e.ctrlKey && (store.ui.prTool === 'draw' || store.ui.prTool === 'paint' || store.ui.prTool === 'select')) this.noteProps(h.n.id);
    });
    cv.addEventListener('wheel', (e) => this.gridWheel(e), { passive: false });
    wrap.dataset.hint = 'Piano roll';
  }

  private hover(e: PointerEvent) {
    const p = this.local(e);
    const key = clamp(yKey(this.v, p.y), 0, 127);
    const h = this.hit(p.x, p.y);
    const hn = h?.n.id ?? null;
    const he = !!h?.edge;
    if (key !== this.hoverKey || hn !== this.hoverNote || he !== this.hoverEdge) {
      const keyChanged = key !== this.hoverKey;
      this.hoverKey = key;
      this.hoverNote = hn;
      this.hoverEdge = he;
      this.invalidate('grid', 'lane');
      if (keyChanged) this.invalidate('keys');
      this.chKey.textContent = noteName(key);
    }
    this.updateCursor(h);
    const t = xTick(this.v, p.x);
    const tool = TOOLS.find((x) => x.id === store.ui.prTool);
    const where = `${noteName(key)} · ${fmtBST(Math.max(0, t), store.project.timeSig)}`;
    const what = h ? ` · note ${noteName(h.n.key)} vel ${Math.round(h.n.vel * 100)}% len ${h.n.len}t${h.n.muted ? ' (muted)' : ''}` : '';
    setHint(`${where}${what} — ${tool?.label ?? ''} tool: ${tool?.help ?? ''}`);
  }

  updateCursor(h?: Hit | null) {
    const tool = store.ui.prTool;
    let c = CURSORS[tool] ?? 'default';
    if (h && (tool === 'draw' || tool === 'paint' || tool === 'select')) c = h.edge ? 'ew-resize' : tool === 'select' ? 'move' : 'grab';
    if (this.grid.canvas.style.cursor !== c) this.grid.canvas.style.cursor = c;
  }

  private gridDown(e: PointerEvent) {
    e.preventDefault();
    if (this.dragging) return; // a second button during a drag is ignored
    this.flushWheel();
    const p = this.local(e);
    const tool = store.ui.prTool;
    if (e.button === 1) return this.startPan(e);
    if (e.button === 2) {
      if (tool === 'zoom') return this.zoomH(1 / 1.6, p.x);
      return this.startDelete(e);
    }
    if (e.button !== 0) return;
    const h = this.hit(p.x, p.y);
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && tool !== 'zoom' && tool !== 'playback') return this.startBox(e, e.shiftKey, 'select', h);
    switch (tool) {
      case 'draw':
      case 'paint':
        if (h) return this.grabNote(e, h);
        return tool === 'draw' ? this.startCreate(e) : this.startPaint(e);
      case 'select':
        if (h) {
          if (e.shiftKey && this.sel.has(h.n.id)) return this.grabNote(e, h);
          if (e.shiftKey) {
            this.sel.add(h.n.id);
            this.invalidate('grid', 'lane');
            return;
          }
          if (!this.sel.has(h.n.id)) this.setSel([h.n.id]);
          return this.grabNote(e, h);
        }
        return this.startBox(e, e.shiftKey, 'select', null);
      case 'delete':
        return this.startDelete(e);
      case 'mute':
        return this.startMute(e);
      case 'slice':
        return this.startSlice(e);
      case 'zoom':
        return this.startBox(e, false, 'zoom', null);
      case 'playback':
        return this.startScrub(e);
    }
  }

  /** Press on an existing note: resize from the edge, Shift duplicates, otherwise move. */
  private grabNote(e: PointerEvent, h: Hit) {
    const n = h.n;
    const group = this.sel.has(n.id) ? [...this.sel] : [n.id];
    this.lastLen = n.len;
    this.lastVel = n.vel;
    this.lastPan = n.pan;
    if (h.edge && !e.shiftKey) return this.startResize(e, n.id, group);
    if (e.shiftKey) return this.startDuplicate(e, n.id, group);
    this.audition(n.key, n.vel, n.len);
    this.startMove(e, n.id, group, group.length > 1 ? 'Move notes' : 'Move note', false);
  }

  private startCreate(e: PointerEvent) {
    const p = this.local(e);
    const g = this.gridTicks(e.altKey);
    const t = Math.max(0, xTick(this.v, p.x));
    let k = clamp(yKey(this.v, p.y), 0, 127);
    const mask = this.snapMask();
    if (mask) k = snapToScale(k, mask);
    const start = g > 1 ? snapDown(t, g) : Math.round(t);
    const len = this.newLen();
    const keys = chordKeys(k, this.chord, this.fullMask());
    const label = keys.length > 1 ? 'Add chord' : 'Add note';
    const created: Note[] = keys.map((key) => ({ id: uid('n'), key, start, len, vel: this.lastVel, pan: this.lastPan }));
    store.begin(label);
    this.apply(label, (arr) => arr.push(...created), true);
    this.sel.clear();
    this.timeSel = null;
    this.justCreated = created[0].id;
    setTimeout(() => {
      if (this.justCreated === created[0].id) this.justCreated = null;
    }, 600);
    for (const c of created) this.audition(c.key, c.vel, len);
    this.startMove(e, created[0].id, created.map((c) => c.id), label, true);
  }

  private startDuplicate(e: PointerEvent, anchorId: string, group: string[]) {
    const gs = new Set(group);
    const src = this.notes().filter((n) => gs.has(n.id));
    const copies = src.map((n) => ops.cloneNote(n));
    const anchorIdx = src.findIndex((n) => n.id === anchorId);
    store.begin('Duplicate notes');
    this.apply('Duplicate notes', (arr) => arr.push(...copies), true);
    this.setSel(copies.map((c) => c.id));
    this.startMove(e, copies[Math.max(0, anchorIdx)].id, copies.map((c) => c.id), 'Duplicate notes', true);
  }

  private startMove(e: PointerEvent, anchorId: string, ids: string[], label: string, begun: boolean) {
    const idSet = new Set(ids);
    const orig = new Map<string, { key: number; start: number }>();
    for (const n of this.notes()) if (idSet.has(n.id)) orig.set(n.id, { key: n.key, start: n.start });
    const a = orig.get(anchorId);
    if (!a) {
      if (begun) store.end();
      return;
    }
    let minStart = Infinity, lo = 127, hi = 0;
    for (const o of orig.values()) {
      minStart = Math.min(minStart, o.start);
      lo = Math.min(lo, o.key);
      hi = Math.max(hi, o.key);
    }
    const p0 = this.local(e);
    const t0 = xTick(this.v, p0.x);
    const k0 = yKey(this.v, p0.y);
    const mask = this.snapMask();
    let lastDt = 0, lastDk = 0, started = begun;
    this.grid.canvas.style.cursor = 'grabbing';
    this.drag(
      e,
      this.grid.wrap,
      (ev, p) => {
        const g = this.gridTicks(ev.altKey);
        const t = xTick(this.v, p.x);
        const k = yKey(this.v, p.y);
        let ns = a.start + (t - t0);
        ns = g > 1 ? snapRound(ns, g) : Math.round(ns);
        let dt = ns - a.start;
        if (minStart + dt < 0) dt = -minStart;
        const dk = clamp(k - k0, -lo, 127 - hi);
        if (dt === lastDt && dk === lastDk) return;
        const keyChanged = dk !== lastDk;
        lastDt = dt;
        lastDk = dk;
        if (!started) {
          store.begin(label);
          started = true;
        }
        let anchorKey = a.key;
        this.apply(label, (arr) => {
          for (const n of arr) {
            const o = orig.get(n.id);
            if (!o) continue;
            n.start = o.start + dt;
            n.key = mask && dk ? snapToScale(o.key + dk, mask, dk > 0 ? 1 : -1) : o.key + dk;
            if (n.id === anchorId) anchorKey = n.key;
          }
        }, true);
        if (keyChanged) this.audition(anchorKey);
        setHint(`${label}: ${noteName(anchorKey)} at ${fmtBST(a.start + dt, store.project.timeSig)}${dt ? ` (${dt > 0 ? '+' : ''}${dt} ticks)` : ''}`);
      },
      () => {
        if (started) store.end();
        const q = this.local({ clientX: this.lastClient.x, clientY: this.lastClient.y });
        this.updateCursor(this.hit(q.x, q.y));
      },
      { threshold: begun ? 0 : 3, autoScroll: true },
    );
  }

  private startResize(e: PointerEvent, anchorId: string, ids: string[]) {
    const idSet = new Set(ids);
    const orig = new Map<string, { start: number; len: number }>();
    for (const n of this.notes()) if (idSet.has(n.id)) orig.set(n.id, { start: n.start, len: n.len });
    const a = orig.get(anchorId);
    if (!a) return;
    const t0 = xTick(this.v, this.local(e).x);
    const label = ids.length > 1 ? 'Resize notes' : 'Resize note';
    let started = false, lastD = 0;
    this.drag(
      e,
      this.grid.wrap,
      (ev, p) => {
        const g = this.gridTicks(ev.altKey);
        const t = xTick(this.v, p.x);
        let ne = a.start + a.len + (t - t0);
        ne = g > 1 ? snapRound(ne, g) : Math.round(ne);
        let nl = ne - a.start;
        if (nl < (g > 1 ? Math.min(g, a.len) : 1)) nl = g > 1 ? Math.min(g, Math.max(a.len, 1)) : 1;
        const d = nl - a.len;
        if (d === lastD) return;
        lastD = d;
        if (!started) {
          store.begin(label);
          started = true;
        }
        this.apply(label, (arr) => {
          for (const n of arr) {
            const o = orig.get(n.id);
            if (o) n.len = Math.max(1, o.len + d);
          }
        }, true);
        this.lastLen = Math.max(1, a.len + d);
        setHint(`${label}: length ${this.lastLen} ticks (${(this.lastLen / STEP).toFixed(2).replace(/\.?0+$/, '')} steps)`);
      },
      () => {
        if (started) store.end();
      },
      { threshold: 1, autoScroll: true },
    );
  }

  private startDelete(e: PointerEvent) {
    let px = this.local(e);
    let started = false;
    const kill = (list: Note[]) => {
      if (!list.length) return;
      if (!started) {
        store.begin('Delete notes');
        started = true;
      }
      const ids = new Set(list.map((n) => n.id));
      for (const id of ids) this.sel.delete(id);
      this.apply('Delete notes', (arr) => {
        for (let i = arr.length - 1; i >= 0; i--) if (ids.has(arr[i].id)) arr.splice(i, 1);
      }, true);
    };
    kill(this.touched(px.x, px.y, px.x, px.y));
    this.drag(
      e,
      this.grid.wrap,
      (_ev, p) => {
        kill(this.touched(px.x, px.y, p.x, p.y));
        px = p;
      },
      () => {
        if (started) store.end();
      },
      { autoScroll: true },
    );
  }

  private startMute(e: PointerEvent) {
    let px = this.local(e);
    let state: boolean | null = null;
    const done = new Set<string>();
    let started = false;
    const touch = (list: Note[]) => {
      const fresh = list.filter((n) => !done.has(n.id));
      if (!fresh.length) return;
      if (state === null) state = !fresh[0].muted;
      for (const n of fresh) done.add(n.id);
      if (!started) {
        store.begin(state ? 'Mute notes' : 'Unmute notes');
        started = true;
      }
      const ids = new Set(fresh.map((n) => n.id));
      const st = state;
      this.apply('Mute notes', (arr) => ops.setMuted(arr.filter((n) => ids.has(n.id)), st), true);
    };
    touch(this.touched(px.x, px.y, px.x, px.y));
    this.drag(
      e,
      this.grid.wrap,
      (_ev, p) => {
        touch(this.touched(px.x, px.y, p.x, p.y));
        px = p;
      },
      () => {
        if (started) store.end();
      },
      { autoScroll: true },
    );
  }

  private startPaint(e: PointerEvent) {
    const mask = this.snapMask();
    let last: { start: number; len: number } | null = null;
    let started = false;
    const paintAt = (p: { x: number; y: number }, alt: boolean) => {
      const g = this.gridTicks(alt);
      const len = this.newLen();
      const step = Math.max(g, len);
      let k = clamp(yKey(this.v, p.y), 0, 127);
      if (mask) k = snapToScale(k, mask);
      const t = Math.max(0, xTick(this.v, p.x));
      const cell = g > 1 ? snapDown(t, g) : Math.round(t);
      const starts: number[] = [];
      if (!last) starts.push(cell);
      else if (cell >= last.start + step) for (let s = last.start + step; s <= cell; s += step) starts.push(s);
      else if (cell <= last.start - step) starts.push(cell);
      if (!starts.length) return;
      const existing = this.notes();
      const add: Note[] = [];
      for (const s of starts) {
        if (existing.some((n) => n.key === k && n.start === s)) continue;
        for (const key of chordKeys(k, this.chord, this.fullMask())) add.push({ id: uid('n'), key, start: s, len, vel: this.lastVel, pan: this.lastPan });
      }
      last = { start: starts[starts.length - 1], len };
      if (!add.length) return;
      if (!started) {
        store.begin('Paint notes');
        started = true;
      }
      this.apply('Paint notes', (arr) => arr.push(...add), true);
      this.audition(k, this.lastVel, len);
    };
    this.sel.clear();
    paintAt(this.local(e), e.altKey);
    this.drag(e, this.grid.wrap, (ev, p) => paintAt(p, ev.altKey), () => {
      if (started) store.end();
    }, { autoScroll: true });
  }

  private startSlice(e: PointerEvent) {
    const p0 = this.local(e);
    const k0 = clamp(yKey(this.v, p0.y), 0, 127);
    const at = (p: { x: number; y: number }, alt: boolean) => {
      const g = this.gridTicks(alt);
      const t = Math.max(0, xTick(this.v, p.x));
      const k1 = clamp(yKey(this.v, p.y), 0, 127);
      this.slice = { t: g > 1 ? snapRound(t, g) : Math.round(t), lo: Math.min(k0, k1), hi: Math.max(k0, k1) };
      this.invalidate('grid');
    };
    at(p0, e.altKey);
    this.drag(e, this.grid.wrap, (ev, p) => at(p, ev.altKey), () => {
      const s = this.slice;
      this.slice = null;
      if (!s) return;
      const hadSel = this.sel.size > 0;
      const right = this.apply('Slice notes', (arr) => ops.sliceAt(arr, s.t, s.lo, s.hi));
      if (right?.length && hadSel) for (const id of right) this.sel.add(id);
    }, { autoScroll: true });
  }

  private startBox(e: PointerEvent, add: boolean, kind: 'select' | 'zoom', h: Hit | null) {
    const p0 = this.local(e);
    const t0 = xTick(this.v, p0.x);
    const c0 = p0.y + this.sy;
    const base = add ? new Set(this.sel) : new Set<string>();
    this.box = { t0, c0, t1: t0, c1: c0, kind };
    const update = (p: { x: number; y: number }) => {
      if (!this.box) return;
      this.box.t1 = xTick(this.v, p.x);
      this.box.c1 = p.y + this.sy;
      if (kind === 'select') {
        const tMin = Math.min(this.box.t0, this.box.t1), tMax = Math.max(this.box.t0, this.box.t1);
        const kHi = 127 - Math.floor(Math.min(this.box.c0, this.box.c1) / this.rowH);
        const kLo = 127 - Math.floor(Math.max(this.box.c0, this.box.c1) / this.rowH);
        const s = new Set(base);
        for (const n of this.notes()) if (n.key >= kLo && n.key <= kHi && n.start < tMax && n.start + n.len > tMin) s.add(n.id);
        this.sel = s;
        this.invalidate('grid', 'lane');
      } else this.invalidate('grid');
    };
    this.drag(e, this.grid.wrap, (_ev, p) => update(p), (_ev, moved) => {
      const b = this.box;
      this.box = null;
      if (!b) return;
      if (kind === 'zoom') {
        const tMin = Math.min(b.t0, b.t1), tMax = Math.max(b.t0, b.t1);
        const cMin = Math.min(b.c0, b.c1), cMax = Math.max(b.c0, b.c1);
        if (!moved || (tMax - tMin) * this.zx < 6) return this.zoomH(1.6, p0.x);
        const rows = Math.max(1, (cMax - cMin) / this.rowH);
        this.zx = clamp(this.grid.w / (tMax - tMin), 0.01, 24);
        this.sx = tMin;
        const newRow = clamp(this.grid.h / rows, 5, 48);
        this.sy = (cMin / this.rowH) * newRow;
        this.rowH = newRow;
        this.invalidate();
        return;
      }
      if (!moved) {
        if (h) {
          // ctrl+click toggles one note
          const s = new Set(this.sel);
          if (s.has(h.n.id)) s.delete(h.n.id);
          else s.add(h.n.id);
          this.setSel(s);
        } else if (!add) {
          this.setSel([]);
          this.timeSel = null;
        }
      }
    }, { threshold: 2, autoScroll: true });
  }

  private startPan(e: PointerEvent) {
    const sx0 = this.sx, sy0 = this.sy;
    const x0 = e.clientX, y0 = e.clientY;
    this.grid.canvas.style.cursor = 'grabbing';
    this.drag(e, this.grid.wrap, (ev) => {
      this.sx = sx0 - (ev.clientX - x0) / this.zx;
      this.sy = sy0 - (ev.clientY - y0);
      this.invalidate();
    }, () => this.updateCursor());
  }

  private startScrub(e: PointerEvent) {
    let prev: number | null = null;
    const c = this.ch();
    const at = (p: { x: number; y: number }) => {
      const t = Math.max(0, xTick(this.v, p.x));
      this.scrub = t;
      if (c) {
        for (const n of this.notes()) {
          if (n.muted) continue;
          const crossed = prev === null ? n.start <= t && n.start + n.len > t : (n.start > Math.min(prev, t) && n.start <= Math.max(prev, t));
          if (crossed) engine.preview(c.id, n.key, n.vel, clamp(n.len * engine.spt, 0.05, 1.2));
        }
      }
      prev = t;
      this.invalidate('grid');
      setHint(`Scrub ${fmtBST(t, store.project.timeSig)}`);
    };
    at(this.local(e));
    this.drag(e, this.grid.wrap, (_ev, p) => at(p), () => {
      this.scrub = null;
    }, { autoScroll: true });
  }

  private gridWheel(e: WheelEvent) {
    e.preventDefault();
    let dy = e.deltaY, dx = e.deltaX;
    if (e.deltaMode === 1) {
      dy *= 16;
      dx *= 16;
    } else if (e.deltaMode === 2) {
      dy *= this.grid.h;
      dx *= this.grid.w;
    }
    const p = this.local(e);
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.altKey) this.zoomV(Math.exp(-clamp(dy, -150, 150) * 0.0022), p.y);
    else if (ctrl) this.zoomH(Math.exp(-clamp(dy || dx, -150, 150) * 0.0025), p.x);
    else if (e.altKey) {
      const h = this.hit(p.x, p.y);
      if (!h || !dy) return;
      const ids = new Set(this.sel.has(h.n.id) ? this.sel : [h.n.id]);
      const d = dy < 0 ? 0.02 : -0.02;
      if (!this.wheelLive) {
        store.begin('Note velocity');
        this.wheelLive = true;
      }
      this.apply('Note velocity', (arr) => {
        for (const n of arr) if (ids.has(n.id)) n.vel = clamp(Math.round((n.vel + d) * 100) / 100, 0.01, 1);
      }, true);
      clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => this.flushWheel(), 450);
      setHint(`Velocity ${Math.round(clamp(h.n.vel, 0, 1) * 100)}%${ids.size > 1 ? ` (${ids.size} notes)` : ''}`);
    } else if (e.shiftKey) this.scrollBy((dy || dx) / this.zx, 0);
    else this.scrollBy(dx / this.zx, dy);
  }

  // ================================================================ keyboard (piano) mouse
  private wireKeys(wrap: HTMLElement) {
    const cv = this.keys.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.dragging) return;
      e.preventDefault();
      this.releaseFocus();
      const c = this.ch();
      if (!c) return;
      const p = this.local(e, wrap);
      const k = clamp(yKey(this.v, p.y), 0, 127);
      if (e.ctrlKey || e.metaKey) {
        const ids = this.notes().filter((n) => n.key === k).map((n) => n.id);
        this.setSel(e.shiftKey ? [...this.sel, ...ids] : ids);
        return;
      }
      const velAt = (x: number) => clamp(0.35 + (0.65 * x) / Math.max(1, this.keys.w), 0.1, 1);
      let cur = k;
      engine.noteOn(cur, velAt(p.x), c.id, 'pr-kbd');
      this.kbdKey = cur;
      this.pollLit();
      this.drag(e, wrap, (_ev, q) => {
        const nk = clamp(yKey(this.v, q.y), 0, 127);
        if (nk === cur) return;
        engine.noteOff(cur, c.id, 'pr-kbd');
        cur = nk;
        engine.noteOn(cur, velAt(q.x), c.id, 'pr-kbd');
        this.kbdKey = cur;
        this.pollLit();
      }, () => {
        engine.noteOff(cur, c.id, 'pr-kbd');
        this.kbdKey = null;
        this.pollLit();
      });
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.dragging) return;
      const k = clamp(yKey(this.v, this.local(e, wrap).y), 0, 127);
      if (k !== this.hoverKey) {
        this.hoverKey = k;
        this.chKey.textContent = noteName(k);
        this.invalidate('grid', 'keys');
      }
    });
    cv.addEventListener('pointerleave', () => {
      if (this.dragging) return;
      this.hoverKey = null;
      this.invalidate('grid', 'keys');
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (e.ctrlKey || e.metaKey) this.zoomV(Math.exp(-clamp(dy, -150, 150) * 0.0022), this.local(e, wrap).y);
      else this.scrollBy(0, dy);
    }, { passive: false });
  }

  // ================================================================ ruler mouse
  private wireRuler(wrap: HTMLElement) {
    const cv = this.ruler.canvas;
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.timeSel) {
        this.timeSel = null;
        this.invalidate('grid', 'ruler');
      }
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.dragging) return;
      e.preventDefault();
      this.releaseFocus();
      const p = this.local(e, wrap);
      if (e.ctrlKey || e.metaKey) {
        const g = this.gridTicks(e.altKey);
        const snap = (t: number) => (g > 1 ? snapRound(Math.max(0, t), g) : Math.round(Math.max(0, t)));
        const a = snap(xTick(this.v, p.x));
        const add = e.shiftKey;
        const base = add ? new Set(this.sel) : new Set<string>();
        const upd = (x: number) => {
          const b = snap(xTick(this.v, x));
          this.timeSel = b === a ? null : { start: Math.min(a, b), end: Math.max(a, b) };
          const s = new Set(base);
          if (this.timeSel) for (const n of this.notes()) if (n.start >= this.timeSel.start && n.start < this.timeSel.end) s.add(n.id);
          this.sel = s;
          this.invalidate('grid', 'ruler', 'lane');
        };
        this.drag(e, wrap, (_ev, q) => upd(q.x), () => {}, { autoScroll: true });
        return;
      }
      const setPos = (x: number) => {
        const t = Math.max(0, Math.round(xTick(this.v, x)));
        engine.setPosition(this.songTickFor(t));
        this.placePlayhead();
      };
      setPos(p.x);
      this.drag(e, wrap, (_ev, q) => setPos(q.x), () => {});
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.dragging) return;
      this.rulerHover = xTick(this.v, this.local(e, wrap).x);
      this.invalidate('ruler');
    });
    cv.addEventListener('pointerleave', () => {
      this.rulerHover = null;
      this.invalidate('ruler');
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (e.shiftKey) this.scrollBy(dy / this.zx, 0);
      else this.zoomH(Math.exp(-clamp(dy, -150, 150) * 0.0025), this.local(e, wrap).x);
    }, { passive: false });
  }

  /** Pattern tick -> engine position (song mode: inside the clip of this pattern under the song position). */
  private songTickFor(t: number) {
    if (!store.ui.songMode) return t;
    const pat = this.pat();
    const plen = this.patLen();
    const pos = engine.position;
    const clips = store.project.playlist.clips.filter((c) => c.kind === 'pattern' && c.ref === pat.id);
    const c = clips.find((x) => pos >= x.start && pos < x.start + x.len) ?? clips[0];
    if (!c) return t;
    const loopStart = c.start - c.offset + Math.floor((pos - c.start + c.offset) / plen) * plen;
    return clamp(Math.max(loopStart, c.start - c.offset) + t, c.start, c.start + c.len - 1);
  }

  // ================================================================ velocity / pan lane
  private wireLane(wrap: HTMLElement) {
    const cv = this.lane.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    const valAt = (y: number) => {
      const top = 6, bot = this.lane.h - 4, span = Math.max(1, bot - top);
      return this.laneMode === 'vel' ? clamp((bot - y) / span, 0.01, 1) : clamp((top + span / 2 - y) / (span / 2), -1, 1);
    };
    cv.addEventListener('pointerdown', (e) => {
      if ((e.button !== 0 && e.button !== 2) || this.dragging) return;
      e.preventDefault();
      this.releaseFocus();
      if (!this.ch()) return;
      const reset = e.button === 2;
      const label = this.laneMode === 'vel' ? 'Note velocity' : 'Note pan';
      let prev = this.local(e, wrap);
      let started = false;
      const paint = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const x0 = Math.min(a.x, b.x) - 3, x1 = Math.max(a.x, b.x) + 3;
        const onlySel = this.sel.size > 0;
        const v = this.v;
        const hits: { id: string; val: number }[] = [];
        for (const n of this.notes()) {
          if (onlySel && !this.sel.has(n.id)) continue;
          const x = tickX(v, n.start);
          if (x < x0 || x > x1) continue;
          const f = b.x === a.x ? 1 : clamp((x - a.x) / (b.x - a.x), 0, 1);
          const val = reset ? (this.laneMode === 'vel' ? 0.78 : 0) : valAt(a.y + (b.y - a.y) * f);
          hits.push({ id: n.id, val });
        }
        if (!hits.length) return;
        if (!started) {
          store.begin(label);
          started = true;
        }
        const m = new Map(hits.map((h) => [h.id, h.val]));
        this.apply(label, (arr) => {
          for (const n of arr) {
            const val = m.get(n.id);
            if (val === undefined) continue;
            if (this.laneMode === 'vel') n.vel = Math.round(val * 1000) / 1000;
            else n.pan = Math.round(val * 1000) / 1000;
          }
        }, true);
        const last = hits[hits.length - 1].val;
        setHint(this.laneMode === 'vel' ? `Velocity ${Math.round(last * 100)}%` : `Pan ${last === 0 ? 'centered' : Math.round(Math.abs(last) * 100) + '% ' + (last < 0 ? 'left' : 'right')}`);
      };
      paint(prev, prev);
      this.drag(e, wrap, (_ev, p) => {
        paint(prev, p);
        prev = p;
      }, () => {
        if (started) store.end();
      });
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.dragging) return;
      const p = this.local(e, wrap);
      let best: Note | null = null, bd = 6;
      for (const n of this.notes()) {
        const d = Math.abs(tickX(this.v, n.start) - p.x);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      const id = best?.id ?? null;
      if (id !== this.laneHover) {
        this.laneHover = id;
        this.invalidate('lane');
      }
      if (best) setHint(`${noteName(best.key)} at ${fmtBST(best.start, store.project.timeSig)} — velocity ${Math.round(best.vel * 100)}% · pan ${Math.round(best.pan * 100)}`);
    });
    cv.addEventListener('pointerleave', () => {
      this.laneHover = null;
      this.invalidate('lane');
    });
    cv.addEventListener('wheel', (e) => this.gridWheel(e), { passive: false });
  }

  private syncLaneTabs() {
    this.laneName.textContent = this.laneMode === 'vel' ? 'Note velocity' : 'Note panning';
    this.lane.wrap.dataset.hint =
      this.laneMode === 'vel'
        ? 'Control lane: note velocity — drag to paint (only selected notes when there is a selection) · right-drag resets'
        : 'Control lane: note panning — drag to paint (only selected notes when there is a selection) · right-drag centres';
  }

  setLaneMode(m: 'vel' | 'pan') {
    this.laneMode = m;
    lsSet(LS.laneMode, m);
    this.syncLaneTabs();
    if (!this.showLane) this.toggleLane();
    this.invalidate('lane');
  }

  private laneItems(): MenuItem[] {
    return [
      { label: 'Note velocity', checked: this.laneMode === 'vel', action: () => this.setLaneMode('vel') },
      { label: 'Note panning', checked: this.laneMode === 'pan', action: () => this.setLaneMode('pan') },
      { sep: true },
      { label: 'Show Control lane', checked: this.showLane, action: () => this.toggleLane() },
    ];
  }

  channelMenu(x: number, y: number) {
    const cur = this.ch()?.id;
    const pat = this.pat();
    const items: MenuItem[] = store.project.channels.map((c) => ({
      label: c.name + ((pat?.notes[c.id]?.length ?? 0) ? `  (${pat.notes[c.id].length})` : ''),
      color: c.color,
      checked: c.id === cur,
      action: () => store.setUI({ pianoRollChannel: c.id, selectedChannels: [c.id] }),
    }));
    if (!items.length) items.push({ label: 'No channels — add one in the Channel rack', disabled: true });
    showMenu(items, x, y);
  }

  // ================================================================ overview strip
  private wireOverview(wrap: HTMLElement) {
    const cv = this.ovw.canvas;
    const geo = () => overviewSpan(this.v, this.ovw.w, this.contentEnd());
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.dragging) return;
      e.preventDefault();
      this.releaseFocus();
      const x = this.local(e, wrap).x;
      const g0 = geo();
      if (x < g0.x0 || x > g0.x1) {
        // jump: centre the view there, then keep dragging the box
        this.sx = x / g0.k - this.grid.w / 2 / this.zx;
        this.clampScroll();
        this.invalidate();
      }
      const sx0 = this.sx, cx0 = e.clientX;
      cv.style.cursor = 'grabbing';
      this.drag(e, wrap, (ev) => {
        this.sx = sx0 + (ev.clientX - cx0) / g0.k;
        this.invalidate();
      }, () => (cv.style.cursor = ''));
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.dragging) return;
      const x = this.local(e, wrap).x;
      const g0 = geo();
      cv.style.cursor = x >= g0.x0 && x <= g0.x1 ? 'grab' : 'pointer';
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (e.shiftKey) this.scrollBy(dy / this.zx, 0);
      else this.zoomH(Math.exp(-clamp(dy, -150, 150) * 0.0025));
    }, { passive: false });
  }

  private applyLaneLayout() {
    this.body.classList.toggle('no-lane', !this.showLane);
    this.body.style.setProperty('--pr-lane-h', this.laneH + 'px');
  }

  toggleLane() {
    this.showLane = !this.showLane;
    lsSet(LS.lane, this.showLane ? '1' : '0');
    this.applyLaneLayout();
    this.bar.sync();
    this.invalidate();
  }

  private wireSplit(split: HTMLElement) {
    split.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const h0 = this.laneH;
      const y0 = e.clientY;
      this.drag(e, split, (ev) => {
        const maxH = Math.max(40, this.body.clientHeight - 120);
        this.laneH = clamp(h0 - (ev.clientY - y0), 40, maxH);
        this.applyLaneLayout();
      }, () => lsSet(LS.laneH, String(Math.round(this.laneH))));
    });
  }

  // ================================================================ scrollbars
  private wireScrollbars() {
    const thumbDrag = (horiz: boolean) => (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const s0 = horiz ? this.sx : this.sy;
      const c0 = horiz ? e.clientX : e.clientY;
      const track = horiz ? this.hs : this.vs;
      const thumb = horiz ? this.hThumb : this.vThumb;
      this.drag(e, track, (ev) => {
        const d = (horiz ? ev.clientX : ev.clientY) - c0;
        const trackLen = horiz ? track.clientWidth - thumb.offsetWidth : track.clientHeight - thumb.offsetHeight;
        if (trackLen <= 0) return;
        if (horiz) {
          const range = this.contentEnd() - this.grid.w / this.zx;
          this.sx = s0 + (d / trackLen) * range;
        } else {
          const range = 128 * this.rowH - this.grid.h;
          this.sy = s0 + (d / trackLen) * range;
        }
        this.invalidate();
      }, () => {});
    };
    this.hThumb.addEventListener('pointerdown', thumbDrag(true));
    this.vThumb.addEventListener('pointerdown', thumbDrag(false));
    this.hs.addEventListener('pointerdown', (e) => {
      if (e.target !== this.hs) return;
      const r = this.hThumb.getBoundingClientRect();
      this.scrollBy(((e.clientX < r.left ? -1 : 1) * this.grid.w * 0.9) / this.zx, 0);
    });
    this.vs.addEventListener('pointerdown', (e) => {
      if (e.target !== this.vs) return;
      const r = this.vThumb.getBoundingClientRect();
      this.scrollBy(0, (e.clientY < r.top ? -1 : 1) * this.grid.h * 0.9);
    });
    this.hs.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.scrollBy((e.deltaY || e.deltaX) / this.zx, 0);
    }, { passive: false });
    this.vs.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.scrollBy(0, e.deltaY);
    }, { passive: false });
  }

  // ================================================================ toolbar
  private buildBar(): BarApi {
    const menuBtn = el('button', { class: 'pr-hbtn pr-menu-btn', html: IC.arrow, 'data-hint': 'Piano roll menu — edit, tools, selection, zoom, view' });
    menuBtn.addEventListener('click', () => {
      const r = menuBtn.getBoundingClientRect();
      showMenu(this.menuItems(), r.left, r.bottom + 2);
    });

    // tools
    const toolBtns = TOOLS.map((t) => {
      const b = el('button', { class: 'tool-btn', html: TOOL_ICONS[t.id], 'data-hint': `${t.label} tool (${t.key}) — ${t.help}` });
      b.addEventListener('click', () => store.setUI({ prTool: t.id }));
      (b as any)._tool = t.id;
      return b;
    });
    const tools = el('div', { class: 'pr-tools' }, ...toolBtns);

    // snap
    const snapSel = el('select', { class: 'pr-snap', 'data-hint': 'Snap for the piano roll (shared with the global snap) — Alt while dragging bypasses it · Backspace toggles Line / None' }) as HTMLSelectElement;
    for (const s of SNAP_ORDER) snapSel.append(el('option', { value: s, text: SNAP_LABELS[s] }));
    snapSel.addEventListener('change', () => {
      store.setUI({ snap: snapSel.value as Snap });
      snapSel.blur();
    });
    const snapBox = el('div', { class: 'pr-box', 'data-hint': 'Snap' }, el('span', { class: 'pr-box-i', html: ICONS.magnet }), snapSel);

    // chord stamp (FL's stamp button: pick a chord, drawing a note stamps it)
    const chordLbl = el('span', { class: 'pr-tbtn-t' });
    const chordBtn = el('button', { class: 'pr-tbtn pr-chord', 'data-hint': 'Chord stamp — drawing a note adds the rest of the chord (click to choose)' }, el('span', { class: 'pr-tbtn-i', html: IC.stamp }), chordLbl);
    chordBtn.addEventListener('click', () => {
      const r = chordBtn.getBoundingClientRect();
      showMenu(this.chordItems(), r.left, r.bottom + 2);
    });

    // scale (root + type menu) with highlight / snap-to-scale toggles
    const scaleLbl = el('span', { class: 'pr-tbtn-t' });
    const scaleBtn = el('button', { class: 'pr-tbtn pr-scale', 'data-hint': 'Scale — root and type (14 scales) used by highlighting, snap-to-scale and the in-scale chord stamps' }, el('span', { class: 'pr-tbtn-i', html: ICONS.scale }), scaleLbl);
    scaleBtn.addEventListener('click', () => {
      const r = scaleBtn.getBoundingClientRect();
      const sc = store.ui.scale;
      showMenu(
        [
          { label: 'Root', submenu: ROOT_NAMES.map((n, i) => ({ label: n, checked: sc.root === i, action: () => store.setUI({ scale: { ...store.ui.scale, root: i } }) })) },
          { label: 'Scale', submenu: SCALES.map((x) => ({ label: x.name, checked: sc.type === x.id, action: () => store.setUI({ scale: { ...store.ui.scale, type: x.id } }) })) },
          { sep: true },
          { cmd: 'pr.scaleHighlight' },
          { cmd: 'pr.scaleSnap' },
        ],
        r.left,
        r.bottom + 2,
      );
    });
    const hiBtn = el('button', { class: 'pr-hbtn pr-opt', html: ICONS.scale, 'data-hint': 'Highlight the scale — rows outside the scale are dimmed, root rows tinted' });
    hiBtn.addEventListener('click', () => store.setUI({ scale: { ...store.ui.scale, highlight: !store.ui.scale.highlight } }));
    const lockBtn = el('button', { class: 'pr-hbtn pr-opt', html: IC.lock, 'data-hint': 'Snap to scale — drawn, moved and transposed notes are forced onto the scale' });
    lockBtn.addEventListener('click', () => store.setUI({ scale: { ...store.ui.scale, snap: !store.ui.scale.snap } }));

    const ghostBtn = el('button', { class: 'pr-hbtn', html: ICONS.ghost, 'data-hint': 'Ghost notes — show the other channels of this pattern as dim outlines (Alt+V)' });
    ghostBtn.addEventListener('click', () => store.setUI({ ghost: !store.ui.ghost }));
    const laneBtn = el('button', { class: 'pr-hbtn pr-opt2', html: IC.lane, 'data-hint': 'Show / hide the Control lane (velocity / panning)' });
    laneBtn.addEventListener('click', () => this.toggleLane());
    const zOut = el('button', { class: 'pr-hbtn pr-opt2', html: IC.zoomOut, 'data-hint': 'Zoom out (Page Down) · Ctrl+wheel zooms around the mouse' });
    zOut.addEventListener('click', () => this.zoomH(1 / 1.3));
    const zIn = el('button', { class: 'pr-hbtn pr-opt2', html: IC.zoomIn, 'data-hint': 'Zoom in (Page Up) · Shift+1…4 quick zoom levels' });
    zIn.addEventListener('click', () => this.zoomH(1.3));

    // FL keeps this toolbar in the window title bar
    const root = el(
      'div',
      { class: 'pr-hx' },
      menuBtn,
      snapBox,
      chordBtn,
      scaleBtn,
      hiBtn,
      lockBtn,
      el('div', { class: 'pr-hsep' }),
      tools,
      el('div', { class: 'pr-hsep' }),
      ghostBtn,
      laneBtn,
      zOut,
      zIn,
      this.status,
    );

    const sync = () => {
      const ui = store.ui;
      if (!ui) return;
      for (const b of toolBtns) b.classList.toggle('on', (b as any)._tool === ui.prTool);
      if (document.activeElement !== snapSel) snapSel.value = ui.snap;
      const st = SCALES.find((x) => x.id === ui.scale.type);
      scaleLbl.textContent = `${ROOT_NAMES[ui.scale.root] ?? 'C'} ${st?.name ?? ''}`;
      scaleBtn.classList.toggle('on', ui.scale.highlight || ui.scale.snap);
      hiBtn.classList.toggle('on', ui.scale.highlight);
      lockBtn.classList.toggle('on', ui.scale.snap);
      ghostBtn.classList.toggle('on', ui.ghost);
      laneBtn.classList.toggle('on', this.showLane);
      const ch = CHORDS.find((c) => c.id === this.chord);
      chordLbl.textContent = this.chord === 'off' || !ch ? 'Chord' : ch.name;
      chordBtn.classList.toggle('on', this.chord !== 'off');
    };
    const syncChannel = () => {
      if (!store.project) return;
      const c = this.ch();
      const name = c?.name ?? '(no channel)';
      if (this.chName.textContent !== name) this.chName.textContent = name;
      this.chBox.style.setProperty('--cc', c?.color ?? '#7a8287');
    };
    return { root, sync, syncChannel, setChord: (id: string) => { this.chord = id; sync(); } };
  }

  private chordItems(): MenuItem[] {
    return CHORDS.map((ch) => ({ label: ch.id === 'off' ? 'No chord' : ch.name, checked: this.chord === ch.id, action: () => this.bar.setChord(ch.id) }));
  }

  menuItems(): MenuItem[] {
    const c = (id: string): MenuItem => ({ cmd: id });
    return [
      {
        label: 'Edit',
        submenu: [c('edit.undo'), c('edit.redo'), { sep: true }, c('pr.cut'), c('pr.copy'), c('pr.paste'), c('pr.delete'), { sep: true }, c('pr.duplicate'), c('pr.props'), { sep: true }, c('pr.shiftLeft'), c('pr.shiftRight'), c('pr.rotateLeft'), c('pr.rotateRight'), c('pr.nudgeLeft'), c('pr.nudgeRight'), { sep: true }, c('pr.transposeUp'), c('pr.transposeDown'), c('pr.octaveUp'), c('pr.octaveDown'), c('pr.nudgeUp'), c('pr.nudgeDown'), { sep: true }, c('pr.mute'), c('pr.unmute')],
      },
      {
        label: 'Tools',
        submenu: [c('pr.quickQuantize'), c('pr.quantizeStarts'), c('pr.quantize'), { sep: true }, c('pr.legato'), c('pr.articulate'), c('pr.discardLengths'), { sep: true }, c('pr.chop'), c('pr.chopDialog'), c('pr.glue'), { sep: true }, c('pr.arpeggiate'), c('pr.strum'), c('pr.flam'), { sep: true }, c('pr.limit'), c('pr.flip'), c('pr.randomize'), c('pr.scaleLevels')],
      },
      {
        label: 'Select',
        submenu: [c('pr.selectAll'), c('pr.deselect'), c('pr.invertSel'), { sep: true }, c('pr.selRandom'), c('pr.selMoreRandom'), c('pr.selOdd'), { sep: true }, c('pr.selPrevTime'), c('pr.selNextTime')],
      },
      {
        label: 'Zoom',
        submenu: [c('pr.zoomIn'), c('pr.zoomOut'), { sep: true }, c('pr.zoom1'), c('pr.zoom2'), c('pr.zoom3'), c('pr.zoom4'), { sep: true }, c('pr.center')],
      },
      {
        label: 'View',
        submenu: [c('pr.ghost'), c('pr.lane'), c('pr.names'), c('pr.follow'), { sep: true }, c('pr.scaleHighlight'), c('pr.scaleSnap')],
      },
      {
        label: 'Chord stamp',
        submenu: this.chordItems(),
      },
      { sep: true },
      c('pr.importMidi'),
      c('pr.exportMidi'),
    ];
  }

  toolMenu(x?: number, y?: number) {
    if (x === undefined || y === undefined || x < 0) {
      const r = this.grid.wrap.getBoundingClientRect();
      x = this.lastClient.x >= 0 ? this.lastClient.x : r.left + r.width / 2;
      y = this.lastClient.y >= 0 ? this.lastClient.y : r.top + r.height / 2;
    }
    showMenu(TOOLS.map((t) => ({ label: t.label + ' tool', shortcut: t.key, checked: store.ui.prTool === t.id, action: () => store.setUI({ prTool: t.id }) })), x, y);
  }

  // ================================================================ selection commands
  selectAll() {
    this.setSel(this.notes().map((n) => n.id));
  }
  deselect() {
    this.timeSel = null;
    this.setSel([]);
  }
  invertSel() {
    this.setSel(this.notes().filter((n) => !this.sel.has(n.id)).map((n) => n.id));
  }
  selRandom(more: boolean) {
    const pool = this.notes().filter((n) => !more || !this.sel.has(n.id));
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    this.setSel(more ? [...this.sel, pick.id] : [pick.id]);
  }
  selOdd() {
    const base = this.selected().length ? this.selected() : this.notes().slice();
    base.sort((a, b) => a.start - b.start || a.key - b.key);
    this.setSel(base.filter((_, i) => i % 2 === 0).map((n) => n.id));
  }
  /** Ctrl+Left / Ctrl+Right: step the time selection (one bar, or the length of a ruler selection). */
  selTime(dir: 1 | -1) {
    const bar = this.barT;
    let next: { start: number; end: number };
    const r = this.timeSel;
    if (r) {
      const len = r.end - r.start;
      const st = Math.max(0, r.start + dir * len);
      next = { start: st, end: st + len };
    } else {
      // first press: the bar holding the selection (or the first bar in view)
      const s = this.selected();
      const a = s.length ? snapDown(ops.span(s).start, bar) : snapDown(Math.max(0, this.sx + 1), bar);
      next = { start: a, end: a + bar };
    }
    this.timeSel = next;
    this.setSel(this.notes().filter((n) => n.start >= next.start && n.start < next.end).map((n) => n.id));
    const x0 = tickX(this.v, next.start), x1 = tickX(this.v, next.end);
    if (x0 < 0 || x1 > this.grid.w) this.sx = next.start - (this.grid.w * 0.1) / this.zx;
    this.invalidate();
  }

  // ================================================================ clipboard
  copy(cut = false) {
    const t = this.targetOf(this.notes());
    if (!t.length) return toast('Nothing to copy', 'info', 1000);
    clipboard = deepClone(t);
    if (cut) {
      const ids = new Set(t.map((n) => n.id));
      this.apply('Cut notes', (arr) => {
        for (let i = arr.length - 1; i >= 0; i--) if (ids.has(arr[i].id)) arr.splice(i, 1);
      });
      this.setSel([]);
    }
    toast(`${cut ? 'Cut' : 'Copied'} ${t.length} note${t.length === 1 ? '' : 's'}`, 'info', 900);
  }
  paste() {
    if (!this.ch()) return;
    if (!clipboard.length) return toast('Clipboard is empty', 'info', 1000);
    const add = clipboard.map((n) => ops.cloneNote(n));
    this.apply('Paste notes', (arr) => arr.push(...add));
    this.setSel(add.map((n) => n.id));
  }
  deleteSel() {
    const ids = new Set(this.selected().map((n) => n.id));
    if (!ids.size) return toast('Select notes to delete (Ctrl+A selects all)', 'info', 1400);
    this.apply('Delete notes', (arr) => {
      for (let i = arr.length - 1; i >= 0; i--) if (ids.has(arr[i].id)) arr.splice(i, 1);
    });
    this.setSel([]);
  }
  duplicate() {
    const unit = Math.max(this.gridTicks(), 96);
    this.edit('Duplicate notes', (arr, t) => ops.duplicateRight(arr, t, unit), 'always');
    // keep the copies visible
    const s = this.selected();
    if (s.length) {
      const sp = ops.span(s);
      if (tickX(this.v, sp.end) > this.grid.w) {
        this.sx = sp.start - (this.grid.w * 0.15) / this.zx;
        this.invalidate();
      }
    }
  }

  // ================================================================ dialogs (live preview, one undo step)
  async toolDialog(title: string, label: string, fields: Field[], values: Record<string, any>, run: (arr: Note[], target: Note[], v: Record<string, any>) => string[] | void, opts: { intro?: string; width?: number; only?: string[] } = {}) {
    const c = this.ch();
    if (!c) return toast('No channel to edit', 'warn');
    const patId = this.pat().id, chId = c.id;
    const pt0 = store.pattern(patId);
    if (!pt0) return;
    const had = !!pt0.notes[chId];
    const orig: Note[] = deepClone(pt0.notes[chId] ?? []);
    const selIds = opts.only ? new Set(opts.only) : new Set(orig.filter((n) => this.sel.has(n.id)).map((n) => n.id));
    const useSel = selIds.size > 0;
    if (!orig.length) return toast('No notes to process', 'info', 1200);
    this.flushWheel();
    store.begin(label);
    let newSel: string[] | void = undefined;
    const ok = await formDialog(title, fields, values, (v) => {
      store.live((p) => {
        const pt = p.patterns.find((x) => x.id === patId);
        if (!pt) return;
        const arr: Note[] = deepClone(orig);
        const target = useSel ? arr.filter((n) => selIds.has(n.id)) : arr.slice();
        newSel = run(arr, target, v);
        pt.notes[chId] = arr;
      }, label);
    }, { intro: opts.intro, width: opts.width });
    if (!ok) {
      store.live((p) => {
        const pt = p.patterns.find((x) => x.id === patId);
        if (!pt) return;
        if (had) pt.notes[chId] = deepClone(orig);
        else delete pt.notes[chId];
      }, label);
    }
    store.end();
    if (ok && newSel && useSel && !opts.only) this.setSel(newSel);
    this.invalidate();
  }

  private gridOpt(v: string) {
    return v === 'current' ? this.gridTicks() : snapTicks(v as Snap, store.project.timeSig);
  }
  private gridOptions(withCurrent = true) {
    const o = GRID_CHOICES.map((s) => ({ value: s as string, label: SNAP_LABELS[s] }));
    return withCurrent ? [{ value: 'current', label: 'Current snap' }, ...o] : o;
  }

  quantizeDialog() {
    this.toolDialog('Quantize', 'Quantize', [
      { kind: 'select', key: 'grid', label: 'Grid', options: this.gridOptions() },
      { kind: 'range', key: 'strength', label: 'Strength', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'check', key: 'starts', label: 'Start times', hint: 'Move note starts onto the grid' },
      { kind: 'check', key: 'ends', label: 'End times', hint: 'Move note ends onto the grid' },
    ], DLG.quantize, (_arr, t, v) => ops.quantize(t, { grid: this.gridOpt(v.grid), strength: v.strength / 100, starts: v.starts, ends: v.ends }));
  }
  articulateDialog() {
    this.toolDialog('Articulate', 'Articulate', [
      { kind: 'range', key: 'pct', label: 'Length', min: 1, max: 200, step: 1, unit: '%' },
      { kind: 'select', key: 'mode', label: 'Relative to', options: [{ value: 'length', label: 'Current length' }, { value: 'gap', label: 'Distance to next note' }] },
    ], DLG.articulate, (_arr, t, v) => ops.articulate(t, v.pct / 100, v.mode));
  }
  chopDialog() {
    this.toolDialog('Chop', 'Chop', [
      { kind: 'select', key: 'grid', label: 'Piece length', options: this.gridOptions() },
      { kind: 'range', key: 'gate', label: 'Gate', min: 5, max: 100, step: 1, unit: '%' },
    ], DLG.chop, (arr, t, v) => ops.chop(arr, t, this.gridOpt(v.grid), v.gate / 100));
  }
  arpDialog() {
    this.toolDialog('Arpeggiate', 'Arpeggiate', [
      { kind: 'select', key: 'pattern', label: 'Pattern', options: [{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }, { value: 'updown', label: 'Up & down' }, { value: 'downup', label: 'Down & up' }, { value: 'random', label: 'Random' }] },
      { kind: 'select', key: 'grid', label: 'Step', options: this.gridOptions(false) },
      { kind: 'range', key: 'octaves', label: 'Octaves', min: 1, max: 4, step: 1 },
      { kind: 'range', key: 'gate', label: 'Gate', min: 5, max: 100, step: 1, unit: '%' },
    ], DLG.arp, (arr, t, v) => ops.arpeggiate(arr, t, { pattern: v.pattern, step: this.gridOpt(v.grid), octaves: v.octaves, gate: v.gate / 100 }), { intro: 'Notes that start together are played one after another over the chord length.' });
  }
  strumDialog() {
    this.toolDialog('Strum', 'Strum', [
      { kind: 'range', key: 'amount', label: 'Offset per note', min: 0, max: 96, step: 1 },
      { kind: 'select', key: 'unit', label: 'Unit', options: [{ value: 'ticks', label: 'Ticks (1/96 beat)' }, { value: 'ms', label: 'Milliseconds' }] },
      { kind: 'select', key: 'dir', label: 'Direction', options: [{ value: 'up', label: 'Up (low → high)' }, { value: 'down', label: 'Down (high → low)' }, { value: 'alt', label: 'Alternate' }] },
      { kind: 'range', key: 'curve', label: 'Velocity curve', min: -80, max: 80, step: 1, unit: '%' },
      { kind: 'check', key: 'keepEnds', label: 'Keep note ends', hint: 'Shorten delayed notes so they still end together' },
    ], DLG.strum, (_arr, t, v) => ops.strum(t, { ticks: v.unit === 'ms' ? v.amount / 1000 / engine.spt : v.amount, dir: v.dir, velCurve: v.curve / 100, keepEnds: v.keepEnds }));
  }
  flamDialog() {
    this.toolDialog('Flam', 'Flam', [
      { kind: 'range', key: 'count', label: 'Grace notes', min: 1, max: 4, step: 1 },
      { kind: 'range', key: 'spacing', label: 'Spacing', min: 1, max: 48, step: 1, unit: 'ticks' },
      { kind: 'range', key: 'vel', label: 'Velocity', min: 5, max: 100, step: 1, unit: '%' },
      { kind: 'check', key: 'after', label: 'Placement', hint: 'Place the extra hits after the note (drag / ruff)' },
    ], DLG.flam, (arr, t, v) => ops.flam(arr, t, { count: v.count, spacing: v.spacing, vel: v.vel / 100, after: v.after }));
  }
  limitDialog() {
    const names = Array.from({ length: 128 }, (_, k) => ({ value: String(k), label: noteName(k) })).reverse();
    const vals = { lo: String(DLG.limit.lo), hi: String(DLG.limit.hi) };
    this.toolDialog('Limit', 'Limit', [
      { kind: 'select', key: 'hi', label: 'Highest key', options: names },
      { kind: 'select', key: 'lo', label: 'Lowest key', options: names },
    ], vals, (_arr, t, v) => {
      DLG.limit = { lo: parseInt(v.lo), hi: parseInt(v.hi) };
      ops.limit(t, parseInt(v.lo), parseInt(v.hi));
    }, { intro: 'Notes outside the range are folded in by octaves.' });
  }
  flipDialog() {
    this.toolDialog('Flip', 'Flip', [
      { kind: 'select', key: 'axis', label: 'Flip', options: [{ value: 'h', label: 'Horizontally (reverse in time)' }, { value: 'v', label: 'Vertically (mirror pitch)' }] },
    ], DLG.flip, (_arr, t, v) => ops.flip(t, v.axis, this.snapMask()));
  }
  randomizeDialog() {
    this.toolDialog('Randomize', 'Randomize', [
      { kind: 'range', key: 'vel', label: 'Velocity', min: 0, max: 100, step: 1, unit: '±%' },
      { kind: 'range', key: 'timing', label: 'Timing', min: 0, max: 48, step: 1, unit: '±ticks' },
      { kind: 'range', key: 'length', label: 'Length', min: 0, max: 100, step: 1, unit: '±%' },
      { kind: 'range', key: 'pan', label: 'Pan', min: 0, max: 100, step: 1, unit: '±%' },
      { kind: 'range', key: 'pitch', label: 'Pitch', min: 0, max: 12, step: 1, unit: '±st' },
    ], DLG.randomize, (_arr, t, v) => ops.randomize(t, { vel: v.vel / 100, timing: v.timing, length: v.length / 100, pan: v.pan / 100, pitch: v.pitch }, this.snapMask()), { intro: 'Every change re-rolls the dice — tweak until it feels right.' });
  }
  levelsDialog() {
    this.toolDialog('Scale levels', 'Scale levels', [
      { kind: 'select', key: 'param', label: 'Property', options: [{ value: 'vel', label: 'Velocity' }, { value: 'pan', label: 'Pan' }] },
      { kind: 'range', key: 'from', label: 'From', min: -100, max: 100, step: 1, unit: '%' },
      { kind: 'range', key: 'to', label: 'To', min: -100, max: 100, step: 1, unit: '%' },
    ], DLG.levels, (_arr, t, v) => ops.scaleLevels(t, v.from / 100, v.to / 100, v.param), { intro: 'Ramps the value across the notes in time order (pan: −100 left … +100 right).' });
  }

  noteProps(id: string) {
    const n = this.notes().find((x) => x.id === id);
    if (!n) return;
    this.lastLen = n.len;
    this.lastVel = n.vel;
    this.lastPan = n.pan;
    const names = Array.from({ length: 128 }, (_, k) => ({ value: String(k), label: noteName(k) })).reverse();
    const vals: Record<string, any> = { key: String(n.key), start: n.start, len: n.len, vel: Math.round(n.vel * 100), pan: Math.round(n.pan * 100), muted: !!n.muted };
    this.toolDialog('Note properties', 'Note properties', [
      { kind: 'select', key: 'key', label: 'Key', options: names },
      { kind: 'number', key: 'start', label: 'Start', min: 0, max: 1e7, step: 1, unit: 'ticks (96 = 1 beat)' },
      { kind: 'number', key: 'len', label: 'Length', min: 1, max: 1e6, step: 1, unit: 'ticks' },
      { kind: 'range', key: 'vel', label: 'Velocity', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'range', key: 'pan', label: 'Pan', min: -100, max: 100, step: 1, unit: 'L ↔ R' },
      { kind: 'check', key: 'muted', label: 'Muted', hint: 'Muted notes stay in the pattern but do not play' },
    ], vals, (_arr, t, v) => {
      const x = t[0];
      if (!x) return;
      x.key = clamp(parseInt(v.key), 0, 127);
      x.start = Math.max(0, Math.round(v.start));
      x.len = Math.max(1, Math.round(v.len));
      x.vel = clamp(v.vel / 100, 0, 1);
      x.pan = clamp(v.pan / 100, -1, 1);
      if (v.muted) x.muted = true;
      else delete x.muted;
    }, { only: [id], intro: `${noteName(n.key)} at ${fmtBST(n.start, store.project.timeSig)}` });
  }
}

// ------------------------------------------------------------------ commands
let registered = false;
function registerCommands() {
  if (registered) return;
  registered = true;
  const P = () => inst!;
  const cmd = (id: string, label: string, keys: string[], run: () => void, extra: Partial<Command> = {}): Command => ({ id, label, category: 'Piano roll', ctx: 'pianoroll', keys, run: () => inst && run(), ...extra });
  const tr = (semis: number, label: string, scale = true) => () => P().edit(label, (_a, t) => ops.transpose(t, semis, scale ? P().snapMask() : null));
  const list: Command[] = [
    ...TOOLS.map((t) => cmd('pr.tool.' + t.id, `${t.label} tool`, [t.key], () => store.setUI({ prTool: t.id }), { checked: () => store.ui.prTool === t.id })),
    cmd('pr.toolMenu', 'Tool menu at the mouse', ['F3'], () => P().toolMenu()),
    cmd('pr.delete', 'Delete selected notes', ['Del'], () => P().deleteSel()),
    cmd('pr.selectAll', 'Select all notes', ['Ctrl+A'], () => P().selectAll()),
    cmd('pr.deselect', 'Deselect all', ['Ctrl+D'], () => P().deselect()),
    cmd('pr.copy', 'Copy', ['Ctrl+C'], () => P().copy()),
    cmd('pr.paste', 'Paste', ['Ctrl+V'], () => P().paste()),
    cmd('pr.cut', 'Cut', ['Ctrl+X'], () => P().copy(true)),
    cmd('pr.duplicate', 'Duplicate selection to the right', ['Ctrl+B'], () => P().duplicate()),
    cmd('pr.props', 'Note properties… (double-click a note)', [], () => {
      const s = P().selected()[0] ?? P().notes()[0];
      if (s) P().noteProps(s.id);
    }),
    cmd('pr.shiftLeft', 'Shift left one snap step', ['Shift+Left'], () => P().edit('Shift notes', (_a, t) => ops.shiftTime(t, -P().gridTicks())), { repeat: true }),
    cmd('pr.shiftRight', 'Shift right one snap step', ['Shift+Right'], () => P().edit('Shift notes', (_a, t) => ops.shiftTime(t, P().gridTicks())), { repeat: true }),
    cmd('pr.rotateLeft', 'Rotate left (wrap in pattern)', ['Ctrl+Shift+Left'], () => P().edit('Rotate notes', (_a, t) => ops.rotate(t, -P().gridTicks(), store.patternLength())), { repeat: true }),
    cmd('pr.rotateRight', 'Rotate right (wrap in pattern)', ['Ctrl+Shift+Right'], () => P().edit('Rotate notes', (_a, t) => ops.rotate(t, P().gridTicks(), store.patternLength())), { repeat: true }),
    cmd('pr.transposeUp', 'Transpose up a semitone', ['Shift+Up'], tr(1, 'Transpose'), { repeat: true }),
    cmd('pr.transposeDown', 'Transpose down a semitone', ['Shift+Down'], tr(-1, 'Transpose'), { repeat: true }),
    cmd('pr.octaveUp', 'Transpose up an octave', ['Ctrl+Up'], tr(12, 'Transpose octave'), { repeat: true }),
    cmd('pr.octaveDown', 'Transpose down an octave', ['Ctrl+Down'], tr(-12, 'Transpose octave'), { repeat: true }),
    cmd('pr.nudgeLeft', 'Nudge left 1 tick', ['Alt+Left'], () => P().edit('Nudge notes', (_a, t) => ops.shiftTime(t, -1)), { repeat: true }),
    cmd('pr.nudgeRight', 'Nudge right 1 tick', ['Alt+Right'], () => P().edit('Nudge notes', (_a, t) => ops.shiftTime(t, 1)), { repeat: true }),
    cmd('pr.nudgeUp', 'Nudge up a semitone (ignore scale)', ['Alt+Up'], tr(1, 'Transpose', false), { repeat: true }),
    cmd('pr.nudgeDown', 'Nudge down a semitone (ignore scale)', ['Alt+Down'], tr(-1, 'Transpose', false), { repeat: true }),
    cmd('pr.quickQuantize', 'Quick quantize', ['Ctrl+Q'], () => P().edit('Quantize', (_a, t) => ops.quickQuantize(t, P().gridTicks(), true))),
    cmd('pr.quantizeStarts', 'Quick quantize start times', ['Shift+Q'], () => P().edit('Quantize start times', (_a, t) => ops.quickQuantize(t, P().gridTicks(), false))),
    cmd('pr.quantize', 'Quantize…', ['Alt+Q'], () => P().quantizeDialog()),
    cmd('pr.legato', 'Quick legato', ['Ctrl+L'], () => P().edit('Legato', (_a, t) => ops.legato(t))),
    cmd('pr.articulate', 'Articulate…', ['Alt+L'], () => P().articulateDialog()),
    cmd('pr.chop', 'Quick chop', ['Ctrl+U'], () => P().edit('Chop', (arr, t) => ops.chop(arr, t, P().gridTicks()))),
    cmd('pr.chopDialog', 'Chop…', ['Alt+U'], () => P().chopDialog()),
    cmd('pr.glue', 'Glue', ['Ctrl+G'], () => P().edit('Glue', (arr, t) => ops.glue(arr, t))),
    cmd('pr.arpeggiate', 'Arpeggiate…', ['Alt+A'], () => P().arpDialog()),
    cmd('pr.strum', 'Strum…', ['Alt+S'], () => P().strumDialog()),
    cmd('pr.flam', 'Flam…', ['Alt+F'], () => P().flamDialog()),
    cmd('pr.limit', 'Limit…', ['Alt+K'], () => P().limitDialog()),
    cmd('pr.flip', 'Flip…', ['Alt+Y'], () => P().flipDialog()),
    cmd('pr.randomize', 'Randomize…', ['Alt+R'], () => P().randomizeDialog()),
    cmd('pr.scaleLevels', 'Scale levels…', ['Alt+X'], () => P().levelsDialog()),
    cmd('pr.mute', 'Mute notes', ['Alt+M'], () => P().edit('Mute notes', (_a, t) => ops.setMuted(t, true))),
    cmd('pr.unmute', 'Unmute notes', ['Alt+Shift+M'], () => P().edit('Unmute notes', (_a, t) => ops.setMuted(t, false))),
    cmd('pr.invertSel', 'Invert selection', ['Shift+I'], () => P().invertSel()),
    cmd('pr.selRandom', 'Select one at random', ['Shift+R'], () => P().selRandom(false)),
    cmd('pr.selMoreRandom', 'Select more at random', ['Shift+M'], () => P().selRandom(true)),
    cmd('pr.selOdd', 'Select odd notes', ['Shift+O'], () => P().selOdd()),
    cmd('pr.selPrevTime', 'Select previous time', ['Ctrl+Left'], () => P().selTime(-1), { repeat: true }),
    cmd('pr.selNextTime', 'Select next time', ['Ctrl+Right'], () => P().selTime(1), { repeat: true }),
    cmd('pr.discardLengths', 'Discard lengths', ['Shift+D'], () => P().edit('Discard lengths', (_a, t) => ops.discardLengths(t, Math.max(P().gridTicks(), 6)))),
    cmd('pr.importMidi', 'Import MIDI file…', ['Ctrl+M'], () => importMidi()),
    cmd('pr.exportMidi', 'Export MIDI file…', ['Ctrl+Shift+M'], () => exportMidi()),
    cmd('pr.zoomIn', 'Zoom in', ['PageUp'], () => P().zoomH(1.3), { repeat: true }),
    cmd('pr.zoomOut', 'Zoom out', ['PageDown'], () => P().zoomH(1 / 1.3), { repeat: true }),
    cmd('pr.zoom1', 'Zoom level 1 (close)', ['Shift+1'], () => P().quickZoom(1)),
    cmd('pr.zoom2', 'Zoom level 2', ['Shift+2'], () => P().quickZoom(2)),
    cmd('pr.zoom3', 'Zoom level 3', ['Shift+3'], () => P().quickZoom(3)),
    cmd('pr.zoom4', 'Zoom to fit', ['Shift+4'], () => P().quickZoom(4)),
    cmd('pr.center', 'Center on playhead', ['Shift+0'], () => P().centerOnPlayhead()),
    cmd('pr.ghost', 'Ghost notes', ['Alt+V'], () => store.setUI({ ghost: !store.ui.ghost }), { checked: () => store.ui.ghost }),
    cmd('pr.lane', 'Control lane (velocity / panning)', [], () => P().toggleLane(), { checked: () => !!inst?.showLane }),
    cmd('pr.names', 'Note names on notes', [], () => {
      const p = P();
      p.showNames = !p.showNames;
      lsSet(LS.names, p.showNames ? '1' : '0');
      p.invalidate('grid');
    }, { checked: () => !!inst?.showNames }),
    cmd('pr.follow', 'Follow playhead', [], () => {
      const p = P();
      p.follow = !p.follow;
      lsSet(LS.follow, p.follow ? '1' : '0');
    }, { checked: () => !!inst?.follow }),
    cmd('pr.scaleHighlight', 'Highlight scale', [], () => store.setUI({ scale: { ...store.ui.scale, highlight: !store.ui.scale.highlight } }), { checked: () => store.ui.scale.highlight }),
    cmd('pr.scaleSnap', 'Snap to scale', [], () => store.setUI({ scale: { ...store.ui.scale, snap: !store.ui.scale.snap } }), { checked: () => store.ui.scale.snap }),
  ];
  commands.register(list);
}

// ------------------------------------------------------------------ window
export function createPianoRoll(): PanelDef {
  const pr = new PianoRoll();
  inst = pr;
  registerCommands();
  return {
    body: pr.root,
    headerExtra: pr.bar.root,
    onShow: () => pr.onShow(),
    onHide: () => pr.onHide(),
    onResize: () => pr.invalidate(),
  };
}
