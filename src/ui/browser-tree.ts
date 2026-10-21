// Browser tree model: node types and the per-tab tree builders (ALL · PROJECT · PLUGINS · LIBRARY ·
// SOUNDS · STARRED). Builders are pure functions of the project + the browser's own state (env).
import { store } from '../core/store';
import type { ID, Wave } from '../core/types';
import { SYNTH_PRESETS, synthPreset } from '../core/project';
import { FX_DEFS, FX_ORDER } from '../core/params';
import { AudioListing, basename, isElectron } from '../core/native';
import { BUILTIN_SOUNDS } from '../audio/sounds';
import { allInstruments, getInstrument } from '../audio/plugins/registry';
import type { PluginPreset } from '../audio/plugins/api';
import type { DragSample } from './dnd';
import { getRecent } from './fileops';
import { ICONS } from './icons';
import { BI, BR, BR_TINT, CAT_COLOR, CAT_ICON, FX_COLOR, FX_ICON, SAMPLER_COLOR, SAMPLER_ICON, SYNTH_COLOR, WAVE_ICON } from './browser-icons';

export type Tab = 'all' | 'project' | 'plugins' | 'library' | 'sounds' | 'starred';
export const TABS: { id: Tab; label: string; short: string; hint: string }[] = [
  { id: 'all', label: 'ALL', short: 'ALL', hint: 'Everything: project, recent files, plugins, presets, sounds and starred items' },
  { id: 'project', label: 'PROJECT', short: 'PROJ', hint: 'What the current project uses: channels, patterns, automation and mixer effects' },
  { id: 'plugins', label: 'PLUGINS', short: 'PLUG', hint: 'Plugin database: every instrument and effect — double-click adds, drag onto the Channel rack / Mixer' },
  { id: 'library', label: 'LIBRARY', short: 'LIB', hint: 'Built-in sounds and factory presets for every instrument' },
  { id: 'sounds', label: 'SOUNDS', short: 'SND', hint: 'Your sound folders and files dropped onto the browser' },
  { id: 'starred', label: 'STARRED', short: '★', hint: 'Your starred sounds, presets and plugins' },
];

export type Kind =
  | 'folder'
  | 'sample'
  | 'preset' // Tri-Osc preset
  | 'plugpreset' // plugin factory / user preset
  | 'plugin' // instrument (registry id, 'triosc' or 'sampler')
  | 'fx'
  | 'channel'
  | 'pattern'
  | 'automation'
  | 'mixfx'
  | 'recent'
  | 'action'
  | 'empty';

export interface BNode {
  key: string;
  kind: Kind;
  label: string;
  depth: number;
  parent: BNode | null;
  children?: BNode[];
  tint?: string; // label colour (FL colour-codes top-level folders)
  color?: string; // icon colour
  icon?: string;
  meta?: string; // right-aligned text in tree mode
  where?: string; // breadcrumb shown with search results (also searched)
  info?: string; // one-line description for the info panel
  ref?: string; // sample ref
  preset?: string; // preset name
  plugin?: string; // instrument id
  fx?: string; // effect type
  id?: ID; // channel / pattern / automation / fx-slot id
  track?: number; // mixer track of an fx slot
  path?: string; // recent project path
  index?: number; // recent project index (Alt+0…9)
  root?: string; // user folder this node belongs to
  files?: number; // folders: sounds inside (recursive)
  thumb?: boolean; // draw a plugin thumbnail under the row
  run?: () => void;
}
type NodeInit = Omit<BNode, 'depth' | 'parent'>;

export interface TreeEnv {
  favs: readonly string[];
  folders: readonly string[];
  listings: Map<string, { loading: boolean; files: AudioListing[] }>;
  picked: readonly DragSample[];
  dropped: readonly DragSample[];
  sampleName(ref: string): string;
  sampleColor(ref: string): string;
  sourceOf(ref: string): string;
  resolvable(ref: string): boolean;
  addFolder(): void;
  addFiles(): void;
}

export const LEAF: ReadonlySet<Kind> = new Set<Kind>(['sample', 'preset', 'plugpreset', 'plugin', 'fx', 'channel', 'pattern', 'automation', 'mixfx', 'recent']);
export const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const stripExt = (n: string) => n.replace(/\.[^.\\/]+$/, '');

