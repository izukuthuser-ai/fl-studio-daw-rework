// Mixer strips, FL 21 style: numbered colour band, rotated name beside a thin stereo peak meter,
// mute LED, pan knob, stereo-separation knob, arm / solo / input indicator column, fader with value,
// and the routing ("send") arrow. Strips are keyed by track id and only patched in place.
import { store } from '../core/store';
import { MixerTrack } from '../core/types';
import { MIXER_PARAMS } from '../core/params';
import { clamp, el, fmtDb } from '../core/util';
import { FaderOpts, KnobEl, KnobOpts, fader, knob, promptDialog, showMenu } from './widgets';
import { addFx } from './ops';
import { DT_FX } from './dnd';
import {
  dbToNorm,
  destOf,
  faderFromNorm,
  fmtDbShort,
  lastSoloKey,
  normToDb,
  renameTrack,
  setArmed,
  setVolume,
  soloTrack,
  soloedTracks,
  targetsFor,
  toggleMute,
  trackLabel,
} from './mixer-ops';
import {
  IC,
  automateTrack,
  clickSelect,
  inputItems,
  inputLabel,
  inputState,
  keyFor,
  readFxDrop,
  selectTrack,
  sendSelectedTo,
  setHint,
  setText,
  stripMenu,
} from './mixer-ui';

const ZERO_N = dbToNorm(0);
const METER_FALL = 0.9; // norm units / s
const HOLD_MS = 1100;
const HOLD_FALL = 0.32; // norm units / s
const CLIP_MS = 2600;

// ---------------------------------------------------------------------------
// shared per-update context
// ---------------------------------------------------------------------------
export interface UpdateCtx {
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
export function buildCtx(): UpdateCtx {
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
// stereo peak meter with peak hold + clip LED
// ---------------------------------------------------------------------------
export class PeakMeter {
  readonly el: HTMLElement;
  readonly clipEl: HTMLElement;
  private cov: HTMLElement[] = [];
  private pk: HTMLElement[] = [];
  private disp = [0, 0];
  private hold = [0, 0];
  private holdT = [0, 0];
  private clipT = -1e9;
  private wCov = [-1, -1];
  private wPk = [-1, -1];
  private wHot = [false, false];
  private wClip = false;

  constructor(hint: string) {
    this.el = el('div', { class: 'mx-meter', 'data-hint': hint });
    for (let c = 0; c < 2; c++) {
      const cov = el('div', { class: 'mx-mcov' });
      const pk = el('div', { class: 'mx-mpk' });
      this.cov.push(cov);
      this.pk.push(pk);
      this.el.append(el('div', { class: 'mx-mch' }, el('div', { class: 'mx-mlit' }), cov, pk));
    }
    this.clipEl = el('div', { class: 'mx-clip', 'data-hint': 'Clip indicator — lights when the level peaks above 0 dB (click to reset)' });
    this.clipEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.reset();
    });
  }

  reset() {
    this.clipT = -1e9;
    this.hold = [0, 0];
    this.holdT = [0, 0];
  }

  /** Highest held peak (norm units). */
  get peak() {
    return Math.max(this.hold[0], this.hold[1]);
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
        this.cov[c].style.transform = `scaleY(${cov.toFixed(4)})`;
      }
      const h = this.hold[c];
      if (Math.abs(h - this.wPk[c]) > 0.0015) {
        this.wPk[c] = h;
        this.pk[c].style.transform = `translateY(${((1 - h) * 100).toFixed(2)}%)`;
        const hot = h > ZERO_N;
        if (hot !== this.wHot[c]) {
          this.wHot[c] = hot;
          this.pk[c].classList.toggle('hot', hot);
        }
      }
    }
    const clip = now - this.clipT < CLIP_MS;
    if (clip !== this.wClip) {
      this.wClip = clip;
      this.clipEl.classList.toggle('on', clip);
    }
  }
}

