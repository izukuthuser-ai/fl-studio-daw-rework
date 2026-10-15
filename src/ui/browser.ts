// Browser (Alt+F8): instant fuzzy search over built-in sounds, synth presets, favourites, user
// folders, dropped files and the current project. The tree is rebuilt only when a section's
// content changes; rows are virtualised and keyed by node, so the row under the mouse and the
// row being dragged survive every re-render.
import './browser.css';
import { store } from '../core/store';
import { Command, commands } from '../core/commands';
import { engine } from '../audio/engine';
import { samples } from '../audio/samples';
import { BUILTIN_BY_ID, BUILTIN_SOUNDS } from '../audio/sounds';
import { SYNTH_PRESETS, synthPreset } from '../core/project';
import { AudioListing, basename, isElectron, native } from '../core/native';
import { el, fuzzyScore } from '../core/util';
import type { ID, Wave } from '../core/types';
import { ICONS } from './icons';
import { MenuItem, iconBtn, showMenu, toast } from './widgets';
import { addChannel, describeTarget } from './ops';
import { DT_PATTERN, DT_PRESET, DT_SAMPLE, DragSample, hasType, pickSamples, samplesFromDrop, setDragData } from './dnd';
import { clonePattern, deletePattern, patternColor, renamePattern, selectPattern } from './actions';
import { wm } from './wm';
import { BR, CAT_COLOR, CAT_ICON, SAMPLER_COLOR, SYNTH_COLOR, WAVE_ICON } from './browser-icons';
import { Preview, drawPreview, synthCurve } from './browser-draw';
import type { PanelDef } from './panel';

const RH = 22; // row height (px) — keep in sync with .br-row in browser.css
const OVERSCAN = 8;
const MAX_RESULTS = 500;

type Kind = 'section' | 'folder' | 'sample' | 'preset' | 'channel' | 'pattern' | 'automation' | 'action' | 'empty';
type SectionId = 'builtin' | 'presets' | 'favs' | 'folders' | 'dropped' | 'project';

interface BNode {
  key: string;
  kind: Kind;
  label: string;
  section: SectionId;
  depth: number;
  parent: BNode | null;
  children?: BNode[];
  ref?: string; // sample ref
  preset?: string; // synth preset name
  id?: ID; // channel / pattern / automation id
  color?: string;
  icon?: string;
  meta?: string; // right-aligned text in tree mode
  where?: string; // context shown with search results (also searched)
  root?: string; // user folder this node belongs to
  files?: number; // folders: sounds inside (recursive)
  run?: () => void; // action rows
}
type NodeInit = Omit<BNode, 'depth' | 'parent' | 'section'> & { section?: SectionId };
type RowEl = HTMLDivElement & { _sig?: string };

const SECTION_DEF: Record<SectionId, { label: string; icon: string }> = {
  builtin: { label: 'Built-in sounds', icon: ICONS.drum },
  presets: { label: 'Synth presets', icon: ICONS.synth },
  favs: { label: 'Favorites', icon: ICONS.starFill },
  folders: { label: isElectron ? 'Your folders' : 'Your files', icon: ICONS.folder },
  dropped: { label: 'Dropped files', icon: BR.tray },
  project: { label: 'Current project', icon: BR.project },
};
const SECTION_ORDER: SectionId[] = ['builtin', 'presets', 'favs', 'folders', 'dropped', 'project'];
const DEFAULT_OPEN = ['sec:builtin', 'bi/Kicks', 'sec:presets', 'sec:favs', 'sec:folders', 'sec:dropped', 'sec:project', 'proj/patterns'];
const LEAF: ReadonlySet<Kind> = new Set<Kind>(['sample', 'preset', 'channel', 'pattern', 'automation']);
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const stripExt = (n: string) => n.replace(/\.[^.\\/]+$/, '');

const presetWave = new Map<string, Wave>();
function presetIcon(name: string) {
  let w = presetWave.get(name);
  if (!w) {
    w = synthPreset(name).osc.find((o) => o.level > 0)?.wave ?? 'sawtooth';
    presetWave.set(name, w);
  }
  return WAVE_ICON[w];
}

function fmtDur(sec: number) {
  if (sec < 1) return Math.round(sec * 1000) + ' ms';
  if (sec < 60) return sec.toFixed(2) + ' s';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')} min`;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

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
    c('browser.enter', "Replace selected channel's sample / apply preset", ['Enter'], () => api?.enter()),
    c('browser.addChannel', 'Open selected sound in a new channel', ['Shift+Enter'], () => api?.addSel()),
    c('browser.search', 'Search the browser', ['Ctrl+F'], () => api?.focusSearch()),
    { ...c('browser.clearSearch', 'Clear browser search', ['Esc'], () => api?.clearSearch()), enabled: () => !!api?.searching(), hidden: true },
    c('browser.favorite', 'Add / remove favorite', [], () => api?.favSel()),
  ]);
}