export const DEFAULT_OPEN: Record<Tab, string[]> = {
  all: ['sec:pdb', 'pdb/inst', 'pdb/inst/Synth'],
  project: ['proj/channels', 'proj/patterns', 'proj/auto', 'proj/fx'],
  plugins: ['pdb/inst', 'pdb/inst/Synth', 'pdb/inst/Sampler', 'pdb/fx', 'pdb/fx/Delay & reverb'],
  library: ['lib/sounds', 'bi/Kicks', 'lib/triosc'],
  sounds: ['sec:folders', 'sec:dropped'],
  starred: [],
};

/** FL groups its effects by purpose; ours follow the same idea. */
const FX_CAT: Record<string, string> = {
  compressor: 'Dynamics',
  limiter: 'Dynamics',
  eq: 'Filter & EQ',
  filter: 'Filter & EQ',
  reverb: 'Delay & reverb',
  delay: 'Delay & reverb',
  distortion: 'Distortion',
  bitcrusher: 'Distortion',
  riffstack: 'Distortion',
  chorus: 'Modulation',
  width: 'Stereo',
};

// ---------------- instrument catalogue (registry + built-ins) ----------------
export interface InstInfo {
  id: string;
  name: string;
  desc: string;
  category: string;
  color: string;
  icon: string;
}
export function instruments(): InstInfo[] {
  const list: InstInfo[] = allInstruments().map((p) => ({ id: p.id, name: p.name, desc: p.desc, category: p.category, color: p.color, icon: p.icon }));
  list.push({ id: 'triosc', name: 'Tri-Osc Synth', desc: 'Three-oscillator subtractive synth', category: 'Synth', color: SYNTH_COLOR, icon: WAVE_ICON.sawtooth });
  list.push({ id: 'sampler', name: 'Sampler', desc: 'Plays any audio file or built-in sound', category: 'Sampler', color: SAMPLER_COLOR, icon: SAMPLER_ICON });
  return list.sort((a, b) => coll.compare(a.name, b.name));
}
export function instInfo(id: string | undefined): InstInfo | undefined {
  return id ? instruments().find((x) => x.id === id) : undefined;
}
export function fxColor(type: string) {
  return (FX_COLOR as Record<string, string>)[type] ?? '#9fb2c2';
}
export function fxIcon(type: string) {
  return (FX_ICON as Record<string, string>)[type] ?? BI.knob;
}

/** Factory presets + presets the user saved from the plugin window (stored per plugin). */
export function pluginPresets(id: string): PluginPreset[] {
  const pl = getInstrument(id);
  if (!pl) return [];
  let user: PluginPreset[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem('lf.presets.' + id) ?? '[]');
    if (Array.isArray(raw)) user = raw.filter((p) => p && typeof p.name === 'string').map((p) => ({ ...p, category: 'User' }));
  } catch {}
  let factory: PluginPreset[] = [];
  try {
    factory = pl.presets();
  } catch {}
  return [...factory, ...user];
}

const presetWave = new Map<string, Wave>();
export function presetIcon(name: string) {
  let w = presetWave.get(name);
  if (!w) {
    w = synthPreset(name).osc.find((o) => o.level > 0)?.wave ?? 'sawtooth';
    presetWave.set(name, w);
  }
  return WAVE_ICON[w];
}

// ---------------- tree ----------------
export class Tree {
  byKey = new Map<string, BNode>();
  roots: BNode[] = [];

  add(parent: BNode | null, n: NodeInit): BNode {
    const node: BNode = { ...n, depth: parent ? parent.depth + 1 : 0, parent };
    if (parent) (parent.children ??= []).push(node);
    else this.roots.push(node);
    // keys are unique per tab; a duplicate (e.g. the same sound in two places) gets a suffix
    let k = node.key;
    for (let i = 2; this.byKey.has(k); i++) k = node.key + '#' + i;
    node.key = k;
    this.byKey.set(k, node);
    return node;
  }
  folder(parent: BNode | null, key: string, label: string, extra: Partial<NodeInit> = {}): BNode {
    return this.add(parent, { key, kind: 'folder', label, children: [], ...extra });
  }
  empty(parent: BNode | null, label: string) {
    return this.add(parent, { key: (parent?.key ?? 'root') + '|empty', kind: 'empty', label });
  }
}

