// Mixer window (F9): master + insert strips with peak meters, routing, and the selected
// track's 10-slot effect rack. Strips are keyed by track id and updated in place; DOM is only
// restructured when the track list changes, so a control being dragged always survives.
import './mixer.css';
import { store } from '../core/store';
import { commands } from '../core/commands';
import { engine } from '../audio/engine';
import { FxSlot, FxType, MixerTrack } from '../core/types';
import { FX_DEFS, FX_MIX_PARAM, FX_ORDER, MIXER_PARAMS, ParamDef, fmtParam } from '../core/params';
import { PALETTE, clamp, el, fmtDb } from '../core/util';
import { FaderOpts, KnobEl, KnobOpts, MenuItem, colorMenu, fader, knob, promptDialog, select, showMenu, toast } from './widgets';
import { addFx, addMixerTrack, createAutomation, createsLoop, linkChannelsToTrack } from './ops';
import { exportAudio } from './fileops';
import { wm } from './wm';
import type { PanelDef } from './panel';
import {
  MAX_FX,
  commitSlot,
  dbToNorm,
  deleteTracks,
  destOf,
  faderFromNorm,
  findSlot,
  fmtDbShort,
  insertFx,
  insertTrackAfter,
  lastSoloKey,
  liveSlot,
  moveFx,
  moveTrack,
  normToDb,
  removeFx,
  renameTrack,
  replaceFx,
  resetFx,
  routeTracks,
  setArmed,
  setColor,
  setVolume,
  soloTrack,
  soloedTracks,
  targetsFor,
  toggleFx,
  toggleMute,
  trackLabel,
  unmuteAll,
} from './mixer-ops';

/** Drag type for reordering effect slots inside the rack. */
const DT_FXSLOT = 'application/x-loopforge-fxslot';
/** Drag type accepted from other windows (e.g. plugin picker): JSON { type: FxType }. */
import { DT_FX } from './dnd';
export { DT_FX };

const SCALE_DB = [6, 0, -6, -12, -24, -40];
const ZERO_N = dbToNorm(0);
const METER_FALL = 0.9; // norm units / s
const HOLD_MS = 1100;
const HOLD_FALL = 0.32; // norm units / s
const CLIP_MS = 2600;

const svg = (d: string, vb = '0 0 24 24') => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  unmute: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10"/>'),
  render: svg('<path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 17v2.5h14V17"/>'),
  panel: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/>'),
  more: svg('<circle cx="12" cy="6" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/>'),
  caret: svg('<path d="M9 6l6 6-6 6"/>'),
  send: `<svg viewBox="0 0 12 8"><path d="M6 1L11 7H1z" fill="currentColor"/></svg>`,
  arm: `<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.1" fill="currentColor"/></svg>`,
};

function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}
function setHint(e: HTMLElement, s: string) {
  if (e.dataset.hint !== s) e.dataset.hint = s;
}
function keyFor(id: string): string {
  return commands.keysFor(id)[0] ?? '';
}
/** Keep room on the right for a submenu (the shared menu can't flip submenus to the left). */
function fitX(x: number, need: number) {
  return Math.max(0, Math.min(x, innerWidth - need));
}
function scaleLabel(d: number) {
  return d > 0 ? '+' + d : String(d);
}

// ---------------------------------------------------------------------------
// selection helpers
// ---------------------------------------------------------------------------
function selectTrack(i: number, multi: number[] = [i]) {
  store.setUI({ selectedMixer: i, selectedMixerTracks: multi });
}

