// Playlist window (F5): arrangement of pattern / audio / automation clips on tracks.
// Canvas-based (grid + clips layer, overlay layer for the playhead and rubber bands, ruler),
// native scrollbars over a sized spacer for virtual scrolling, DOM track headers + clip picker.
import './playlist.css';
import { store } from '../core/store';
import { commands, Command } from '../core/commands';
import { engine } from '../audio/engine';
import { samples } from '../audio/samples';
import { Clip, ClipKind, ID, PPQ, STEP, Snap, ToolId } from '../core/types';
import { SNAP_LABELS, clamp, deepClone, el, fmtBST, snapDown, snapRound, snapTicks, uid } from '../core/util';
import { ICONS, TOOL_ICONS } from './icons';
import { MenuItem, drag, select, setHint, showMenu, toast } from './widgets';
import { DT_PATTERN, DT_SAMPLE, hasType, readDrag, samplesFromDrop } from './dnd';
import { selectPattern } from './actions';
import { addChannel, addPlaylistTrack } from './ops';
import { wm } from './wm';
import type { PanelDef } from './panel';
import {
  DEFAULT_TRACK_H,
  Source,
  channelsWithNotes,
  contentRate,
  currentSource,
  ensureTracks,
  extent,
  maxClipLen,
  normalizeOffset,
  sampleTicks,
  sliceClip,
  sourceInfo,
  sourceLength,
} from './playlist-model';
import {
  COL,
  Lookup,
  OVERVIEW_H,
  RULER_H,
  View,
  autoPointMap,
  buildLookup,
  bumpGeneration,
  clearPreviewCaches,
  clipGeom,
  drawMain,
  drawOverview,
  drawRuler,
  firstCandidate,
  overviewRange,
  gridUnit,
  titleHeight,
  trackAt,
  trackHeight,
  trackTop,
} from './playlist-render';
import { DT_PLCLIP, createHeaders, createPicker, pickerDrag, setSource } from './playlist-side';

const TOOLS: { id: ToolId; label: string; key: string; hint: string }[] = [
  { id: 'draw', label: 'Draw', key: 'P', hint: 'Draw (P) — click to place the current source, drag clips to move, drag edges to resize' },
  { id: 'paint', label: 'Paint', key: 'B', hint: 'Paint (B) — drag to lay down consecutive copies of the source' },
  { id: 'delete', label: 'Delete', key: 'D', hint: 'Delete (D) — click or drag across clips to remove them' },
  { id: 'mute', label: 'Mute', key: 'T', hint: 'Mute (T) — click or drag across clips to toggle their mute' },
  { id: 'slice', label: 'Slice', key: 'C', hint: 'Slice (C) — click to split clips at the cursor, drag vertically to cut across tracks' },
  { id: 'select', label: 'Select', key: 'E', hint: 'Select (E) — drag a box to select, drag a selection to move it' },
  { id: 'slip', label: 'Slip', key: 'S', hint: 'Slip (S) — drag inside a clip to shift its content without moving the clip' },
  { id: 'zoom', label: 'Zoom', key: 'Z', hint: 'Zoom (Z) — drag a range to zoom to it, click to zoom in, right-click to zoom out' },
  { id: 'playback', label: 'Playback', key: 'Y', hint: 'Playback (Y) — hold the mouse button to play the song from that point' },
];

const MIN_PPT = 0.004;
const MAX_PPT = 6;
const F_MAIN = 1, F_OV = 2, F_RULER = 4, F_HEAD = 8, F_MAP = 16, F_ALL = 31;
/** Default vertical zoom: FL-density tracks (56 px tracks × 0.62 ≈ 35 px). */
const DEFAULT_VZ = 0.62;

const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  follow: svg('<path d="M12 3v18"/><path d="M15 9l4 3-4 3"/><path d="M4 7h4M4 12h4M4 17h4"/>'),
  zoomIn: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5"/>'),
  zoomOut: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5"/>'),
  picker: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 4.5v15"/><path d="M5.5 8h1.5M5.5 11h1.5M5.5 14h1.5"/>'),
  caret: svg('<path d="M6 9l6 6 6-6"/>'),
  arrow: `<svg viewBox="0 0 24 24"><path d="M8 5l9 7-9 7z" fill="currentColor"/></svg>`,
  track: svg('<path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 14v6M15 17h6"/>'),
};

interface Pos {
  x: number; // canvas-local css px
  y: number;
  cx: number; // content px
  cy: number;
  tick: number;
  track: number;
}

interface Hit {
  clip: Clip;
  zone: 'body' | 'title' | 'left' | 'right' | 'auto';
  point: number; // automation point index (zone 'auto'), -1 = none
}

let registered = false;
let clipboard: Clip[] = [];

function loadPrefs(): { ppt?: number; vz?: number; follow?: boolean; picker?: boolean } {
  try {
    return JSON.parse(localStorage.getItem('lf.playlist') ?? '{}') ?? {};
  } catch {
    return {};
  }
}