export function walk(n: BNode, fn: (n: BNode) => void) {
  fn(n);
  if (n.children) for (const c of n.children) walk(c, fn);
}

// ---------------- section builders ----------------
function projectContents(t: Tree, parent: BNode | null) {
  const p = store.project;
  const tint = parent ? undefined : BR_TINT.project;
  const chs = t.folder(parent, 'proj/channels', 'Channels', { icon: BI.rack, meta: String(p.channels.length), tint, info: 'Every channel (generator) in the Channel rack' });
  for (const c of p.channels) {
    const plug = c.type === 'plugin' ? instInfo(c.plugin?.type) : undefined;
    const icon = plug ? plug.icon : c.type === 'synth' ? WAVE_ICON[c.synth?.osc.find((o) => o.level > 0)?.wave ?? 'sawtooth'] : BR.sample;
    t.add(chs, { key: 'ch|' + c.id, kind: 'channel', label: c.name, id: c.id, color: c.color, icon, meta: c.mixer > 0 ? `M${c.mixer}` : 'Master', where: 'Project › Channels' });
  }
  if (!p.channels.length) t.empty(chs, 'No channels yet');
  const pts = t.folder(parent, 'proj/patterns', 'Patterns', { icon: BI.pattern, meta: String(p.patterns.length), tint, info: 'Patterns — drag one onto the Playlist' });
  p.patterns.forEach((pt, i) => t.add(pts, { key: 'pt|' + pt.id, kind: 'pattern', label: pt.name, id: pt.id, color: pt.color, meta: String(i + 1), where: 'Project › Patterns' }));
  const aus = t.folder(parent, 'proj/auto', 'Automation clips', { icon: ICONS.automation, meta: String(p.automations.length), tint, info: 'Automation clips in the Playlist' });
  for (const a of p.automations) t.add(aus, { key: 'au|' + a.id, kind: 'automation', label: a.name, id: a.id, color: a.color, icon: ICONS.automation, where: 'Project › Automation' });
  if (!p.automations.length) t.empty(aus, 'None — right-click a knob to create one');
  let fxn = 0;
  for (const m of p.mixer) fxn += m.fx.length;
  const fxs = t.folder(parent, 'proj/fx', 'Effects', { icon: BI.mixer, meta: String(fxn), tint, info: 'Effects loaded in mixer slots' });
  p.mixer.forEach((m, i) => {
    const track = i === 0 ? 'Master' : m.name && m.name !== `Insert ${i}` ? `${i} · ${m.name}` : `Insert ${i}`;
    for (const f of m.fx) {
      const def = FX_DEFS[f.type];
      t.add(fxs, { key: 'mfx|' + f.id, kind: 'mixfx', label: def?.name ?? f.type, id: f.id, fx: f.type, track: i, color: fxColor(f.type), icon: fxIcon(f.type), meta: track, where: 'Project › Effects › ' + track, info: f.enabled ? 'On' : 'Bypassed' });
    }
  });
  if (!fxn) t.empty(fxs, 'No mixer effects yet');
}

function recentContents(t: Tree, parent: BNode | null) {
  const list = getRecent();
  list.forEach((path, i) => {
    const dir = basename(path.replace(/[\\/][^\\/]*$/, ''));
    t.add(parent, { key: 'rc|' + path, kind: 'recent', label: stripExt(basename(path)), path, index: i, icon: BI.project, color: BR_TINT.recent, meta: i < 10 ? `Alt+${i}` : '', where: 'Recent files' + (dir ? ' › ' + dir : '') });
  });
  if (!list.length) t.empty(parent, isElectron ? 'No recent projects yet' : 'Recent projects appear here in the desktop app');
}