export function createBrowser(): PanelDef {
  // ---------------- state ----------------
  const favs = loadList('lf.favs');
  let favSet = new Set(favs);
  const folders = isElectron ? loadList('lf.folders') : [];
  const listings = new Map<string, { loading: boolean; files: AudioListing[] }>();
  const picked: DragSample[] = []; // web build: files added this session
  const dropped: DragSample[] = [];
  const names = new Map<string, string>(); // ref -> display name for session sounds
  const open = new Set(loadList('lf.browser.open', DEFAULT_OPEN));
  const byKey = new Map<string, BNode>();
  let roots: BNode[] = [];
  let rows: BNode[] = [];
  let query = '';
  let selKey: string | null = null;
  let projSig = '';
  let dragRow: RowEl | null = null;
  let rowEls = new Map<string, RowEl>();
  let raf = 0;
  const visible = () => !!wm?.get('browser')?.visible;

  // ---------------- DOM ----------------
  const input = el('input', {
    class: 'br-q',
    type: 'text',
    placeholder: 'Search sounds, presets, project…',
    spellcheck: false,
    'data-hint': 'Fuzzy search across every section (Ctrl+F) — ↑/↓ pick a result, Enter previews it, Esc clears',
  }) as HTMLInputElement;
  const clearBtn = el('button', { class: 'br-clear', html: ICONS.close, 'data-hint': 'Clear search (Esc)' });
  const status = el('div', { class: 'br-status' });
  const top = el(
    'div',
    { class: 'br-top' },
    el('div', { class: 'br-search' }, el('span', { class: 'br-search-ic', html: ICONS.search }), input, clearBtn),
    status,
  );
  const spacer = el('div', { class: 'br-spacer' });
  const layer = el('div', { class: 'br-layer' });
  const emptyMsg = el('div', { class: 'br-empty' });
  const list = el('div', { class: 'br-list', 'data-hint': 'Click = preview · double-click = new channel · drag onto the Channel rack / Playlist · right-click for more' }, spacer, layer, emptyMsg);
  const infoIc = el('span', { class: 'br-info-ic' });
  const infoName = el('div', { class: 'br-info-name' });
  const infoMeta = el('div', { class: 'br-info-meta' });
  const wave = el('canvas', { class: 'br-wave', 'data-hint': 'Click the waveform to preview the selected sound again' }) as HTMLCanvasElement;
  const info = el('div', { class: 'br-info' }, el('div', { class: 'br-info-head' }, infoIc, infoName), infoMeta, wave);
  const root = el('div', { class: 'browser' }, top, list, info);

  // ---------------- tree ----------------
  function add(parent: BNode | null, n: NodeInit): BNode {
    const node: BNode = { ...n, section: n.section ?? parent!.section, depth: parent ? parent.depth + 1 : 0, parent };
    if (parent) (parent.children ??= []).push(node);
    byKey.set(node.key, node);
    return node;
  }
  const emptyRow = (p: BNode, label: string) => add(p, { key: p.key + '|empty', kind: 'empty', label });

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

  function fillDir(rootNode: BNode, dir: string, files: AudioListing[]) {
    const dirs = new Map<string, BNode>([['', rootNode]]);
    const rootName = rootNode.label;
    for (const f of files) {
      const parts = f.rel.split(/[\\/]+/).filter(Boolean);
      parts.pop();
      let cur = rootNode;
      let acc = '';
      for (const part of parts) {
        acc = acc ? acc + '/' + part : part;
        let d = dirs.get(acc);
        if (!d) {
          d = add(cur, { key: `uf|${dir}|d|${acc}`, kind: 'folder', label: part, root: dir, where: rootName + '/' + acc });
          dirs.set(acc, d);
        }
        cur = d;
      }
      add(cur, { key: `uf|${dir}|f|${f.rel}`, kind: 'sample', label: stripExt(f.name), ref: 'file:' + f.path, root: dir, where: acc ? rootName + '/' + acc : rootName, color: SAMPLER_COLOR });
    }
    const finish = (n: BNode): number => {
      if (!n.children) return n.kind === 'sample' ? 1 : 0;
      n.children.sort((a, b) => (a.kind === 'folder') !== (b.kind === 'folder') ? (a.kind === 'folder' ? -1 : 1) : coll.compare(a.label, b.label));
      let c = 0;
      for (const ch of n.children) c += finish(ch);
      n.files = c;
      n.meta = String(c);
      return c;
    };
    finish(rootNode);
  }

  function buildTree() {
    byKey.clear();
    const sec: Partial<Record<SectionId, BNode>> = {};
    for (const id of SECTION_ORDER) sec[id] = add(null, { key: 'sec:' + id, kind: 'section', label: SECTION_DEF[id].label, section: id, icon: SECTION_DEF[id].icon, children: [] });

    // built-in sounds, grouped by category
    const cats = new Map<string, BNode>();
    for (const s of BUILTIN_SOUNDS) {
      let c = cats.get(s.category);
      if (!c) {
        c = add(sec.builtin!, { key: 'bi/' + s.category, kind: 'folder', label: s.category, color: CAT_COLOR[s.category], icon: CAT_ICON[s.category] });
        cats.set(s.category, c);
      }
      const ref = 'builtin:' + s.id;
      add(c, { key: 'bi|' + ref, kind: 'sample', label: s.name, ref, color: CAT_COLOR[s.category], where: 'Built-in · ' + s.category });
    }
    for (const c of cats.values()) {
      c.files = c.children!.length;
      c.meta = String(c.files);
    }
    sec.builtin!.files = BUILTIN_SOUNDS.length;

    // synth presets
    for (const p of SYNTH_PRESETS) add(sec.presets!, { key: 'pr|' + p.name, kind: 'preset', label: p.name, preset: p.name, color: SYNTH_COLOR, icon: presetIcon(p.name), where: 'Synth preset' });

    // favourites
    for (const r of favs) {
      if (r.startsWith('preset:')) {
        const name = r.slice(7);
        if (SYNTH_PRESETS.some((p) => p.name === name)) add(sec.favs!, { key: 'fav|' + r, kind: 'preset', label: name, preset: name, color: SYNTH_COLOR, icon: presetIcon(name), meta: 'Preset', where: 'Favorite · preset' });
      } else if (resolvable(r)) {
        add(sec.favs!, { key: 'fav|' + r, kind: 'sample', label: sampleName(r), ref: r, color: sampleColor(r), meta: sourceOf(r), where: 'Favorite · ' + sourceOf(r) });
      }
    }
    if (!sec.favs!.children!.length) emptyRow(sec.favs!, 'Click ☆ on a sound to pin it here');

    // user folders (desktop) / session files (web)
    if (isElectron) {
      add(sec.folders!, { key: 'act|addFolder', kind: 'action', label: 'Add folder…', icon: BR.addFolder, run: () => void addFolder() });
      for (const dir of folders) {
        const rn = add(sec.folders!, { key: 'uf|' + dir, kind: 'folder', label: basename(dir) || dir, root: dir, where: dir });
        const st = listings.get(dir);
        if (!st || st.loading) emptyRow(rn, 'Scanning…');
        else if (!st.files.length) emptyRow(rn, 'No audio files found');
        else fillDir(rn, dir, st.files);
      }
    } else {
      add(sec.folders!, { key: 'act|addFiles', kind: 'action', label: 'Add audio files…', icon: BR.plus, run: () => void addFiles() });
      for (const s of picked) add(sec.folders!, { key: 'uf|' + s.ref, kind: 'sample', label: s.name, ref: s.ref, color: SAMPLER_COLOR, where: 'Your files' });
    }

    // dropped files
    for (const s of dropped) add(sec.dropped!, { key: 'drop|' + s.ref, kind: 'sample', label: s.name, ref: s.ref, color: SAMPLER_COLOR, where: 'Dropped' });
    if (!dropped.length) emptyRow(sec.dropped!, 'Drop audio files here');

    // current project
    const p = store.project;
    const chs = add(sec.project!, { key: 'proj/channels', kind: 'folder', label: 'Channels', icon: ICONS.channelRack, meta: String(p.channels.length) });
    for (const c of p.channels) {
      const icon = c.type === 'synth' ? WAVE_ICON[c.synth?.osc.find((o) => o.level > 0)?.wave ?? 'sawtooth'] : BR.sample;
      add(chs, { key: 'ch|' + c.id, kind: 'channel', label: c.name, id: c.id, color: c.color, icon, meta: c.mixer > 0 ? `M${c.mixer}` : 'Master', where: 'Project · channel' });
    }
    if (!p.channels.length) emptyRow(chs, 'No channels yet');
    const pts = add(sec.project!, { key: 'proj/patterns', kind: 'folder', label: 'Patterns', icon: ICONS.pianoRoll, meta: String(p.patterns.length) });
    p.patterns.forEach((pt, i) => add(pts, { key: 'pt|' + pt.id, kind: 'pattern', label: pt.name, id: pt.id, color: pt.color, meta: String(i + 1), where: 'Project · pattern ' + (i + 1) }));
    const aus = add(sec.project!, { key: 'proj/auto', kind: 'folder', label: 'Automation clips', icon: ICONS.automation, meta: String(p.automations.length) });
    for (const a of p.automations) add(aus, { key: 'au|' + a.id, kind: 'automation', label: a.name, id: a.id, color: a.color, icon: ICONS.automation, where: 'Project · automation' });
    if (!p.automations.length) emptyRow(aus, 'None — right-click a knob to create one');

    roots = SECTION_ORDER.map((id) => sec[id]!);
  }

  function walk(n: BNode, fn: (n: BNode) => void) {
    fn(n);
    if (n.children) for (const c of n.children) walk(c, fn);
  }

  function searchRows(q: string): BNode[] {
    const ql = q.toLowerCase();
    const hits: { n: BNode; s: number }[] = [];
    const seen = new Set<string>();
    const consider = (n: BNode) => {
      if (!LEAF.has(n.kind)) return;
      const ident = n.kind === 'sample' ? 's:' + n.ref : n.kind === 'preset' ? 'p:' + n.preset : n.key;
      if (seen.has(ident)) return;
      let s = fuzzyScore(q, n.label);
      if (n.where) {
        const i = n.where.toLowerCase().indexOf(ql);
        if (i >= 0) s = Math.max(s, 480 - i);
      }
      if (s < 0) return;
      if (n.section === 'project') s -= 5; // on near-ties, sounds and presets come before project items
      seen.add(ident);
      hits.push({ n, s });
    };
    // favourites last, so a favourite that also lives elsewhere shows up once under its real home
    for (const r of roots) if (r.section !== 'favs') walk(r, consider);
    for (const r of roots) if (r.section === 'favs') walk(r, consider);
    hits.sort((a, b) => b.s - a.s || coll.compare(a.n.label, b.n.label));
    return hits.slice(0, MAX_RESULTS).map((h) => h.n);
  }

  function flatten() {
    if (query) {
      rows = searchRows(query);
      status.textContent = rows.length ? `${rows.length >= MAX_RESULTS ? MAX_RESULTS + '+' : rows.length} ${rows.length === 1 ? 'result' : 'results'} · Esc clears` : 'No matches · Esc clears';
      return;
    }
    const out: BNode[] = [];
    const visit = (n: BNode) => {
      out.push(n);
      if (n.children && open.has(n.key)) for (const c of n.children) visit(c);
    };
    for (const r of roots) visit(r);
    rows = out;
  }

  function rebuild() {
    buildTree();
    flatten();
    render();
  }

  // ---------------- rendering (virtualised, keyed rows) ----------------
  function isFavNode(n: BNode) {
    const r = favRef(n);
    return !!r && favSet.has(r);
  }
  function isCurrent(n: BNode) {
    const ui = store.ui;
    if (n.kind === 'pattern') return n.id === ui.currentPattern;
    if (n.kind === 'channel') return ui.selectedChannels.includes(n.id!);
    if (n.kind === 'automation') return ui.plSource?.kind === 'automation' && ui.plSource.ref === n.id;
    return false;
  }
  function hintFor(n: BNode): string {
    switch (n.kind) {
      case 'sample':
        return `${n.label} — click to preview · double-click adds a new channel · drag onto the Channel rack or Playlist · Enter loads it into the selected channel`;
      case 'preset':
        return `${n.label} (Tri-Osc Synth preset) — double-click adds a synth channel · drag onto the Channel rack · Enter applies it to the selected synth channel`;
      case 'section':
      case 'folder':
        return n.root && n.key === 'uf|' + n.root ? `${n.root} — right-click to refresh or remove` : `${n.label} — click to expand / collapse (← →)`;
      case 'channel':
        return `${n.label} — click to select · double-click opens its settings`;
      case 'pattern':
        return `${n.label} — click to select · drag onto the Playlist to place it · double-click shows the Channel rack`;
      case 'automation':
        return `${n.label} — click to use as the Playlist's clip source`;
      case 'action':
        return n.label;
      default:
        return '';
    }
  }
  function iconEl(n: BNode, isOpen: boolean): HTMLElement {
    const e = el('span', { class: 'br-ic' });
    switch (n.kind) {
      case 'section':
      case 'action':
      case 'channel':
      case 'automation':
        e.innerHTML = n.icon ?? '';
        break;
      case 'folder':
        e.innerHTML = n.icon ?? (isOpen ? BR.folderOpen : BR.folder);
        break;
      case 'sample':
        e.innerHTML = BR.sample;
        break;
      case 'preset':
        e.innerHTML = n.icon ?? WAVE_ICON.sawtooth;
        break;
      case 'pattern':
        e.append(el('span', { class: 'br-swatch' }));
        break;
      case 'empty':
        break;
    }
    if (n.color) e.style.setProperty('--c', n.color);
    return e;
  }

  function paintRow(r: RowEl, n: BNode, i: number) {
    const flat = !!query;
    const isOpen = !flat && !!n.children && open.has(n.key);
    const fav = isFavNode(n);
    const meta = flat ? n.where ?? '' : n.meta ?? '';
    const depth = flat ? 0 : n.depth;
    const sig = `${n.kind}\u0001${n.label}\u0001${meta}\u0001${depth}\u0001${isOpen}\u0001${fav}\u0001${n.color ?? ''}\u0001${flat}`;
    r.style.top = i * RH + 'px';
    if (r.dataset.key !== n.key) r.dataset.key = n.key;
    if (r._sig !== sig) {
      r._sig = sig;
      r.className = 'br-row k-' + n.kind + (n.kind === 'section' ? ' s-' + n.section : '') + (flat ? ' flat' : '');
      r.style.paddingLeft = (flat ? 6 : 3 + depth * 12) + 'px';
      r.textContent = '';
      if (!flat) r.append(el('span', { class: 'br-tw' + (isOpen ? ' open' : ''), html: n.children ? BR.chevron : '' }));
      r.append(iconEl(n, isOpen), el('span', { class: 'br-label', text: n.label }));
      if (meta) r.append(el('span', { class: 'br-meta', text: meta }));
      if (n.kind === 'sample' || n.kind === 'preset')
        r.append(el('span', { class: 'br-star' + (fav ? ' on' : ''), html: fav ? ICONS.starFill : ICONS.star, 'data-hint': fav ? 'Remove from favorites' : 'Add to favorites' }));
      r.draggable = n.kind === 'sample' || n.kind === 'preset' || n.kind === 'pattern';
      r.dataset.hint = hintFor(n);
    }
    r.classList.toggle('sel', n.key === selKey);
    r.classList.toggle('cur', isCurrent(n));
  }

  function render() {
    if (!visible()) return;
    const n = rows.length;
    spacer.style.height = n * RH + 'px';
    const h = list.clientHeight || 600;
    const st = list.scrollTop;
    const i0 = Math.max(0, Math.floor(st / RH) - OVERSCAN);
    const i1 = Math.min(n, Math.ceil((st + h) / RH) + OVERSCAN);
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
    emptyMsg.textContent = query && !n ? `Nothing matches “${query}”` : '';
    emptyMsg.style.display = query && !n ? '' : 'none';
  }
  function renderSoon() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }
  function ensureVisible(i: number) {
    if (i < 0) return;
    const h = list.clientHeight;
    if (i * RH < list.scrollTop) list.scrollTop = i * RH;
    else if ((i + 1) * RH > list.scrollTop + h) list.scrollTop = (i + 1) * RH - h;
  }

  // ---------------- selection / open state ----------------
  const cur = () => (selKey ? byKey.get(selKey) : undefined);
  function select(n: BNode | undefined, scroll = false) {
    if (!n) return;
    const changed = selKey !== n.key;
    selKey = n.key;
    if (scroll) ensureVisible(rows.indexOf(n));
    render();
    if (changed) void showInfo(n);
  }
  function persistOpen() {
    saveList('lf.browser.open', [...open]);
  }
  /** If the selected node is hidden inside a collapsed folder, select that folder instead. */
  function revealSel() {
    const n = cur();
    if (!n || query) return;
    const chain: BNode[] = [];
    for (let p = n.parent; p; p = p.parent) chain.unshift(p);
    for (const a of chain)
      if (!open.has(a.key)) {
        selKey = a.key;
        void showInfo(a);
        return;
      }
  }
  function setOpen(n: BNode, on: boolean) {
    if (!n.children) return;
    if (on) open.add(n.key);
    else open.delete(n.key);
    revealSel();
    persistOpen();
    flatten();
    render();
  }
  const toggle = (n: BNode) => setOpen(n, !open.has(n.key));
  function setOpenDeep(n: BNode, on: boolean) {
    walk(n, (c) => {
      if (!c.children || c === n) return;
      if (on) open.add(c.key);
      else open.delete(c.key);
    });
    if (on) open.add(n.key);
    revealSel();
    persistOpen();
    flatten();
    render();
  }
  function collapseAll() {
    for (const k of [...open]) if (!k.startsWith('sec:')) open.delete(k);
    revealSel();
    persistOpen();
    flatten();
    render();
    ensureVisible(rows.findIndex((r) => r.key === selKey));
  }

  // ---------------- actions ----------------
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
    addChannel('synth', { preset: name });
    toast(`Added a Tri-Osc Synth (“${name}”) to the Channel rack`, 'ok', 1400);
  }
  function replaceSample(ref: string, name: string) {
    const ch = store.selectedChannel;
    if (!ch) {
      toast('There is no channel to load into — double-click the sound to add one', 'warn');
      return;
    }
    if (ch.type !== 'sampler' || !ch.sampler) {
      toast(`“${ch.name}” is a synth channel — double-click the sound to add it as a new channel`, 'warn', 3000);
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

  function favRef(n: BNode | undefined): string | null {
    if (!n) return null;
    if (n.kind === 'sample') return n.ref ?? null;
    if (n.kind === 'preset') return 'preset:' + n.preset;
    return null;
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
    open.add('sec:folders');
    open.add('uf|' + dir);
    persistOpen();
    await scan(dir);
    const n = byKey.get('uf|' + dir);
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
    open.add('sec:folders');
    persistOpen();
    rebuild();
    select(byKey.get('uf|' + got[0].ref), true);
    toast(`${plural(got.length, 'sound')} added (kept for this session)`, 'ok', 1600);
  }
  function removeSession(listArr: DragSample[], ref: string) {
    const i = listArr.findIndex((x) => x.ref === ref);
    if (i >= 0) listArr.splice(i, 1);
    rebuild();
  }

  // ---------------- info strip ----------------
  let infoTok = 0;
  let infoPreview: Preview = { kind: 'none' };
  function setInfo(icon: string, color: string | undefined, name: string, meta: string, pv: Preview, missing = false) {
    infoIc.innerHTML = icon;
    infoIc.style.setProperty('--c', color ?? 'var(--text-dim)');
    infoName.textContent = name;
    infoMeta.textContent = meta;
    info.classList.toggle('missing', missing);
    info.classList.toggle('idle', pv.kind === 'none');
    infoPreview = pv;
    drawPreview(wave, pv);
  }
  function idleInfo() {
    setInfo(BR.sample, undefined, 'Nothing selected', 'Click a sound to preview it', { kind: 'none' });
  }
  async function showInfo(n: BNode | undefined) {
    const tok = ++infoTok;
    if (!n || n.kind === 'empty') return idleInfo();
    switch (n.kind) {
      case 'sample': {
        const ref = n.ref!;
        setInfo(BR.sample, n.color, n.label, 'Loading…', { kind: 'none' });
        const b = await samples.ensure(ref);
        if (tok !== infoTok) return;
        if (!b) return setInfo(BR.sample, n.color, n.label, 'Missing or unreadable file', { kind: 'none' }, true);
        const chs = b.numberOfChannels === 1 ? 'Mono' : b.numberOfChannels === 2 ? 'Stereo' : b.numberOfChannels + ' ch';
        const pk = samples.peaks(ref, 200);
        return setInfo(BR.sample, n.color, n.label, `${fmtDur(b.duration)} · ${chs} · ${(b.sampleRate / 1000).toFixed(1)} kHz`, pk ? { kind: 'peaks', data: pk, color: n.color ?? '#f6a432' } : { kind: 'none' });
      }
      case 'preset': {
        const def = SYNTH_PRESETS.find((p) => p.name === n.preset);
        return setInfo(n.icon ?? WAVE_ICON.sawtooth, SYNTH_COLOR, n.label, `Tri-Osc Synth · ${def?.desc ?? ''}`, { kind: 'line', data: synthCurve(synthPreset(n.preset!)), color: SYNTH_COLOR });
      }
      case 'channel': {
        const c = store.channel(n.id);
        if (!c) return idleInfo();
        const route = c.mixer > 0 ? `Insert ${c.mixer}` : 'Master';
        if (c.type === 'synth' && c.synth) return setInfo(n.icon ?? '', c.color, c.name, `Tri-Osc Synth → ${route}`, { kind: 'line', data: synthCurve(c.synth), color: c.color });
        const ref = c.sampler?.sampleRef;
        setInfo(BR.sample, c.color, c.name, `Sampler · ${ref ? sampleName(ref) : 'empty'} → ${route}`, { kind: 'none' });
        if (!ref) return;
        const b = await samples.ensure(ref);
        if (tok !== infoTok || !b) return;
        const pk = samples.peaks(ref, 200);
        if (pk) setInfo(BR.sample, c.color, c.name, `Sampler · ${sampleName(ref)} · ${fmtDur(b.duration)} → ${route}`, { kind: 'peaks', data: pk, color: c.color });
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
        return setInfo('<span class="br-swatch"></span>', p.color, p.name, `Pattern ${i + 1} · ${plural(bars, 'bar')} · ${plural(used, 'channel')} · ${plural(notes.length, 'note')}`, { kind: 'notes', notes, length: len, color: p.color });
      }
      case 'automation': {
        const a = store.project.automations.find((x) => x.id === n.id);
        if (!a) return idleInfo();
        return setInfo(ICONS.automation, a.color, a.name, `Automation → ${describeTarget(a.target).name}`, { kind: 'auto', points: a.points, length: a.length, color: a.color });
      }
      case 'section':
      case 'folder': {
        const count = n.files ?? n.children?.filter((c) => c.kind !== 'empty' && c.kind !== 'action').length ?? 0;
        const what = n.files !== undefined ? 'sound' : 'item';
        const icon = n.icon ?? BR.folder;
        return setInfo(icon, n.color ?? (n.kind === 'section' ? 'var(--accent)' : undefined), n.label, n.root && n.key === 'uf|' + n.root ? `${plural(count, what)} · ${n.root}` : plural(count, what), { kind: 'none' });
      }
      case 'action':
        return setInfo(n.icon ?? BR.plus, 'var(--accent2)', n.label, isElectron ? 'Pick a folder — its sub-folders are scanned for audio' : 'Pick audio files from disk (kept for this session)', { kind: 'none' });
    }
  }

  // ---------------- context menus ----------------
  function menuFor(n: BNode, x: number, y: number) {
    const items: MenuItem[] = [];
    const ch = store.selectedChannel;
    const enterKey = commands.shortcutLabel('browser.enter');
    const addKey = commands.shortcutLabel('browser.addChannel');
    const favItem = (): MenuItem => ({ label: isFavNode(n) ? 'Remove from favorites' : 'Add to favorites', action: () => toggleFav(n) });
    switch (n.kind) {
      case 'sample':
        items.push(
          { label: 'Preview', action: () => void preview(n) },
          { label: 'Open in new channel', shortcut: addKey, action: () => addSampleChannel(n.ref!, n.label) },
          {
            label: ch?.type === 'sampler' ? `Replace sample in “${ch.name}”` : "Replace selected channel's sample",
            shortcut: enterKey,
            disabled: ch?.type !== 'sampler',
            action: () => replaceSample(n.ref!, n.label),
          },
          { sep: true },
          favItem(),
        );
        if (n.section === 'dropped') items.push({ label: 'Remove from list', action: () => removeSession(dropped, n.ref!) });
        if (n.section === 'folders' && !isElectron) items.push({ label: 'Remove from list', action: () => removeSession(picked, n.ref!) });
        if (n.root) items.push({ sep: true }, { label: 'Refresh folder', action: () => void scan(n.root!) });
        break;
      case 'preset':
        items.push(
          { label: 'Open in new channel', shortcut: addKey, action: () => addPresetChannel(n.preset!) },
          {
            label: ch?.type === 'synth' ? `Apply to “${ch.name}”` : 'Apply to selected synth channel',
            shortcut: enterKey,
            disabled: ch?.type !== 'synth',
            action: () => applyPreset(n.preset!),
          },
          { sep: true },
          favItem(),
        );
        break;
      case 'folder':
      case 'section':
        items.push(
          { label: open.has(n.key) ? 'Collapse' : 'Expand', action: () => toggle(n) },
          { label: 'Expand all inside', action: () => setOpenDeep(n, true) },
          { label: 'Collapse all inside', action: () => setOpenDeep(n, false) },
        );
        if (n.root) {
          items.push({ sep: true }, { label: 'Refresh', action: () => void scan(n.root!) });
          if (n.key === 'uf|' + n.root) items.push({ label: 'Remove from browser', action: () => removeFolder(n.root!) });
        }
        if (n.key === 'sec:folders') items.push({ sep: true }, { label: isElectron ? 'Add folder…' : 'Add audio files…', action: () => void (isElectron ? addFolder() : addFiles()) });
        if (n.key === 'sec:favs')
          items.push({ sep: true }, {
            label: 'Clear favorites',
            disabled: !favs.length,
            action: () => {
              favs.length = 0;
              favSet = new Set();
              saveList('lf.favs', favs);
              rebuild();
            },
          });
        if (n.key === 'sec:dropped')
          items.push({ sep: true }, {
            label: 'Clear list',
            disabled: !dropped.length,
            action: () => {
              dropped.length = 0;
              rebuild();
            },
          });
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
          { label: 'Channel settings…', action: () => openChannelSettings(n.id!) },
          { label: 'Open in Piano roll', action: () => { store.setUI({ selectedChannels: [n.id!], pianoRollChannel: n.id! }); wm.show('pianoroll'); } },
        );
        break;
      case 'automation':
        items.push({ label: 'Use as Playlist clip source', action: () => activate(n) }, { label: 'Show Playlist', action: () => wm.show('playlist') });
        break;
      case 'action':
        items.push({ label: n.label, action: () => n.run?.() });
        break;
    }
    if (items.length) showMenu(items, x, y);
  }
  function openChannelSettings(id: ID) {
    store.setUI({ settingsChannel: id });
    wm.show('channelsettings');
  }

  // ---------------- interaction ----------------
  function activate(n: BNode, clicks = 1) {
    select(n);
    switch (n.kind) {
      case 'section':
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
    }
  }

  const nodeOf = (t: EventTarget | null): BNode | undefined => {
    const r = t instanceof Element ? (t.closest('.br-row') as HTMLElement | null) : null;
    return r ? byKey.get(r.dataset.key ?? '') : undefined;
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
    if (n.kind === 'sample') addSampleChannel(n.ref!, n.label);
    else if (n.kind === 'preset') addPresetChannel(n.preset!);
    else if (n.kind === 'channel') openChannelSettings(n.id!);
    else if (n.kind === 'pattern') wm.show('channelrack');
    else if (n.kind === 'automation') wm.show('playlist');
  });
  list.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const n = nodeOf(e.target);
    if (n) menuFor(n, e.clientX, e.clientY);
    else
      showMenu(
        [
          { label: isElectron ? 'Add folder…' : 'Add audio files…', action: () => void (isElectron ? addFolder() : addFiles()) },
          { label: 'Collapse all', action: collapseAll },
        ],
        e.clientX,
        e.clientY,
      );
  });
  layer.addEventListener('dragstart', (e) => {
    const r = e.target instanceof Element ? (e.target.closest('.br-row') as RowEl | null) : null;
    const n = nodeOf(e.target);
    if (!r || !n) return;
    if (n.kind === 'sample') setDragData(e, DT_SAMPLE, { ref: n.ref, name: n.label });
    else if (n.kind === 'preset') setDragData(e, DT_PRESET, { preset: n.preset, name: n.preset });
    else if (n.kind === 'pattern') setDragData(e, DT_PATTERN, { id: n.id, name: n.label });
    else {
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
    open.add('sec:dropped');
    persistOpen();
    if (query) {
      input.value = '';
      onQuery();
    }
    rebuild();
    const first = byKey.get('drop|' + got[0].ref);
    if (first) {
      select(first, true);
      void preview(first);
    }
    toast(`${plural(got.length, 'sound')} added to Dropped files`, 'ok', 1500);
  });

  // ---------------- search box ----------------
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
      if (e.shiftKey) {
        if (n.kind === 'sample') addSampleChannel(n.ref!, n.label);
        else if (n.kind === 'preset') addPresetChannel(n.preset!);
        return;
      }
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

  // ---------------- keyboard API ----------------
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
      if (n.children && open.has(n.key)) setOpen(n, false);
      else if (n.parent) select(n.parent, true);
    },
    right() {
      const n = cur();
      if (!n || !rows.includes(n)) return move(1, false);
      if (query || !n.children) return;
      if (!open.has(n.key)) setOpen(n, true);
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
        case 'section':
        case 'folder':
          return toggle(n);
        case 'action':
          return n.run?.();
        case 'channel':
        case 'pattern':
        case 'automation':
          return activate(n);
      }
    },
    addSel() {
      const n = cur();
      if (n?.kind === 'sample') addSampleChannel(n.ref!, n.label);
      else if (n?.kind === 'preset') addPresetChannel(n.preset!);
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
  };
  registerCommands();

  // ---------------- store wiring ----------------
  const sigOf = () => {
    const p = store.project;
    if (!p) return '';
    return (
      p.channels.map((c) => `${c.id}:${c.name}:${c.color}:${c.type}:${c.mixer}:${c.type === 'synth' ? c.synth?.osc.find((o) => o.level > 0)?.wave : ''}`).join('|') +
      '#' +
      p.patterns.map((x) => `${x.id}:${x.name}:${x.color}`).join('|') +
      '#' +
      p.automations.map((a) => `${a.id}:${a.name}:${a.color}`).join('|')
    );
  };
  let infoRaf = 0;
  store.on('project', () => {
    const s = sigOf();
    if (s !== projSig) {
      projSig = s;
      rebuild();
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
    if (keys.includes('currentPattern') || keys.includes('selectedChannels') || keys.includes('plSource')) renderSoon();
  });

  new ResizeObserver(() => renderSoon()).observe(list);
  new ResizeObserver(() => drawPreview(wave, infoPreview)).observe(wave);

  // ---------------- header extra ----------------
  const headerExtra = el(
    'div',
    { class: 'br-hx' },
    iconBtn(isElectron ? BR.addFolder : BR.plus, isElectron ? 'Add a folder of sounds to the browser' : 'Add audio files to the browser (kept for this session)', () => void (isElectron ? addFolder() : addFiles()), 'br-hbtn'),
    iconBtn(BR.collapse, 'Collapse all folders', collapseAll, 'br-hbtn'),
  );

  // ---------------- init ----------------
  projSig = sigOf();
  buildTree();
  flatten();
  idleInfo();
  for (const dir of folders) void scan(dir);

  return {
    body: root,
    headerExtra,
    onShow: () => {
      render();
      drawPreview(wave, infoPreview);
    },
    onResize: renderSoon,
  };
}
