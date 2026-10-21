// Plugin picker (F8): a searchable grid of instruments (Tri-Osc Synth presets, an empty Sampler and
// every built-in sound) and effects. Click or Enter adds the plugin; tiles can also be dragged onto
// the Channel rack (instruments) or a mixer strip / FX slot (effects).
import './pluginPicker.css';
import { store } from '../core/store';
import { engine } from '../audio/engine';
import { BUILTIN_SOUNDS } from '../audio/sounds';
import { SYNTH_PRESETS, synthPreset } from '../core/project';
import { FX_DEFS, FX_ORDER } from '../core/params';
import { clamp, el, fuzzyScore } from '../core/util';
import { hooks } from './actions';
import { addChannel, addFx } from './ops';
import { DT_FX, DT_PRESET, DT_SAMPLE, setDragData } from './dnd';
import { modal } from './widgets';
import { wm } from './wm';
import { ICONS } from './icons';
import { allInstruments } from '../audio/plugins/registry';
import { openPluginWindow } from './pluginWindow';
import { BR, CAT_COLOR, CAT_ICON, FX_COLOR, FX_ICON, SAMPLER_COLOR, SAMPLER_ICON, SYNTH_COLOR, WAVE_ICON } from './browser-icons';

const MAX_FX_SLOTS = 10;

type Group = 'synth' | 'sampler' | 'fx';
interface Item {
  key: string;
  group: Group;
  name: string;
  desc: string;
  icon: string;
  color: string;
  keywords: string;
  hint: string;
  pick: () => void;
  drag?: (e: DragEvent) => void;
  previewRef?: string;
}

function buildItems(): Item[] {
  const items: Item[] = [];
  const toRack = () => wm.show('channelrack');
  for (const pl of allInstruments()) {
    items.push({
      key: 'plug:' + pl.id,
      group: 'synth',
      name: pl.name,
      desc: pl.desc,
      icon: pl.icon,
      color: pl.color,
      keywords: `${pl.name} ${pl.desc} plugin instrument synth ${pl.presets().map((x) => x.name).join(' ')}`,
      hint: `${pl.name} — ${pl.desc}. Click or Enter adds it to the Channel rack and opens it`,
      pick: () => {
        const id = addChannel('plugin', { pluginType: pl.id, group: 'Synths' });
        toRack();
        openPluginWindow(id, 'show');
      },
    });
  }
  for (const p of SYNTH_PRESETS) {
    const wave = synthPreset(p.name).osc.find((o) => o.level > 0)?.wave ?? 'sawtooth';
    items.push({
      key: 'syn:' + p.name,
      group: 'synth',
      name: p.name,
      desc: p.desc,
      icon: WAVE_ICON[wave],
      color: SYNTH_COLOR,
      keywords: `tri-osc synth instrument preset ${p.desc}`,
      hint: `${p.name} — Tri-Osc Synth preset (${p.desc}). Click or Enter adds a synth channel · drag onto the Channel rack`,
      pick: () => {
        addChannel('synth', { preset: p.name });
        toRack();
      },
      drag: (e) => setDragData(e, DT_PRESET, { preset: p.name, name: p.name }),
    });
  }
  items.push({
    key: 'smp:empty',
    group: 'sampler',
    name: 'Sampler (empty)',
    desc: 'Load a sound later',
    icon: SAMPLER_ICON,
    color: SAMPLER_COLOR,
    keywords: 'sampler instrument empty audio file',
    hint: 'Empty Sampler — click or Enter adds a channel; drop a sound on it later',
    pick: () => {
      addChannel('sampler');
      toRack();
    },
  });
  for (const s of BUILTIN_SOUNDS) {
    const ref = 'builtin:' + s.id;
    items.push({
      key: 'snd:' + s.id,
      group: 'sampler',
      name: s.name,
      desc: 'Sampler · ' + s.category,
      icon: CAT_ICON[s.category],
      color: CAT_COLOR[s.category],
      keywords: `sampler built-in sound ${s.category}`,
      hint: `${s.name} (${s.category}) — click or Enter adds a Sampler channel · ▶ previews · drag onto the Channel rack or Playlist`,
      pick: () => {
        addChannel('sampler', { sampleRef: ref });
        toRack();
      },
      drag: (e) => setDragData(e, DT_SAMPLE, { ref, name: s.name }),
      previewRef: ref,
    });
  }
  for (const t of FX_ORDER) {
    const d = FX_DEFS[t];
    items.push({
      key: 'fx:' + t,
      group: 'fx',
      name: d.name,
      desc: d.desc,
      icon: FX_ICON[t],
      color: FX_COLOR[t],
      keywords: `effect fx ${t} ${d.desc}`,
      hint: `${d.name} — ${d.desc}. Click or Enter adds it to the selected mixer track · drag onto any mixer strip or FX slot`,
      pick: () => {
        addFx(clamp(store.ui.selectedMixer, 0, store.project.mixer.length - 1), t);
        wm.show('mixer');
      },
      drag: (e) => setDragData(e, DT_FX, { type: t, name: d.name }),
    });
  }
  return items;
}