function pluginDb(t: Tree, parent: BNode | null, thumbs: boolean) {
  const tint = parent ? BR_TINT.plugins : BR_TINT.plugins;
  const inst = t.folder(parent, 'pdb/inst', 'Instruments', { icon: BI.keys, tint, color: BR_TINT.plugins, info: 'Instruments (generators) — double-click adds a channel' });
  const cats = new Map<string, BNode>();
  for (const it of instruments()) {
    let c = cats.get(it.category);
    if (!c) {
      c = t.folder(inst, 'pdb/inst/' + it.category, it.category, { icon: BI.plug, tint: BR_TINT.pluginsDim, color: BR_TINT.plugins });
      cats.set(it.category, c);
    }
    t.add(c, { key: 'plug|' + it.id, kind: 'plugin', label: it.name, plugin: it.id, color: it.color, icon: it.icon, info: it.desc, thumb: thumbs, where: 'Plugins › Instruments › ' + it.category });
  }
  for (const c of cats.values()) c.meta = String(c.children!.length);
  inst.meta = String(instruments().length);
  const fx = t.folder(parent, 'pdb/fx', 'Effects', { icon: BI.knob, tint, color: BR_TINT.plugins, info: 'Effects — double-click adds one to the selected mixer track' });
  const fcats = new Map<string, BNode>();
  const order = FX_ORDER.filter((x) => FX_DEFS[x]);
  const groups = [...new Set(order.map((x) => FX_CAT[x] ?? 'Misc'))].sort((a, b) => coll.compare(a, b));
  for (const g of groups) fcats.set(g, t.folder(fx, 'pdb/fx/' + g, g, { icon: BI.plug, tint: BR_TINT.pluginsDim, color: BR_TINT.plugins }));
  for (const type of order) {
    const def = FX_DEFS[type];
    const g = fcats.get(FX_CAT[type] ?? 'Misc')!;
    t.add(g, { key: 'fx|' + type, kind: 'fx', label: def.name, fx: type, color: fxColor(type), icon: fxIcon(type), info: def.desc, thumb: thumbs, where: 'Plugins › Effects › ' + (FX_CAT[type] ?? 'Misc') });
  }
  for (const g of fcats.values()) {
    g.children!.sort((a, b) => coll.compare(a.label, b.label));
    g.meta = String(g.children!.length);
  }
  fx.meta = String(order.length);
}

function builtinSounds(t: Tree, parent: BNode | null) {
  const cats = new Map<string, BNode>();
  for (const s of BUILTIN_SOUNDS) {
    let c = cats.get(s.category);
    if (!c) {
      c = t.folder(parent, 'bi/' + s.category, s.category, { color: CAT_COLOR[s.category], icon: CAT_ICON[s.category] });
      cats.set(s.category, c);
    }
    const ref = 'builtin:' + s.id;
    t.add(c, { key: 'bi|' + ref, kind: 'sample', label: s.name, ref, color: CAT_COLOR[s.category], where: 'Built-in sounds › ' + s.category });
  }
  for (const c of cats.values()) {
    c.files = c.children!.length;
    c.meta = String(c.files);
  }
}

function presetLibrary(t: Tree, parent: BNode | null) {
  const tri = t.folder(parent, 'lib/triosc', 'Tri-Osc Synth', { icon: WAVE_ICON.sawtooth, color: SYNTH_COLOR, meta: String(SYNTH_PRESETS.length), info: 'Tri-Osc Synth presets' });
  for (const p of SYNTH_PRESETS) t.add(tri, { key: 'tri|' + p.name, kind: 'preset', label: p.name, preset: p.name, color: SYNTH_COLOR, icon: presetIcon(p.name), info: p.desc, where: 'Presets › Tri-Osc Synth' });
  for (const pl of allInstruments()) {
    const list = pluginPresets(pl.id);
    const f = t.folder(parent, 'lib/pl/' + pl.id, pl.name, { icon: pl.icon, color: pl.color, meta: String(list.length), info: `${pl.name} presets` });
    const cats = new Map<string, BNode>();
    for (const pr of list) {
      const cat = pr.category || 'Presets';
      let c = cats.get(cat);
      if (!c) {
        c = t.folder(f, `lib/pl/${pl.id}/${cat}`, cat, { color: pl.color });
        cats.set(cat, c);
      }
      t.add(c, { key: `pp|${pl.id}|${cat}|${pr.name}`, kind: 'plugpreset', label: pr.name, preset: pr.name, plugin: pl.id, color: pl.color, icon: BI.presets, where: `Presets › ${pl.name} › ${cat}` });
    }
    for (const c of cats.values()) c.meta = String(c.children!.length);
    if (!list.length) t.empty(f, 'No presets');
  }
}