function clickSelect(i: number, e: PointerEvent) {
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

function automateTrack(trackId: string, param: 'volDb' | 'pan' | 'width') {
  const isMaster = store.project.mixer[0]?.id === trackId;
  createAutomation({ scope: isMaster ? 'master' : 'mixer', id: trackId, param });
}

// ---------------------------------------------------------------------------
// shared per-update context
// ---------------------------------------------------------------------------
interface UpdateCtx {
  n: number;
  sel: number;
  multi: Set<number>;
  soloed: Set<number>;
  feeds: Map<number, string[]>;
  sources: Map<number, number[]>; // track -> inserts routed into it
  selDest: number;
}

let soloKey = '';
let soloCache = new Set<number>();
function buildCtx(): UpdateCtx {
  const m = store.project.mixer;
  const key = lastSoloKey() + '|' + m.map((t) => (t.mute ? 'm' : 'u') + t.route).join(',');
  if (key !== soloKey) {
    soloKey = key;
    soloCache = soloedTracks(m);
  }
  const feeds = new Map<number, string[]>();
  for (const c of store.project.channels) {
    const k = c.mixer >= 0 && c.mixer < m.length ? c.mixer : 0;
    const arr = feeds.get(k);
    if (arr) arr.push(c.name);
    else feeds.set(k, [c.name]);
  }
  const sources = new Map<number, number[]>();
  for (let k = 1; k < m.length; k++) {
    const d = destOf(m, k);
    const arr = sources.get(d);
    if (arr) arr.push(k);
    else sources.set(d, [k]);
  }
  const sel = clamp(store.ui.selectedMixer, 0, m.length - 1);
  return { n: m.length, sel, multi: new Set(store.ui.selectedMixerTracks), soloed: soloCache, feeds, sources, selDest: destOf(m, sel) };
}

// ---------------------------------------------------------------------------
// strip
// ---------------------------------------------------------------------------
class Strip {
  readonly root: HTMLElement;
  index: number;
  readonly isMaster: boolean;
  private numEl: HTMLElement;
  private pipsEl: HTMLElement;
  private nameEl: HTMLElement;
  private ledEl: HTMLElement;
  private soloEl: HTMLElement;
  private armEl: HTMLElement;
  private zone: HTMLElement;
  private gfill: HTMLElement;
  private dbEl: HTMLElement;
  private routeEl: HTMLElement;
  private sendEl: HTMLElement;
  private clipEl: HTMLElement;
  private peakEl: HTMLElement | null = null;
  private faderEl: KnobEl | null = null;
  private faderH = 0;
  private faderOpts: FaderOpts;
  private panOpts: KnobOpts;
  private widthOpts: KnobOpts;
  private pan: KnobEl;
  private width: KnobEl;
  private mcov: HTMLElement[] = [];
  private mpk: HTMLElement[] = [];
  // meter state
  private disp = [0, 0];
  private hold = [0, 0];
  private holdT = [0, 0];
  private clipT = -1e9;
  private wCov = [-1, -1];
  private wPk = [-1, -1];
  private wHot = [false, false];
  private wClip = false;
  private peakTxtT = 0;
  // last rendered values
  private last: Record<string, unknown> = {};

  constructor(readonly id: string, index: number) {
    this.index = index;
    this.isMaster = index === 0;
    const M = this.isMaster;

    this.numEl = el('span', { class: 'mx-num' });
    this.pipsEl = el('span', { class: 'mx-pips' });
    this.nameEl = el('div', { class: 'mx-name' });
    this.nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameTrack(this.idx());
    });

    this.panOpts = {
      def: MIXER_PARAMS.pan,
      size: 26,
      bipolar: true,
      name: '',
      get: () => this.track()?.pan ?? 0,
      set: (v) => this.live((t) => (t.pan = v)),
      begin: () => store.begin('Mixer pan'),
      end: () => store.end(),
      onAutomate: () => automateTrack(this.id, 'pan'),
    };
    this.widthOpts = {
      def: MIXER_PARAMS.width,
      size: 18,
      bipolar: true,
      color: 'var(--accent2)',
      name: '',
      get: () => this.track()?.width ?? 1,
      set: (v) => this.live((t) => (t.width = v)),
      begin: () => store.begin('Mixer stereo width'),
      end: () => store.end(),
      onAutomate: () => automateTrack(this.id, 'width'),
    };
    this.pan = knob(this.panOpts);
    this.width = knob(this.widthOpts);
    this.pan.classList.add('mx-pan');
    this.width.classList.add('mx-width');

    this.ledEl = el('div', { class: 'led mx-led' });
    this.ledEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && !M) soloTrack(this.idx());
      else toggleMute(this.idx());
    });
    this.ledEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!M) soloTrack(this.idx());
    });
    this.soloEl = el('button', { class: 'mx-solo', text: 'S', 'data-hint': `Solo this track (${keyFor('mixer.solo') || 'S'}) — Alt+click: solo with its routing` });
    this.soloEl.addEventListener('click', (e) => {
      e.stopPropagation();
      soloTrack(this.idx(), e.altKey);
    });
    this.armEl = el('button', { class: 'mx-arm', html: IC.arm, 'data-hint': `Arm for render — armed tracks are rendered as WAV stems with ${keyFor('mixer.render') || 'Alt+R'}` });
    this.armEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = this.track();
      if (t) setArmed(targetsFor(this.idx()), !t.armed);
    });

    // fader zone: groove + fill, dB scale, stereo meter, clip LED, fader (added on resize)
    this.gfill = el('div', { class: 'mx-gfill' });
    const groove = el('div', { class: 'mx-groove' }, this.gfill);
    const scale = el('div', { class: 'mx-scale' }, ...SCALE_DB.map((d) => el('span', { class: d === 0 ? 'zero' : '', style: { top: ((1 - dbToNorm(d)) * 100).toFixed(2) + '%' }, text: scaleLabel(d) })));
    const meter = el('div', { class: 'mx-meter', 'data-hint': 'Peak meter (L / R) with peak hold' });
    for (let c = 0; c < 2; c++) {
      const cov = el('div', { class: 'mx-mcov' });
      const pk = el('div', { class: 'mx-mpk' });
      this.mcov.push(cov);
      this.mpk.push(pk);
      meter.append(el('div', { class: 'mx-mch' }, el('div', { class: 'mx-mlit' }), cov, pk));
    }
    this.clipEl = el('div', { class: 'mx-clip', 'data-hint': 'Clip indicator — lights when the track peaks above 0 dB (click to reset)' });
    this.clipEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.resetMeter();
    });
    this.zone = el('div', { class: 'mx-fz' }, groove, scale, meter, this.clipEl);

    this.faderOpts = {
      def: MIXER_PARAMS.volDb,
      height: 160,
      name: '',
      get: () => this.track()?.volDb ?? 0,
      set: (v) => this.live((t) => (t.volDb = v)),
      begin: () => store.begin('Mixer volume'),
      end: () => store.end(),
      toNorm: dbToNorm,
      fromNorm: faderFromNorm,
      onAutomate: () => automateTrack(this.id, 'volDb'),
    };

    this.dbEl = el('div', { class: 'mx-db' });
    this.dbEl.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const i = this.idx();
      const t = this.track();
      if (!t) return;
      const v = await promptDialog('Track volume', 'Volume in dB (−60 = −∞ … +5.6)', t.volDb <= -60 ? '-inf' : String(t.volDb));
      if (v === null) return;
      const n = /inf/i.test(v) ? -60 : parseFloat(v);
      if (!isNaN(n)) setVolume(i, n);
    });
    if (M) this.peakEl = el('div', { class: 'mx-peak', text: '-∞', 'data-hint': 'Master peak level (hold) — click to reset' });
    this.peakEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.resetMeter();
    });

    this.routeEl = el('div', { class: 'mx-route' });
    this.routeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = this.routeEl.getBoundingClientRect();
      if (M) return;
      showMenu(routeItems(this.idx()), r.left, r.bottom + 2);
    });
    this.sendEl = el('div', { class: 'mx-send', html: IC.send });
    this.sendEl.addEventListener('click', (e) => {
      e.stopPropagation();
      sendSelectedTo(this.idx());
    });

    this.root = el(
      'div',
      { class: 'mx-strip' + (M ? ' master' : '') },
      el('div', { class: 'mx-cbar' }),
      el('div', { class: 'mx-head' }, el('div', { class: 'mx-headrow' }, this.numEl, this.pipsEl), this.nameEl),
      el('div', { class: 'mx-knobs' }, this.pan, this.width),
      el('div', { class: 'mx-btns' }, this.ledEl, this.soloEl, this.armEl),
      this.zone,
      el('div', { class: 'mx-dbrow' }, this.dbEl, this.peakEl),
      this.routeEl,
      this.sendEl,
    );

    // selection: capture phase so touching a knob/fader also selects its track
    this.root.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0 && e.button !== 2) return;
        const tgt = e.target as HTMLElement;
        if (tgt.closest('.mx-send')) return;
        const i = this.idx();
        if (i < 0) return;
        const onControl = !!tgt.closest('.knob, .fader, .led, .mx-solo, .mx-arm, .mx-clip, .mx-route, .mx-peak');
        if (e.button === 2 || onControl) {
          if (store.ui.selectedMixerTracks.includes(i)) store.setUI({ selectedMixer: i });
          else selectTrack(i);
          return;
        }
        clickSelect(i, e);
      },
      true,
    );
    this.root.addEventListener('contextmenu', (e) => {
      if (e.defaultPrevented) return; // a control (fader) showed its own menu
      e.preventDefault();
      stripMenu(this.idx(), e.clientX, e.clientY);
    });
    // effects dropped from other windows
    this.root.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes(DT_FX)) {
        e.preventDefault();
        this.root.classList.add('drop');
      }
    });
    this.root.addEventListener('dragleave', () => this.root.classList.remove('drop'));
    this.root.addEventListener('drop', (e) => {
      this.root.classList.remove('drop');
      const type = readFxDrop(e);
      if (!type) return;
      e.preventDefault();
      addFx(this.idx(), type);
    });
  }

  idx(): number {
    const m = store.project.mixer;
    if (m[this.index]?.id === this.id) return this.index;
    const k = m.findIndex((t) => t.id === this.id);
    if (k >= 0) this.index = k;
    return k;
  }
  track(): MixerTrack | undefined {
    const i = this.idx();
    return i >= 0 ? store.project.mixer[i] : undefined;
  }
  private live(fn: (t: MixerTrack) => void) {
    store.live((p) => {
      const i = this.idx();
      if (i >= 0) fn(p.mixer[i]);
    });
  }

  setFaderHeight(h: number) {
    if (this.faderEl && this.faderH === h) return;
    this.faderH = h;
    this.faderOpts.height = h;
    const f = fader(this.faderOpts);
    if (this.faderEl) this.faderEl.replaceWith(f);
    else this.zone.append(f);
    this.faderEl = f;
  }

  update(u: UpdateCtx) {
    const i = this.index;
    const t = store.project.mixer[i];
    if (!t) return;
    const L = this.last;
    const root = this.root;
    const M = this.isMaster;

    if (L.color !== t.color) {
      L.color = t.color;
      root.style.setProperty('--tc', t.color);
    }
    setText(this.numEl, M ? 'M' : String(i));
    const nameChanged = L.name !== t.name;
    if (nameChanged) {
      L.name = t.name;
      setText(this.nameEl, t.name);
      this.panOpts.name = this.widthOpts.name = this.faderOpts.name = t.name;
    }

    // selection / state classes
    const sel = u.sel === i;
    const inMulti = u.multi.has(i) && u.multi.size > 1;
    root.classList.toggle('sel', sel);
    root.classList.toggle('multi', inMulti && !sel);
    root.classList.toggle('muted', t.mute);
    root.classList.toggle('armed', t.armed);
    root.classList.toggle('soloed', u.soloed.has(i));
    this.ledEl.classList.toggle('on', !t.mute);
    this.soloEl.classList.toggle('on', u.soloed.has(i));
    this.armEl.classList.toggle('on', t.armed);

    // controls
    if (nameChanged || L.vol !== t.volDb) {
      L.vol = t.volDb;
      this.faderEl?.update();
      this.gfill.style.transform = `scaleY(${dbToNorm(t.volDb).toFixed(4)})`;
      setText(this.dbEl, fmtDbShort(t.volDb));
      setHint(this.dbEl, `${t.name} volume: ${fmtDb(t.volDb)} — double-click to type, Alt+click fader to reset`);
    }
    if (nameChanged || L.pan !== t.pan) {
      L.pan = t.pan;
      this.pan.update();
    }
    if (nameChanged || L.width !== t.width) {
      L.width = t.width;
      this.width.update();
    }

    // effect pips
    const fxSig = t.fx.map((f) => (f.enabled ? '1' : '0')).join('');
    if (L.fx !== fxSig) {
      L.fx = fxSig;
      this.pipsEl.textContent = '';
      for (const f of t.fx) this.pipsEl.append(el('i', { class: f.enabled ? 'on' : '' }));
    }

    // routing
    const dest = destOf(store.project.mixer, i);
    const routeTxt = M ? 'Output' : dest === 0 ? 'Master' : String(dest);
    setText(this.routeEl, (M ? '' : '→ ') + routeTxt);
    setHint(this.routeEl, M ? 'The master track goes to the audio output' : `Routed to ${trackLabel(dest)} — click to change the destination`);
    let send = '';
    if (i === u.sel) send = 'self';
    else if (u.sel > 0 && u.selDest === i) send = 'out';
    else if (u.sel >= 0 && i > 0 && destOf(store.project.mixer, i) === u.sel && u.sel !== 0) send = 'in';
    if (L.send !== send || L.sendSel !== u.sel) {
      L.send = send;
      L.sendSel = u.sel;
      this.sendEl.className = 'mx-send' + (send ? ' ' + send : '');
      const selName = trackLabel(u.sel);
      setHint(
        this.sendEl,
        send === 'self'
          ? 'Selected track'
          : u.sel === 0
            ? 'Select an insert, then click here to route it to this track'
            : send === 'out'
              ? `${selName} is routed here — click to route it back to the master`
              : send === 'in'
                ? `This track feeds ${selName}`
                : `Click to route ${selName} (and other selected tracks) to ${trackLabel(i)}`,
      );
    }

    // descriptive hint (channels feeding the strip)
    const feeds = u.feeds.get(i) ?? [];
    const srcs = (u.sources.get(i) ?? []).filter((k) => k !== i);
    const fedBy = [feeds.length ? feeds.join(', ') : '', srcs.length ? (M ? `${srcs.length} insert${srcs.length > 1 ? 's' : ''}` : 'inserts ' + srcs.join(', ')) : ''].filter(Boolean).join(' + ');
    const hint = `${M ? 'Master' : 'Insert ' + i} “${t.name}” · fed by: ${fedBy || 'nothing'} · ${t.fx.length} FX${M ? '' : ' · → ' + trackLabel(dest)}${t.mute ? ' · MUTED' : ''} — click select, Ctrl/Shift+click multi-select, right-click menu, double-click name to rename`;
    setHint(root, hint);
    setHint(this.nameEl, hint);
    setHint(this.ledEl, `${t.mute ? 'Muted' : 'Active'} — click to ${t.mute ? 'unmute' : 'mute'}${M ? '' : ', Ctrl+click or right-click to solo'}`);
  }

  resetMeter() {
    this.clipT = -1e9;
    this.hold = [0, 0];
    this.holdT = [0, 0];
  }

  tick(lr: number[] | undefined, dt: number, now: number) {
    for (let c = 0; c < 2; c++) {
      const raw = lr ? lr[c] ?? lr[0] ?? 0 : 0;
      if (raw >= 1) this.clipT = now;
      const n = raw > 0.001 ? dbToNorm(20 * Math.log10(raw)) : 0;
      let d = this.disp[c] - dt * METER_FALL;
      if (n > d) d = n;
      if (d < 0) d = 0;
      this.disp[c] = d;
      if (n >= this.hold[c]) {
        this.hold[c] = n;
        this.holdT[c] = now;
      } else if (now - this.holdT[c] > HOLD_MS) this.hold[c] = Math.max(0, this.hold[c] - dt * HOLD_FALL);

      const cov = 1 - d;
      if (Math.abs(cov - this.wCov[c]) > 0.0015) {
        this.wCov[c] = cov;
        this.mcov[c].style.transform = `scaleY(${cov.toFixed(4)})`;
      }
      const h = this.hold[c];
      if (Math.abs(h - this.wPk[c]) > 0.0015) {
        this.wPk[c] = h;
        this.mpk[c].style.transform = `translateY(${((1 - h) * 100).toFixed(2)}%)`;
        const hot = h > ZERO_N;
        if (hot !== this.wHot[c]) {
          this.wHot[c] = hot;
          this.mpk[c].classList.toggle('hot', hot);
        }
      }
    }
    const clip = now - this.clipT < CLIP_MS;
    if (clip !== this.wClip) {
      this.wClip = clip;
      this.clipEl.classList.toggle('on', clip);
    }
    if (this.peakEl && now - this.peakTxtT > 120) {
      this.peakTxtT = now;
      const pk = Math.max(this.hold[0], this.hold[1]);
      const db = pk > 0 ? Math.max(-60, normToDb(pk)) : -60;
      setText(this.peakEl, db <= -59.5 ? '-∞' : db.toFixed(1));
      this.peakEl.classList.toggle('hot', pk > ZERO_N);
    }
  }
}

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------
function routeItems(i: number): MenuItem[] {
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

function sendSelectedTo(j: number) {
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

function stripMenu(i: number, x: number, y: number) {
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
    {
      label: nCh ? `Link ${nCh} selected channel${nCh > 1 ? 's' : ''} to this track` : 'Link selected channels to this track',
      shortcut: keyFor('mixer.link'),
      disabled: !nCh,
      action: () => linkChannelsToTrack(i, store.ui.selectedChannels),
    },
    { sep: true },
    { label: 'Insert track after', action: () => ensureVisibleLater(insertTrackAfter(i)) },
    { label: M ? 'Delete track (master can’t be deleted)' : tg.length > 1 ? `Delete ${tg.length} tracks` : 'Delete track', disabled: M || !tg.some((k) => k > 0), action: () => deleteTracks(tg) },
    { label: 'Move left', shortcut: keyFor('mixer.moveLeft'), disabled: i <= 1, action: () => ensureVisibleLater(moveTrack(i, -1)) },
    { label: 'Move right', shortcut: keyFor('mixer.moveRight'), disabled: M || i >= m.length - 1, action: () => ensureVisibleLater(moveTrack(i, 1)) },
    { sep: true },
    { label: 'Arm for render', checked: t.armed, disabled: M, action: () => setArmed(tg, !t.armed) },
    { label: 'Solo', shortcut: keyFor('mixer.solo'), disabled: M, action: () => soloTrack(i) },
    { label: 'Solo with routing', shortcut: keyFor('mixer.soloRouting'), disabled: M, action: () => soloTrack(i, true) },
    { label: 'Unmute all tracks', action: unmuteAll },
  ];
  showMenu(items, fitX(x, 540), y);
}

function fxPickItems(onPick: (type: FxType) => void, current?: FxType): MenuItem[] {
  return FX_ORDER.map((type) => ({ label: FX_DEFS[type].name, checked: current === type, action: () => onPick(type) }));
}

function readFxDrop(e: DragEvent): FxType | null {
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

// ---------------------------------------------------------------------------
// FX rack panel (selected track)
// ---------------------------------------------------------------------------
class FxPanel {
  readonly root = el('div', { class: 'mx-panel' });
  readonly expanded = new Set<string>();
  private sig = '';
  private ups: (() => void)[] = [];
  private scrollEl: HTMLElement | null = null;
  private builtFor = '';

  sync(force = false) {
    const m = store.project.mixer;
    const t = m[clamp(store.ui.selectedMixer, 0, m.length - 1)];
    const sig = t ? `${t.id}|${t.fx.map((f) => f.id + ':' + f.type + (this.expanded.has(f.id) ? '+' : '')).join(',')}` : '';
    if (force || sig !== this.sig) {
      this.sig = sig;
      this.build(t);
    }
    for (const u of this.ups) u();
  }

  private build(t: MixerTrack | undefined) {
    const keepScroll = t && t.id === this.builtFor ? this.scrollEl?.scrollTop ?? 0 : 0;
    this.ups = [];
    this.root.textContent = '';
    this.scrollEl = null;
    this.builtFor = t?.id ?? '';
    if (!t) return;
    const tid = t.id;
    const tr = () => store.project.mixer.find((x) => x.id === tid);
    const ti = () => store.project.mixer.findIndex((x) => x.id === tid);
    const ups = this.ups;

    // ---- header ----
    const sw = el('div', { class: 'mx-p-swatch', 'data-hint': 'Track color — click to change' });
    sw.addEventListener('click', (e) => colorMenu(PALETTE, (c) => setColor([ti()], c), e.clientX, e.clientY));
    const kind = el('div', { class: 'mx-p-kind' });
    const name = el('div', { class: 'mx-p-name', 'data-hint': `Double-click to rename (${keyFor('mixer.rename') || 'F2'})` });
    name.addEventListener('dblclick', () => renameTrack(ti()));
    const moreBtn = el('button', { class: 'mx-p-more', html: IC.more, 'data-hint': 'Track menu' });
    moreBtn.addEventListener('click', () => {
      const r = moreBtn.getBoundingClientRect();
      stripMenu(ti(), r.left, r.bottom + 2);
    });
    const head = el('div', { class: 'mx-p-head' }, sw, el('div', { class: 'mx-p-titles' }, kind, name), moreBtn);
    ups.push(() => {
      const x = tr();
      if (!x) return;
      const i = ti();
      setText(kind, i === 0 ? 'Master track' : `Insert ${i}`);
      setText(name, x.name);
      head.style.setProperty('--tc', x.color);
    });

    // ---- route + inputs ----
    const rsel = el('select', { class: 'select mx-p-route', 'data-hint': 'Send this track’s output to another track — destinations that would create a feedback loop are disabled' }) as HTMLSelectElement;
    rsel.addEventListener('change', () => {
      routeTracks([ti()], parseInt(rsel.value, 10));
      rsel.blur(); // give the keyboard back to the mixer shortcuts
    });
    rsel.addEventListener('keydown', (e) => e.stopPropagation());
    let rsig = '';
    ups.push(() => {
      const m = store.project.mixer;
      const i = ti();
      if (i < 0) return;
      const s = i + '#' + m.map((z) => z.name + '>' + z.route).join('|');
      if (s !== rsig) {
        rsig = s;
        rsel.textContent = '';
        if (i === 0) {
          rsel.append(el('option', { value: '-1', text: 'Audio output' }));
          rsel.disabled = true;
        } else {
          rsel.disabled = false;
          m.forEach((_, j) => {
            if (j === i) return;
            const o = el('option', { value: String(j), text: trackLabel(j) }) as HTMLOptionElement;
            o.disabled = createsLoop(m, i, j);
            rsel.append(o);
          });
        }
      }
      const v = i === 0 ? '-1' : String(destOf(m, i));
      if (rsel.value !== v) rsel.value = v;
    });
    const inputs = el('div', { class: 'mx-p-inputs' });
    ups.push(() => {
      const m = store.project.mixer;
      const i = ti();
      const ch = store.project.channels.filter((c) => c.mixer === i || (i === 0 && (c.mixer < 0 || c.mixer >= m.length)));
      const ins: number[] = [];
      for (let k = 1; k < m.length; k++) if (destOf(m, k) === i) ins.push(k);
      const parts = [ch.map((c) => c.name).join(', '), ins.length ? (i === 0 ? `${ins.length} inserts` : 'inserts ' + ins.join(', ')) : ''].filter(Boolean);
      const s = parts.join('  +  ') || 'Nothing is routed here';
      setText(inputs, s);
      inputs.classList.toggle('none', !parts.length);
      setHint(inputs, `Fed by: ${s}. Select channels in the Channel Rack and press ${keyFor('mixer.link') || 'Ctrl+L'} here to link them to this track`);
    });

    // ---- track knobs ----
    const tcell = (def: ParamDef, key: 'pan' | 'width', label: string, color?: string) => {
      const val = el('div', { class: 'mx-pc-v' });
      const k = knob({
        def,
        size: 30,
        bipolar: true,
        color,
        name: tr()?.name,
        get: () => (tr()?.[key] as number) ?? def.def,
        set: (v) =>
          store.live((p) => {
            const x = p.mixer.find((z) => z.id === tid);
            if (x) x[key] = v;
          }),
        begin: () => store.begin(key === 'pan' ? 'Mixer pan' : 'Mixer stereo width'),
        end: () => store.end(),
        onAutomate: () => automateTrack(tid, key),
      });
      let last = NaN;
      ups.push(() => {
        const v = tr()?.[key] as number;
        if (v === last) return;
        last = v;
        k.update();
        setText(val, fmtParam(def, v));
      });
      return el('div', { class: 'mx-pc' }, k, el('div', { class: 'mx-pc-l', text: label }), val);
    };
    const vol = el('div', { class: 'mx-p-vol' });
    ups.push(() => {
      const x = tr();
      if (x) setText(vol, fmtDb(x.volDb));
    });

    const fxCount = el('span', { class: 'mx-sec-n' });
    ups.push(() => setText(fxCount, `${tr()?.fx.length ?? 0} / ${MAX_FX}`));

    // ---- effect slots ----
    const list = el('div', { class: 'mx-fxlist' });
    for (let k = 0; k < MAX_FX; k++) {
      const s = t.fx[k];
      if (s) {
        list.append(this.slotRow(s, k, ti));
        if (this.expanded.has(s.id)) list.append(this.editor(s));
      } else list.append(this.emptyRow(k, ti));
    }

    this.root.append(
      head,
      el(
        'div',
        { class: 'mx-p-grid' },
        el('label', { text: 'Route to' }),
        rsel,
        el('label', { text: 'Inputs' }),
        inputs,
      ),
      el('div', { class: 'mx-p-ctrls' }, tcell(MIXER_PARAMS.pan, 'pan', 'Pan'), tcell(MIXER_PARAMS.width, 'width', 'Width', 'var(--accent2)'), el('div', { class: 'mx-pc' }, el('div', { class: 'mx-p-volbox' }, vol), el('div', { class: 'mx-pc-l', text: 'Volume' }))),
      el('div', { class: 'mx-sec' }, el('span', { text: 'Effects' }), fxCount),
      (this.scrollEl = el('div', { class: 'mx-p-scroll' }, list, el('div', { class: 'mx-p-foot', text: 'Drag a slot number to reorder · right-click a slot for more' }))),
    );
    if (keepScroll) this.scrollEl.scrollTop = keepScroll;
  }

  private slotRow(s: FxSlot, k: number, ti: () => number): HTMLElement {
    const sid = s.id;
    const def = FX_DEFS[s.type];
    const slot = () => findSlot(store.project, sid)?.slot;
    const open = this.expanded.has(sid);
    const num = el('div', { class: 'mx-fx-num', text: String(k + 1), draggable: 'true', 'data-hint': 'Drag to reorder effects' });
    const led = el('div', { class: 'led mx-fx-led', 'data-hint': 'Effect on / bypassed — click to toggle' });
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFx(sid);
    });
    const nm = el('div', { class: 'mx-fx-name', 'data-hint': `${def.name} — ${def.desc}. Click to ${open ? 'hide' : 'show'} its controls` }, el('span', { class: 'mx-fx-caret', html: IC.caret }), el('span', { text: def.name }));
    nm.addEventListener('click', () => {
      if (this.expanded.has(sid)) this.expanded.delete(sid);
      else this.expanded.add(sid);
      this.sync();
    });
    const mix = knob({
      def: FX_MIX_PARAM,
      size: 20,
      name: def.name,
      get: () => slot()?.mix ?? 1,
      set: (v) => liveSlot(sid, (x) => (x.mix = v)),
      begin: () => store.begin('Effect mix'),
      end: () => store.end(),
    });
    mix.classList.add('mx-fx-mix');
    const menuBtn = el('button', { class: 'mx-fx-menu', html: IC.more, 'data-hint': 'Effect menu: replace, move, reset, remove' });
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      slotMenu(sid, r.left, r.bottom + 2, this);
    });
    const row = el('div', { class: 'mx-fx' + (open ? ' open' : '') }, num, led, nm, mix, menuBtn);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      slotMenu(sid, e.clientX, e.clientY, this);
    });
    num.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(DT_FXSLOT, sid);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    num.addEventListener('dragend', () => row.classList.remove('dragging'));
    this.dropTarget(row, k, ti);
    let lastMix = NaN;
    let lastEn: boolean | null = null;
    this.ups.push(() => {
      const x = slot();
      if (!x) return;
      if (x.enabled !== lastEn) {
        lastEn = x.enabled;
        led.classList.toggle('on', x.enabled);
        row.classList.toggle('bypassed', !x.enabled);
      }
      if (x.mix !== lastMix) {
        lastMix = x.mix;
        mix.update();
      }
    });
    return row;
  }

  private emptyRow(k: number, ti: () => number): HTMLElement {
    const row = el(
      'div',
      { class: 'mx-fx empty', 'data-hint': 'Empty slot — click to insert an effect (or drop one here)' },
      el('div', { class: 'mx-fx-num', text: String(k + 1) }),
      el('div', { class: 'mx-fx-name', text: 'Empty slot' }),
      el('div', { class: 'mx-fx-add', html: IC.plus }),
    );
    row.addEventListener('click', () => {
      const r = row.getBoundingClientRect();
      const i = ti();
      showMenu(
        fxPickItems((type) => {
          const before = new Set(store.project.mixer[i]?.fx.map((f) => f.id));
          addFx(i, type);
          const added = store.project.mixer[i]?.fx.find((f) => !before.has(f.id));
          if (added) {
            this.expanded.add(added.id);
            this.sync();
          }
        }),
        r.left + 24,
        r.bottom + 2,
      );
    });
    this.dropTarget(row, k, ti);
    return row;
  }

  private dropTarget(row: HTMLElement, k: number, ti: () => number) {
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
        const id = insertFx(ti(), type, k);
        if (id) this.expanded.add(id);
      }
    });
  }

  private editor(s: FxSlot): HTMLElement {
    const sid = s.id;
    const def = FX_DEFS[s.type];
    const slot = () => findSlot(store.project, sid)?.slot;
    const grid = el('div', { class: 'mx-fx-ed' });
    for (const pd of def.params) {
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
          size: 30,
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

function slotMenu(sid: string, x: number, y: number, panel: FxPanel) {
  const f = findSlot(store.project, sid);
  if (!f) return;
  const n = f.track.fx.length;
  const wasOpen = panel.expanded.has(sid);
  showMenu(
    [
      { label: f.slot.enabled ? 'Bypass' : 'Enable', action: () => toggleFx(sid) },
      { label: wasOpen ? 'Hide controls' : 'Show controls', action: () => { if (wasOpen) panel.expanded.delete(sid); else panel.expanded.add(sid); panel.sync(); } },
      {
        label: 'Replace with',
        submenu: fxPickItems((type) => {
          const id = replaceFx(sid, type);
          if (id && wasOpen) panel.expanded.add(id);
        }, f.slot.type),
      },
      { sep: true },
      { label: 'Move up', disabled: f.k === 0, action: () => moveFx(sid, f.k - 1) },
      { label: 'Move down', disabled: f.k >= n - 1, action: () => moveFx(sid, f.k + 1) },
      { label: 'Reset parameters', action: () => resetFx(sid) },
      { sep: true },
      { label: 'Remove', action: () => removeFx(sid) },
    ],
    fitX(x, 420),
    y,
  );
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------
let ensureVisibleLater: (i: number) => void = () => {};

export function createMixer(): PanelDef {
  const views = new Map<string, Strip>();
  let order: Strip[] = [];
  let idSig = '';
  let faderH = 0;
  let dirty = false;
  const visible = () => !!wm?.get('mixer')?.visible;

  const masterSlot = el('div', { class: 'mx-master-slot' });
  const inserts = el('div', { class: 'mx-inserts' });
  const addBtn = el('button', { class: 'mx-add', html: IC.plus, 'data-hint': 'Add an insert track (no limit)' });
  addBtn.addEventListener('click', () => {
    const i = addMixerTrack();
    selectTrack(i);
    ensureVisibleLater(i);
  });
  const strips = el('div', { class: 'mx-strips' }, masterSlot, inserts, addBtn);
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

  const ensureVisible = (i: number) => {
    const v = order[i];
    if (!v || i === 0) return;
    const masterW = masterSlot.offsetWidth;
    const left = v.root.offsetLeft;
    const right = left + v.root.offsetWidth;
    if (left - masterW < wrap.scrollLeft) wrap.scrollLeft = left - masterW;
    else if (right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = right - wrap.clientWidth + 36;
  };
  ensureVisibleLater = (i: number) => {
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
        if (faderH) v.setFaderHeight(faderH);
      }
      v.index = i;
      next.set(key, v);
      newOrder.push(v);
    });
    for (const [key, v] of views) if (!next.has(key)) v.root.remove();
    views.clear();
    for (const [k, v] of next) views.set(k, v);
    order = newOrder;
    // master
    const mv = order[0];
    if (mv && masterSlot.firstChild !== mv.root) {
      masterSlot.textContent = '';
      masterSlot.append(mv.root);
    }
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
  }

  // ---- fader height follows the window ----
  const ro = new ResizeObserver(() => {
    const z = order[0]?.root.querySelector('.mx-fz') as HTMLElement | null;
    const h = z ? Math.floor(z.clientHeight) : 0;
    if (h < 40 || h === faderH) return;
    faderH = h;
    for (const v of order) v.setFaderHeight(h);
    sync();
  });
  ro.observe(wrap);

  // ---- meters ----
  let raf = 0;
  let lastT = 0;
  const frame = (t: number) => {
    raf = requestAnimationFrame(frame);
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 1 / 60;
    lastT = t;
    const levels = engine.ready ? engine.readMeters() : [];
    for (let k = 0; k < order.length; k++) order[k].tick(levels[k], dt, t);
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

  // ---- store wiring ----
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

  // ---- header extra ----
  const hbtn = (icon: string, label: string, hint: string, fn: () => void) => {
    const b = el('button', { class: 'mx-hbtn', 'data-hint': hint }, el('span', { class: 'mx-hbtn-i', html: icon }), el('span', { text: label }));
    b.addEventListener('click', fn);
    return b;
  };
  const panelBtn = el('button', { class: 'mx-hbtn icon' + (panelOn ? ' on' : ''), html: IC.panel, 'data-hint': 'Show / hide the effects panel' });
  panelBtn.addEventListener('click', () => {
    panelOn = !panelOn;
    root.classList.toggle('no-panel', !panelOn);
    panelBtn.classList.toggle('on', panelOn);
    try {
      localStorage.setItem('lf.mixer.panel', panelOn ? '1' : '0');
    } catch {}
  });
  const headerExtra = el(
    'div',
    { class: 'mx-hx' },
    hbtn(IC.plus, 'Insert', 'Add an insert track', () => {
      const i = addMixerTrack();
      selectTrack(i);
      ensureVisibleLater(i);
    }),
    hbtn(IC.unmute, 'Unmute all', 'Unmute every mixer track (clears solo)', unmuteAll),
    hbtn(IC.render, 'Render armed', `Render armed tracks to WAV stems (${keyFor('mixer.render') || 'Alt+R'})`, renderArmed),
    el('div', { class: 'mx-hx-sp' }),
    panelBtn,
  );

  registerMixerCommands(ensureVisible);
  sync(true);

  return {
    body: root,
    headerExtra,
    onShow: () => {
      sync(true);
      startMeters();
    },
    onHide: () => stopMeters(),
    onResize: () => {
      if (dirty && visible()) sync(true);
    },
  };
}

function renderArmed() {
  const armed = store.project.mixer.map((t, i) => (i > 0 && t.armed ? i : -1)).filter((i) => i > 0);
  if (!armed.length) {
    toast('No tracks are armed — click the record button on a strip (or right-click → Arm for render)', 'warn', 3200);
    return;
  }
  exportAudio('wav', armed);
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