function score(q: string, it: Item): number {
  let s = fuzzyScore(q, it.name);
  const k = it.keywords.toLowerCase().indexOf(q.toLowerCase());
  if (k >= 0) s = Math.max(s, 600 - k * 0.5);
  return s;
}

function fxTarget(): string {
  const m = store.project.mixer;
  const i = clamp(store.ui.selectedMixer, 0, m.length - 1);
  const t = m[i];
  if (!t) return '';
  const label = i === 0 ? 'Master' : `Insert ${i}${t.name && t.name !== `Insert ${i}` ? ' · ' + t.name : ''}`;
  return `Adds to ${label} — ${t.fx.length}/${MAX_FX_SLOTS} slots used`;
}

let current: { close: (v: null) => void } | null = null;

function open() {
  if (current) {
    current.close(null); // F8 again closes the picker
    return;
  }
  const items = buildItems();
  const input = el('input', { class: 'pp-q', type: 'text', placeholder: 'Search instruments and effects…', spellcheck: false, 'data-hint': 'Type to filter (fuzzy) — arrows move, Enter adds, Esc closes' }) as HTMLInputElement;
  const count = el('span', { class: 'pp-count' });
  const scroll = el('div', { class: 'pp-scroll' });
  const body = el(
    'div',
    { class: 'pp' },
    el('div', { class: 'pp-search' }, el('span', { class: 'pp-search-ic', html: ICONS.search }), input, count),
    scroll,
  );

  let vis: { it: Item; el: HTMLElement; s: number }[] = [];
  let hl = 0;
  let hlEl: HTMLElement | null = null;
  let lastQ: string | null = null;
  const lastPtr = { x: -1, y: -1 };

  const dlg = modal<null>('Plugin picker', body, [{ label: 'Close', value: null }], {
    width: 760,
    cancelValue: null,
    onKey: (e) => {
      switch (e.key) {
        case 'ArrowDown':
          moveV(1);
          break;
        case 'ArrowUp':
          moveV(-1);
          break;
        case 'ArrowRight':
          moveH(1);
          break;
        case 'ArrowLeft':
          moveH(-1);
          break;
        case 'Enter':
          pick(hl);
          break;
        case 'F8':
          dlg.close(null);
          break;
        default:
          return false;
      }
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
  });
  current = dlg;
  void dlg.promise.then(() => {
    if (current === dlg) current = null;
  });
  dlg.root.classList.add('pp-modal');
  const overlay = dlg.root.parentElement;
  dlg.root.querySelector('.modal-buttons')?.prepend(
    el(
      'div',
      { class: 'pp-foot' },
      el('kbd', { text: '↑↓←→' }),
      ' move ',
      el('kbd', { text: 'Enter' }),
      ' add ',
      el('kbd', { text: 'Esc' }),
      ' close',
      el('span', { class: 'pp-foot-sep' }),
      'Drag a tile onto the Channel rack or a mixer slot',
    ),
  );

  function paintHl(scrollTo: boolean) {
    const t = vis[hl]?.el ?? null;
    if (hlEl !== t) {
      hlEl?.classList.remove('hl');
      t?.classList.add('hl');
      hlEl = t;
    }
    if (scrollTo) t?.scrollIntoView({ block: 'nearest' });
  }

  function tile(x: { it: Item; s: number }): HTMLElement {
    const i = vis.length;
    const it = x.it;
    const ic = el('div', { class: 'pp-ic', html: it.icon });
    ic.style.setProperty('--c', it.color);
    const t = el(
      'div',
      { class: 'pp-tile g-' + it.group, 'data-hint': it.hint, draggable: !!it.drag },
      ic,
      el('div', { class: 'pp-tx' }, el('div', { class: 'pp-name', text: it.name }), el('div', { class: 'pp-desc', text: it.desc })),
    );
    t.style.setProperty('--c', it.color);
    if (it.previewRef) {
      const ref = it.previewRef;
      const pb = el('button', { class: 'pp-play', html: BR.play, 'data-hint': `Preview ${it.name}` });
      pb.addEventListener('click', (e) => {
        e.stopPropagation();
        void engine.previewSample(ref);
      });
      t.append(pb);
    }
    t.addEventListener('pointermove', (e) => {
      // ignore the synthetic moves browsers send while keyboard navigation scrolls the grid
      if (e.screenX === lastPtr.x && e.screenY === lastPtr.y) return;
      lastPtr.x = e.screenX;
      lastPtr.y = e.screenY;
      if (hl !== i) {
        hl = i;
        paintHl(false);
      }
    });
    t.addEventListener('click', () => pick(i));
    if (it.drag) {
      t.addEventListener('dragstart', (e) => {
        it.drag!(e);
        // let drops reach the windows underneath, and make sure the target window is open
        setTimeout(() => {
          overlay?.classList.add('pp-dragging');
          const target = it.group === 'fx' ? 'mixer' : 'channelrack';
          if (!wm.get(target)?.visible) wm.show(target);
        }, 0);
      });
      t.addEventListener('dragend', (e) => {
        if (e.dataTransfer && e.dataTransfer.dropEffect !== 'none') dlg.close(null);
        else overlay?.classList.remove('pp-dragging');
      });
    }
    vis.push({ it, el: t, s: x.s });
    return t;
  }

  function section(title: string, sub: string, groups: { label: string; list: { it: Item; s: number }[] }[], wide = false) {
    const total = groups.reduce((a, g) => a + g.list.length, 0);
    if (!total) return;
    const sec = el(
      'div',
      { class: 'pp-sec' },
      el('div', { class: 'pp-sec-h' }, el('span', { class: 'pp-sec-t', text: title }), el('span', { class: 'pp-sec-n', text: String(total) }), el('span', { class: 'pp-sec-x', text: sub })),
    );
    for (const g of groups) {
      if (!g.list.length) continue;
      if (g.label) sec.append(el('div', { class: 'pp-grp', text: g.label }));
      const grid = el('div', { class: 'pp-grid' + (wide ? ' wide' : '') });
      for (const x of g.list) grid.append(tile(x));
      sec.append(grid);
    }
    scroll.append(sec);
  }

  function render() {
    const q = input.value.trim();
    const scored = items.map((it) => ({ it, s: q ? score(q, it) : 0 })).filter((x) => x.s >= 0);
    if (q) scored.sort((a, b) => b.s - a.s);
    scroll.textContent = '';
    vis = [];
    hlEl = null;
    const by = (g: Group) => scored.filter((x) => x.it.group === g);
    section('Instruments', 'Adds a new channel to the Channel rack', [
      { label: 'Tri-Osc Synth', list: by('synth') },
      { label: 'Sampler', list: by('sampler') },
    ]);
    section('Effects', fxTarget(), [{ label: '', list: by('fx') }], true);
    if (!vis.length) scroll.append(el('div', { class: 'pp-empty' }, el('div', { class: 'pp-empty-ic', html: ICONS.search }), `Nothing matches “${q}”`));
    count.textContent = q ? `${vis.length} of ${items.length}` : `${items.length}`;
    if (q !== lastQ) {
      lastQ = q;
      hl = 0;
      if (q) {
        let best = -Infinity;
        vis.forEach((v, i) => {
          if (v.s > best) {
            best = v.s;
            hl = i;
          }
        });
      }
      scroll.scrollTop = 0;
    }
    hl = clamp(hl, 0, Math.max(0, vis.length - 1));
    paintHl(true);
  }

  function pick(i: number) {
    const v = vis[i];
    if (!v) return;
    dlg.close(null);
    v.it.pick();
  }
  function moveH(d: 1 | -1) {
    if (!vis.length) return;
    hl = clamp(hl + d, 0, vis.length - 1);
    paintHl(true);
  }
  /** Geometric up/down: nearest tile in the next row above/below (works across grids). */
  function moveV(d: 1 | -1) {
    const curEl = vis[hl]?.el;
    if (!curEl) return;
    const r0 = curEl.getBoundingClientRect();
    const cx = r0.left + r0.width / 2;
    const cy = r0.top + r0.height / 2;
    const cands = vis.map((v, i) => {
      const r = v.el.getBoundingClientRect();
      return { i, dy: (r.top + r.height / 2 - cy) * d, dx: Math.abs(r.left + r.width / 2 - cx) };
    }).filter((c) => c.dy > 4);
    if (!cands.length) return;
    const minDy = Math.min(...cands.map((c) => c.dy));
    const row = cands.filter((c) => c.dy <= minDy + 4);
    row.sort((a, b) => a.dx - b.dx);
    hl = row[0].i;
    paintHl(true);
  }

  input.addEventListener('input', render);
  render();
  setTimeout(() => input.focus(), 0);
}

export function initPluginPicker() {
  hooks.openPluginPicker = open;
}
