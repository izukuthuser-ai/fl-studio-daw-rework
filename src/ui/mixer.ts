// Mixer window (F9), laid out like FL Studio 21: a header with the mixer menu and view presets, the
// "C" (current) and master strips docked on the left, insert strips with routing arrows and send
// cables, and the selected track's panel (input, 10 FX slots, EQ, output) on the right.
// Strips are keyed by track id and updated in place; DOM is only restructured when the track list
// changes, so a control being dragged always survives.
import './mixer.css';
import { store } from '../core/store';
import { commands } from '../core/commands';
import { engine } from '../audio/engine';
import { clamp, el } from '../core/util';
import { MenuItem, showMenu, toast } from './widgets';
import { addMixerTrack, linkChannelsToTrack } from './ops';
import { wm } from './wm';
import type { PanelDef } from './panel';
import { DT_FX } from './dnd';
import { destOf, moveTrack, renameTrack, soloTrack, trackLabel, unmuteAll } from './mixer-ops';
import { CurrentStrip, Strip, buildCtx } from './mixer-strip';
import { FxPanel } from './mixer-panel';
import { IC, inputLabel, inputOptions, inputState, keyFor, mxHooks, renderArmed, selIndex, selectTrack, setHint, setText } from './mixer-ui';
export { DT_FX };

