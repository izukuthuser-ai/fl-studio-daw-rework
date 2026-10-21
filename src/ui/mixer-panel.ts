// Mixer side panel (FL 21 layout) for the selected track: audio input selector at the top, ten effect
// slots (click a filled slot to open its plugin window, an empty one to pick an effect), the track EQ
// graph, and the output (routing) selector at the bottom. Persistent parts are patched in place; only
// the slot list is rebuilt, and only when the track or its effect chain changes.
import { store } from '../core/store';
import { FxSlot, MixerTrack } from '../core/types';
import { FX_DEFS, FX_MIX_PARAM, fmtParam } from '../core/params';
import { clamp, el } from '../core/util';
import { MenuItem, knob, select, showMenu } from './widgets';
import { createAutomation, createsLoop } from './ops';
import { openFxWindow } from './pluginWindow';
import { getFxUI } from '../audio/plugins/registry';
import { engine } from '../audio/engine';
import { DT_FX } from './dnd';
import { EqView } from './mixer-eq';
import {
  MAX_FX,
  commitSlot,
  destOf,
  findSlot,
  insertFx,
  liveSlot,
  moveFx,
  removeFx,
  replaceFx,
  resetFx,
  routeTracks,
  setInput,
  toggleFx,
  trackLabel,
} from './mixer-ops';
import { DT_FXSLOT, IC, fitX, fxPickItems, inputLabel, inputOptions, inputState, readFxDrop, setHint, setText } from './mixer-ui';

export class FxPanel {
  readonly root: HTMLElement;
  readonly expanded = new Set<string>();
  private list: HTMLElement;
  private scrollEl: HTMLElement;
  private eq = new EqView();
  private inSel: HTMLSelectElement;
  private inLed: HTMLElement;
  private inMsg: HTMLElement;
  private outSel: HTMLSelectElement;
  private sig = '';
  private builtFor = '';
  private ups: (() => void)[] = [];
  private inSig = '';
  private outSig = '';

  constructor() {
    // ---- input (top) ----
    this.inSel = el('select', { class: 'mx-p-sel', 'data-hint': 'Audio input for this track (mic / line-in / interface) — it plays through the track’s effects; arm the track and record to capture it' }) as HTMLSelectElement;
    this.inSel.addEventListener('change', () => {
      const i = this.ti();
      if (i >= 0) setInput([i], this.inSel.value);
      this.inSel.blur(); // give the keyboard back to the mixer shortcuts
    });
    this.inSel.addEventListener('keydown', (e) => e.stopPropagation());
    this.inLed = el('div', { class: 'mx-p-inled' });
    this.inMsg = el('div', { class: 'mx-p-msg' });
    const inRow = el('div', { class: 'mx-p-row in' }, el('span', { class: 'mx-p-ic', html: IC.jackIn }), el('div', { class: 'mx-p-selw' }, this.inSel), this.inLed);

    // ---- slots ----
    this.list = el('div', { class: 'mx-fxlist' });
    this.scrollEl = el('div', { class: 'mx-p-scroll' }, this.list);

    // ---- output (bottom) ----
    this.outSel = el('select', { class: 'mx-p-sel', 'data-hint': 'Output — send this track to the master or another insert (destinations that would create a feedback loop are disabled)' }) as HTMLSelectElement;
    this.outSel.addEventListener('change', () => {
      const i = this.ti();
      if (i > 0) routeTracks([i], parseInt(this.outSel.value, 10));
      this.outSel.blur();
    });
    this.outSel.addEventListener('keydown', (e) => e.stopPropagation());
    const outRow = el('div', { class: 'mx-p-row out' }, el('span', { class: 'mx-p-ic', html: IC.jackOut }), el('div', { class: 'mx-p-selw' }, this.outSel));

    this.root = el('div', { class: 'mx-panel' }, inRow, this.inMsg, this.scrollEl, this.eq.root, outRow);
  }