function fillDir(t: Tree, rootNode: BNode, dir: string, files: AudioListing[]) {
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
        d = t.folder(cur, `uf|${dir}|d|${acc}`, part, { root: dir, where: rootName + '/' + acc });
        dirs.set(acc, d);
      }
      cur = d;
    }
    t.add(cur, { key: `uf|${dir}|f|${f.rel}`, kind: 'sample', label: stripExt(f.name), ref: 'file:' + f.path, root: dir, where: acc ? rootName + '/' + acc : rootName, color: SAMPLER_COLOR });
  }
  const finish = (n: BNode): number => {
    if (!n.children) return n.kind === 'sample' ? 1 : 0;
    n.children.sort((a, b) => ((a.kind === 'folder') !== (b.kind === 'folder') ? (a.kind === 'folder' ? -1 : 1) : coll.compare(a.label, b.label)));
    let c = 0;
    for (const ch of n.children) c += finish(ch);
    n.files = c;
    n.meta = String(c);
    return c;
  };
  finish(rootNode);
}

function userFolders(t: Tree, parent: BNode, env: TreeEnv) {
  if (isElectron) {
    t.add(parent, { key: 'act|addFolder', kind: 'action', label: 'Add folder…', icon: BR.addFolder, run: env.addFolder });
    for (const dir of env.folders) {
      const rn = t.folder(parent, 'uf|' + dir, basename(dir) || dir, { root: dir, where: dir });
      const st = env.listings.get(dir);
      if (!st || st.loading) t.empty(rn, 'Scanning…');
      else if (!st.files.length) t.empty(rn, 'No audio files found');
      else fillDir(t, rn, dir, st.files);
    }
  } else {
    t.add(parent, { key: 'act|addFiles', kind: 'action', label: 'Add audio files…', icon: BR.plus, run: env.addFiles });
    for (const s of env.picked) t.add(parent, { key: 'uf|' + s.ref, kind: 'sample', label: s.name, ref: s.ref, color: SAMPLER_COLOR, where: 'Your files' });
  }
}

function droppedFiles(t: Tree, parent: BNode, env: TreeEnv) {
  for (const s of env.dropped) t.add(parent, { key: 'drop|' + s.ref, kind: 'sample', label: s.name, ref: s.ref, color: SAMPLER_COLOR, where: 'Dropped files' });
  if (!env.dropped.length) t.empty(parent, 'Drop audio files onto the browser');
}

/** Resolve a starred reference to a leaf node (or null when it no longer exists). */
function starredNode(t: Tree, parent: BNode | null, r: string, env: TreeEnv) {
  const base = { key: 'fav|' + r };
  if (r.startsWith('preset:')) {
    const name = r.slice(7);
    const p = SYNTH_PRESETS.find((x) => x.name === name);
    if (p) t.add(parent, { ...base, kind: 'preset', label: name, preset: name, color: SYNTH_COLOR, icon: presetIcon(name), meta: 'Tri-Osc', info: p.desc, where: 'Starred › Tri-Osc preset' });
  } else if (r.startsWith('plugpreset:')) {
    const [, id, ...rest] = r.split(':');
    const name = rest.join(':');
    const pl = getInstrument(id);
    if (pl && pluginPresets(id).some((x) => x.name === name)) t.add(parent, { ...base, kind: 'plugpreset', label: name, preset: name, plugin: id, color: pl.color, icon: BI.presets, meta: pl.name, where: 'Starred › ' + pl.name + ' preset' });
  } else if (r.startsWith('plugin:')) {
    const it = instInfo(r.slice(7));
    if (it) t.add(parent, { ...base, kind: 'plugin', label: it.name, plugin: it.id, color: it.color, icon: it.icon, meta: 'Instrument', info: it.desc, where: 'Starred › Instrument' });
  } else if (r.startsWith('fx:')) {
    const type = r.slice(3);
    const def = (FX_DEFS as Record<string, (typeof FX_DEFS)[keyof typeof FX_DEFS] | undefined>)[type];
    if (def) t.add(parent, { ...base, kind: 'fx', label: def.name, fx: type, color: fxColor(type), icon: fxIcon(type), meta: 'Effect', info: def.desc, where: 'Starred › Effect' });
  } else if (env.resolvable(r)) {
    t.add(parent, { ...base, kind: 'sample', label: env.sampleName(r), ref: r, color: env.sampleColor(r), meta: env.sourceOf(r), where: 'Starred › ' + env.sourceOf(r) });
  }
}