// ---------------------------------------------------------------------------
// insert / master strip
// ---------------------------------------------------------------------------
export class Strip {
  readonly root: HTMLElement;
  index: number;
  readonly isMaster: boolean;
  readonly sendEl: HTMLElement;
  readonly zone: HTMLElement;
  private numEl: HTMLElement;
  private pipsEl: HTMLElement;
  private nameEl: HTMLElement;
  private mbox: HTMLElement;
  private ledEl: HTMLElement;
  private soloEl: HTMLElement;
  private armEl: HTMLElement;
  private inEl: HTMLElement;
  private gfill: HTMLElement;
  private dbEl: HTMLElement;
  private meter: PeakMeter;
  private faderEl: KnobEl | null = null;
  private faderKey = '';
  private faderOpts: FaderOpts;
  private panOpts: KnobOpts;
  private widthOpts: KnobOpts;
  private pan: KnobEl;
  private width: KnobEl;
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
    this.meter = new PeakMeter('Peak meter (L / R) with peak hold');
    this.mbox = el('div', { class: 'mx-mbox' }, this.meter.el, this.meter.clipEl);

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
      name: '',
      get: () => this.track()?.width ?? 1,
      set: (v) => this.live((t) => (t.width = v)),
      begin: () => store.begin('Mixer stereo separation'),
      end: () => store.end(),
      onAutomate: () => automateTrack(this.id, 'width'),
    };
    this.pan = knob(this.panOpts);
    this.width = knob(this.widthOpts);
    this.pan.classList.add('mx-pan');
    this.width.classList.add('mx-width');

    this.ledEl = el('div', { class: 'mx-led' });
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
    this.armEl = el('button', { class: 'mx-arm', html: IC.arm });
    this.armEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = this.track();
      if (t) setArmed(targetsFor(this.idx()), !t.armed);
    });
    this.inEl = el('div', { class: 'mx-in' });
    this.inEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = this.inEl.getBoundingClientRect();
      showMenu(inputItems(this.idx()), r.left, r.bottom + 2);
    });

    // fader zone: groove (lit below the cap on the selected track) + fader (added once sized)
    this.gfill = el('div', { class: 'mx-gfill' });
    this.zone = el('div', { class: 'mx-fz' }, el('div', { class: 'mx-groove' }, this.gfill));
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

    this.sendEl = el('div', { class: 'mx-send', html: IC.send });
    this.sendEl.addEventListener('click', (e) => {
      e.stopPropagation();
      sendSelectedTo(this.idx());
    });

    this.root = el(
      'div',
      { class: 'mx-strip' + (M ? ' master' : '') },
      el('div', { class: 'mx-band' }, this.numEl, this.pipsEl),
      el('div', { class: 'mx-top' }, this.nameEl, this.mbox),
      el('div', { class: 'mx-ctl' }, this.ledEl, this.pan),
      el('div', { class: 'mx-low' }, el('div', { class: 'mx-lcol' }, this.width, el('div', { class: 'mx-lsp' }), this.armEl, this.soloEl, this.inEl), this.zone),
      this.dbEl,
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
        const onControl = !!tgt.closest('.knob, .fader, .mx-led, .mx-solo, .mx-arm, .mx-clip, .mx-in, .mx-db');
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
      if (e.defaultPrevented) return; // a control (fader / knob) showed its own menu
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

  /** Size the fader to the zone. The shared widget assumes a 14 px cap, so a taller cap shrinks its box. */
  setFaderSize(zoneH: number, capH: number) {
    const h = Math.max(30, Math.round(zoneH - capH + 14));
    const key = h + ':' + capH;
    if (this.faderEl && this.faderKey === key) return;
    this.faderKey = key;
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
    const soloed = u.soloed.has(i);
    root.classList.toggle('sel', sel);
    root.classList.toggle('multi', inMulti && !sel);
    root.classList.toggle('muted', t.mute);
    root.classList.toggle('armed', t.armed);
    root.classList.toggle('soloed', soloed);
    this.ledEl.classList.toggle('on', !t.mute);
    this.soloEl.classList.toggle('on', soloed);
    this.armEl.classList.toggle('on', t.armed);

    // live input: arm colour + IN indicator
    const ist = inputState(t);
    const inKey = ist + '|' + (t.input ?? '') + '|' + t.armed;
    if (L.input !== inKey) {
      L.input = inKey;
      this.armEl.classList.toggle('ready', !!t.input);
      root.classList.toggle('has-input', !!t.input);
      this.inEl.className = 'mx-in ' + ist;
      setText(this.inEl, ist === 'none' ? '' : 'IN');
      const dev = inputLabel(t.input);
      setHint(
        this.inEl,
        ist === 'none'
          ? 'No audio input — click to pick one (mic / line-in / interface)'
          : ist === 'live'
            ? `Input live: ${dev}${t.armed ? ' · armed — transport Record records it into the Playlist' : ' · arm the track to record it'} — click to change`
            : ist === 'error'
              ? `Input unavailable: ${dev} — click to pick another`
              : `Opening input: ${dev}…`,
      );
      setHint(
        this.armEl,
        M
          ? 'The master track can’t be armed'
          : t.input
            ? `${t.armed ? 'Armed' : 'Arm'} for recording — with Record on, playing records “${dev}” into the Playlist. Armed tracks also render as stems (${keyFor('mixer.render') || 'Alt+R'})`
            : `${t.armed ? 'Armed' : 'Arm'} for stem render (${keyFor('mixer.render') || 'Alt+R'}) — pick an input (IN) to record live audio`,
      );
    }

    // controls
    const selCh = L.sel !== sel;
    if (nameChanged || L.vol !== t.volDb || selCh) {
      L.vol = t.volDb;
      this.faderEl?.update();
      this.gfill.style.transform = `scaleY(${dbToNorm(t.volDb).toFixed(4)})`;
      setText(this.dbEl, fmtDbShort(t.volDb));
      setHint(this.dbEl, `${t.name} volume: ${fmtDb(t.volDb)} — double-click to type, Alt+click fader to reset`);
    }
    L.sel = sel;
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

    // routing arrow (FL send switch)
    let send = '';
    if (i === u.sel) send = 'self';
    else if (u.sel > 0 && u.selDest === i) send = 'out';
    else if (i > 0 && u.sel >= 0 && destOf(store.project.mixer, i) === u.sel) send = 'in';
    if (L.send !== send || L.sendSel !== u.sel) {
      L.send = send;
      L.sendSel = u.sel;
      this.sendEl.className = 'mx-send' + (send ? ' ' + send : '');
      this.sendEl.innerHTML = send === 'self' ? IC.out : send === 'in' ? IC.sendIn : IC.send;
      const selName = trackLabel(u.sel);
      setHint(
        this.sendEl,
        send === 'self'
          ? M
            ? 'Master — feeds the audio output'
            : `Selected track — routed to ${trackLabel(u.selDest)}`
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
    const dest = destOf(store.project.mixer, i);
    const feeds = u.feeds.get(i) ?? [];
    const srcs = (u.sources.get(i) ?? []).filter((k) => k !== i);
    const fedBy = [feeds.length ? feeds.join(', ') : '', srcs.length ? (M ? `${srcs.length} insert${srcs.length > 1 ? 's' : ''}` : 'inserts ' + srcs.join(', ')) : ''].filter(Boolean).join(' + ');
    const hint = `${M ? 'Master' : 'Insert ' + i} “${t.name}” · fed by: ${fedBy || 'nothing'} · ${t.fx.length} FX${M ? '' : ' · → ' + trackLabel(dest)}${t.input ? ' · input: ' + inputLabel(t.input) : ''}${t.mute ? ' · MUTED' : ''} — click select, Ctrl/Shift+click multi-select, right-click menu, double-click name to rename`;
    setHint(root, hint);
    setHint(this.nameEl, hint);
    setHint(this.ledEl, `${t.mute ? 'Muted' : 'Active'} — click to ${t.mute ? 'unmute' : 'mute'}${M ? '' : ', Ctrl+click or right-click to solo'}`);
  }

  resetMeter() {
    this.meter.reset();
  }

  tick(lr: number[] | undefined, dt: number, now: number) {
    this.meter.tick(lr, dt, now);
  }
}

// ---------------------------------------------------------------------------
// "C" strip: mirrors the selected track's level on a big scaled meter (FL's Current track)
// ---------------------------------------------------------------------------
const SCALE = [6, 3, 0, -3, -6, -9, -12, -18, -24, -40];
const MINOR = new Set([3, -3, -9, -18]);

export class CurrentStrip {
  readonly root: HTMLElement;
  private meter: PeakMeter;
  private peakEl: HTMLElement;
  private txtT = 0;
  private sel = -1;

  constructor() {
    this.meter = new PeakMeter('Current track meter — mirrors the selected mixer track (L / R)');
    const scale = el(
      'div',
      { class: 'mx-cscale' },
      ...SCALE.map((d) => el('span', { class: (d === 0 ? 'zero' : '') + (MINOR.has(d) ? ' minor' : ''), style: { top: ((1 - dbToNorm(d)) * 100).toFixed(2) + '%' }, text: d > 0 ? '+' + d : String(Math.abs(d)) })),
    );
    this.peakEl = el('div', { class: 'mx-db mx-cpeak', text: '-∞', 'data-hint': 'Peak level of the selected track (hold) — click to reset' });
    this.peakEl.addEventListener('click', () => this.meter.reset());
    this.root = el(
      'div',
      { class: 'mx-strip current', 'data-hint': 'C — Current: follows the selected mixer track, showing its stereo peak level against a dB scale' },
      el('div', { class: 'mx-band' }, el('span', { class: 'mx-num', text: 'C' })),
      el('div', { class: 'mx-cbody' }, scale, el('div', { class: 'mx-cmeter' }, this.meter.el, this.meter.clipEl)),
      this.peakEl,
      el('div', { class: 'mx-send none' }),
    );
  }

  tick(levels: number[][], sel: number, dt: number, now: number) {
    if (sel !== this.sel) {
      this.sel = sel;
      this.meter.reset();
    }
    this.meter.tick(levels[sel], dt, now);
    if (now - this.txtT > 120) {
      this.txtT = now;
      const pk = this.meter.peak;
      const db = pk > 0 ? Math.max(-60, normToDb(pk)) : -60;
      setText(this.peakEl, db <= -59.5 ? '-∞' : db.toFixed(1));
      this.peakEl.classList.toggle('hot', pk > ZERO_N);
    }
  }
}