  private track(): MixerTrack | undefined {
    const m = store.project.mixer;
    return m[clamp(store.ui.selectedMixer, 0, m.length - 1)];
  }
  private ti(): number {
    const id = this.builtFor;
    return store.project.mixer.findIndex((x) => x.id === id);
  }

  sync(force = false) {
    const t = this.track();
    const sig = t ? `${t.id}|${t.fx.map((f) => f.id + ':' + f.type + (this.expanded.has(f.id) ? '+' : '')).join(',')}` : '';
    if (force || sig !== this.sig) {
      this.sig = sig;
      this.buildSlots(t);
    }
    for (const u of this.ups) u();
    this.syncInput();
    this.syncOutput();
    if (t) this.eq.setTrack(t.id);
  }

  /** Input selector + live / error state (also called when the engine's input manager changes). */
  syncInput() {
    const t = this.track();
    if (!t) return;
    const opts = inputOptions();
    const cur = t.input ?? '';
    const known = opts.some((o) => o.value === cur);
    const s = opts.map((o) => o.value + '=' + o.label).join('|') + '#' + (known ? '' : cur);
    if (s !== this.inSig) {
      this.inSig = s;
      this.inSel.textContent = '';
      for (const o of opts) this.inSel.append(el('option', { value: o.value, text: o.label }));
      if (!known) this.inSel.append(el('option', { value: cur, text: 'Unavailable input' }));
    }
    if (this.inSel.value !== cur && document.activeElement !== this.inSel) this.inSel.value = cur;
    const st = inputState(t);
    this.inLed.className = 'mx-p-inled ' + st;
    const dev = inputLabel(t.input);
    const err = st === 'error' ? ((engine.ready ? engine.inputs?.error : null) ?? 'Input unavailable').replace(/:\s*$/, ' (device not found)') + ' — pick another input' : '';
    const msg = st === 'live' ? (t.armed ? `Live · armed — Record + Play records “${dev}”` : 'Live input · arm the track to record it') : st === 'pending' ? `Opening “${dev}”…` : st === 'error' ? err : '';
    setText(this.inMsg, msg);
    this.inMsg.className = 'mx-p-msg ' + st;
    setHint(this.inLed, st === 'live' ? `Input live: ${dev}` : st === 'pending' ? 'Opening input…' : st === 'error' ? err : 'No input');
  }

  private syncOutput() {
    const m = store.project.mixer;
    const i = this.ti();
    if (i < 0) return;
    const s = i + '#' + m.map((z) => z.name + '>' + z.route).join('|');
    if (s !== this.outSig) {
      this.outSig = s;
      this.outSel.textContent = '';
      if (i === 0) {
        this.outSel.append(el('option', { value: '-1', text: 'Audio output' }));
        this.outSel.disabled = true;
      } else {
        this.outSel.disabled = false;
        m.forEach((_, j) => {
          if (j === i) return;
          const o = el('option', { value: String(j), text: trackLabel(j) }) as HTMLOptionElement;
          o.disabled = createsLoop(m, i, j);
          this.outSel.append(o);
        });
      }
    }
    const v = i === 0 ? '-1' : String(destOf(m, i));
    if (this.outSel.value !== v && document.activeElement !== this.outSel) this.outSel.value = v;
  }

  // ---------------------------------------------------------------------------
  // slots
  // ---------------------------------------------------------------------------
  private buildSlots(t: MixerTrack | undefined) {
    const keepScroll = t && t.id === this.builtFor ? this.scrollEl.scrollTop : 0;
    this.ups = [];
    this.list.textContent = '';
    this.builtFor = t?.id ?? '';
    if (!t) return;
    const ti = () => this.ti();
    for (let k = 0; k < MAX_FX; k++) {
      const s = t.fx[k];
      if (s) {
        this.list.append(this.slotRow(s, k));
        if (this.expanded.has(s.id)) this.list.append(this.editor(s));
      } else this.list.append(this.emptyRow(k, ti));
    }
    this.scrollEl.scrollTop = keepScroll;
  }