function starred(t: Tree, parent: BNode | null, env: TreeEnv) {
  const before = t.byKey.size;
  for (const r of env.favs) starredNode(t, parent, r, env);
  if (t.byKey.size === before) t.empty(parent, 'Star sounds, presets and plugins (☆ on a row) to collect them here');
}

/** Build the tree shown by one tab. */
export function buildTab(tab: Tab, env: TreeEnv, thumbs: boolean): Tree {
  const t = new Tree();
  switch (tab) {
    case 'all': {
      const proj = t.folder(null, 'sec:project', 'Current project', { icon: BI.page, tint: BR_TINT.project, color: BR_TINT.project, info: 'Channels, patterns, automation and effects of this project' });
      projectContents(t, proj);
      const rec = t.folder(null, 'sec:recent', 'Recent files', { icon: BI.recent, tint: BR_TINT.recent, color: BR_TINT.recent, info: 'Recently opened projects' });
      recentContents(t, rec);
      const pdb = t.folder(null, 'sec:pdb', 'Plugin database', { icon: BI.plugDb, tint: BR_TINT.plugins, color: BR_TINT.plugins, info: 'Every instrument and effect' });
      pluginDb(t, pdb, thumbs);
      const pre = t.folder(null, 'sec:presets', 'Plugin presets', { icon: BI.presets, tint: BR_TINT.plugins, color: '#c59be8', info: 'Factory and user presets of every instrument' });
      presetLibrary(t, pre);
      const snd = t.folder(null, 'sec:sounds', 'Built-in sounds', { icon: BI.packs, tint: BR_TINT.library, color: '#e8b04a', files: BUILTIN_SOUNDS.length, info: 'Procedurally generated drum kit, 808s and FX' });
      builtinSounds(t, snd);
      const uf = t.folder(null, 'sec:folders', isElectron ? 'Your folders' : 'Your files', { icon: BI.folder, tint: BR_TINT.user, color: '#9fb2c2', info: isElectron ? 'Folders of sounds you added' : 'Audio files you added this session' });
      userFolders(t, uf, env);
      const dr = t.folder(null, 'sec:dropped', 'Dropped files', { icon: BI.tray, tint: BR_TINT.user, color: '#9fb2c2', info: 'Audio files dropped onto the browser' });
      droppedFiles(t, dr, env);
      const st = t.folder(null, 'sec:starred', 'Starred', { icon: BI.star, tint: BR_TINT.starred, color: BR_TINT.starred, info: 'Your favourites' });
      starred(t, st, env);
      break;
    }
    case 'project':
      projectContents(t, null);
      break;
    case 'plugins':
      pluginDb(t, null, thumbs);
      break;
    case 'library': {
      const snd = t.folder(null, 'lib/sounds', 'Built-in sounds', { icon: BI.packs, tint: BR_TINT.library, color: '#e8b04a', files: BUILTIN_SOUNDS.length, meta: String(BUILTIN_SOUNDS.length), info: 'Procedurally generated drum kit, 808s and FX' });
      builtinSounds(t, snd);
      presetLibrary(t, null);
      break;
    }
    case 'sounds': {
      const uf = t.folder(null, 'sec:folders', isElectron ? 'Your folders' : 'Your files', { icon: BI.folder, tint: BR_TINT.user, color: '#9fb2c2', info: isElectron ? 'Folders of sounds you added' : 'Audio files you added this session' });
      userFolders(t, uf, env);
      const dr = t.folder(null, 'sec:dropped', 'Dropped files', { icon: BI.tray, tint: BR_TINT.user, color: '#9fb2c2', info: 'Audio files dropped onto the browser' });
      droppedFiles(t, dr, env);
      break;
    }
    case 'starred':
      starred(t, null, env);
      break;
  }
  return t;
}
