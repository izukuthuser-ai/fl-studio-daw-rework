// Browser (Alt+F8), laid out like FL Studio 21's: tab bar (ALL · PROJECT · PLUGINS · LIBRARY · SOUNDS ·
// STARRED), a colour-coded tree with indent guides and plugin thumbnails, an info panel (title / type /
// size / path + waveform) and the TAGS search bar at the bottom. Rows are virtualised (variable height
// because of thumbnails) and keyed by node, so the row under the mouse and the row being dragged
// survive every re-render. The tree is rebuilt only when what it shows changes.
import './browser.css';
import { store } from '../core/store';
import { Command, commands } from '../core/commands';
import { engine } from '../audio/engine';
import { samples } from '../audio/samples';
import { BUILTIN_BY_ID } from '../audio/sounds';
import { SYNTH_PRESETS, synthPreset } from '../core/project';
import { FX_DEFS, FX_ORDER } from '../core/params';
import { AudioListing, basename, isElectron, native } from '../core/native';
import { clamp, deepClone, el, fuzzyScore } from '../core/util';
import type { FxType, ID } from '../core/types';
import { allInstruments } from '../audio/plugins/registry';
import { ICONS } from './icons';
import { MenuItem, iconBtn, showMenu, toast } from './widgets';
import { addChannel, addFx, describeTarget } from './ops';
import { DT_FX, DT_PATTERN, DT_PLUGIN, DT_PRESET, DT_SAMPLE, DragSample, hasType, pickSamples, samplesFromDrop, setDragData } from './dnd';
import { clonePattern, deletePattern, patternColor, renamePattern, selectPattern } from './actions';
import { openFxWindow, openPluginWindow } from './pluginWindow';
import { wm } from './wm';
import { BI, BR, CAT_COLOR, SAMPLER_COLOR } from './browser-icons';
import { Preview, drawPreview, synthCurve } from './browser-draw';
import { effectThumb, instrumentThumb, THUMB_H } from './browser-thumbs';
import { BNode, DEFAULT_OPEN, LEAF, TABS, Tab, Tree, TreeEnv, buildTab, coll, instInfo, pluginPresets, stripExt, walk } from './browser-tree';
import type { PanelDef } from './panel';

const RH = 22; // row height (px) — keep in sync with --br-rh in browser.css
const IND = 14; // indent per depth level (px)
const OVERSCAN = 6;
const MAX_RESULTS = 500;
const TAGS = ['Kick', 'Snare', 'Clap', 'Hat', '808', 'Perc', 'Cymbal', 'FX', 'Synth', 'Bass', 'Lead', 'Pad', 'Pluck', 'Reverb', 'Delay', 'Distortion', 'EQ'];