  private slotRow(s: FxSlot, k: number): HTMLElement {
    const sid = s.id;
    const def = FX_DEFS[s.type];
    const name = def?.name ?? s.type;
    const slot = () => findSlot(store.project, sid)?.slot;
    const arrow = el('div', { class: 'mx-fx-arrow', html: IC.menu, 'data-hint': 'Slot menu: replace, insert, move, reset, remove' });
    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = arrow.getBoundingClientRect();
      this.slotMenu(sid, r.left, r.bottom + 2);
    });
    const nm = el('div', { class: 'mx-fx-name', text: name });
    const led = el('div', { class: 'mx-fx-led' });
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFx(sid);
    });
    const mix = knob({
      def: FX_MIX_PARAM,
      size: 16,
      name,
      get: () => slot()?.mix ?? 1,
      set: (v) => liveSlot(sid, (x) => (x.mix = v)),
      begin: () => store.begin('Effect mix'),
      end: () => store.end(),
    });
    mix.classList.add('mx-fx-mix');
    const row = el('div', { class: 'mx-fx filled', draggable: 'true', 'data-hint': `Slot ${k + 1}: ${name} — ${def?.desc ?? ''}. Click to open its window · drag to reorder · right-click for options` }, arrow, nm, mix, led);
    row.addEventListener('click', () => openFxWindow(sid));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.slotMenu(sid, e.clientX, e.clientY);
    });
    row.addEventListener('dragstart', (e) => {
      if ((e.target as HTMLElement).closest('.knob')) {
        e.preventDefault();
        return;
      }
      e.dataTransfer?.setData(DT_FXSLOT, sid);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    this.dropTarget(row, k);
    let lastMix = NaN;
    let lastEn: boolean | null = null;
    this.ups.push(() => {
      const x = slot();
      if (!x) return;
      if (x.enabled !== lastEn) {
        lastEn = x.enabled;
        led.classList.toggle('on', x.enabled);
        row.classList.toggle('bypassed', !x.enabled);
        setHint(led, `${name} ${x.enabled ? 'on' : 'bypassed'} — click to ${x.enabled ? 'bypass' : 'enable'}`);
      }
      if (x.mix !== lastMix) {
        lastMix = x.mix;
        mix.update();
      }
    });
    return row;
  }

  private emptyRow(k: number, ti: () => number): HTMLElement {
    const arrow = el('div', { class: 'mx-fx-arrow', html: IC.menu });
    const row = el(
      'div',
      { class: 'mx-fx empty', 'data-hint': `Slot ${k + 1} (empty) — click to insert an effect, or drop one here` },
      arrow,
      el('div', { class: 'mx-fx-name', text: `Slot ${k + 1}` }),
      el('div', { class: 'mx-fx-ph' }),
      el('div', { class: 'mx-fx-led' }),
    );
    row.addEventListener('click', () => {
      const r = row.getBoundingClientRect();
      const i = ti();
      showMenu(
        fxPickItems((type) => {
          const id = insertFx(i, type, k);
          if (id) openFxWindow(id, 'show'); // FL opens the plugin right away
        }),
        fitX(r.left + 16, 360),
        r.bottom + 1,
      );
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      row.click();
    });
    this.dropTarget(row, k);
    return row;
  }

  private dropTarget(row: HTMLElement, k: number) {
    row.addEventListener('dragover', (e) => {
      const types = Array.from(e.dataTransfer?.types ?? []);
      if (!types.includes(DT_FXSLOT) && !types.includes(DT_FX)) return;
      e.preventDefault();
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop');
      const sid = e.dataTransfer?.getData(DT_FXSLOT);
      if (sid) {
        e.preventDefault();
        moveFx(sid, k);
        return;
      }
      const type = readFxDrop(e);
      if (type) {
        e.preventDefault();
        insertFx(this.ti(), type, k);
      }
    });
  }

  private slotMenu(sid: string, x: number, y: number) {
    const f = findSlot(store.project, sid);
    if (!f) return;
    const n = f.track.fx.length;
    const open = this.expanded.has(sid);
    const items: MenuItem[] = [
      { label: 'Open plugin window', action: () => openFxWindow(sid, 'show') },
      { label: f.slot.enabled ? 'Bypass' : 'Enable', action: () => toggleFx(sid) },
      {
        label: open ? 'Hide controls in mixer' : 'Show controls in mixer',
        // effects with their own editor (e.g. the Riffstack rack) only open in their window
        disabled: !!getFxUI(f.slot.type) && !open,
        action: () => {
          if (open) this.expanded.delete(sid);
          else this.expanded.add(sid);
          this.sync();
        },
      },
      { sep: true },
      {
        label: 'Replace with',
        submenu: fxPickItems((type) => {
          const id = replaceFx(sid, type);
          if (id && open) this.expanded.add(id);
        }, f.slot.type),
      },
      { label: 'Insert above', disabled: n >= MAX_FX, submenu: n >= MAX_FX ? undefined : fxPickItems((type) => insertFx(f.index, type, f.k)) },
      { label: 'Move up', disabled: f.k === 0, action: () => moveFx(sid, f.k - 1) },
      { label: 'Move down', disabled: f.k >= n - 1, action: () => moveFx(sid, f.k + 1) },
      { label: 'Reset parameters', action: () => resetFx(sid) },
      { sep: true },
      { label: 'Remove', action: () => removeFx(sid) },
    ];
    showMenu(items, fitX(x, 380), y);
  }

  /** Optional inline parameter page under a slot ("Show controls in mixer"). */
  private editor(s: FxSlot): HTMLElement {
    const sid = s.id;
    const def = FX_DEFS[s.type];
    if (getFxUI(s.type)) {
      return el('div', { class: 'mx-fx-ed' }, el('button', { class: 'btn small', text: `Open ${def?.name ?? 'editor'}…`, onclick: () => openFxWindow(sid, 'show') }));
    }
    const slot = () => findSlot(store.project, sid)?.slot;
    const grid = el('div', { class: 'mx-fx-ed' });
    for (const pd of def?.params ?? []) {
      const get = () => slot()?.params[pd.key] ?? pd.def;
      const automate = () => createAutomation({ scope: 'fx', id: sid, param: pd.key });
      if (pd.options) {
        const sel = select(
          pd.options.map((o, idx) => ({ value: idx, label: o })),
          Math.round(get()),
          (v) => commitSlot(sid, `${def.name} ${pd.label}`, (x) => (x.params[pd.key] = v)),
          `${def.name} — ${pd.label}`,
        );
        sel.addEventListener('change', () => sel.blur());
        sel.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showMenu([{ label: 'Create automation clip', action: automate }], e.clientX, e.clientY);
        });
        grid.append(el('div', { class: 'mx-pc wide' }, el('div', { class: 'mx-pc-l', text: pd.label }), sel));
        this.ups.push(() => {
          const v = String(Math.round(get()));
          if (sel.value !== v && document.activeElement !== sel) sel.value = v;
        });
      } else {
        const val = el('div', { class: 'mx-pc-v' });
        const kb = knob({
          def: pd,
          size: 26,
          name: def.name,
          bipolar: pd.min < 0 && Math.abs(pd.min + pd.max) < 1e-9,
          get,
          set: (v) => liveSlot(sid, (x) => (x.params[pd.key] = v)),
          begin: () => store.begin(`${def.name} ${pd.label}`),
          end: () => store.end(),
          onAutomate: automate,
        });
        let last = NaN;
        this.ups.push(() => {
          const v = get();
          if (v === last) return;
          last = v;
          kb.update();
          setText(val, fmtParam(pd, v));
        });
        grid.append(el('div', { class: 'mx-pc' }, kb, el('div', { class: 'mx-pc-l', text: pd.label }), val));
      }
    }
    return grid;
  }
}