// ---------------------------------------------------------------------------
// view presets (FL: Compact / Wide / Extra large)
// ---------------------------------------------------------------------------
interface View {
  id: string;
  label: string;
  w: number; // insert strip width
  mw: number; // master strip width
  cw: number; // current strip width
  band: number; // header band height
  name: number; // name + meter area height
  knob: number; // pan knob
  sknob: number; // stereo separation knob
  capW: number;
  capH: number;
  meter: number; // meter bar width
  fs: number; // name font size
}
const VIEWS: View[] = [
  { id: 'compact', label: 'Compact', w: 36, mw: 42, cw: 30, band: 18, name: 88, knob: 22, sknob: 14, capW: 13, capH: 21, meter: 3, fs: 10 },
  { id: 'wide', label: 'Wide', w: 46, mw: 54, cw: 36, band: 28, name: 114, knob: 27, sknob: 17, capW: 16, capH: 26, meter: 5, fs: 11 },
  { id: 'xl', label: 'Extra large', w: 62, mw: 70, cw: 44, band: 34, name: 156, knob: 34, sknob: 21, capW: 21, capH: 32, meter: 6, fs: 12.5 },
];
function loadView(): View {
  let id = 'wide';
  try {
    id = localStorage.getItem('lf.mixer.view') ?? 'wide';
  } catch {}
  return VIEWS.find((v) => v.id === id) ?? VIEWS[1];
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------
export function createMixer(): PanelDef {
  const views = new Map<string, Strip>();
  let order: Strip[] = [];
  let idSig = '';
  let dirty = false;
  let view = loadView();
  let zoneH = 0;
  const visible = () => !!wm?.get('mixer')?.visible;

  const current = new CurrentStrip();
  const masterSlot = el('div', { class: 'mx-master-slot' }, current.root);
  const inserts = el('div', { class: 'mx-inserts' });
  const addBtn = el('button', { class: 'mx-add', html: IC.plus, 'data-hint': 'Add an insert track (no limit)' });
  addBtn.addEventListener('click', () => {
    const i = addMixerTrack();
    selectTrack(i);
    mxHooks.ensureVisible(i);
  });
  const ns = 'http://www.w3.org/2000/svg';
  const cables = document.createElementNS(ns, 'svg');
  cables.setAttribute('class', 'mx-cables');
  const strips = el('div', { class: 'mx-strips' }, masterSlot, inserts, addBtn);
  strips.append(cables);
  const wrap = el('div', { class: 'mx-wrap' }, strips);
  const panel = new FxPanel();
  const root = el('div', { class: 'mixer' }, wrap, panel.root);

  let panelOn = true;
  try {
    panelOn = localStorage.getItem('lf.mixer.panel') !== '0';
  } catch {}
  root.classList.toggle('no-panel', !panelOn);

  // vertical wheel scrolls the strips horizontally (controls handle their own wheel)
  wrap.addEventListener(
    'wheel',
    (e) => {
      if (e.defaultPrevented || e.ctrlKey) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        wrap.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false },
  );
  wrap.addEventListener('scroll', () => queueCables(), { passive: true });

  const ensureVisible = (i: number) => {
    const v = order[i];
    if (!v || i === 0) return;
    const masterW = masterSlot.offsetWidth;
    const left = v.root.offsetLeft;
    const right = left + v.root.offsetWidth;
    if (left - masterW < wrap.scrollLeft) wrap.scrollLeft = left - masterW;
    else if (right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = right - wrap.clientWidth + 40;
  };
  mxHooks.ensureVisible = (i: number) => {
    if (i < 0) return;
    queueMicrotask(() => requestAnimationFrame(() => ensureVisible(i)));
  };

  // ---- structure ----
  function reconcile() {
    const m = store.project.mixer;
    const next = new Map<string, Strip>();
    const newOrder: Strip[] = [];
    m.forEach((t, i) => {
      const key = t.id + (i === 0 ? ':M' : '');
      let v = views.get(key);
      if (!v) {
        v = new Strip(t.id, i);
        if (zoneH) v.setFaderSize(zoneH, view.capH);
      }
      v.index = i;
      next.set(key, v);
      newOrder.push(v);
    });
    for (const [key, v] of views) if (!next.has(key)) v.root.remove();
    views.clear();
    for (const [k, v] of next) views.set(k, v);
    order = newOrder;
    // master (after the current strip)
    const mv = order[0];
    if (mv && current.root.nextSibling !== mv.root) masterSlot.append(mv.root);
    // inserts: only move nodes that are out of place (keeps a dragged control alive)
    let prev: ChildNode | null = null;
    for (let k = 1; k < order.length; k++) {
      const node = order[k].root;
      const expected: ChildNode | null = prev ? prev.nextSibling : inserts.firstChild;
      if (expected !== node) inserts.insertBefore(node, expected);
      prev = node;
    }
    while (prev && prev.nextSibling) prev.nextSibling.remove();
    if (!prev) inserts.textContent = '';
  }

  // ---- header ----
  const title = el('div', { class: 'mx-title' });
  let lastTitle = '';
  function syncTitle() {
    const m = store.project.mixer;
    const i = selIndex();
    const t = m[i];
    if (!t) return;
    const s = `Mixer - ${t.name}`;
    if (s !== lastTitle) {
      lastTitle = s;
      setText(title, s);
      wm?.get('mixer')?.setTitle(s);
    }
    const ch = store.project.channels.filter((c) => c.mixer === i || (i === 0 && (c.mixer < 0 || c.mixer >= m.length))).map((c) => c.name);
    const ins: number[] = [];
    for (let k = 1; k < m.length; k++) if (destOf(m, k) === i) ins.push(k);
    const fed = [ch.join(', '), ins.length ? (i === 0 ? `${ins.length} inserts` : 'inserts ' + ins.join(', ')) : ''].filter(Boolean).join(' + ') || 'nothing';
    setHint(title, `${i === 0 ? 'Master' : 'Insert ' + i} “${t.name}” · fed by ${fed} · ${i === 0 ? 'audio output' : '→ ' + trackLabel(destOf(m, i))}${t.input ? ' · input: ' + inputLabel(t.input) : ''} — drag to move the window`);
  }

  // ---- sync ----
  function sync(force = false) {
    if (!store.project) return;
    const m = store.project.mixer;
    const ids = m.map((t) => t.id).join(',');
    if (ids !== idSig) {
      idSig = ids;
      reconcile();
    }
    if (!force && !visible()) {
      dirty = true;
      return;
    }
    dirty = false;
    order.forEach((v, i) => (v.index = i));
    const u = buildCtx();
    for (const v of order) v.update(u);
    panel.sync();
    syncTitle();
    queueCables();
  }

  // ---- send cables (selected track → its destination), FL style ----
  let cablesQueued = false;
  let cableSig = '';
  function queueCables() {
    if (cablesQueued) return;
    cablesQueued = true;
    requestAnimationFrame(drawCables);
  }
  function drawCables() {
    cablesQueued = false;
    if (!visible()) return;
    const m = store.project.mixer;
    const sel = selIndex();
    const sr = strips.getBoundingClientRect();
    let d = '';
    let clip = false;
    let clipX = 0;
    if (sel > 0) {
      const dest = destOf(m, sel);
      const a = order[sel]?.sendEl.getBoundingClientRect();
      const b = order[dest]?.sendEl.getBoundingClientRect();
      if (a && b && a.width && b.width) {
        const x1 = a.left + a.width / 2 - sr.left, y1 = a.bottom - sr.top - 1;
        const x2 = b.left + b.width / 2 - sr.left, y2 = b.bottom - sr.top - 1;
        const yb = Math.min(sr.height - 2, Math.max(y1, y2) + 9);
        d = `M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${yb.toFixed(1)} ${x2.toFixed(1)},${yb.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
        clip = dest > 0;
        clipX = masterSlot.getBoundingClientRect().right - sr.left;
      }
    }
    const w = strips.scrollWidth;
    const sig = `${d}|${clip}|${clipX.toFixed(1)}|${w}|${sr.height}`;
    if (sig === cableSig) return;
    cableSig = sig;
    cables.setAttribute('width', String(w));
    cables.setAttribute('height', String(Math.round(sr.height)));
    cables.innerHTML = d
      ? `<defs><clipPath id="mxCableClip"><rect x="${clipX.toFixed(1)}" y="0" width="${Math.max(0, w - clipX)}" height="${Math.round(sr.height)}"/></clipPath></defs>` +
        `<g ${clip ? 'clip-path="url(#mxCableClip)"' : ''}><path class="mx-cable-sh" d="${d}"/><path class="mx-cable" d="${d}"/></g>`
      : '';
  }

  // ---- fader size follows the strip layout ----
  function measure() {
    const z = (order[1] ?? order[0])?.zone;
    const h = z ? Math.floor(z.clientHeight) : 0;
    if (h < 24) return;
    if (h !== zoneH) {
      zoneH = h;
      for (const v of order) v.setFaderSize(h, view.capH);
      sync();
    }
    queueCables();
  }
  const ro = new ResizeObserver(() => measure());
  ro.observe(wrap);

  // ---- view presets ----
  const viewLbl = el('span', { class: 'mx-view-l' });
  function applyView(v: View, save = true) {
    view = v;
    const s = root.style;
    s.setProperty('--mx-strip-w', v.w + 'px');
    s.setProperty('--mx-master-w', v.mw + 'px');
    s.setProperty('--mx-cur-w', v.cw + 'px');
    s.setProperty('--mx-band-h', v.band + 'px');
    s.setProperty('--mx-name-h', v.name + 'px');
    s.setProperty('--mx-knob', v.knob + 'px');
    s.setProperty('--mx-sknob', v.sknob + 'px');
    s.setProperty('--mx-cap-w', v.capW + 'px');
    s.setProperty('--mx-cap-h', v.capH + 'px');
    s.setProperty('--mx-meter-w', v.meter + 'px');
    s.setProperty('--mx-fs', v.fs + 'px');
    root.dataset.view = v.id;
    setText(viewLbl, v.label);
    if (save)
      try {
        localStorage.setItem('lf.mixer.view', v.id);
      } catch {}
    zoneH = 0; // force re-measure: the cap size may have changed
    requestAnimationFrame(() => {
      measure();
      const i = selIndex();
      if (i > 0) ensureVisible(i);
    });
  }
  const stepView = (d: number) => applyView(VIEWS[(VIEWS.indexOf(view) + d + VIEWS.length) % VIEWS.length]);

  // ---- meters ----
  let raf = 0;
  let lastT = 0;
  const frame = (t: number) => {
    raf = requestAnimationFrame(frame);
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 1 / 60;
    lastT = t;
    const levels = engine.ready ? engine.readMeters() : [];
    for (let k = 0; k < order.length; k++) order[k].tick(levels[k], dt, t);
    current.tick(levels, selIndex(), dt, t);
  };
  const startMeters = () => {
    if (!raf) {
      lastT = 0;
      raf = requestAnimationFrame(frame);
    }
  };
  const stopMeters = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  // ---- store / engine wiring ----
  store.on('project', () => sync());
  store.on('loaded', () => {
    panel.expanded.clear();
    idSig = '';
    for (const v of views.values()) v.root.remove();
    views.clear();
    sync(true);
  });
  store.on('ui', (keys) => {
    if (keys.includes('selectedMixer') || keys.includes('selectedMixerTracks')) sync();
  });
  // live-input state changes asynchronously (permission, device open/close, errors)
  let inSig = '';
  const onInputs = () => {
    const s = store.project.mixer.map((t) => inputState(t)).join('') + '|' + inputOptions().map((o) => o.value + o.label).join(',') + '|' + (engine.inputs?.error ?? '');
    if (s === inSig) return;
    inSig = s;
    if (visible()) {
      sync();
      panel.syncInput();
    } else dirty = true;
  };
  engine.init().then(() => engine.inputs?.onChange(onInputs));

  // ---- header extra ----
  const hbtn = (icon: string, hint: string, fn: (b: HTMLElement) => void, cls = '') => {
    const b = el('button', { class: 'mx-hbtn ' + cls, html: icon, 'data-hint': hint });
    b.addEventListener('click', () => fn(b));
    return b;
  };
  const panelBtn = hbtn(IC.panel, 'Show / hide the mixer track panel (input, effects, EQ, output)', () => togglePanel(), 'icon' + (panelOn ? ' on' : ''));
  function togglePanel() {
    panelOn = !panelOn;
    root.classList.toggle('no-panel', !panelOn);
    panelBtn.classList.toggle('on', panelOn);
    headerExtra.classList.toggle('no-panel', !panelOn);
    try {
      localStorage.setItem('lf.mixer.panel', panelOn ? '1' : '0');
    } catch {}
    requestAnimationFrame(() => queueCables());
  }
  const addInsert = () => {
    const i = addMixerTrack();
    selectTrack(i);
    mxHooks.ensureVisible(i);
  };
  const resetMeters = () => {
    for (const v of order) v.resetMeter();
  };
  const mixerMenu = (b: HTMLElement) => {
    const r = b.getBoundingClientRect();
    const items: MenuItem[] = [
      { label: 'Add insert track', action: addInsert },
      { label: 'Rename selected track…', shortcut: keyFor('mixer.rename'), action: () => renameTrack(selIndex()) },
      { label: 'Unmute all tracks', action: unmuteAll },
      { label: 'Render armed tracks to WAV…', shortcut: keyFor('mixer.render'), action: renderArmed },
      { label: 'Reset peak meters', action: resetMeters },
      { sep: true },
      ...VIEWS.map((v) => ({ label: `View: ${v.label}`, checked: v === view, action: () => applyView(v) })),
      { label: 'Show track panel', checked: panelOn, action: togglePanel },
    ];
    showMenu(items, r.left, r.bottom + 2);
  };
  const viewBox = el(
    'div',
    { class: 'mx-view' },
    hbtn(IC.left, 'Previous mixer view preset', () => stepView(-1), 'arrow'),
    el('button', { class: 'mx-view-btn', 'data-hint': 'Mixer view preset (strip width / height) — click to choose: Compact, Wide, Extra large' }, viewLbl),
    hbtn(IC.tri, 'Next mixer view preset', () => stepView(1), 'arrow'),
  );
  (viewBox.querySelector('.mx-view-btn') as HTMLElement).addEventListener('click', (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(VIEWS.map((v) => ({ label: v.label, checked: v === view, action: () => applyView(v) })), r.left, r.bottom + 2);
  });
  const sp = el('div', { class: 'mx-hx-sp' });
  // FL keeps the title above the track panel; dragging it (or the empty header) moves the window
  const forwardDrag = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const h = wm?.get('mixer')?.header;
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: false, cancelable: true, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, button: 0, buttons: 1, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: true }));
  };
  const forwardDbl = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    wm?.get('mixer')?.header.dispatchEvent(new MouseEvent('dblclick', { bubbles: false, clientX: e.clientX, clientY: e.clientY }));
  };
  for (const x of [sp, title]) {
    x.addEventListener('pointerdown', forwardDrag);
    x.addEventListener('dblclick', forwardDbl);
  }
  const headerExtra = el(
    'div',
    { class: 'mx-hx' + (panelOn ? '' : ' no-panel') },
    hbtn(IC.menu, 'Mixer menu — tracks, render, view presets', mixerMenu, 'mxmenu'),
    hbtn(IC.plus, 'Add an insert track', addInsert, 'icon'),
    hbtn(IC.unmute, 'Unmute every mixer track (clears solo)', unmuteAll, 'icon'),
    hbtn(IC.render, `Render armed tracks to WAV stems (${keyFor('mixer.render') || 'Alt+R'})`, renderArmed, 'icon'),
    viewBox,
    sp,
    panelBtn,
    title,
  );

  registerMixerCommands(ensureVisible);
  applyView(view, false);
  sync(true);

  return {
    body: root,
    headerExtra,
    onShow: () => {
      sync(true);
      startMeters();
      requestAnimationFrame(() => measure());
    },
    onHide: () => stopMeters(),
    onResize: () => {
      if (dirty && visible()) sync(true);
      queueCables();
    },
  };
}

let registered = false;
function registerMixerCommands(ensureVisible: (i: number) => void) {
  if (registered) return;
  registered = true;
  const sel = () => clamp(store.ui.selectedMixer, 0, store.project.mixer.length - 1);
  const step = (d: -1 | 1) => {
    const i = clamp(sel() + d, 0, store.project.mixer.length - 1);
    selectTrack(i);
    ensureVisible(i);
  };
  const move = (d: -1 | 1) => {
    const j = moveTrack(sel(), d);
    if (j > 0) requestAnimationFrame(() => ensureVisible(j));
  };
  commands.register([
    { id: 'mixer.solo', label: 'Solo selected track', category: 'Mixer', ctx: 'mixer', keys: ['S'], run: () => soloTrack(sel()) },
    { id: 'mixer.soloRouting', label: 'Solo selected track with its routing', category: 'Mixer', ctx: 'mixer', keys: ['Alt+S'], run: () => soloTrack(sel(), true) },
    {
      id: 'mixer.selectAll',
      label: 'Select all mixer tracks',
      category: 'Mixer',
      ctx: 'mixer',
      keys: ['Ctrl+A'],
      run: () => store.setUI({ selectedMixerTracks: store.project.mixer.map((_, i) => i) }),
    },
    {
      id: 'mixer.link',
      label: 'Link selected channels to selected track',
      category: 'Mixer',
      ctx: 'mixer',
      keys: ['Ctrl+L'],
      run: () => {
        if (!store.ui.selectedChannels.length) toast('Select channels in the Channel Rack first', 'warn');
        else linkChannelsToTrack(sel(), store.ui.selectedChannels);
      },
    },
    { id: 'mixer.moveLeft', label: 'Move track left', category: 'Mixer', ctx: 'mixer', keys: ['Alt+Left'], run: () => move(-1), repeat: true },
    { id: 'mixer.moveRight', label: 'Move track right', category: 'Mixer', ctx: 'mixer', keys: ['Alt+Right'], run: () => move(1), repeat: true },
    { id: 'mixer.rename', label: 'Rename mixer track…', category: 'Mixer', ctx: 'mixer', keys: ['F2'], run: () => renameTrack(sel()) },
    { id: 'mixer.render', label: 'Render armed tracks to WAV', category: 'Mixer', ctx: 'mixer', keys: ['Alt+R'], run: renderArmed },
    { id: 'mixer.prev', label: 'Select previous mixer track', category: 'Mixer', ctx: 'mixer', keys: ['Left'], run: () => step(-1), repeat: true },
    { id: 'mixer.next', label: 'Select next mixer track', category: 'Mixer', ctx: 'mixer', keys: ['Right'], run: () => step(1), repeat: true },
    {
      id: 'mixer.add',
      label: 'Add mixer insert track',
      category: 'Mixer',
      ctx: 'mixer',
      keys: [],
      run: () => {
        const i = addMixerTrack();
        selectTrack(i);
        requestAnimationFrame(() => ensureVisible(i));
      },
    },
    { id: 'mixer.unmuteAll', label: 'Unmute all mixer tracks', category: 'Mixer', ctx: 'mixer', keys: [], run: unmuteAll },
  ]);
}