export function createPlaylist(): PanelDef {
  const prefs = loadPrefs();
  const v: View = { ppt: clamp(prefs.ppt ?? 0.16, MIN_PPT, MAX_PPT), vz: clamp(prefs.vz ?? DEFAULT_VZ, 0.45, 3), sx: 0, sy: 0, w: 600, h: 300, dpr: 1, tops: [0], rowH: DEFAULT_TRACK_H };
  let L: Lookup = { pat: new Map(), ch: new Map(), auto: new Map(), byTrack: [], maxLen: [], lastEnd: 0 };
  const sel = new Set<ID>();
  let follow = prefs.follow ?? true;
  let pickerOn = prefs.picker ?? true;
  let dragging = false;
  let flags = F_ALL;
  let raf = 0;
  // overlay state
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let sliceLine: { t: number; tr0: number; tr1: number } | null = null;
  let zoomBox: { t0: number; t1: number } | null = null;
  let drop: { track: number; tick: number; len: number | null; color: string } | null = null;
  let hoverAuto: { clipId: ID; point: number } | null = null;
  let hoverTick: number | null = null;
  let mouse = { x: 300, y: 200 };

  const savePrefs = () => {
    try {
      localStorage.setItem('lf.playlist', JSON.stringify({ ppt: v.ppt, vz: v.vz, follow, picker: pickerOn }));
    } catch {}
  };

  // =========================================================================
  // DOM
  // =========================================================================
  const root = el('div', { class: 'pl' + (pickerOn ? '' : ' no-picker') });
  const picker = createPicker();
  const posLabel = el('span', { class: 'pl-corner-pos', text: '1:01:00' });
  const trkLabel = el('span', { class: 'pl-corner-trk', text: '' });
  const corner = el('div', { class: 'pl-corner', 'data-hint': 'Mouse position (bar:step:tick) and track' }, posLabel, trkLabel);
  const rulerCv = el('canvas', { class: 'pl-ruler-cv' }) as HTMLCanvasElement;
  const rulerWrap = el(
    'div',
    { class: 'pl-ruler', 'data-hint': 'Timeline — click: set song position · drag: time selection (loops playback) · drag the marker: move position · double-click: clear selection · wheel: zoom' },
    rulerCv,
  );
  const mapCv = el('canvas', { class: 'pl-map-cv' }) as HTMLCanvasElement;
  const mapWrap = el('div', { class: 'pl-map', 'data-hint': 'Song overview — drag the box to scroll, click to jump there · wheel: zoom' }, mapCv);
  const mainCv = el('canvas', { class: 'pl-cv' }) as HTMLCanvasElement;
  const ovCv = el('canvas', { class: 'pl-cv pl-ov' }) as HTMLCanvasElement;
  const spacer = el('div', { class: 'pl-spacer' });
  const scroll = el('div', { class: 'pl-scroll', tabindex: '-1' }, spacer);
  const viewEl = el('div', { class: 'pl-view' }, mainCv, ovCv, scroll);
  const headers = createHeaders({
    getView: () => v,
    onWheel: (e) => onWheel(e),
    refresh: () => invalidate(F_HEAD),
    selectTrack: (i, add) => {
      const ids = store.project.playlist.clips.filter((c) => c.track === i).map((c) => c.id);
      setSel(add ? [...sel, ...ids] : ids);
    },
  });
  const arr = el('div', { class: 'pl-arr' }, corner, mapWrap, rulerWrap, headers.root, viewEl);
  const body = el('div', { class: 'pl-body' }, picker.root, arr);
  const mg = mainCv.getContext('2d', { alpha: false })!;
  const og = ovCv.getContext('2d')!;
  const rg = rulerCv.getContext('2d', { alpha: false })!;
  const mapG = mapCv.getContext('2d', { alpha: false })!;

  // ---- toolbar ----
  const menuBtn = el('button', { class: 'pl-hbtn pl-menu-btn', html: IC.arrow, 'data-hint': 'Playlist menu — editing, view and track commands' });
  menuBtn.addEventListener('click', () => {
    const r = menuBtn.getBoundingClientRect();
    showMenu(mainMenu(), r.left, r.bottom + 2);
  });
  const pickerBtn = el('button', { class: 'pl-hbtn' + (pickerOn ? ' on' : ''), html: IC.picker, 'data-hint': 'Show / hide the clip picker (patterns, audio and automation clips)' });
  pickerBtn.addEventListener('click', () => togglePicker());
  const toolBtns = new Map<ToolId, HTMLElement>();
  const toolGroup = el('div', { class: 'pl-tools' });
  for (const t of TOOLS) {
    const b = el('button', { class: 'tool-btn', html: TOOL_ICONS[t.id], 'data-hint': t.hint });
    b.addEventListener('click', () => store.setUI({ plTool: t.id }));
    toolBtns.set(t.id, b);
    toolGroup.append(b);
  }
  const snapSel = select(
    (Object.keys(SNAP_LABELS) as Snap[]).map((s) => ({ value: s, label: SNAP_LABELS[s] })),
    store.ui?.snap ?? 'line',
    (s) => store.setUI({ snap: s }),
    'Snap — clip moves, resizes and time selections snap to this grid (hold Alt to bypass, Backspace toggles Line / None)',
  );
  snapSel.classList.add('pl-snap');
  const srcIcon = el('span', { class: 'pl-src-ic' });
  const srcSw = el('span', { class: 'pl-src-sw' });
  const srcName = el('span', { class: 'pl-src-name' });
  const srcBtn = el('button', { class: 'pl-src', 'data-hint': 'Clip source — what Draw and Paint place. Click to choose; or click a clip / picker item' }, srcIcon, srcSw, srcName, el('span', { class: 'pl-src-caret', html: IC.caret }));
  srcBtn.addEventListener('click', () => {
    const r = srcBtn.getBoundingClientRect();
    showMenu(sourceMenu(), r.left, r.bottom + 2);
  });
  const selInfo = el('span', { class: 'pl-selinfo' });
  const followBtn = el('button', { class: 'pl-hbtn' + (follow ? ' on' : ''), html: IC.follow, 'data-hint': 'Follow playhead — page the view along with song playback' });
  followBtn.addEventListener('click', () => toggleFollow());
  const zoomOutBtn = el('button', { class: 'pl-hbtn pl-opt', html: IC.zoomOut, 'data-hint': 'Zoom out (PageDown · Ctrl+wheel)' });
  zoomOutBtn.addEventListener('click', () => zoomAt(v.ppt / 1.4, v.w / 2));
  const zoomInBtn = el('button', { class: 'pl-hbtn pl-opt', html: IC.zoomIn, 'data-hint': 'Zoom in (PageUp · Ctrl+wheel)' });
  zoomInBtn.addEventListener('click', () => zoomAt(v.ppt * 1.4, v.w / 2));
  const addTrackBtn = el('button', { class: 'pl-addtrack', 'data-hint': 'Add a playlist track at the bottom' }, el('span', { html: IC.track }), el('span', { text: 'Track' }));
  addTrackBtn.addEventListener('click', () => {
    addPlaylistTrack();
    requestAnimationFrame(() => (scroll.scrollTop = scroll.scrollHeight));
  });
  // FL keeps the playlist toolbar in the window title bar: ▸ menu · snap · tools · source
  const bar = el(
    'div',
    { class: 'pl-hx' },
    menuBtn,
    el('div', { class: 'pl-snapbox' }, el('span', { class: 'pl-magnet', html: ICONS.magnet }), snapSel),
    el('div', { class: 'pl-hsep' }),
    toolGroup,
    el('div', { class: 'pl-hsep' }),
    srcBtn,
    el('div', { class: 'pl-bar-right' }, selInfo, pickerBtn, followBtn, zoomOutBtn, zoomInBtn, el('div', { class: 'pl-hsep' }), addTrackBtn),
  );
  root.append(body);

  // =========================================================================
  // view / geometry
  // =========================================================================
  const visible = () => wm?.get('playlist')?.visible ?? true;
  const syncScroll = () => {
    v.sx = scroll.scrollLeft;
    v.sy = scroll.scrollTop;
  };
  const sizeCanvas = (c: HTMLCanvasElement, w: number, h: number) => {
    const W = Math.max(1, Math.round(w * v.dpr)), H = Math.max(1, Math.round(h * v.dpr));
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  };
  const measure = () => {
    const w = scroll.clientWidth, h = scroll.clientHeight;
    if (!w || !h) return false;
    v.dpr = window.devicePixelRatio || 1;
    v.w = w;
    v.h = h;
    sizeCanvas(mainCv, w, h);
    sizeCanvas(ovCv, w, h);
    sizeCanvas(rulerCv, w, RULER_H);
    sizeCanvas(mapCv, w, OVERVIEW_H);
    return true;
  };
  const layoutTracks = () => {
    const t = store.project.playlist.tracks;
    const tops = new Array<number>(t.length + 1);
    let y = 0;
    for (let i = 0; i < t.length; i++) {
      tops[i] = y;
      y += Math.max(14, Math.round((t[i].height || DEFAULT_TRACK_H) * v.vz));
    }
    tops[t.length] = y;
    v.tops = tops;
    v.rowH = Math.max(14, Math.round(DEFAULT_TRACK_H * v.vz));
  };
  let minSpacerW = 0;
  const contentTicks = () => {
    const bar = store.barTicks;
    return Math.max(store.songLength(), L.lastEnd, engine.songStart, store.ui.loop?.end ?? 0) + 16 * bar;
  };
  const updateSpacer = () => {
    const w = Math.max(Math.ceil(contentTicks() * v.ppt), minSpacerW);
    const h = Math.ceil(trackTop(v, store.project.playlist.tracks.length) + 3 * v.rowH);
    const ws = w + 'px', hs = h + 'px';
    if (spacer.style.width !== ws) spacer.style.width = ws;
    if (spacer.style.height !== hs) spacer.style.height = hs;
  };
  const pos = (ev: { clientX: number; clientY: number }): Pos => {
    const r = scroll.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const cx = x + scroll.scrollLeft, cy = y + scroll.scrollTop;
    return { x, y, cx, cy, tick: Math.max(0, cx / v.ppt), track: trackAt(v, cy) };
  };
  const grid = (): number => {
    const s = store.ui.snap;
    if (s === 'none') return 0;
    if (s === 'line' || s === 'cell') return gridUnit(v.ppt, store.project.timeSig, 11);
    return snapTicks(s, store.project.timeSig);
  };
  const snapT = (t: number, ev?: { altKey: boolean } | null, mode: 'round' | 'floor' = 'round') => {
    const g = ev?.altKey ? 0 : grid();
    if (!g) return Math.max(0, Math.round(t));
    return Math.max(0, mode === 'floor' ? snapDown(t, g) : snapRound(t, g));
  };
  const playingSong = () => engine.ready && engine.playing && engine.mode === 'song';
  const clipById = (id: ID) => store.project.playlist.clips.find((c) => c.id === id);
  const selectedClips = () => store.project.playlist.clips.filter((c) => sel.has(c.id));

  // =========================================================================
  // rendering
  // =========================================================================
  const invalidate = (f: number) => {
    flags |= f;
    if (!raf) raf = requestAnimationFrame(frame);
  };
  function frame() {
    raf = 0;
    if (!visible() || !store.project) return;
    if (v.w !== scroll.clientWidth || v.h !== scroll.clientHeight) {
      if (measure()) flags |= F_ALL;
    }
    syncScroll();
    const playing = playingSong();
    if (playing && follow && !dragging) {
      const x = engine.position * v.ppt;
      if (x > v.sx + v.w - 12 || x < v.sx) {
        scroll.scrollLeft = Math.max(0, x - 32);
        syncScroll();
        flags |= F_ALL;
      }
    }
    if (flags & F_HEAD) headers.sync(v);
    if (flags & F_MAIN) drawMain(mg, v, store.project, L, { sel, loop: store.ui.loop, hoverAuto });
    if (flags & F_OV) drawOverlay();
    if (flags & F_RULER)
      drawRuler(rg, v, store.project, { loop: store.ui.loop, songStart: engine.songStart, songEnd: store.songLength(), playhead: playing ? engine.position : null, hoverTick });
    if (flags & (F_MAP | F_RULER)) drawOverview(mapG, v, store.project, L, v.w, { total: mapTotal(), songStart: engine.songStart, playhead: playing ? engine.position : null, loop: store.ui.loop });
    headers.setActive(playing ? playingTracks(engine.position) : null);
    flags = 0;
    if (playing) invalidate(F_OV | F_RULER);
  }

  /** Tracks with a non-muted clip under the song position (lights their level bars). */
  function playingTracks(pos: number): Set<number> {
    const out = new Set<number>();
    const tracks = store.project.playlist.tracks;
    for (let i = 0; i < L.byTrack.length; i++) {
      const list = L.byTrack[i];
      if (!list?.length || tracks[i]?.mute) continue;
      for (let k = firstCandidate(list, pos, L.maxLen[i] ?? 0); k < list.length; k++) {
        const c = list[k];
        if (c.start > pos) break;
        if (!c.muted && pos < c.start + c.len) {
          out.add(i);
          break;
        }
      }
    }
    return out;
  }
  /** Ticks shown by the overview strip: the song plus some room, at least the visible range. */
  function mapTotal() {
    const bar = store.barTicks;
    const end = Math.max(store.songLength(), L.lastEnd, store.ui.loop?.end ?? 0, bar * 8);
    return Math.max(Math.ceil((end + bar * 4) / bar) * bar, (v.sx + v.w) / v.ppt);
  }

  function drawOverlay() {
    const g = og;
    g.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    g.clearRect(0, 0, v.w, v.h);
    const { ppt, sx, sy } = v;
    if (drop) {
      const top = trackTop(v, drop.track) - sy, h = trackHeight(v, drop.track);
      g.fillStyle = 'rgba(79,198,230,0.09)';
      g.fillRect(0, top, v.w, h);
      g.fillStyle = 'rgba(79,198,230,0.6)';
      g.fillRect(0, top, v.w, 1);
      g.fillRect(0, top + h - 1, v.w, 1);
      const x = drop.tick * ppt - sx;
      const w = drop.len ? Math.max(4, drop.len * ppt) : 60;
      g.setLineDash([4, 3]);
      g.strokeStyle = drop.color;
      g.lineWidth = 1.5;
      g.strokeRect(x + 0.75, top + 2.75, w - 1.5, h - 5.5);
      g.setLineDash([]);
      g.lineWidth = 1;
    }
    if (zoomBox) {
      const a = Math.min(zoomBox.t0, zoomBox.t1) * ppt - sx, b = Math.max(zoomBox.t0, zoomBox.t1) * ppt - sx;
      g.fillStyle = 'rgba(79,198,230,0.12)';
      g.fillRect(a, 0, b - a, v.h);
      g.fillStyle = COL.accent2;
      g.fillRect(Math.round(a), 0, 1, v.h);
      g.fillRect(Math.round(b), 0, 1, v.h);
    }
    if (box) {
      const x = Math.min(box.x0, box.x1) - sx, y = Math.min(box.y0, box.y1) - sy;
      const w = Math.abs(box.x1 - box.x0), h = Math.abs(box.y1 - box.y0);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(x, y, w, h);
      g.setLineDash([5, 3]);
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
      g.setLineDash([]);
    }
    if (sliceLine) {
      const x = Math.round(sliceLine.t * ppt - sx);
      const a = Math.min(sliceLine.tr0, sliceLine.tr1), b = Math.max(sliceLine.tr0, sliceLine.tr1);
      const y0 = trackTop(v, a) - sy, y1 = trackTop(v, b + 1) - sy;
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(x - 1, y0, 3, y1 - y0);
      g.fillStyle = '#ffffff';
      g.fillRect(x, y0, 1, y1 - y0);
    }
    // song position / playhead
    const playing = playingSong();
    const p = playing ? engine.position : engine.songStart;
    const x = Math.round(p * ppt - sx);
    if (x >= -2 && x <= v.w + 2) {
      if (playing) {
        g.fillStyle = 'rgba(125,255,168,0.22)';
        g.fillRect(x - 2, 0, 5, v.h);
        g.fillStyle = '#7dffa8';
        g.fillRect(x, 0, 1, v.h);
      } else {
        g.fillStyle = store.ui.songMode ? 'rgba(246,164,50,0.7)' : 'rgba(246,164,50,0.35)';
        g.fillRect(x, 0, 1, v.h);
      }
    }
  }

  // =========================================================================
  // project sync
  // =========================================================================
  const updateTitle = () => {
    const w = wm?.get('playlist');
    if (w) w.setTitle(`Playlist - Arrangement › ${store.currentPattern?.name ?? '(none)'}`);
  };
  const updateTools = () => {
    for (const [id, b] of toolBtns) b.classList.toggle('on', store.ui.plTool === id);
    root.dataset.tool = store.ui.plTool;
  };
  const updateSource = () => {
    const s = currentSource();
    if (!s) {
      srcName.textContent = '(none)';
      return;
    }
    const info = sourceInfo(store.project, s.kind, s.ref);
    srcIcon.innerHTML = s.kind === 'pattern' ? ICONS.pianoRoll : s.kind === 'audio' ? ICONS.wave : ICONS.automation;
    srcSw.style.background = info.color;
    srcName.textContent = info.name;
  };
  const updateSelInfo = () => {
    const n = sel.size;
    selInfo.textContent = n ? `${n} selected` : '';
  };
  const setSel = (ids: Iterable<ID>) => {
    sel.clear();
    for (const id of expandGroups(ids)) sel.add(id);
    updateSelInfo();
    invalidate(F_MAIN);
  };
  function expandGroups(ids: Iterable<ID>): Set<ID> {
    const out = new Set(ids);
    const groups = new Set<string>();
    const clips = store.project.playlist.clips;
    for (const c of clips) if (c.group && out.has(c.id)) groups.add(c.group);
    if (groups.size) for (const c of clips) if (c.group && groups.has(c.group)) out.add(c.id);
    return out;
  }
  const refreshLookup = () => {
    L = buildLookup(store.project);
  };
  const refresh = () => {
    if (!store.project) return;
    refreshLookup();
    bumpGeneration();
    layoutTracks();
    if (sel.size) {
      const ids = new Set(store.project.playlist.clips.map((c) => c.id));
      let changed = false;
      for (const id of sel)
        if (!ids.has(id)) {
          sel.delete(id);
          changed = true;
        }
      if (changed) updateSelInfo();
    }
    updateSpacer();
    picker.sync();
    updateSource();
    updateTitle();
    invalidate(F_ALL);
  };

  // =========================================================================
  // hit testing
  // =========================================================================
  function hitAt(x: number, y: number): Hit | null {
    syncScroll();
    const cy = y + v.sy, cx = x + v.sx;
    const tr = trackAt(v, cy);
    const list = L.byTrack[tr];
    if (!list?.length) return null;
    const tick = cx / v.ppt;
    const tol = 3 / v.ppt;
    let best: Clip | null = null;
    for (let k = firstCandidate(list, tick - tol, L.maxLen[tr] ?? 0); k < list.length; k++) {
      const c = list[k];
      if (c.start > tick + tol) break;
      const small = c.len * v.ppt < 8 ? tol : 0;
      if (tick >= c.start - small && tick <= c.start + c.len + small) {
        if (!best || sel.has(c.id) || !sel.has(best.id)) best = c;
      }
    }
    if (!best) return null;
    const G = clipGeom(v, best);
    const lx = x - G.x;
    const edge = G.w >= 14 ? Math.min(7, G.w / 4) : 0;
    const rEdge = G.w >= 14 ? edge : G.w >= 6 ? 3 : 0;
    if (best.kind === 'automation') {
      const th = titleHeight(G.h);
      const inTitle = th > 0 && y - G.y < th;
      if (!inTitle && G.h >= 22) {
        const a = L.auto.get(best.ref);
        if (a) {
          const m = autoPointMap(v, best);
          let bi = -1, bd = 7 * 7;
          a.points.forEach((pt, i) => {
            if (pt.t < best!.offset || pt.t > best!.offset + best!.len) return;
            const dx = m.xOf(pt.t) - x, dy = m.yOf(pt.v) - y;
            const d = dx * dx + dy * dy;
            if (d <= bd) {
              bd = d;
              bi = i;
            }
          });
          if (bi >= 0) return { clip: best, zone: 'auto', point: bi };
          if (edge && lx <= edge) return { clip: best, zone: 'left', point: -1 };
          if (rEdge && G.w - lx <= rEdge) return { clip: best, zone: 'right', point: -1 };
          return { clip: best, zone: 'auto', point: -1 };
        }
      }
    }
    if (edge && lx <= edge) return { clip: best, zone: 'left', point: -1 };
    if (rEdge && G.w - lx <= rEdge) return { clip: best, zone: 'right', point: -1 };
    const th = titleHeight(G.h);
    return { clip: best, zone: th && y - G.y < th ? 'title' : 'body', point: -1 };
  }

  // =========================================================================
  // drag plumbing (with edge auto-scroll)
  // =========================================================================
  function track(e: PointerEvent, move: (ev: PointerEvent) => void, up: (ev: PointerEvent) => void, auto: 'xy' | 'x' | false = 'xy') {
    dragging = true;
    let last = e;
    let ar = 0;
    const step = () => {
      ar = 0;
      if (!dragging) return;
      const r = scroll.getBoundingClientRect();
      const W = scroll.clientWidth, H = scroll.clientHeight;
      const x = last.clientX - r.left, y = last.clientY - r.top;
      const E = 26;
      let dx = 0, dy = 0;
      if (x < E) dx = -Math.min(48, E - x);
      else if (x > W - E) dx = Math.min(48, x - (W - E));
      if (auto === 'xy') {
        if (y < E && y > -60) dy = -Math.min(48, E - y);
        else if (y > H - E) dy = Math.min(48, y - (H - E));
      }
      if (!dx && !dy) return;
      const sl = scroll.scrollLeft, st = scroll.scrollTop;
      if (dx > 0 && scroll.scrollLeft + W >= scroll.scrollWidth - 2) {
        minSpacerW = scroll.scrollWidth + 400;
        updateSpacer();
      }
      scroll.scrollLeft += dx * 0.5;
      scroll.scrollTop += dy * 0.5;
      if (scroll.scrollLeft !== sl || scroll.scrollTop !== st) {
        syncScroll();
        move(last);
      }
      ar = requestAnimationFrame(step);
    };
    drag(
      e,
      (_dx, _dy, ev) => {
        last = ev;
        move(ev);
        if (auto && !ar) ar = requestAnimationFrame(step);
      },
      (ev) => {
        dragging = false;
        if (ar) cancelAnimationFrame(ar);
        if (minSpacerW) {
          minSpacerW = 0;
          updateSpacer();
        }
        up(ev);
        invalidate(F_ALL);
      },
    );
  }

  /** Apply a live edit and refresh the hit-test index immediately (for sweeps within one event). */
  const liveNow = (fn: Parameters<typeof store.live>[0], label?: string) => {
    store.live(fn, label);
    refreshLookup();
  };

  // =========================================================================
  // edit gestures
  // =========================================================================
  function useClipSource(c: Clip) {
    if (c.kind === 'pattern') {
      if (store.ui.currentPattern !== c.ref || store.ui.plSource?.ref !== c.ref) selectPattern(c.ref);
    } else if (store.ui.plSource?.ref !== c.ref) store.setUI({ plSource: { kind: c.kind, ref: c.ref } });
  }

  function moveClips(e: PointerEvent, p0: Pos, anchor: Clip, opts: { dup?: boolean; began?: boolean; label?: string } = {}) {
    let ids = sel.has(anchor.id) ? [...sel] : [anchor.id];
    const init = new Map<ID, { start: number; track: number }>();
    for (const id of ids) {
      const c = clipById(id);
      if (c) init.set(id, { start: c.start, track: c.track });
    }
    const a0 = { start: anchor.start, track: anchor.track };
    let minStart = Infinity, minTrack = Infinity, maxTrack = 0;
    for (const i of init.values()) {
      minStart = Math.min(minStart, i.start);
      minTrack = Math.min(minTrack, i.track);
      maxTrack = Math.max(maxTrack, i.track);
    }
    let began = !!opts.began;
    let moved = false;
    track(
      e,
      (ev) => {
        const q = pos(ev);
        if (!moved && Math.abs(q.cx - p0.cx) < 3 && Math.abs(q.cy - p0.cy) < 3) return;
        moved = true;
        if (!began) {
          began = true;
          store.begin(opts.label ?? (init.size > 1 ? 'Move clips' : 'Move clip'));
          if (opts.dup) {
            const map = new Map<ID, ID>();
            const gmap = new Map<string, string>();
            store.live((p) => {
              const add: Clip[] = [];
              for (const c of p.playlist.clips) {
                if (!init.has(c.id)) continue;
                const cp: Clip = { ...c, id: uid('k') };
                if (c.group) {
                  if (!gmap.has(c.group)) gmap.set(c.group, uid('g'));
                  cp.group = gmap.get(c.group);
                }
                map.set(c.id, cp.id);
                add.push(cp);
              }
              p.playlist.clips.push(...add);
            });
            const ninit = new Map<ID, { start: number; track: number }>();
            for (const [k, val] of init) ninit.set(map.get(k)!, val);
            init.clear();
            for (const [k, val] of ninit) init.set(k, val);
            ids = [...init.keys()];
            sel.clear();
            for (const id of ids) sel.add(id);
            updateSelInfo();
          }
        }
        let ns = a0.start + (q.cx - p0.cx) / v.ppt;
        ns = snapT(ns, ev);
        const dT = Math.max(ns - a0.start, -minStart);
        const n = store.project.playlist.tracks.length;
        const dTr = clamp(q.track - p0.track, -minTrack, n + 2 - maxTrack);
        store.live((p) => {
          ensureTracks(p, maxTrack + dTr + 1);
          for (const c of p.playlist.clips) {
            const i = init.get(c.id);
            if (i) {
              c.start = i.start + dT;
              c.track = i.track + dTr;
            }
          }
        }, 'move');
        setHint(`Move: ${fmtBST(a0.start + dT, store.project.timeSig)} · track ${a0.track + dTr + 1}${ev.altKey ? ' · no snap' : ''}`);
      },
      () => {
        if (began) store.end();
      },
    );
  }

  function resizeClips(e: PointerEvent, p0: Pos, anchor: Clip, side: 'left' | 'right') {
    const ids = sel.has(anchor.id) ? [...sel] : [anchor.id];
    const init = new Map<ID, { start: number; len: number; offset: number }>();
    for (const id of ids) {
      const c = clipById(id);
      if (c) init.set(id, { start: c.start, len: c.len, offset: c.offset });
    }
    const ref = side === 'right' ? anchor.start + anchor.len : anchor.start;
    let began = false;
    track(
      e,
      (ev) => {
        const q = pos(ev);
        if (!began) {
          if (Math.abs(q.cx - p0.cx) < 2) return;
          began = true;
          store.begin(side === 'right' ? 'Resize clips' : 'Trim clip starts');
        }
        const g = ev.altKey ? 0 : grid();
        let t = ref + (q.cx - p0.cx) / v.ppt;
        t = g ? snapRound(t, g) : Math.round(t);
        const d = t - ref;
        const minLen = g || 6;
        store.live((p) => {
          for (const c of p.playlist.clips) {
            const i = init.get(c.id);
            if (!i) continue;
            const ml = Math.min(minLen, i.len);
            if (side === 'right') {
              c.len = clamp(i.len + d, ml, Math.max(ml, maxClipLen(p, { ...c, offset: i.offset })));
            } else {
              const rate = contentRate(p, c);
              let dd = Math.min(d, i.len - ml);
              dd = Math.max(dd, -i.start);
              if (c.kind !== 'pattern') dd = Math.max(dd, -i.offset / rate);
              c.start = i.start + dd;
              c.len = i.len - dd;
              c.offset = i.offset + dd * rate;
              normalizeOffset(p, c);
            }
          }
        });
        const a = clipById(anchor.id);
        if (a) setHint(`${side === 'right' ? 'Length' : 'Start'}: ${side === 'right' ? (a.len / store.barTicks).toFixed(2) + ' bars' : fmtBST(a.start, store.project.timeSig)}`);
      },
      () => began && store.end(),
    );
  }

  function slipClips(e: PointerEvent, p0: Pos, anchor: Clip) {
    const ids = sel.has(anchor.id) ? [...sel] : [anchor.id];
    const init = new Map<ID, number>();
    for (const id of ids) {
      const c = clipById(id);
      if (c) init.set(id, c.offset);
    }
    let began = false;
    track(
      e,
      (ev) => {
        const q = pos(ev);
        if (!began) {
          if (Math.abs(q.cx - p0.cx) < 2) return;
          began = true;
          store.begin('Slip clip content');
        }
        const g = ev.altKey ? 0 : grid();
        let d = (q.cx - p0.cx) / v.ppt;
        d = g ? snapRound(d, g) : Math.round(d);
        store.live((p) => {
          for (const c of p.playlist.clips) {
            const o = init.get(c.id);
            if (o === undefined) continue;
            const rate = contentRate(p, c);
            c.offset = o - d * rate;
            if (c.kind === 'audio') {
              const st = sampleTicks(p, p.channels.find((x) => x.id === c.ref));
              if (st !== null) c.offset = Math.min(c.offset, Math.max(0, (st - 1) * rate));
            }
            normalizeOffset(p, c);
          }
        });
        setHint(`Slip: content offset ${d >= 0 ? '+' : ''}${(d / STEP).toFixed(2)} steps`);
      },
      () => began && store.end(),
      'x',
    );
  }

  function drawNewClip(e: PointerEvent, p0: Pos) {
    const src = currentSource();
    if (!src) {
      toast('Choose a pattern or clip in the picker first', 'warn');
      return;
    }
    const p = store.project;
    const len = sourceLength(p, src.kind, src.ref);
    const start = snapT(p0.tick, e, 'floor');
    const id = uid('k');
    store.begin('Add clip');
    liveNow((pp) => {
      ensureTracks(pp, p0.track + 1);
      pp.playlist.clips.push({ id, kind: src.kind, ref: src.ref, track: p0.track, start, len, offset: 0 });
    });
    const clip = clipById(id)!;
    moveClips(e, p0, clip, { began: true });
  }

  function paintClips(e: PointerEvent, p0: Pos) {
    const src = currentSource();
    if (!src) {
      toast('Choose a pattern or clip in the picker first', 'warn');
      return;
    }
    const len = Math.max(1, sourceLength(store.project, src.kind, src.ref));
    const start0 = snapT(p0.tick, e, 'floor');
    const tr = p0.track;
    let ids: ID[] = [];
    let lastKey = '';
    store.begin('Paint clips');
    const apply = (count: number, dir: 1 | -1) => {
      const key = count + ':' + dir;
      if (key === lastKey) return;
      lastKey = key;
      liveNow((p) => {
        const drop = new Set(ids);
        p.playlist.clips = p.playlist.clips.filter((c) => !drop.has(c.id));
        ids = [];
        ensureTracks(p, tr + 1);
        for (let k = 0; k < count; k++) {
          const s = start0 + dir * k * len;
          if (s < 0) break;
          if (p.playlist.clips.some((c) => c.track === tr && c.start === s && c.ref === src.ref && c.kind === src.kind)) continue;
          const id = uid('k');
          ids.push(id);
          p.playlist.clips.push({ id, kind: src.kind, ref: src.ref, track: tr, start: s, len, offset: 0 });
        }
      });
    };
    apply(1, 1);
    track(
      e,
      (ev) => {
        const q = pos(ev);
        const dt = q.tick - start0;
        if (dt >= 0) apply(Math.floor(dt / len) + 1, 1);
        else apply(Math.ceil(-dt / len) + 1, -1);
      },
      () => store.end(),
      'x',
    );
  }

  /** Sweep across clips: right-drag / Delete tool deletes, Mute tool toggles mute. */
  function sweep(e: PointerEvent, p0: Pos, mode: 'delete' | 'mute') {
    let began = false;
    const done = new Set<ID>();
    let lx = p0.x, ly = p0.y;
    const at = (x: number, y: number) => {
      const h = hitAt(x, y);
      if (!h || done.has(h.clip.id)) return;
      if (!began) {
        began = true;
        store.begin(mode === 'delete' ? 'Delete clips' : 'Toggle clip mute');
      }
      const id = h.clip.id;
      done.add(id);
      liveNow((p) => {
        if (mode === 'delete') p.playlist.clips = p.playlist.clips.filter((c) => c.id !== id);
        else {
          const c = p.playlist.clips.find((x) => x.id === id);
          if (c) {
            if (c.muted) delete c.muted;
            else c.muted = true;
          }
        }
      });
    };
    at(p0.x, p0.y);
    track(
      e,
      (ev) => {
        const q = pos(ev);
        const dist = Math.hypot(q.x - lx, q.y - ly);
        const n = Math.max(1, Math.ceil(dist / 4));
        for (let i = 1; i <= n; i++) at(lx + ((q.x - lx) * i) / n, ly + ((q.y - ly) * i) / n);
        lx = q.x;
        ly = q.y;
      },
      () => began && store.end(),
    );
  }

  function sliceAt(t: number, filter: (c: Clip) => boolean, label = 'Slice clips') {
    let made = 0;
    const newIds: ID[] = [];
    store.commit(label, (p) => {
      const add: Clip[] = [];
      for (const c of p.playlist.clips) {
        if (!filter(c)) continue;
        const r = sliceClip(p, c, t);
        if (r) {
          add.push(r);
          newIds.push(r.id);
          made++;
        }
      }
      p.playlist.clips.push(...add);
    });
    if (made) {
      const keep = [...sel].filter((id) => clipById(id));
      if (keep.length) setSel([...keep, ...newIds.filter((id) => sel.size)]);
    }
    return made;
  }

  function sliceTool(e: PointerEvent, p0: Pos) {
    const t = snapT(p0.tick, e);
    sliceLine = { t, tr0: p0.track, tr1: p0.track };
    invalidate(F_OV);
    track(
      e,
      (ev) => {
        if (sliceLine) sliceLine.tr1 = pos(ev).track;
        invalidate(F_OV);
      },
      () => {
        if (!sliceLine) return;
        const a = Math.min(sliceLine.tr0, sliceLine.tr1), b = Math.max(sliceLine.tr0, sliceLine.tr1);
        sliceLine = null;
        sliceAt(t, (c) => c.track >= a && c.track <= b);
      },
      'xy',
    );
  }

  function boxSelect(e: PointerEvent, p0: Pos, additive: boolean, toggleClip: Clip | null = null) {
    const base = additive ? new Set(sel) : new Set<ID>();
    const startSel = new Set(sel);
    box = { x0: p0.cx, y0: p0.cy, x1: p0.cx, y1: p0.cy };
    let moved = false;
    track(
      e,
      (ev) => {
        const q = pos(ev);
        if (!box) return;
        box.x1 = q.cx;
        box.y1 = q.cy;
        if (!moved && Math.hypot(q.cx - p0.cx, q.cy - p0.cy) < 3) return;
        moved = true;
        const t0 = Math.min(box.x0, box.x1) / v.ppt, t1 = Math.max(box.x0, box.x1) / v.ppt;
        const ya = Math.min(box.y0, box.y1), yb = Math.max(box.y0, box.y1);
        const tra = trackAt(v, ya), trb = trackAt(v, yb);
        const hits = new Set(base);
        for (let i = tra; i <= trb; i++) {
          for (const c of L.byTrack[i] ?? []) {
            if (c.start < t1 && c.start + c.len > t0) {
              // must overlap the vertical band too (partial track coverage counts)
              hits.add(c.id);
            }
          }
        }
        setSel(hits);
        invalidate(F_OV);
      },
      () => {
        box = null;
        if (!moved) {
          if (toggleClip) {
            const ids = expandGroups([toggleClip.id]);
            const on = startSel.has(toggleClip.id);
            for (const id of ids) on ? startSel.delete(id) : startSel.add(id);
            setSel(startSel);
          } else if (!additive) setSel([]);
        }
        invalidate(F_OV);
      },
    );
  }

  function zoomTool(e: PointerEvent, p0: Pos) {
    zoomBox = { t0: p0.tick, t1: p0.tick };
    track(
      e,
      (ev) => {
        if (zoomBox) zoomBox.t1 = pos(ev).tick;
        invalidate(F_OV);
      },
      () => {
        if (!zoomBox) return;
        const a = Math.min(zoomBox.t0, zoomBox.t1), b = Math.max(zoomBox.t0, zoomBox.t1);
        zoomBox = null;
        if ((b - a) * v.ppt < 6) zoomAt(v.ppt * 2, p0.x);
        else zoomToRange(a, b);
      },
      'x',
    );
  }

  function playbackTool(e: PointerEvent, p0: Pos) {
    store.setUI({ songMode: true });
    engine.setPosition(snapT(p0.tick, e));
    if (!engine.playing) engine.play();
    invalidate(F_OV | F_RULER);
    track(e, () => {}, () => engine.stop(), false);
  }

  function autoPointDrag(e: PointerEvent, hit: Hit) {
    const c = hit.clip;
    const aid = c.ref;
    let idx = hit.point;
    const add = idx < 0;
    const compute = (ev: PointerEvent) => {
      const q = pos(ev);
      syncScroll();
      const m = autoPointMap(v, c);
      const tick = ev.altKey ? q.tick : snapT(q.tick, ev);
      return { t: Math.max(0, tick - c.start + c.offset), val: Math.round(m.vAt(q.y) * 1000) / 1000 };
    };
    store.begin(add ? 'Add automation point' : 'Move automation point');
    const setPoint = (t: number, val: number) =>
      store.live((p) => {
        const a = p.automations.find((x) => x.id === aid);
        if (!a || !a.points[idx]) return;
        const prev = a.points[idx - 1], next = a.points[idx + 1];
        const lo = prev ? prev.t : 0;
        const hi = Math.min(next ? next.t : Infinity, c.offset + c.len);
        const tt = clamp(t, lo, Math.max(lo, hi));
        a.points[idx] = { t: Math.round(tt * 100) / 100, v: val };
        if (tt > a.length) a.length = Math.ceil(tt);
      });
    if (add) {
      const { t, val } = compute(e);
      store.live((p) => {
        const a = p.automations.find((x) => x.id === aid);
        if (!a) return;
        let i = a.points.findIndex((pt) => pt.t > t);
        if (i < 0) i = a.points.length;
        a.points.splice(i, 0, { t, v: val });
        if (t > a.length) a.length = Math.ceil(t);
        idx = i;
      });
      hoverAuto = { clipId: c.id, point: idx };
    }
    track(
      e,
      (ev) => {
        const { t, val } = compute(ev);
        setPoint(t, val);
        hoverAuto = { clipId: c.id, point: idx };
        const a = store.project.automations.find((x) => x.id === aid);
        setHint(`${a?.name ?? 'Automation'}: ${Math.round(val * 100)}% at ${fmtBST(c.start + t - c.offset, store.project.timeSig)}`);
      },
      () => store.end(),
      'x',
    );
  }

  function deleteAutoPoint(hit: Hit) {
    const aid = hit.clip.ref;
    const i = hit.point;
    const a = store.project.automations.find((x) => x.id === aid);
    if (!a) return;
    if (a.points.length <= 1) {
      toast('An automation clip needs at least one point', 'info', 1500);
      return;
    }
    store.commit('Delete automation point', (p) => {
      const au = p.automations.find((x) => x.id === aid);
      au?.points.splice(i, 1);
    });
    hoverAuto = null;
  }

  function openClip(c: Clip) {
    if (c.kind === 'pattern') {
      selectPattern(c.ref);
      const chs = channelsWithNotes(store.project, c.ref);
      if (chs.length === 1) {
        store.setUI({ selectedChannels: [chs[0]], pianoRollChannel: chs[0] });
        wm.show('pianoroll');
      } else wm.show('channelrack');
    } else if (c.kind === 'audio') {
      store.setUI({ settingsChannel: c.ref, selectedChannels: [c.ref], plSource: { kind: 'audio', ref: c.ref } });
      wm.show('channelsettings');
    }
  }

  // =========================================================================
  // pointer input on the arrangement
  // =========================================================================
  scroll.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  scroll.addEventListener('contextmenu', (e) => e.preventDefault());
  scroll.addEventListener('pointerdown', (e) => {
    const p0 = pos(e);
    if (p0.x >= scroll.clientWidth || p0.y >= scroll.clientHeight) return; // native scrollbars
    syncScroll();
    if (e.button === 1) {
      e.preventDefault();
      const sl = scroll.scrollLeft, st = scroll.scrollTop;
      scroll.classList.add('panning');
      drag(e, (dx, dy) => {
        scroll.scrollLeft = sl - dx;
        scroll.scrollTop = st - dy;
      }, () => scroll.classList.remove('panning'));
      return;
    }
    e.preventDefault();
    scroll.focus({ preventScroll: true });
    const tool = store.ui.plTool;
    const hit = hitAt(p0.x, p0.y);
    if (e.button === 2) {
      if (tool === 'zoom') return zoomAt(v.ppt / 2, p0.x);
      if (hit?.zone === 'auto' && hit.point >= 0) return deleteAutoPoint(hit);
      return sweep(e, p0, 'delete');
    }
    if (e.button !== 0) return;
    if ((e.ctrlKey || e.metaKey) && tool !== 'zoom' && tool !== 'playback') {
      // Ctrl+drag = box select (Ctrl+Shift adds); Ctrl+click on a clip toggles it
      return boxSelect(e, p0, e.shiftKey, hit?.clip ?? null);
    }
    switch (tool) {
      case 'draw':
      case 'paint':
      case 'select': {
        if (hit) {
          if (hit.zone === 'auto') {
            useClipSource(hit.clip);
            return autoPointDrag(e, hit);
          }
          if (!sel.has(hit.clip.id)) setSel([hit.clip.id]);
          useClipSource(hit.clip);
          if (hit.zone === 'left' || hit.zone === 'right') return resizeClips(e, p0, hit.clip, hit.zone);
          return moveClips(e, p0, hit.clip, { dup: e.shiftKey, label: e.shiftKey ? 'Duplicate clips' : undefined });
        }
        if (tool === 'select') return boxSelect(e, p0, e.shiftKey);
        if (sel.size) setSel([]);
        if (tool === 'paint') return paintClips(e, p0);
        return drawNewClip(e, p0);
      }
      case 'delete':
        return sweep(e, p0, 'delete');
      case 'mute':
        return sweep(e, p0, 'mute');
      case 'slice':
        return sliceTool(e, p0);
      case 'slip':
        if (hit) return slipClips(e, p0, hit.clip);
        return boxSelect(e, p0, e.shiftKey);
      case 'zoom':
        return zoomTool(e, p0);
      case 'playback':
        return playbackTool(e, p0);
    }
  });

  scroll.addEventListener('dblclick', (e) => {
    const tool = store.ui.plTool;
    if (tool !== 'draw' && tool !== 'paint' && tool !== 'select') return;
    const q = pos(e);
    const h = hitAt(q.x, q.y);
    if (!h || h.zone === 'auto') return;
    openClip(h.clip);
  });

  const clipHint = (h: Hit) => {
    const info = sourceInfo(store.project, h.clip.kind, h.clip.ref);
    const kind = h.clip.kind === 'pattern' ? 'Pattern' : h.clip.kind === 'audio' ? 'Audio' : 'Automation';
    const where = `${fmtBST(h.clip.start, store.project.timeSig)}, ${(h.clip.len / store.barTicks).toFixed(2)} bars${h.clip.muted ? ' · muted' : ''}${h.clip.group ? ' · grouped' : ''}`;
    if (h.zone === 'left') return `${kind} clip "${info.name}" — drag to trim the start`;
    if (h.zone === 'right') return `${kind} clip "${info.name}" — drag to change the length`;
    if (h.zone === 'auto')
      return h.point >= 0
        ? `Automation point — drag to move (Alt: no snap), right-click to delete`
        : `Automation "${info.name}" — click to add a point and drag it; use the title strip to move the clip`;
    const open = h.clip.kind === 'pattern' ? ' · double-click: edit pattern' : h.clip.kind === 'audio' ? ' · double-click: channel settings' : '';
    return `${kind} clip "${info.name}" (${where}) — drag: move · Shift+drag: duplicate · right-click: delete${open}`;
  };
  const cursorFor = (tool: ToolId, h: Hit | null): string => {
    switch (tool) {
      case 'zoom':
        return 'zoom-in';
      case 'slice':
        return 'col-resize';
      case 'delete':
        return h ? 'not-allowed' : 'default';
      case 'mute':
        return h ? 'pointer' : 'default';
      case 'playback':
        return 'pointer';
      case 'slip':
        return h ? 'ew-resize' : 'default';
    }
    if (!h) return tool === 'select' ? 'default' : 'crosshair';
    if (h.zone === 'left' || h.zone === 'right') return 'ew-resize';
    if (h.zone === 'auto') return h.point >= 0 ? 'grab' : 'copy';
    return 'move';
  };
  let lastCursor = '';
  scroll.addEventListener('pointermove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (dragging || e.buttons) return;
    const q = pos(e);
    if (q.x >= scroll.clientWidth || q.y >= scroll.clientHeight) return;
    hoverTick = q.tick;
    posLabel.textContent = fmtBST(q.tick, store.project.timeSig);
    trkLabel.textContent = 'Track ' + (q.track + 1);
    const h = hitAt(q.x, q.y);
    const cur = cursorFor(store.ui.plTool, h);
    if (cur !== lastCursor) {
      scroll.style.cursor = cur;
      lastCursor = cur;
    }
    const ha = h && h.zone === 'auto' && h.point >= 0 ? { clipId: h.clip.id, point: h.point } : null;
    if ((ha?.clipId ?? '') + (ha?.point ?? '') !== (hoverAuto?.clipId ?? '') + (hoverAuto?.point ?? '')) {
      hoverAuto = ha;
      invalidate(F_MAIN);
    }
    setHint(h ? clipHint(h) : TOOLS.find((t) => t.id === store.ui.plTool)?.hint ?? '');
    invalidate(F_RULER);
  });
  scroll.addEventListener('pointerleave', () => {
    if (dragging) return;
    hoverTick = null;
    if (hoverAuto) {
      hoverAuto = null;
      invalidate(F_MAIN);
    }
    invalidate(F_RULER);
  });
  scroll.addEventListener('scroll', () => invalidate(F_ALL));

  // ---- wheel ----
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = scroll.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * k, dx = e.deltaX * k;
    if (e.ctrlKey || e.metaKey) {
      const d = dy || dx;
      zoomAt(v.ppt * Math.pow(1.2, -clamp(d, -300, 300) / 100), clamp(x, 0, v.w));
      return;
    }
    if (e.altKey) {
      const d = dy || dx;
      setVZoom(v.vz * (d < 0 ? 1.12 : 1 / 1.12), clamp(y, 0, v.h));
      return;
    }
    if (e.shiftKey) {
      scroll.scrollLeft += dy || dx;
      return;
    }
    scroll.scrollTop += dy;
    if (dx) scroll.scrollLeft += dx;
  }
  viewEl.addEventListener('wheel', onWheel, { passive: false });

  // =========================================================================
  // zoom
  // =========================================================================
  function zoomAt(ppt: number, anchorX: number) {
    ppt = clamp(ppt, MIN_PPT, MAX_PPT);
    if (Math.abs(ppt - v.ppt) < 1e-9) return;
    const tick = (scroll.scrollLeft + anchorX) / v.ppt;
    v.ppt = ppt;
    const target = Math.max(0, tick * ppt - anchorX);
    minSpacerW = target + v.w;
    updateSpacer();
    scroll.scrollLeft = target;
    minSpacerW = 0;
    syncScroll();
    savePrefs();
    invalidate(F_ALL);
  }
  function zoomToRange(a: number, b: number) {
    if (b <= a) return;
    v.ppt = clamp((v.w - 24) / (b - a), MIN_PPT, MAX_PPT);
    const target = Math.max(0, a * v.ppt - 12);
    minSpacerW = target + v.w;
    updateSpacer();
    scroll.scrollLeft = target;
    minSpacerW = 0;
    savePrefs();
    invalidate(F_ALL);
  }
  function setVZoom(vz: number, anchorY: number) {
    vz = clamp(vz, 0.45, 3);
    if (Math.abs(vz - v.vz) < 1e-6) return;
    const cy = scroll.scrollTop + anchorY;
    const tr = trackAt(v, cy);
    const frac = (cy - trackTop(v, tr)) / trackHeight(v, tr);
    v.vz = vz;
    layoutTracks();
    updateSpacer();
    scroll.scrollTop = Math.max(0, trackTop(v, tr) + frac * trackHeight(v, tr) - anchorY);
    savePrefs();
    invalidate(F_ALL);
  }
  const focusTick = () => (playingSong() ? engine.position : engine.songStart);
  function centerOn(t: number) {
    scroll.scrollLeft = Math.max(0, t * v.ppt - v.w / 2);
    invalidate(F_ALL);
  }
  function zoomLevel(n: 1 | 2 | 3 | 4) {
    if (n === 4) return zoomToRange(0, Math.max(store.songLength(), store.barTicks));
    const ppt = n === 1 ? 1.2 : n === 2 ? 0.32 : 0.09;
    const t = focusTick();
    const x = t * v.ppt - scroll.scrollLeft;
    zoomAt(ppt, x >= 0 && x <= v.w ? x : v.w / 2);
  }

  // =========================================================================
  // ruler
  // =========================================================================
  const rulerTick = (ev: { clientX: number }) => {
    const r = rulerCv.getBoundingClientRect();
    return Math.max(0, (ev.clientX - r.left + scroll.scrollLeft) / v.ppt);
  };
  const rulerHit = (ev: { clientX: number; clientY: number }): 'marker' | 'loopStart' | 'loopEnd' | null => {
    const r = rulerCv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const sx = scroll.scrollLeft;
    if (y >= 11 && Math.abs(x - (engine.songStart * v.ppt - sx)) <= 6) return 'marker';
    const loop = store.ui.loop;
    if (loop && y >= 11) {
      if (Math.abs(x - (loop.start * v.ppt - sx)) <= 4) return 'loopStart';
      if (Math.abs(x - (loop.end * v.ppt - sx)) <= 4) return 'loopEnd';
    }
    return null;
  };
  rulerCv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const what = rulerHit(e);
    const t0 = rulerTick(e);
    if (what === 'marker') {
      track(e, (ev) => engine.setPosition(snapT(rulerTick(ev), ev)), () => {}, 'x');
      return;
    }
    if (what === 'loopStart' || what === 'loopEnd') {
      const loop = store.ui.loop!;
      const fixed = what === 'loopStart' ? loop.end : loop.start;
      track(
        e,
        (ev) => {
          const t = snapT(rulerTick(ev), ev);
          const a = Math.min(t, fixed), b = Math.max(t, fixed);
          if (b > a) store.setUI({ loop: { start: a, end: b } });
        },
        () => {},
        'x',
      );
      return;
    }
    const s0 = snapT(t0, e);
    let moved = false;
    track(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - e.clientX) < 4) return;
        moved = true;
        const t = snapT(rulerTick(ev), ev);
        const a = Math.min(s0, t), b = Math.max(s0, t);
        store.setUI({ loop: b > a ? { start: a, end: b } : null });
        setHint(b > a ? `Time selection ${fmtBST(a, store.project.timeSig)} – ${fmtBST(b, store.project.timeSig)} (${((b - a) / store.barTicks).toFixed(2)} bars)` : '');
      },
      (ev) => {
        if (moved) return;
        const loop = store.ui.loop;
        if (loop && (t0 < loop.start || t0 > loop.end)) store.setUI({ loop: null });
        engine.setPosition(snapT(t0, ev));
      },
      'x',
    );
  });
  rulerCv.addEventListener('dblclick', () => store.setUI({ loop: null }));
  rulerCv.addEventListener('pointermove', (e) => {
    if (dragging) return;
    const what = rulerHit(e);
    rulerCv.style.cursor = what === 'marker' ? 'grab' : what ? 'ew-resize' : 'text';
    hoverTick = rulerTick(e);
    posLabel.textContent = fmtBST(hoverTick, store.project.timeSig);
    invalidate(F_RULER);
  });
  rulerCv.addEventListener('pointerleave', () => {
    hoverTick = null;
    invalidate(F_RULER);
  });
  rulerCv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = snapT(rulerTick(e), e);
    showMenu(
      [
        { label: 'Set song position here', action: () => engine.setPosition(t) },
        { label: 'Select whole song', action: () => store.setUI({ loop: { start: 0, end: store.songLength() } }) },
        { label: 'Clear time selection', disabled: !store.ui.loop, action: () => store.setUI({ loop: null }) },
        { label: 'Select clips in time selection', disabled: !store.ui.loop, action: () => selectInRange(store.ui.loop!) },
      ],
      e.clientX,
      e.clientY,
    );
  });
  rulerWrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = rulerCv.getBoundingClientRect();
      const d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
      if (e.shiftKey) scroll.scrollLeft += d;
      else zoomAt(v.ppt * Math.pow(1.2, -clamp(d, -300, 300) / 100), clamp(e.clientX - r.left, 0, v.w));
    },
    { passive: false },
  );

  // =========================================================================
  // overview strip
  // =========================================================================
  mapCv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    syncScroll();
    const r = mapCv.getBoundingClientRect();
    const total = mapTotal();
    const rg0 = overviewRange(v, total, v.w);
    const x = e.clientX - r.left;
    // outside the box: jump so the box is centred there, then keep dragging it
    if (x < rg0.x0 || x > rg0.x1) {
      scroll.scrollLeft = Math.max(0, (x / rg0.k) * v.ppt - v.w / 2);
      syncScroll();
      invalidate(F_ALL);
    }
    const sl0 = scroll.scrollLeft, cx0 = e.clientX;
    mapCv.classList.add('dragging');
    drag(
      e,
      (_dx, _dy, ev) => {
        const target = sl0 + ((ev.clientX - cx0) / rg0.k) * v.ppt;
        if (target + v.w > scroll.scrollWidth) {
          minSpacerW = target + v.w;
          updateSpacer();
        }
        scroll.scrollLeft = Math.max(0, target);
        syncScroll();
        invalidate(F_ALL);
      },
      () => {
        mapCv.classList.remove('dragging');
        if (minSpacerW) {
          minSpacerW = 0;
          updateSpacer();
        }
      },
    );
  });
  mapCv.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const r = mapCv.getBoundingClientRect();
    const rg0 = overviewRange(v, mapTotal(), v.w);
    const x = e.clientX - r.left;
    mapCv.style.cursor = x >= rg0.x0 && x <= rg0.x1 ? 'grab' : 'pointer';
  });
  mapWrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
      if (e.shiftKey) scroll.scrollLeft += d;
      else zoomAt(v.ppt * Math.pow(1.2, -clamp(d, -300, 300) / 100), v.w / 2);
    },
    { passive: false },
  );

  // =========================================================================
  // drag & drop from the picker / browser / OS
  // =========================================================================
  const acceptsDrop = (e: DragEvent) => hasType(e, DT_PLCLIP) || hasType(e, DT_PATTERN) || hasType(e, DT_SAMPLE) || hasType(e, 'Files');
  viewEl.addEventListener('dragover', (e) => {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const q = pos(e);
    let len: number | null = null;
    let color: string = COL.accent2;
    const src = pickerDrag;
    if (src) {
      len = sourceLength(store.project, src.kind, src.ref);
      color = sourceInfo(store.project, src.kind, src.ref).color;
    }
    const nd = { track: q.track, tick: snapT(q.tick, e, 'floor'), len, color };
    if (!drop || drop.track !== nd.track || drop.tick !== nd.tick || drop.len !== nd.len) {
      drop = nd;
      invalidate(F_OV);
    }
  });
  viewEl.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && viewEl.contains(e.relatedTarget as Node)) return;
    drop = null;
    invalidate(F_OV);
  });
  viewEl.addEventListener('drop', async (e) => {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    const q = pos(e);
    drop = null;
    invalidate(F_OV);
    const start = snapT(q.tick, e, 'floor');
    const tr = q.track;
    const pl = readDrag<{ kind: ClipKind; ref: ID }>(e, DT_PLCLIP);
    const pat = readDrag<{ id: ID }>(e, DT_PATTERN);
    if (pl || pat) {
      e.stopPropagation();
      const kind: ClipKind = pl?.kind ?? 'pattern';
      const ref = pl?.ref ?? pat!.id;
      if (!sourceInfo(store.project, kind, ref).exists) return;
      placeClip({ kind, ref }, tr, start);
      setSource(kind, ref);
      return;
    }
    if (hasType(e, DT_SAMPLE)) e.stopPropagation();
    const list = await samplesFromDrop(e);
    if (!list.length) return;
    for (const s of list) await samples.ensure(s.ref);
    let last: ID | null = null;
    store.begin(list.length > 1 ? 'Add audio clips' : 'Add audio clip');
    list.forEach((s, i) => {
      const cid = addChannel('sampler', { sampleRef: s.ref, name: s.name, audioClip: true, group: 'Audio', mixer: 0 }, false);
      last = cid;
      const len = sourceLength(store.project, 'audio', cid);
      const id = uid('k');
      store.live((p) => {
        ensureTracks(p, tr + i + 1);
        p.playlist.clips.push({ id, kind: 'audio', ref: cid, track: tr + i, start, len, offset: 0 });
      });
    });
    store.end();
    if (last) store.setUI({ plSource: { kind: 'audio', ref: last } });
    toast(`Added ${list.length} audio clip${list.length > 1 ? 's' : ''}`, 'ok', 1400);
  });

  function placeClip(src: Source, tr: number, start: number) {
    const len = sourceLength(store.project, src.kind, src.ref);
    const id = uid('k');
    store.commit(`Add ${src.kind} clip`, (p) => {
      ensureTracks(p, tr + 1);
      p.playlist.clips.push({ id, kind: src.kind, ref: src.ref, track: tr, start, len, offset: 0 });
    });
  }

  // =========================================================================
  // commands
  // =========================================================================
  function selectInRange(r: { start: number; end: number }) {
    setSel(store.project.playlist.clips.filter((c) => c.start >= r.start && c.start < r.end).map((c) => c.id));
  }
  function selectAll() {
    setSel(store.project.playlist.clips.map((c) => c.id));
  }
  function deselect() {
    setSel([]);
    if (store.ui.loop) store.setUI({ loop: null });
  }
  function copy(): boolean {
    const cs = selectedClips();
    if (!cs.length) {
      toast('Select clips to copy first', 'info', 1400);
      return false;
    }
    clipboard = deepClone(cs);
    toast(`Copied ${cs.length} clip${cs.length > 1 ? 's' : ''}`, 'info', 1000);
    return true;
  }
  function cut() {
    if (!copy()) return;
    const ids = new Set(sel);
    store.commit('Cut clips', (p) => (p.playlist.clips = p.playlist.clips.filter((c) => !ids.has(c.id))));
    setSel([]);
  }
  function paste() {
    if (!clipboard.length) {
      toast('Clipboard is empty', 'info', 1200);
      return;
    }
    const ext = extent(clipboard)!;
    const at = focusTick();
    const d = Math.round(at) - ext.start;
    const ids: ID[] = [];
    const gmap = new Map<string, string>();
    store.commit('Paste clips', (p) => {
      let maxT = 0;
      for (const c of clipboard) {
        if (!sourceInfo(p, c.kind, c.ref).exists) continue;
        const nc: Clip = { ...c, id: uid('k'), start: c.start + d };
        if (c.group) {
          if (!gmap.has(c.group)) gmap.set(c.group, uid('g'));
          nc.group = gmap.get(c.group);
        }
        ids.push(nc.id);
        maxT = Math.max(maxT, nc.track);
        p.playlist.clips.push(nc);
      }
      ensureTracks(p, maxT + 1);
    });
    setSel(ids);
  }
  function duplicate() {
    let cs = selectedClips();
    const loop = store.ui.loop;
    if (!cs.length && loop) cs = store.project.playlist.clips.filter((c) => c.start >= loop.start && c.start < loop.end);
    if (!cs.length) {
      toast('Select clips (or make a time selection) to duplicate', 'info', 1500);
      return;
    }
    let span: number;
    let newLoop: { start: number; end: number } | null = null;
    if (loop && loop.end > loop.start && cs.every((c) => c.start >= loop.start && c.start < loop.end)) {
      span = loop.end - loop.start;
      newLoop = { start: loop.end, end: loop.end + span };
    } else {
      const ext = extent(cs)!;
      const e = ext.end - ext.start;
      const bar = store.barTicks, beat = (PPQ * 4) / store.project.timeSig[1];
      const unit = e >= bar ? bar : e >= beat ? beat : STEP;
      span = Math.max(unit, Math.ceil(e / unit - 1e-6) * unit);
    }
    const ids: ID[] = [];
    const gmap = new Map<string, string>();
    store.commit('Duplicate clips', (p) => {
      for (const c of cs) {
        const nc: Clip = { ...c, id: uid('k'), start: c.start + span };
        if (c.group) {
          if (!gmap.has(c.group)) gmap.set(c.group, uid('g'));
          nc.group = gmap.get(c.group);
        }
        ids.push(nc.id);
        p.playlist.clips.push(nc);
      }
    });
    setSel(ids);
    if (newLoop) store.setUI({ loop: newLoop });
    ensureVisible(extent(selectedClips()));
  }
  function ensureVisible(r: { start: number; end: number } | null) {
    if (!r) return;
    const a = r.start * v.ppt, b = r.end * v.ppt;
    const sl = scroll.scrollLeft;
    if (b > sl + v.w || a < sl) scroll.scrollLeft = Math.max(0, Math.min(a - 24, b - v.w + 24 > a ? a - 24 : b - v.w + 24));
  }
  function selectTime(dir: -1 | 1) {
    const loop = store.ui.loop;
    let r: { start: number; end: number };
    if (loop && loop.end > loop.start) r = loop;
    else r = extent(selectedClips()) ?? { start: engine.songStart, end: engine.songStart + store.barTicks };
    const len = r.end - r.start;
    if (len <= 0) return;
    const nr = dir < 0 ? { start: Math.max(0, r.start - len), end: r.start } : { start: r.end, end: r.end + len };
    if (nr.end <= nr.start) return;
    store.setUI({ loop: nr });
    selectInRange(nr);
    ensureVisible(nr);
  }
  function deleteSel() {
    if (!sel.size) return;
    const ids = new Set(sel);
    store.commit(ids.size > 1 ? 'Delete clips' : 'Delete clip', (p) => (p.playlist.clips = p.playlist.clips.filter((c) => !ids.has(c.id))));
    setSel([]);
  }
  function sliceAtPosition() {
    const t = Math.round(focusTick());
    const crossing = (c: Clip) => c.start < t && c.start + c.len > t;
    const selCross = selectedClips().filter(crossing);
    const ids = new Set(selCross.map((c) => c.id));
    const n = sliceAt(t, selCross.length ? (c) => ids.has(c.id) : crossing, 'Slice at song position');
    if (!n) toast('No clips under the song position', 'info', 1200);
  }
  function quantize() {
    const g = grid() || STEP;
    const ids = sel.size ? new Set(sel) : null;
    store.commit('Quick quantize clips', (p) => {
      for (const c of p.playlist.clips) if (!ids || ids.has(c.id)) c.start = Math.max(0, snapRound(c.start, g));
    });
  }
  function group() {
    if (sel.size < 2) {
      toast('Select two or more clips to group', 'info', 1400);
      return;
    }
    const gid = uid('g');
    const ids = new Set(sel);
    store.commit('Group clips', (p) => p.playlist.clips.forEach((c) => ids.has(c.id) && (c.group = gid)));
    toast(`Grouped ${ids.size} clips`, 'ok', 1000);
  }
  function ungroup() {
    const ids = new Set(sel);
    store.commit('Ungroup clips', (p) => p.playlist.clips.forEach((c) => ids.has(c.id) && delete c.group));
  }
  function muteSel() {
    const cs = selectedClips();
    if (!cs.length) return;
    const mute = cs.some((c) => !c.muted);
    const ids = new Set(sel);
    store.commit(mute ? 'Mute clips' : 'Unmute clips', (p) =>
      p.playlist.clips.forEach((c) => {
        if (!ids.has(c.id)) return;
        if (mute) c.muted = true;
        else delete c.muted;
      }),
    );
  }
  function makeUnique() {
    const cs = selectedClips().filter((c) => c.kind === 'pattern');
    if (!cs.length) {
      toast('Select pattern clips to make unique', 'info', 1400);
      return;
    }
    let lastId = '';
    store.commit('Make unique', (p) => {
      const byPat = new Map<ID, Clip[]>();
      for (const c of p.playlist.clips) if (sel.has(c.id) && c.kind === 'pattern') (byPat.get(c.ref) ?? byPat.set(c.ref, []).get(c.ref)!).push(c);
      for (const [pid, clips] of byPat) {
        const src = p.patterns.find((x) => x.id === pid);
        if (!src) continue;
        const np = deepClone(src);
        np.id = uid('p');
        np.name = src.name + ' #' + (p.patterns.filter((x) => x.name.startsWith(src.name)).length + 1);
        for (const a of Object.values(np.notes)) for (const n of a) n.id = uid('n');
        p.patterns.splice(p.patterns.indexOf(src) + 1, 0, np);
        for (const c of clips) c.ref = np.id;
        lastId = np.id;
      }
    });
    if (lastId) selectPattern(lastId);
  }
  function toggleFollow() {
    follow = !follow;
    followBtn.classList.toggle('on', follow);
    savePrefs();
  }
  function togglePicker() {
    pickerOn = !pickerOn;
    root.classList.toggle('no-picker', !pickerOn);
    pickerBtn.classList.toggle('on', pickerOn);
    savePrefs();
    if (pickerOn) picker.sync(true);
    invalidate(F_ALL);
  }
  function toolMenu(x: number, y: number) {
    showMenu(
      TOOLS.map((t) => ({ label: t.label, shortcut: t.key, checked: store.ui.plTool === t.id, action: () => store.setUI({ plTool: t.id }) })),
      x,
      y,
    );
  }
  function sourceMenu(): MenuItem[] {
    const p = store.project;
    const cur = currentSource();
    const it = (kind: ClipKind, ref: ID, label: string, color: string): MenuItem => ({ label, color, checked: !!cur && cur.kind === kind && cur.ref === ref, action: () => setSource(kind, ref) });
    const items: MenuItem[] = p.patterns.map((pt, i) => it('pattern', pt.id, `${i + 1}. ${pt.name}`, pt.color));
    const audio = p.channels.filter((c) => c.audioClip);
    if (audio.length) items.push({ sep: true }, ...audio.map((c) => it('audio', c.id, c.name, c.color)));
    if (p.automations.length) items.push({ sep: true }, ...p.automations.map((a) => it('automation', a.id, a.name, a.color)));
    return items;
  }
  function mainMenu(): MenuItem[] {
    return [
      {
        label: 'Edit',
        submenu: [
          { cmd: 'pl.selectAll' },
          { cmd: 'pl.deselect' },
          { sep: true },
          { cmd: 'pl.cut' },
          { cmd: 'pl.copy' },
          { cmd: 'pl.paste' },
          { cmd: 'pl.duplicate' },
          { cmd: 'pl.delete' },
          { sep: true },
          { cmd: 'pl.sliceAtPos' },
          { cmd: 'pl.quantize' },
          { cmd: 'pl.muteSel' },
          { cmd: 'pl.group' },
          { cmd: 'pl.ungroup' },
          { cmd: 'pl.makeUnique' },
        ],
      },
      { label: 'Tools', submenu: TOOLS.map((t) => ({ cmd: 'pl.tool.' + t.id })) },
      {
        label: 'Time selection',
        submenu: [{ cmd: 'pl.selPrev' }, { cmd: 'pl.selNext' }, { cmd: 'pl.selectSong' }, { cmd: 'pl.clearTime' }],
      },
      {
        label: 'View',
        submenu: [
          { cmd: 'pl.zoomIn' },
          { cmd: 'pl.zoomOut' },
          { cmd: 'pl.zoom1' },
          { cmd: 'pl.zoom2' },
          { cmd: 'pl.zoom3' },
          { cmd: 'pl.zoom4' },
          { cmd: 'pl.center' },
          { sep: true },
          { cmd: 'pl.follow' },
          { cmd: 'pl.picker' },
          { label: 'Reset track heights zoom', action: () => setVZoom(DEFAULT_VZ, 0) },
        ],
      },
      {
        label: 'Tracks',
        submenu: [{ cmd: 'pl.addTrack' }, { label: 'Unmute all tracks', action: () => store.commit('Unmute all tracks', (p) => p.playlist.tracks.forEach((t) => (t.mute = false))) }],
      },
      { sep: true },
      { cmd: 'pl.home' },
    ];
  }

  if (!registered) {
    registered = true;
    const C = (id: string, label: string, keys: string[], run: () => void, extra: Partial<Command> = {}): Command => ({ id, label, category: 'Playlist', ctx: 'playlist', keys, run, ...extra });
    commands.register([
      ...TOOLS.map((t) => C('pl.tool.' + t.id, `${t.label} tool`, [t.key], () => store.setUI({ plTool: t.id }), { checked: () => store.ui.plTool === t.id })),
      C('pl.selectAll', 'Select all clips', ['Ctrl+A'], selectAll),
      C('pl.deselect', 'Deselect all', ['Ctrl+D'], deselect),
      C('pl.copy', 'Copy clips', ['Ctrl+C'], () => void copy()),
      C('pl.cut', 'Cut clips', ['Ctrl+X'], cut),
      C('pl.paste', 'Paste clips at song position', ['Ctrl+V'], paste),
      C('pl.duplicate', 'Duplicate selection', ['Ctrl+B'], duplicate),
      C('pl.selPrev', 'Select time before', ['Ctrl+Left'], () => selectTime(-1), { repeat: true }),
      C('pl.selNext', 'Select time after', ['Ctrl+Right'], () => selectTime(1), { repeat: true }),
      C('pl.selectSong', 'Select whole song', [], () => {
        store.setUI({ loop: { start: 0, end: store.songLength() } });
        selectAll();
      }),
      C('pl.clearTime', 'Clear time selection', [], () => store.setUI({ loop: null })),
      C('pl.delete', 'Delete selected clips', ['Del'], deleteSel),
      C('pl.home', 'Song position to start', ['Home'], () => {
        engine.setPosition(0);
        scroll.scrollLeft = 0;
      }),
      C('pl.sliceAtPos', 'Slice clips at song position', ['Ins'], sliceAtPosition),
      C('pl.center', 'Center on playhead', ['Shift+0'], () => centerOn(focusTick())),
      C('pl.zoom1', 'Zoom level 1 (close)', ['Shift+1'], () => zoomLevel(1)),
      C('pl.zoom2', 'Zoom level 2', ['Shift+2'], () => zoomLevel(2)),
      C('pl.zoom3', 'Zoom level 3 (wide)', ['Shift+3'], () => zoomLevel(3)),
      C('pl.zoom4', 'Zoom to fit song', ['Shift+4'], () => zoomLevel(4)),
      C('pl.zoomIn', 'Zoom in', ['PageUp'], () => zoomAt(v.ppt * 1.25, anchorX()), { repeat: true }),
      C('pl.zoomOut', 'Zoom out', ['PageDown'], () => zoomAt(v.ppt / 1.25, anchorX()), { repeat: true }),
      C('pl.quantize', 'Quick quantize clip starts', ['Shift+Q'], quantize),
      C('pl.group', 'Group selected clips', ['Shift+G'], group),
      C('pl.ungroup', 'Ungroup selected clips', ['Alt+G'], ungroup),
      C('pl.muteSel', 'Toggle mute of selected clips', ['Alt+M'], muteSel),
      C('pl.makeUnique', 'Make unique (clone the pattern of selected clips)', [], makeUnique),
      C('pl.toolMenu', 'Playlist tool menu', ['F3'], () => toolMenu(mouse.x, mouse.y)),
      C('pl.addTrack', 'Add playlist track', [], () => addPlaylistTrack()),
      C('pl.follow', 'Follow playhead', [], toggleFollow, { checked: () => follow }),
      C('pl.picker', 'Show clip picker', [], togglePicker, { checked: () => pickerOn }),
    ]);
  }
  function anchorX() {
    const x = focusTick() * v.ppt - scroll.scrollLeft;
    return x >= 0 && x <= v.w ? x : v.w / 2;
  }

  // =========================================================================
  // store / engine wiring
  // =========================================================================
  store.on('project', () => refresh());
  store.on('loaded', () => {
    sel.clear();
    updateSelInfo();
    clearPreviewCaches();
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
    picker.sync(true);
    refresh();
  });
  store.on('ui', (keys) => {
    if (keys.includes('plTool')) {
      updateTools();
      lastCursor = '';
    }
    if (keys.includes('snap') && snapSel.value !== store.ui.snap) snapSel.value = store.ui.snap;
    if (keys.includes('loop')) {
      updateSpacer();
      invalidate(F_MAIN | F_RULER);
    }
    if (keys.includes('currentPattern') || keys.includes('plSource')) {
      picker.sync();
      updateSource();
      updateTitle();
    }
    if (keys.includes('songMode')) invalidate(F_OV | F_RULER);
  });
  engine.on('state', () => invalidate(F_OV | F_RULER));
  samples.on('loaded', () => {
    picker.sync();
    invalidate(F_MAIN | F_MAP);
  });
  window.addEventListener('pointermove', (e) => (mouse = { x: e.clientX, y: e.clientY }), { passive: true });

  const ro = new ResizeObserver(() => {
    if (measure()) invalidate(F_ALL);
  });
  ro.observe(viewEl);

  updateTools();
  if (store.project) refresh();
  // debug / test handle: client coordinates of a tick / track centre, the selection
  Object.defineProperty(root, '__pl', {
    value: {
      view: v,
      sel,
      x: (tick: number) => scroll.getBoundingClientRect().left + tick * v.ppt - scroll.scrollLeft,
      y: (track: number) => scroll.getBoundingClientRect().top + trackTop(v, track) - scroll.scrollTop + trackHeight(v, track) / 2,
      titleY: (track: number) => scroll.getBoundingClientRect().top + trackTop(v, track) - scroll.scrollTop + 7,
    },
  });

  return {
    body: root,
    headerExtra: bar,
    onShow: () => {
      measure();
      refresh();
      updateTitle();
    },
    onResize: () => {
      if (measure()) invalidate(F_ALL);
    },
  };
}