type RowEl = HTMLDivElement & { _sig?: string };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
function fmtDur(sec: number) {
  if (sec < 1) return Math.round(sec * 1000) + ' ms';
  if (sec < 60) return sec.toFixed(2) + ' s';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} min`;
}
function fmtBytes(b: number) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

// ---------- guarded storage ----------
function loadList(key: string, def: string[] = []): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [...def];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [...def];
  } catch {
    return [...def];
  }
}
function saveList(key: string, v: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}
function loadStr(key: string, def: string) {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}
function saveStr(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {}
}

// ---------- keyboard commands (ctx 'browser') ----------
interface BrowserApi {
  move(d: 1 | -1, preview: boolean): void;
  left(): void;
  right(): void;
  enter(): void;
  addSel(): void;
  favSel(): void;
  focusSearch(): void;
  clearSearch(): void;
  searching(): boolean;
  tab(d: 1 | -1): void;
}
let api: BrowserApi | null = null;
let registered = false;
function registerCommands() {
  if (registered) return;
  registered = true;
  const c = (id: string, label: string, keys: string[], run: () => void, repeat = false): Command => ({ id, label, category: 'Browser', ctx: 'browser', keys, run, repeat });
  commands.register([
    c('browser.up', 'Select previous item', ['Up'], () => api?.move(-1, false), true),
    c('browser.down', 'Select next item', ['Down'], () => api?.move(1, false), true),
    c('browser.upPreview', 'Previous item and preview it', ['Shift+Up'], () => api?.move(-1, true), true),
    c('browser.downPreview', 'Next item and preview it', ['Shift+Down'], () => api?.move(1, true), true),
    c('browser.collapse', 'Collapse folder / go to parent', ['Left'], () => api?.left(), true),
    c('browser.expand', 'Expand folder / go to first item', ['Right'], () => api?.right(), true),
    c('browser.enter', "Replace selected channel's sample / apply preset / add plugin", ['Enter'], () => api?.enter()),
    c('browser.addChannel', 'Open selected item in a new channel', ['Shift+Enter'], () => api?.addSel()),
    c('browser.search', 'Search the browser', ['Ctrl+F'], () => api?.focusSearch()),
    { ...c('browser.clearSearch', 'Clear browser search', ['Esc'], () => api?.clearSearch()), enabled: () => !!api?.searching(), hidden: true },
    c('browser.favorite', 'Star / unstar item', [], () => api?.favSel()),
    c('browser.nextTab', 'Next browser tab', ['Ctrl+Right'], () => api?.tab(1)),
    c('browser.prevTab', 'Previous browser tab', ['Ctrl+Left'], () => api?.tab(-1)),
  ]);
}

export function createBrowser(): PanelDef {
  // ================= state =================
  const favs = loadList('lf.favs');
  let favSet = new Set(favs);
  const folders = isElectron ? loadList('lf.folders') : [];
  const listings = new Map<string, { loading: boolean; files: AudioListing[] }>();
  const picked: DragSample[] = []; // web build: files added this session
  const dropped: DragSample[] = [];
  const names = new Map<string, string>(); // ref -> display name for session sounds
  let tab: Tab = (TABS.some((t) => t.id === loadStr('lf.browser.tab', 'all')) ? loadStr('lf.browser.tab', 'all') : 'all') as Tab;
  let thumbs = loadStr('lf.browser.thumbs', '1') !== '0';
  const openSets = new Map<Tab, Set<string>>();
  const openOf = (t: Tab) => {
    let s = openSets.get(t);
    if (!s) {
      // the old single open-set carries over to the ALL tab
      const legacy = t === 'all' ? loadList('lf.browser.open', []) : [];
      s = new Set(loadList('lf.browser.open.' + t, [...DEFAULT_OPEN[t], ...legacy.filter((k) => !k.startsWith('sec:'))]));
      openSets.set(t, s);
    }
    return s;
  };
  let tree: Tree = new Tree();
  let rows: BNode[] = [];
  let tops: number[] = [0];
  let query = '';
  let selKey: string | null = null;
  let projSig = '';
  let regSig = '';
  let dragRow: RowEl | null = null;
  let rowEls = new Map<string, RowEl>();
  let raf = 0;
  const visible = () => !!wm?.get('browser')?.visible;

  // ================= DOM =================
  const tabBtns = new Map<Tab, HTMLElement>();
  const tabBar = el('div', { class: 'br-tabs' });
  for (const t of TABS) {
    const b = el('button', { class: 'br-tab', 'data-hint': `${t.label} — ${t.hint}` }, el('span', { class: 'br-tab-full', text: t.label }), el('span', { class: 'br-tab-short', text: t.short }));
    b.addEventListener('click', () => setTab(t.id));
    tabBtns.set(t.id, b);
    tabBar.append(b);
  }
  const spacer = el('div', { class: 'br-spacer' });
  const layer = el('div', { class: 'br-layer' });
  const emptyMsg = el('div', { class: 'br-empty' });
  const list = el('div', { class: 'br-list', tabindex: '-1', 'data-hint': 'Click = select / preview · double-click = add · drag onto the Channel rack, Playlist or Mixer · right-click for more' }, spacer, layer, emptyMsg);
  const status = el('div', { class: 'br-status' });

  // info panel
  const infoRows = el('div', { class: 'br-info-rows' });
  const infoMark = el('span', { class: 'br-info-mark' });
  const wave = el('canvas', { class: 'br-wave', 'data-hint': 'Click the waveform to preview the selected sound again' }) as HTMLCanvasElement;
  const infoThumb = el('img', { class: 'br-info-thumb', alt: '', draggable: false }) as HTMLImageElement;
  const info = el('div', { class: 'br-info idle' }, infoMark, infoRows, el('div', { class: 'br-info-view' }, wave, infoThumb));

  // TAGS search bar
  const input = el('input', {
    class: 'br-q',
    type: 'text',
    placeholder: 'Search',
    spellcheck: false,
    'data-hint': 'Fuzzy search in the current tab (Ctrl+F) — ↑/↓ pick a result, Enter previews / selects, Shift+Enter adds, Esc clears',
  }) as HTMLInputElement;
  const clearBtn = el('button', { class: 'br-clear', html: ICONS.close, 'data-hint': 'Clear search (Esc)' });
  const tagsBtn = el('button', { class: 'br-tags', text: 'TAGS', 'data-hint': 'Filter by tag — pick a keyword to search for' });
  const folderBtn = el('button', { class: 'br-sbtn', html: BI.folderSmall, 'data-hint': isElectron ? 'Add a folder of sounds to the browser' : 'Add audio files to the browser (kept for this session)' });
  const findBtn = el('button', { class: 'br-sbtn find', html: BI.search, 'data-hint': 'Search the browser (Ctrl+F)' });
  const tagsBar = el('div', { class: 'br-tagsbar' }, tagsBtn, el('div', { class: 'br-search' }, input, clearBtn, folderBtn, findBtn));
  const root = el('div', { class: 'browser' }, tabBar, list, status, info, tagsBar);

  // ================= helpers =================
  function sampleName(ref: string) {
    return names.get(ref) ?? stripExt(samples.displayName(ref));
  }
  function sampleColor(ref: string) {
    const b = ref.startsWith('builtin:') ? BUILTIN_BY_ID.get(ref.slice(8)) : undefined;
    return b ? CAT_COLOR[b.category] : SAMPLER_COLOR;
  }
  function sourceOf(ref: string) {
    if (ref.startsWith('builtin:')) return BUILTIN_BY_ID.get(ref.slice(8))?.category ?? 'Built-in';
    if (ref.startsWith('file:')) return basename(ref.slice(5).replace(/[\\/][^\\/]*$/, '')) || 'File';
    return 'Session';
  }
  function resolvable(ref: string) {
    if (ref.startsWith('builtin:')) return BUILTIN_BY_ID.has(ref.slice(8));
    if (ref.startsWith('file:')) return isElectron;
    if (ref.startsWith('embed:')) return samples.embedded.has(ref);
    return false;
  }
  const env: TreeEnv = {
    get favs() {
      return favs;
    },
    get folders() {
      return folders;
    },
    listings,
    picked,
    dropped,
    sampleName,
    sampleColor,
    sourceOf,
    resolvable,
    addFolder: () => void addFolder(),
    addFiles: () => void addFiles(),
  };

  // ================= tree =================
  function rebuild() {
    tree = buildTab(tab, env, thumbs);
    if (selKey && !tree.byKey.has(selKey)) selKey = null;
    flatten();
    render();
  }
  const cur = () => (selKey ? tree.byKey.get(selKey) : undefined);
  const open = () => openOf(tab);
  const persistOpen = () => saveList('lf.browser.open.' + tab, [...open()]);

  function identity(n: BNode) {
    switch (n.kind) {
      case 'sample':
        return 's:' + n.ref;
      case 'preset':
        return 'p:' + n.preset;
      case 'plugpreset':
        return `pp:${n.plugin}:${n.preset}`;
      case 'plugin':
        return 'pl:' + n.plugin;
      case 'fx':
        return 'fx:' + n.fx;
      default:
        return n.key;
    }
  }
  function searchRows(t: Tree, q: string): BNode[] {
    const ql = q.toLowerCase();
    const hits: { n: BNode; s: number }[] = [];
    const seen = new Set<string>();
    const consider = (n: BNode) => {
      if (!LEAF.has(n.kind)) return;
      const ident = identity(n);
      if (seen.has(ident)) return;
      let s = fuzzyScore(q, n.label);
      const ctx = (n.where ?? '') + ' ' + (n.info ?? '');
      const i = ctx.toLowerCase().indexOf(ql);
      if (i >= 0) s = Math.max(s, 480 - i);
      if (s < 0) return;
      if (n.kind === 'channel' || n.kind === 'pattern' || n.kind === 'automation' || n.kind === 'mixfx') s -= 5;
      seen.add(ident);
      hits.push({ n, s });
    };
    // starred entries last, so an item that also lives elsewhere shows up once under its real home
    for (const r of t.roots) if (r.key !== 'sec:starred') walk(r, consider);
    for (const r of t.roots) if (r.key === 'sec:starred') walk(r, consider);
    hits.sort((a, b) => b.s - a.s || coll.compare(a.n.label, b.n.label));
    return hits.slice(0, MAX_RESULTS).map((h) => h.n);
  }
  const hasThumb = (n: BNode) => thumbs && !!n.thumb && !query;
  const rowH = (n: BNode) => (hasThumb(n) ? RH + THUMB_H + 6 : RH);

  let otherTabHits = 0;
  function flatten() {
    let out: BNode[];
    if (query) {
      out = searchRows(tree, query);
      otherTabHits = 0;
      if (!out.length && tab !== 'all') otherTabHits = searchRows(buildTab('all', env, false), query).length;
      const label = TABS.find((t) => t.id === tab)!.label;
      status.textContent = out.length
        ? `${out.length >= MAX_RESULTS ? MAX_RESULTS + '+' : out.length} ${out.length === 1 ? 'result' : 'results'} in ${label} · Esc clears`
        : `No matches in ${label} · Esc clears`;
    } else {
      out = [];
      const o = open();
      const visit = (n: BNode) => {
        out.push(n);
        if (n.children && o.has(n.key)) for (const c of n.children) visit(c);
      };
      for (const r of tree.roots) visit(r);
    }
    rows = out;
    tops = new Array(rows.length + 1);
    tops[0] = 0;
    for (let i = 0; i < rows.length; i++) tops[i + 1] = tops[i] + rowH(rows[i]);
  }
  /** Index of the row containing y. */
  function rowAt(y: number) {
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // ================= rendering (virtualised, keyed rows) =================
  function favRef(n: BNode | undefined): string | null {
    if (!n) return null;
    switch (n.kind) {
      case 'sample':
        return n.ref ?? null;
      case 'preset':
        return 'preset:' + n.preset;
      case 'plugpreset':
        return `plugpreset:${n.plugin}:${n.preset}`;
      case 'plugin':
        return 'plugin:' + n.plugin;
      case 'fx':
        return 'fx:' + n.fx;
      default:
        return null;
    }
  }
  const isFav = (n: BNode) => {
    const r = favRef(n);
    return !!r && favSet.has(r);
  };
  function isCurrent(n: BNode) {
    const ui = store.ui;
    if (n.kind === 'pattern') return n.id === ui.currentPattern;
    if (n.kind === 'channel') return ui.selectedChannels.includes(n.id!);
    if (n.kind === 'automation') return ui.plSource?.kind === 'automation' && ui.plSource.ref === n.id;
    if (n.kind === 'mixfx') return n.track === ui.selectedMixer;
    return false;
  }
  function hintFor(n: BNode): string {
    switch (n.kind) {
      case 'sample':
        return `${n.label} — click previews · double-click adds a Sampler channel · drag onto the Channel rack or Playlist · Enter loads it into the selected channel`;
      case 'preset':
        return `${n.label} (Tri-Osc Synth preset) — double-click adds a synth channel · drag onto the Channel rack · Enter applies it to the selected synth`;
      case 'plugpreset':
        return `${n.label} (${instInfo(n.plugin)?.name ?? 'plugin'} preset) — double-click adds the instrument with this preset · Enter applies it to the selected channel`;
      case 'plugin':
        return `${n.label} — ${n.info ?? 'instrument'}. Double-click (or Enter) adds it to the Channel rack · drag onto the Channel rack`;
      case 'fx':
        return `${n.label} — ${n.info ?? 'effect'}. Double-click (or Enter) adds it to the selected mixer track · drag onto a mixer strip or slot`;
      case 'folder':
        return n.root && n.key === 'uf|' + n.root ? `${n.root} — right-click to refresh or remove` : `${n.label} — click to open / close (← →)`;
      case 'channel':
        return `${n.label} — click selects · double-click opens its instrument window`;
      case 'pattern':
        return `${n.label} — click selects · drag onto the Playlist · double-click shows the Channel rack`;
      case 'automation':
        return `${n.label} — click to use as the Playlist's clip source`;
      case 'mixfx':
        return `${n.label} on ${n.meta} — click selects the mixer track · double-click opens the effect`;
      case 'recent':
        return `${n.path} — double-click (or Enter) opens it`;
      case 'action':
        return n.label;
      default:
        return '';
    }
  }

  function paintRow(r: RowEl, n: BNode, i: number) {
    const flat = !!query;
    const isOpen = !flat && !!n.children && open().has(n.key);
    const fav = isFav(n);
    const meta = flat ? n.where ?? '' : n.meta ?? '';
    const depth = flat ? 0 : n.depth;
    const th = hasThumb(n);
    const bg = n.kind === 'folder' ? (isOpen ? 'open' : 'closed') : 'leaf';
    const sig = [n.kind, n.label, meta, depth, isOpen, fav, n.color, n.tint, flat, th, n.icon?.length, bg].join('\u0001');
    r.style.top = tops[i] + 'px';
    r.style.height = tops[i + 1] - tops[i] + 'px';
    if (r.dataset.key !== n.key) r.dataset.key = n.key;
    if (r._sig !== sig) {
      r._sig = sig;
      r.className = `br-row k-${n.kind} bg-${bg}${depth === 0 ? ' top' : ''}${flat ? ' flat' : ''}${th ? ' has-thumb' : ''}`;
      r.textContent = '';
      const line = el('div', { class: 'br-line' });
      line.style.paddingLeft = 4 + depth * IND + 'px';
      if (depth > 0) {
        const g = el('span', { class: 'br-guides' });
        g.style.width = depth * IND + 'px';
        line.append(g);
      }
      const ic = el('span', { class: 'br-ic' });
      if (n.kind === 'pattern') ic.append(el('span', { class: 'br-swatch' }));
      else if (n.kind === 'folder' && !n.icon) ic.innerHTML = isOpen ? BI.folderOpen : BI.folder;
      else if (n.kind === 'sample') ic.innerHTML = BR.sample;
      else ic.innerHTML = n.icon ?? '';
      if (n.color) ic.style.setProperty('--c', n.color);
      const lab = el('span', { class: 'br-label', text: n.label });
      if (n.tint) lab.style.color = n.tint;
      line.append(ic, lab);
      if (meta) line.append(el('span', { class: 'br-meta', text: meta }));
      if (favRef(n)) line.append(el('span', { class: 'br-star' + (fav ? ' on' : ''), html: fav ? ICONS.starFill : ICONS.star, 'data-hint': fav ? 'Unstar' : 'Star — collect it under STARRED' }));
      if (n.kind === 'folder') line.append(el('span', { class: 'br-arrow', html: isOpen ? BI.caretDown : BI.caretRight }));
      r.append(line);
      if (th) {
        const t = n.kind === 'fx' ? effectThumb(n.fx!, n.color ?? '#9fb2c2') : instrumentThumb(n.plugin!, n.color ?? '#9fb2c2');
        const img = el('img', { class: 'br-thumb', src: t.url, width: t.w, height: t.h, alt: '', draggable: false }) as HTMLImageElement;
        img.style.marginLeft = 4 + depth * IND + 22 + 'px';
        r.append(img);
      }
      r.draggable = ['sample', 'preset', 'plugpreset', 'plugin', 'fx', 'pattern'].includes(n.kind);
      r.dataset.hint = hintFor(n);
    }
    r.classList.toggle('sel', n.key === selKey);
    r.classList.toggle('cur', isCurrent(n));
  }

  function render() {
    if (!visible()) return;
    const n = rows.length;
    spacer.style.height = tops[n] + 'px';
    const h = list.clientHeight || 600;
    const st = list.scrollTop;
    const i0 = n ? Math.max(0, rowAt(st) - OVERSCAN) : 0;
    const i1 = n ? Math.min(n, rowAt(st + h) + 1 + OVERSCAN) : 0;
    const next = new Map<string, RowEl>();
    for (let i = i0; i < i1; i++) {
      const node = rows[i];
      let r = rowEls.get(node.key);
      if (r) rowEls.delete(node.key);
      else {
        r = el('div', { class: 'br-row' }) as RowEl;
        layer.append(r);
      }
      r.classList.remove('br-gone');
      paintRow(r, node, i);
      next.set(node.key, r);
    }
    for (const [k, r] of rowEls) {
      if (r === dragRow) {
        // the drag source must stay in the document until the drag ends
        r.classList.add('br-gone');
        next.set(k, r);
      } else r.remove();
    }
    rowEls = next;
    let msg = '';
    if (query && !n) msg = otherTabHits ? '' : `Nothing matches “${query}”`;
    else if (!query && !n) msg = 'Nothing here yet';
    emptyMsg.textContent = msg;
    emptyMsg.style.display = msg ? '' : 'none';
    if (query && !n && otherTabHits) {
      emptyMsg.style.display = '';
      emptyMsg.textContent = '';
      emptyMsg.append(
        el('div', { text: `Nothing in ${TABS.find((t) => t.id === tab)!.label}.` }),
        el('button', { class: 'br-alltabs', text: `Show ${otherTabHits} ${otherTabHits === 1 ? 'match' : 'matches'} in ALL`, onclick: () => setTab('all') }),
      );
    }
  }
  function renderSoon() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }
  function ensureVisible(i: number) {
    if (i < 0 || i >= rows.length) return;
    const h = list.clientHeight;
    if (tops[i] < list.scrollTop) list.scrollTop = tops[i];
    else if (tops[i + 1] > list.scrollTop + h) list.scrollTop = tops[i + 1] - h;
  }

  // ================= tabs =================
  function paintTabs() {
    for (const [id, b] of tabBtns) b.classList.toggle('on', id === tab);
  }
  function setTab(t: Tab) {
    if (t === tab && tree.roots.length) {
      rebuild(); // clicking the active tab refreshes it (e.g. presets saved from a plugin window)
      return;
    }
    tab = t;
    saveStr('lf.browser.tab', t);
    paintTabs();
    const keepSel = selKey;
    tree = buildTab(tab, env, thumbs);
    selKey = keepSel && tree.byKey.has(keepSel) ? keepSel : null;
    flatten();
    list.scrollTop = 0;
    render();
    if (selKey) requestAnimationFrame(() => ensureVisible(rows.findIndex((r) => r.key === selKey)));
    else void showInfo(undefined);
  }
  /** Full labels when they fit, then a tighter type size, then short labels. */
  function fitTabs() {
    const over = () => tabBar.scrollWidth > tabBar.clientWidth + 1;
    root.classList.remove('br-narrow', 'br-compact');
    if (!over()) return;
    root.classList.add('br-compact');
    if (!over()) return;
    root.classList.remove('br-compact');
    root.classList.add('br-narrow');
  }

  // ================= selection / open state =================
  function select(n: BNode | undefined, scroll = false) {
    if (!n) return;
    const changed = selKey !== n.key;
    selKey = n.key;
    if (scroll) ensureVisible(rows.indexOf(n));
    render();
    if (changed) void showInfo(n);
  }
  /** If the selected node is hidden inside a closed folder, select that folder instead. */
  function revealSel() {
    const n = cur();
    if (!n || query) return;
    const chain: BNode[] = [];
    for (let p = n.parent; p; p = p.parent) chain.unshift(p);
    for (const a of chain)
      if (!open().has(a.key)) {
        selKey = a.key;
        void showInfo(a);
        return;
      }
  }
  function setOpen(n: BNode, on: boolean) {
    if (!n.children) return;
    if (on) open().add(n.key);
    else open().delete(n.key);
    revealSel();
    persistOpen();
    flatten();
    render();
  }
  const toggle = (n: BNode) => setOpen(n, !open().has(n.key));
  function setOpenDeep(n: BNode, on: boolean) {
    walk(n, (c) => {
      if (!c.children || c === n) return;
      if (on) open().add(c.key);
      else open().delete(c.key);
    });
    if (on) open().add(n.key);
    revealSel();
    persistOpen();
    flatten();
    render();
  }
  function collapseAll() {
    open().clear();
    revealSel();
    persistOpen();
    flatten();
    render();
    ensureVisible(rows.findIndex((r) => r.key === selKey));
  }
  /** Open every ancestor of `n` and select it. */
  function reveal(n: BNode) {
    if (query) {
      input.value = '';
      onQuery();
    }
    for (let p = n.parent; p; p = p.parent) open().add(p.key);
    persistOpen();
    flatten();
    select(n);
    requestAnimationFrame(() => {
      const i = rows.indexOf(n);
      if (i >= 0) list.scrollTop = Math.max(0, tops[i] - list.clientHeight / 3);
      render();
    });
  }

  // ================= actions =================
  async function preview(n: BNode) {
    if (!n.ref) return;
    try {
      await engine.previewSample(n.ref);
    } catch {}
    if (samples.isMissing(n.ref)) toast(`Couldn't load “${n.label}” — the file is missing or unreadable`, 'warn');
  }
  function addSampleChannel(ref: string, name: string) {
    // one undo step: the shared factory leaves sampleName empty for non-built-in sounds
    store.begin('Add channel');
    const id = addChannel('sampler', { sampleRef: ref, name });
    store.live((p) => {
      const c = p.channels.find((x) => x.id === id);
      if (c?.sampler) c.sampler.sampleName = name;
    });
    store.end();
    void samples.ensure(ref);
    toast(`Added “${name}” to the Channel rack`, 'ok', 1400);
  }
  function addPresetChannel(name: string) {
    addChannel('synth', { name: name === 'Init' ? 'Tri-Osc' : name, preset: name, group: 'Synths' });
    toast(`Added a Tri-Osc Synth (“${name}”) to the Channel rack`, 'ok', 1400);
  }
  /** Add an instrument channel (registry plugin, Tri-Osc or Sampler), optionally with a preset. */
  function addInstrument(pluginType: string, preset?: string) {
    if (pluginType === 'triosc') {
      addPresetChannel(preset ?? 'Init');
      wm.show('channelrack');
      return;
    }
    if (pluginType === 'sampler') {
      addChannel('sampler', { name: 'Sampler' });
      wm.show('channelrack');
      toast('Added an empty Sampler — drop a sound on it', 'ok', 1600);
      return;
    }
    const factory = preset ? pluginPresets(pluginType).find((p) => p.name === preset) : undefined;
    store.begin('Add channel');
    const id = addChannel('plugin', { pluginType, preset, group: 'Synths' });
    if (factory) {
      // user presets aren't known to the channel factory: load the state explicitly (same undo step)
      store.live((p) => {
        const c = p.channels.find((x) => x.id === id);
        if (c?.plugin && c.plugin.preset !== factory.name) {
          c.plugin.state = deepClone(factory.state);
          c.plugin.preset = factory.name;
          if (c.name === instInfo(pluginType)?.name) c.name = factory.name;
        }
      });
    }
    store.end();
    wm.show('channelrack');
    openPluginWindow(id, 'show');
  }
  function addEffect(type: string) {
    const track = clamp(store.ui.selectedMixer, 0, store.project.mixer.length - 1);
    addFx(track, type as FxType);
    wm.show('mixer');
  }
  function replaceSample(ref: string, name: string) {
    const ch = store.selectedChannel;
    if (!ch) {
      toast('There is no channel to load into — double-click the sound to add one', 'warn');
      return;
    }
    if (ch.type !== 'sampler' || !ch.sampler) {
      toast(`“${ch.name}” isn't a Sampler channel — double-click the sound to add it as a new channel`, 'warn', 3000);
      return;
    }
    const b = ref.startsWith('builtin:') ? BUILTIN_BY_ID.get(ref.slice(8)) : undefined;
    const old = ch.sampler;
    const autoNamed = ch.name === 'Sampler' || ch.name === old.sampleName || (!!old.sampleRef && ch.name === stripExt(samples.displayName(old.sampleRef)));
    store.commit('Replace sample', (p) => {
      const c = p.channels.find((x) => x.id === ch.id);
      if (!c?.sampler) return;
      c.sampler.sampleRef = ref;
      c.sampler.sampleName = name;
      c.sampler.startOffset = 0;
      c.sampler.rootKey = b?.rootKey ?? 60;
      if (b?.cutGroup !== undefined) c.sampler.cutGroup = b.cutGroup;
      if (autoNamed) c.name = name;
    });
    void samples.ensure(ref);
    toast(`Loaded “${name}” into ${autoNamed ? 'the selected channel' : '“' + ch.name + '”'}`, 'ok', 1400);
  }
  function applyPreset(name: string) {
    const ch = store.selectedChannel;
    if (!ch || ch.type !== 'synth') {
      toast('Select a Tri-Osc Synth channel first — or double-click the preset to add a new one', 'warn', 3000);
      return;
    }
    const autoNamed = ch.name === 'Tri-Osc' || SYNTH_PRESETS.some((p) => p.name === ch.name);
    store.commit('Apply synth preset', (p) => {
      const c = p.channels.find((x) => x.id === ch.id);
      if (!c) return;
      c.synth = synthPreset(name);
      if (autoNamed) c.name = name;
    });
    toast(`Preset “${name}” applied to ${autoNamed ? 'the selected synth' : '“' + ch.name + '”'}`, 'ok', 1400);
  }
  function applyPluginPreset(pluginType: string, name: string) {
    const ch = store.selectedChannel;
    const pr = pluginPresets(pluginType).find((p) => p.name === name);
    const plName = instInfo(pluginType)?.name ?? pluginType;
    if (!pr) return;
    if (!ch || ch.type !== 'plugin' || ch.plugin?.type !== pluginType) {
      toast(`Select a ${plName} channel first — or double-click the preset to add a new one`, 'warn', 3000);
      return;
    }
    store.commit('Load preset', (p) => {
      const c = p.channels.find((x) => x.id === ch.id);
      if (!c?.plugin) return;
      c.plugin.state = deepClone(pr.state);
      c.plugin.preset = pr.name;
    });
    toast(`Preset “${name}” loaded into “${ch.name}”`, 'ok', 1400);
  }
  function openChannel(id: ID) {
    store.setUI({ selectedChannels: [id], pianoRollChannel: id });
    openPluginWindow(id, 'toggle');
  }
  function openRecent(n: BNode) {
    if (n.index !== undefined && n.index < 10) commands.run('file.recent' + n.index);
  }

  function toggleFav(n: BNode | undefined) {
    const r = favRef(n);
    if (!r) return;
    const i = favs.indexOf(r);
    if (i >= 0) favs.splice(i, 1);
    else favs.push(r);
    favSet = new Set(favs);
    saveList('lf.favs', favs);
    rebuild();
  }

  // ---- user folders (desktop) ----
  async function scan(dir: string) {
    listings.set(dir, { loading: true, files: listings.get(dir)?.files ?? [] });
    rebuild();
    let files: AudioListing[] = [];
    try {
      files = await native.listAudio(dir);
    } catch {
      toast('Could not read ' + dir, 'error');
    }
    if (!folders.includes(dir)) return; // removed while scanning
    files.sort((a, b) => coll.compare(a.rel, b.rel));
    listings.set(dir, { loading: false, files });
    rebuild();
  }
  async function addFolder() {
    if (!isElectron) {
      await addFiles();
      return;
    }
    const dir = await native.pickFolder();
    if (!dir) return;
    if (!folders.includes(dir)) {
      folders.push(dir);
      saveList('lf.folders', folders);
    }
    if (tab !== 'all' && tab !== 'sounds') setTab('sounds');
    open().add('sec:folders');
    open().add('uf|' + dir);
    persistOpen();
    await scan(dir);
    const n = tree.byKey.get('uf|' + dir);
    if (n) select(n, true);
    toast(`${basename(dir)}: ${plural(listings.get(dir)?.files.length ?? 0, 'sound')} found`, 'ok', 1800);
  }
  function removeFolder(dir: string) {
    const i = folders.indexOf(dir);
    if (i < 0) return;
    folders.splice(i, 1);
    saveList('lf.folders', folders);
    listings.delete(dir);
    rebuild();
  }
  // ---- session files (web) ----
  async function addFiles() {
    const got = await pickSamples(true);
    if (!got.length) return;
    for (const s of got) {
      names.set(s.ref, s.name);
      if (!picked.some((x) => x.ref === s.ref)) picked.push(s);
    }
    if (tab !== 'all' && tab !== 'sounds') setTab('sounds');
    open().add('sec:folders');
    persistOpen();
    rebuild();
    select(tree.byKey.get('uf|' + got[0].ref), true);
    toast(`${plural(got.length, 'sound')} added (kept for this session)`, 'ok', 1600);
  }
  function removeSession(listArr: DragSample[], ref: string) {
    const i = listArr.findIndex((x) => x.ref === ref);
    if (i >= 0) listArr.splice(i, 1);
    rebuild();
  }

  // ================= info panel =================
  let infoTok = 0;
  let infoPreview: Preview = { kind: 'none' };
  function setInfo(o: { icon?: string; color?: string; rows: [string, string][]; pv?: Preview; thumb?: { url: string; w: number; h: number } | null; missing?: boolean }) {
    infoMark.innerHTML = o.icon ?? '';
    infoMark.style.setProperty('--c', o.color ?? '#8b979d');
    infoRows.textContent = '';
    for (const [k, v] of o.rows) infoRows.append(el('span', { class: 'br-ik', text: k }), el('span', { class: 'br-iv', text: v, title: v }));
    const pv = o.pv ?? { kind: 'none' };
    info.classList.toggle('missing', !!o.missing);
    info.classList.toggle('idle', pv.kind === 'none' && !o.thumb);
    info.classList.toggle('show-thumb', !!o.thumb);
    if (o.thumb) {
      infoThumb.src = o.thumb.url;
      infoThumb.width = o.thumb.w * 1.5;
      infoThumb.height = o.thumb.h * 1.5;
    }
    infoPreview = pv;
    drawPreview(wave, pv);
  }
  function idleInfo() {
    setInfo({ icon: '', rows: [['Title', 'Nothing selected'], ['Tip', 'Click a sound to preview it · double-click adds']] });
  }
  function pathOf(n: BNode): string {
    if (n.ref?.startsWith('file:')) return n.ref.slice(5);
    const parts: string[] = [];
    for (let p = n.parent; p; p = p.parent) parts.unshift(p.label);
    return parts.join(' › ') || n.where || '';
  }
  async function showInfo(n: BNode | undefined) {
    const tok = ++infoTok;
    if (!n || n.kind === 'empty') return idleInfo();
    const path = pathOf(n);
    switch (n.kind) {
      case 'sample': {
        const ref = n.ref!;
        const where = ref.startsWith('builtin:') ? 'Built-in sound · ' + sourceOf(ref) : ref.startsWith('embed:') ? 'Embedded / dropped file' : 'Audio file';
        setInfo({ icon: BR.sample, color: n.color, rows: [['Title', n.label], ['Type', where], ['Size', 'Loading…'], ['Path', path]] });
        const b = await samples.ensure(ref);
        if (tok !== infoTok) return;
        if (!b) return setInfo({ icon: BR.sample, color: n.color, rows: [['Title', n.label], ['Type', where], ['Size', 'Missing or unreadable file'], ['Path', path]], missing: true });
        const chs = b.numberOfChannels === 1 ? 'Mono' : b.numberOfChannels === 2 ? 'Stereo' : b.numberOfChannels + ' ch';
        const emb = samples.embedded.get(ref) as { data?: Uint8Array } | undefined;
        const bytes = emb?.data?.length ?? b.length * b.numberOfChannels * 2 + 44;
        const pk = samples.peaks(ref, 240);
        return setInfo({
          icon: BR.sample,
          color: n.color,
          rows: [['Title', n.label], ['Length', `${fmtDur(b.duration)} · ${chs} · ${(b.sampleRate / 1000).toFixed(1)} kHz`], ['Size', (emb?.data ? '' : '≈ ') + fmtBytes(bytes)], ['Path', path]],
          pv: pk ? { kind: 'peaks', data: pk, color: n.color ?? '#f6a432' } : { kind: 'none' },
        });
      }
      case 'preset': {
        const def = SYNTH_PRESETS.find((p) => p.name === n.preset);
        return setInfo({ icon: n.icon, color: n.color, rows: [['Title', n.label], ['Type', 'Tri-Osc Synth preset'], ['Info', def?.desc ?? ''], ['Path', path]], pv: { kind: 'line', data: synthCurve(synthPreset(n.preset!)), color: n.color ?? '#4fc6e6' } });
      }
      case 'plugpreset': {
        const pl = instInfo(n.plugin);
        return setInfo({ icon: pl?.icon, color: n.color, rows: [['Title', n.label], ['Type', `${pl?.name ?? n.plugin} preset`], ['Info', pl?.desc ?? ''], ['Path', path]], thumb: instrumentThumb(n.plugin!, n.color ?? '#9fb2c2') });
      }
      case 'plugin': {
        const pl = instInfo(n.plugin);
        const np = n.plugin === 'triosc' ? SYNTH_PRESETS.length : n.plugin === 'sampler' ? 0 : pluginPresets(n.plugin!).length;
        return setInfo({
          icon: n.icon,
          color: n.color,
          rows: [['Title', n.label], ['Type', `Instrument · ${pl?.category ?? ''}`], ['Info', `${pl?.desc ?? ''}${np ? ` · ${plural(np, 'preset')}` : ''}`], ['Path', path]],
          thumb: instrumentThumb(n.plugin!, n.color ?? '#9fb2c2'),
        });
      }
      case 'fx': {
        const def = (FX_DEFS as Record<string, { desc: string; params: unknown[] } | undefined>)[n.fx!];
        return setInfo({ icon: n.icon, color: n.color, rows: [['Title', n.label], ['Type', 'Effect'], ['Info', `${def?.desc ?? ''}${def ? ` · ${plural(def.params.length, 'parameter')}` : ''}`], ['Path', path]], thumb: effectThumb(n.fx!, n.color ?? '#9fb2c2') });
      }
      case 'channel': {
        const c = store.channel(n.id);
        if (!c) return idleInfo();
        const route = c.mixer > 0 ? `Insert ${c.mixer}` : 'Master';
        const typ = c.type === 'plugin' ? instInfo(c.plugin?.type)?.name ?? 'Plugin' : c.type === 'synth' ? 'Tri-Osc Synth' : 'Sampler';
        const notes = store.project.patterns.reduce((a, p) => a + (p.notes[c.id]?.length ?? 0), 0);
        const rowsC: [string, string][] = [['Title', c.name], ['Type', `${typ} → ${route}`], ['Notes', `${plural(notes, 'note')} in ${plural(store.project.patterns.filter((p) => p.notes[c.id]?.length).length, 'pattern')}`]];
        if (c.type === 'synth' && c.synth) return setInfo({ icon: n.icon, color: c.color, rows: [...rowsC, ['Path', 'Current project › Channels']], pv: { kind: 'line', data: synthCurve(c.synth), color: c.color } });
        if (c.type === 'plugin') return setInfo({ icon: n.icon, color: c.color, rows: [...rowsC, ['Preset', c.plugin?.preset ?? '—']], thumb: instrumentThumb(c.plugin?.type ?? 'x', instInfo(c.plugin?.type)?.color ?? c.color) });
        const ref = c.sampler?.sampleRef;
        setInfo({ icon: BR.sample, color: c.color, rows: [...rowsC, ['Sample', ref ? sampleName(ref) : 'empty']] });
        if (!ref) return;
        const b = await samples.ensure(ref);
        if (tok !== infoTok || !b) return;
        const pk = samples.peaks(ref, 240);
        if (pk) setInfo({ icon: BR.sample, color: c.color, rows: [...rowsC, ['Sample', `${sampleName(ref)} · ${fmtDur(b.duration)}`]], pv: { kind: 'peaks', data: pk, color: c.color } });
        return;
      }
      case 'pattern': {
        const p = store.pattern(n.id);
        if (!p) return idleInfo();
        const notes: { start: number; len: number; key: number; muted?: boolean }[] = [];
        let used = 0;
        for (const [cid, arr] of Object.entries(p.notes)) {
          if (!arr.length || !store.channel(cid)) continue;
          used++;
          for (const x of arr) notes.push(x);
        }
        const len = store.patternLength(p);
        const bars = Math.round((len / store.barTicks) * 100) / 100;
        const i = store.project.patterns.indexOf(p);
        const clips = store.project.playlist.clips.filter((c) => c.kind === 'pattern' && c.ref === p.id).length;
        return setInfo({
          icon: BI.pattern,
          color: p.color,
          rows: [['Title', p.name], ['Type', `Pattern ${i + 1} · ${plural(bars, 'bar')}`], ['Size', `${plural(used, 'channel')} · ${plural(notes.length, 'note')}`], ['Used', clips ? `${plural(clips, 'clip')} in the Playlist` : 'Not in the Playlist']],
          pv: { kind: 'notes', notes, length: len, color: p.color },
        });
      }
      case 'automation': {
        const a = store.project.automations.find((x) => x.id === n.id);
        if (!a) return idleInfo();
        return setInfo({ icon: ICONS.automation, color: a.color, rows: [['Title', a.name], ['Type', 'Automation clip'], ['Target', describeTarget(a.target).name], ['Points', String(a.points.length)]], pv: { kind: 'auto', points: a.points, length: a.length, color: a.color } });
      }
      case 'mixfx':
        return setInfo({ icon: n.icon, color: n.color, rows: [['Title', n.label], ['Type', 'Mixer effect · ' + (n.info ?? '')], ['Track', n.meta ?? ''], ['Path', 'Current project › Effects']], thumb: effectThumb(n.fx!, n.color ?? '#9fb2c2') });
      case 'recent':
        return setInfo({ icon: BI.project, color: n.color, rows: [['Title', n.label], ['Type', 'LoopForge project'], ['Open', n.meta ? `Double-click or ${n.meta}` : 'Double-click'], ['Path', n.path ?? '']] });
      case 'folder': {
        const count = n.files ?? n.children?.filter((c) => c.kind !== 'empty' && c.kind !== 'action').length ?? 0;
        const what = n.files !== undefined ? 'sound' : 'item';
        return setInfo({ icon: n.icon ?? BI.folder, color: n.color ?? n.tint, rows: [['Title', n.label], ['Type', 'Folder'], ['Size', plural(count, what)], ['Path', n.root && n.key === 'uf|' + n.root ? n.root : n.info ?? path]] });
      }
      case 'action':
        return setInfo({ icon: n.icon, color: '#64c3e6', rows: [['Title', n.label], ['Info', isElectron ? 'Pick a folder — its sub-folders are scanned for audio' : 'Pick audio files from disk (kept for this session)']] });
    }
  }

  // ================= context menus =================
  function menuFor(n: BNode, x: number, y: number) {
    const items: MenuItem[] = [];
    const ch = store.selectedChannel;
    const enterKey = commands.shortcutLabel('browser.enter');
    const addKey = commands.shortcutLabel('browser.addChannel');
    const favItem = (): MenuItem => ({ label: isFav(n) ? 'Unstar' : 'Star (add to STARRED)', action: () => toggleFav(n) });
    switch (n.kind) {
      case 'sample':
        items.push(
          { label: 'Preview', action: () => void preview(n) },
          { label: 'Open in new channel', shortcut: addKey, action: () => addSampleChannel(n.ref!, n.label) },
          { label: ch?.type === 'sampler' ? `Replace sample in “${ch.name}”` : "Replace selected channel's sample", shortcut: enterKey, disabled: ch?.type !== 'sampler', action: () => replaceSample(n.ref!, n.label) },
          { sep: true },
          favItem(),
        );
        if (dropped.some((s) => s.ref === n.ref)) items.push({ label: 'Remove from Dropped files', action: () => removeSession(dropped, n.ref!) });
        if (!isElectron && picked.some((s) => s.ref === n.ref)) items.push({ label: 'Remove from Your files', action: () => removeSession(picked, n.ref!) });
        if (n.root) items.push({ sep: true }, { label: 'Refresh folder', action: () => void scan(n.root!) });
        break;
      case 'preset':
        items.push(
          { label: 'Open in new channel', shortcut: addKey, action: () => addPresetChannel(n.preset!) },
          { label: ch?.type === 'synth' ? `Apply to “${ch.name}”` : 'Apply to selected synth channel', shortcut: enterKey, disabled: ch?.type !== 'synth', action: () => applyPreset(n.preset!) },
          { sep: true },
          favItem(),
        );
        break;
      case 'plugpreset': {
        const same = ch?.type === 'plugin' && ch.plugin?.type === n.plugin;
        items.push(
          { label: 'Open in new channel', shortcut: addKey, action: () => addInstrument(n.plugin!, n.preset) },
          { label: same ? `Load into “${ch!.name}”` : `Load into selected ${instInfo(n.plugin)?.name ?? ''} channel`, shortcut: enterKey, disabled: !same, action: () => applyPluginPreset(n.plugin!, n.preset!) },
          { sep: true },
          favItem(),
        );
        break;
      }
      case 'plugin':
        items.push({ label: 'Add to Channel rack', shortcut: enterKey, action: () => addInstrument(n.plugin!) });
        if (n.plugin !== 'sampler') {
          items.push({ label: 'Show presets', action: () => revealPresets(n.plugin!) });
        }
        items.push({ sep: true }, favItem());
        break;
      case 'fx': {
        const t = clamp(store.ui.selectedMixer, 0, store.project.mixer.length - 1);
        const m = store.project.mixer[t];
        items.push({ label: `Add to ${t === 0 ? 'Master' : m?.name ?? 'Insert ' + t}`, shortcut: enterKey, action: () => addEffect(n.fx!) }, { label: 'Show Mixer', action: () => wm.show('mixer') }, { sep: true }, favItem());
        break;
      }
      case 'folder':
        items.push({ label: open().has(n.key) ? 'Close' : 'Open', action: () => toggle(n) }, { label: 'Open all inside', action: () => setOpenDeep(n, true) }, { label: 'Close all inside', action: () => setOpenDeep(n, false) });
        if (n.root) {
          items.push({ sep: true }, { label: 'Refresh', action: () => void scan(n.root!) });
          if (n.key === 'uf|' + n.root) items.push({ label: 'Remove from browser', action: () => removeFolder(n.root!) });
        }
        if (n.key === 'sec:folders') items.push({ sep: true }, { label: isElectron ? 'Add folder…' : 'Add audio files…', action: () => void (isElectron ? addFolder() : addFiles()) });
        if (n.key === 'sec:starred') items.push({ sep: true }, { label: 'Clear starred', disabled: !favs.length, action: clearStarred });
        if (n.key === 'sec:dropped') items.push({ sep: true }, { label: 'Clear list', disabled: !dropped.length, action: () => { dropped.length = 0; rebuild(); } });
        break;
      case 'pattern':
        items.push(
          { label: 'Select pattern', action: () => selectPattern(n.id!) },
          { label: 'Show in Channel rack', action: () => { selectPattern(n.id!); wm.show('channelrack'); } },
          { sep: true },
          { label: 'Rename…', action: () => void renamePattern(n.id) },
          { label: 'Clone', action: () => clonePattern(n.id) },
          { label: 'Color…', action: () => patternColor(n.id!, x, y) },
          { sep: true },
          { label: 'Delete', action: () => deletePattern(n.id) },
        );
        break;
      case 'channel':
        items.push(
          { label: 'Select channel', action: () => activate(n) },
          { label: 'Instrument window', action: () => openChannel(n.id!) },
          { label: 'Open in Piano roll', action: () => { store.setUI({ selectedChannels: [n.id!], pianoRollChannel: n.id! }); wm.show('pianoroll'); } },
        );
        break;
      case 'automation':
        items.push({ label: 'Use as Playlist clip source', action: () => activate(n) }, { label: 'Show Playlist', action: () => wm.show('playlist') });
        break;
      case 'mixfx':
        items.push({ label: 'Open effect window', action: () => openFxWindow(n.id!, 'show') }, { label: 'Select mixer track', action: () => { activate(n); wm.show('mixer'); } });
        break;
      case 'recent':
        items.push({ label: 'Open project', shortcut: n.meta, action: () => openRecent(n) });
        break;
      case 'action':
        items.push({ label: n.label, action: () => n.run?.() });
        break;
    }
    if (items.length) showMenu(items, x, y);
  }
  function clearStarred() {
    favs.length = 0;
    favSet = new Set();
    saveList('lf.favs', favs);
    rebuild();
  }
  function revealPresets(pluginType: string) {
    setTab('library');
    const key = pluginType === 'triosc' ? 'lib/triosc' : 'lib/pl/' + pluginType;
    const n = tree.byKey.get(key);
    if (!n) return;
    setOpenDeep(n, true);
    reveal(n);
  }

  // ================= interaction =================
  function activate(n: BNode, clicks = 1) {
    select(n);
    switch (n.kind) {
      case 'folder':
        if (clicks < 2) toggle(n);
        break;
      case 'action':
        if (clicks < 2) n.run?.();
        break;
      case 'sample':
        if (clicks < 2) void preview(n);
        break;
      case 'channel':
        store.setUI({ selectedChannels: [n.id!], pianoRollChannel: n.id! });
        break;
      case 'pattern':
        selectPattern(n.id!);
        break;
      case 'automation':
        store.setUI({ plSource: { kind: 'automation', ref: n.id! } });
        break;
      case 'mixfx':
        store.setUI({ selectedMixer: n.track!, selectedMixerTracks: [n.track!] });
        break;
    }
  }
  /** Double-click / Shift+Enter: put the item to use. */
  function use(n: BNode) {
    switch (n.kind) {
      case 'sample':
        return addSampleChannel(n.ref!, n.label);
      case 'preset':
        return addPresetChannel(n.preset!);
      case 'plugpreset':
        return addInstrument(n.plugin!, n.preset);
      case 'plugin':
        return addInstrument(n.plugin!);
      case 'fx':
        return addEffect(n.fx!);
      case 'channel':
        return openChannel(n.id!);
      case 'pattern':
        return wm.show('channelrack');
      case 'automation':
        return wm.show('playlist');
      case 'mixfx':
        return openFxWindow(n.id!, 'show');
      case 'recent':
        return openRecent(n);
    }
  }

  const nodeOf = (t: EventTarget | null): BNode | undefined => {
    const r = t instanceof Element ? (t.closest('.br-row') as HTMLElement | null) : null;
    return r ? tree.byKey.get(r.dataset.key ?? '') : undefined;
  };
  layer.addEventListener('mousedown', (e) => {
    const n = nodeOf(e.target);
    if (!n) return;
    if (e.button === 2) {
      select(n);
      return;
    }
    if (e.button !== 0) return;
    if ((e.target as Element).closest('.br-star')) {
      e.preventDefault();
      select(n);
      toggleFav(n);
      return;
    }
    activate(n, e.detail);
  });
  layer.addEventListener('dblclick', (e) => {
    const n = nodeOf(e.target);
    if (!n || (e.target as Element).closest('.br-star')) return;
    use(n);
  });
  list.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const n = nodeOf(e.target);
    if (n) menuFor(n, e.clientX, e.clientY);
    else showMenu(browserMenu(), e.clientX, e.clientY);
  });
  layer.addEventListener('dragstart', (e) => {
    const r = e.target instanceof Element ? (e.target.closest('.br-row') as RowEl | null) : null;
    const n = nodeOf(e.target);
    if (!r || !n) return;
    switch (n.kind) {
      case 'sample':
        setDragData(e, DT_SAMPLE, { ref: n.ref, name: n.label });
        break;
      case 'preset':
        setDragData(e, DT_PRESET, { preset: n.preset, name: n.preset });
        break;
      case 'plugpreset':
        setDragData(e, DT_PLUGIN, { pluginType: n.plugin, preset: n.preset, name: n.preset });
        break;
      case 'plugin':
        // DT_PLUGIN { pluginType } — a registry id, 'triosc' or 'sampler' (the Channel rack resolves all three)
        setDragData(e, DT_PLUGIN, { pluginType: n.plugin, name: n.label });
        break;
      case 'fx':
        setDragData(e, DT_FX, { type: n.fx, name: n.label });
        break;
      case 'pattern':
        setDragData(e, DT_PATTERN, { id: n.id, name: n.label });
        break;
      default:
        e.preventDefault();
        return;
    }
    dragRow = r;
    if (n.key !== selKey) select(n);
  });
  layer.addEventListener('dragend', () => {
    dragRow = null;
    render();
  });
  list.addEventListener('scroll', renderSoon, { passive: true });
  wave.addEventListener('click', () => {
    const n = cur();
    if (n?.kind === 'sample') void preview(n);
    else if (n?.kind === 'channel') {
      const ref = store.channel(n.id)?.sampler?.sampleRef;
      if (ref) void engine.previewSample(ref);
    }
  });

  // OS files dropped onto the browser
  root.addEventListener('dragover', (e) => {
    if (!hasType(e, 'Files') || dragRow) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    root.classList.add('br-drop');
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove('br-drop');
  });
  root.addEventListener('drop', async (e) => {
    root.classList.remove('br-drop');
    if (!hasType(e, 'Files') || hasType(e, DT_SAMPLE)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    const got = await samplesFromDrop(e);
    if (!got.length) {
      if (!files.some((f) => /\.lfproj$/i.test(f.name))) toast('No playable audio files in that drop', 'warn');
      return;
    }
    for (const s of got) {
      names.set(s.ref, s.name);
      if (!dropped.some((x) => x.ref === s.ref)) dropped.push(s);
    }
    if (tab !== 'all' && tab !== 'sounds') setTab('sounds');
    open().add('sec:dropped');
    persistOpen();
    if (query) {
      input.value = '';
      onQuery();
    }
    rebuild();
    const first = tree.byKey.get('drop|' + got[0].ref);
    if (first) {
      select(first, true);
      void preview(first);
    }
    toast(`${plural(got.length, 'sound')} added to Dropped files`, 'ok', 1500);
  });

  // ================= search / TAGS bar =================
  function onQuery() {
    const q = input.value.trim();
    if (q === query) return;
    query = q;
    root.classList.toggle('searching', !!q);
    flatten();
    list.scrollTop = 0;
    if (q && rows.length) {
      selKey = rows[0].key;
      void showInfo(rows[0]);
    } else if (!q) {
      revealSel();
      flatten();
      requestAnimationFrame(() => ensureVisible(rows.findIndex((r) => r.key === selKey)));
    }
    render();
  }
  input.addEventListener('input', onQuery);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) {
        input.value = '';
        onQuery();
      }
      input.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const n = cur() ?? rows[0];
      if (!n) return;
      if (e.shiftKey) return use(n);
      select(n, true);
      if (n.kind === 'sample') void preview(n);
      input.blur();
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    onQuery();
    input.focus();
  });
  findBtn.addEventListener('click', () => {
    input.focus();
    input.select();
  });
  folderBtn.addEventListener('click', () => void (isElectron ? addFolder() : addFiles()));
  tagsBtn.addEventListener('click', () => {
    const r = tagsBtn.getBoundingClientRect();
    const items: MenuItem[] = TAGS.map((t) => ({ label: t, checked: query.toLowerCase() === t.toLowerCase(), action: () => { input.value = t; onQuery(); } }));
    items.push({ sep: true }, { label: 'Clear filter', disabled: !query, action: () => { input.value = ''; onQuery(); } });
    const m = showMenu(items, r.left, r.top);
    // open upwards: the bar sits at the bottom of the window
    const mr = m.getBoundingClientRect();
    m.style.top = Math.max(0, r.top - mr.height - 2) + 'px';
  });

  // ================= keyboard API =================
  function move(d: 1 | -1, pv: boolean) {
    if (!rows.length) return;
    const i = selKey ? rows.findIndex((r) => r.key === selKey) : -1;
    let j = i < 0 ? (d > 0 ? 0 : rows.length - 1) : i + d;
    while (j >= 0 && j < rows.length && rows[j].kind === 'empty') j += d;
    if (j < 0 || j >= rows.length) return;
    const n = rows[j];
    select(n, true);
    if (pv && n.kind === 'sample') void preview(n);
  }
  api = {
    move,
    left() {
      const n = cur();
      if (!n || !rows.includes(n)) return move(1, false);
      if (query) return;
      if (n.children && open().has(n.key)) setOpen(n, false);
      else if (n.parent) select(n.parent, true);
    },
    right() {
      const n = cur();
      if (!n || !rows.includes(n)) return move(1, false);
      if (query || !n.children) return;
      if (!open().has(n.key)) setOpen(n, true);
      else {
        const first = n.children.find((c) => c.kind !== 'empty');
        if (first) select(first, true);
      }
    },
    enter() {
      const n = cur();
      if (!n) return;
      switch (n.kind) {
        case 'sample':
          return replaceSample(n.ref!, n.label);
        case 'preset':
          return applyPreset(n.preset!);
        case 'plugpreset': {
          const ch = store.selectedChannel;
          if (ch?.type === 'plugin' && ch.plugin?.type === n.plugin) return applyPluginPreset(n.plugin!, n.preset!);
          return addInstrument(n.plugin!, n.preset);
        }
        case 'plugin':
        case 'fx':
        case 'recent':
          return use(n);
        case 'folder':
          return toggle(n);
        case 'action':
          return n.run?.();
        case 'channel':
        case 'pattern':
        case 'automation':
        case 'mixfx':
          return activate(n);
      }
    },
    addSel() {
      const n = cur();
      if (n) use(n);
    },
    favSel() {
      toggleFav(cur());
    },
    focusSearch() {
      if (!visible()) wm.show('browser');
      input.focus();
      input.select();
    },
    clearSearch() {
      input.value = '';
      onQuery();
    },
    searching: () => !!query,
    tab(d) {
      const i = TABS.findIndex((t) => t.id === tab);
      setTab(TABS[(i + d + TABS.length) % TABS.length].id);
    },
  };
  registerCommands();

  // ================= header (window title bar) =================
  function browserMenu(): MenuItem[] {
    return [
      { label: 'Show plugin thumbnails', checked: thumbs, action: () => { thumbs = !thumbs; saveStr('lf.browser.thumbs', thumbs ? '1' : '0'); rebuild(); } },
      { label: 'Tab', submenu: TABS.map((t) => ({ label: t.label, checked: t.id === tab, action: () => setTab(t.id) })) },
      { sep: true },
      { label: 'Close all folders', action: collapseAll },
      { label: "Reveal selected channel's sound / plugin", action: locate },
      { sep: true },
      { label: isElectron ? 'Add folder…' : 'Add audio files…', action: () => void (isElectron ? addFolder() : addFiles()) },
      ...(isElectron ? [{ label: 'Refresh all folders', disabled: !folders.length, action: () => folders.forEach((d) => void scan(d)) }] : []),
      { label: 'Clear dropped files', disabled: !dropped.length, action: () => { dropped.length = 0; rebuild(); } },
      { label: 'Clear starred', disabled: !favs.length, action: clearStarred },
    ];
  }
  /** Find the selected channel's sound / preset / instrument in the browser. */
  function locate() {
    const ch = store.selectedChannel;
    if (!ch) return toast('No channel selected', 'warn');
    const match = (n: BNode) => {
      if (ch.type === 'sampler') return n.kind === 'sample' && !!ch.sampler?.sampleRef && n.ref === ch.sampler.sampleRef;
      if (ch.type === 'plugin') return (n.kind === 'plugpreset' && n.plugin === ch.plugin?.type && n.preset === ch.plugin?.preset) || (n.kind === 'plugin' && n.plugin === ch.plugin?.type);
      return (n.kind === 'preset' && n.preset === ch.name) || (n.kind === 'plugin' && n.plugin === 'triosc');
    };
    const find = () => {
      let best: BNode | undefined;
      for (const r of tree.roots)
        walk(r, (n) => {
          if (!best && match(n) && n.kind !== 'plugin') best = n;
        });
      if (!best) for (const r of tree.roots) walk(r, (n) => (best ??= match(n) ? n : undefined));
      return best;
    };
    let n = find();
    if (!n && tab !== 'all') {
      setTab('all');
      n = find();
    }
    if (!n) return toast(`Couldn't find “${ch.name}”'s sound in the browser`, 'info', 1800);
    reveal(n);
  }
  const menuBtn = iconBtn(BI.menu, 'Browser options — thumbnails, tabs, folders', (e) => showMenu(browserMenu(), e.clientX, e.clientY + 8), 'br-hbtn');
  const upBtn = iconBtn(
    BI.up,
    'Go up — close the selected folder or select its parent (all folders close when nothing is selected)',
    () => {
      const n = cur();
      if (!n) return collapseAll();
      const f = n.children && open().has(n.key) ? n : n.parent;
      if (!f) return collapseAll();
      setOpen(f, false);
      select(f, true);
    },
    'br-hbtn',
  );
  const locBtn = iconBtn(BI.locate, "Reveal the selected channel's sound, preset or plugin", locate, 'br-hbtn');
  const headerExtra = el('div', { class: 'br-hx' }, menuBtn, upBtn, locBtn);

  // ================= store wiring =================
  const sigOf = () => {
    const p = store.project;
    if (!p) return '';
    return (
      p.channels.map((c) => `${c.id}:${c.name}:${c.color}:${c.type}:${c.mixer}:${c.plugin?.type ?? ''}:${c.type === 'synth' ? c.synth?.osc.find((o) => o.level > 0)?.wave : ''}`).join('|') +
      '#' +
      p.patterns.map((x) => `${x.id}:${x.name}:${x.color}`).join('|') +
      '#' +
      p.automations.map((a) => `${a.id}:${a.name}:${a.color}`).join('|') +
      '#' +
      p.mixer.map((m, i) => `${i}:${m.name}:${m.fx.map((f) => f.id + f.type + (f.enabled ? 1 : 0)).join(',')}`).join('|')
    );
  };
  const regSigOf = () => `${allInstruments().map((p) => p.id).join(',')}|${FX_ORDER.join(',')}`;
  let infoRaf = 0;
  store.on('project', () => {
    const s = sigOf();
    if (s !== projSig) {
      projSig = s;
      if (tab === 'all' || tab === 'project') rebuild();
    }
    const n = cur();
    if (n && (n.kind === 'channel' || n.kind === 'pattern' || n.kind === 'automation') && !infoRaf)
      infoRaf = requestAnimationFrame(() => {
        infoRaf = 0;
        void showInfo(cur());
      });
  });
  store.on('loaded', () => {
    projSig = sigOf();
    rebuild();
    if (!cur()) {
      selKey = null;
      idleInfo();
    }
  });
  store.on('ui', (keys) => {
    if (keys.includes('currentPattern') || keys.includes('selectedChannels') || keys.includes('plSource') || keys.includes('selectedMixer')) renderSoon();
  });

  new ResizeObserver(() => {
    fitTabs();
    renderSoon();
  }).observe(root);
  new ResizeObserver(() => drawPreview(wave, infoPreview)).observe(wave);

  // ================= init =================
  projSig = sigOf();
  regSig = regSigOf();
  paintTabs();
  tree = buildTab(tab, env, thumbs);
  flatten();
  idleInfo();
  for (const dir of folders) void scan(dir);

  return {
    body: root,
    headerExtra,
    onShow: () => {
      // plugins / effects registered after startup show up the next time the browser opens
      const rs = regSigOf();
      if (rs !== regSig || tab === 'library' || tab === 'starred') {
        regSig = rs;
        rebuild();
      }
      fitTabs();
      render();
      drawPreview(wave, infoPreview);
    },
    onResize: () => {
      fitTabs();
      renderSoon();
    },
  };
}
