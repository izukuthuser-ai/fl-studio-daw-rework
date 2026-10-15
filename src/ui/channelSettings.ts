// Channel Settings window: common channel header (name, color, volume / pan / pitch, mixer track,
// mute) plus the instrument page (Sampler or Tri-Osc Synth) and a clickable mini keyboard for
// auditioning. Built per channel id + instrument type, then updated in place on every change.
import './channelSettings.css';
import { store } from '../core/store';
import { engine } from '../audio/engine';
import { samples } from '../audio/samples';
import { Channel, Envelope, FilterType, ID, Wave } from '../core/types';
import { CHANNEL_PARAMS, ENV_PARAMS, ParamDef, fmtParam } from '../core/params';
import { SYNTH_PRESETS } from '../core/project';
import { clamp, el, fmtHz, isBlackKey, noteName, shade } from '../core/util';
import { KnobEl, KnobOpts, drag, dragNumber, knob, select } from './widgets';
import { createAutomation } from './ops';
import { pickSamples, DT_SAMPLE, hasType, samplesFromDrop } from './dnd';
import { wm } from './wm';
import type { PanelDef } from './panel';
import { applyPreset, colorChannels, matchingPreset, replaceSample, setMixerTrack, setName, toggleMute } from './channelRack-ops';

const pct = (v: number) => Math.round(v * 100) + '%';
const RESO_DEF: ParamDef = { key: 'reso', label: 'Resonance', min: 0.1, max: 20, def: 0.7, curve: 'log', fmt: (v) => 'Q ' + v.toFixed(2) };
const START_DEF: ParamDef = { key: 'start', label: 'Start', min: 0, max: 0.99, def: 0, fmt: pct };
const LEVEL_DEF: ParamDef = { key: 'level', label: 'Level', min: 0, max: 1, def: 0.8, fmt: pct };
const FINE_DEF: ParamDef = { key: 'fine', label: 'Fine', min: -100, max: 100, def: 0, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v) + ' ct' };
const UNISON_DEF: ParamDef = { key: 'unison', label: 'Unison', min: 1, max: 6, def: 1, step: 1, fmt: (v) => Math.round(v) + (Math.round(v) === 1 ? ' voice' : ' voices') };
const DETUNE_DEF: ParamDef = { key: 'detune', label: 'Detune', min: 0, max: 50, def: 12, fmt: (v) => v.toFixed(1) + ' ct' };
const SYN_CUT_DEF: ParamDef = { key: 'cutoff', label: 'Cutoff', min: 40, max: 20000, def: 6000, curve: 'log', fmt: fmtHz };
const ENVAMT_DEF: ParamDef = { key: 'envAmt', label: 'Env amount', min: 0, max: 1, def: 0.2, fmt: pct };
const GLIDE_DEF: ParamDef = { key: 'glide', label: 'Glide', min: 0.001, max: 1, def: 0.05, curve: 'log', fmt: (v) => (v >= 1 ? v.toFixed(2) + ' s' : Math.round(v * 1000) + ' ms') };
const PITCH_DEF: ParamDef = { ...CHANNEL_PARAMS.pitch, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + ' st' };
const WAVES: { value: Wave; label: string }[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sawtooth', label: 'Saw' },
  { value: 'square', label: 'Square' },
  { value: 'noise', label: 'Noise' },
];
const FILTERS: { value: FilterType; label: string }[] = [
  { value: 'lowpass', label: 'Low pass' },
  { value: 'highpass', label: 'High pass' },
  { value: 'bandpass', label: 'Band pass' },
];
const WAVE_ICON: Record<Wave, string> = {
  sine: 'M2 12 C6 2, 10 2, 12 12 S18 22, 22 12',
  triangle: 'M2 12 L7 4 L17 20 L22 12',
  sawtooth: 'M2 18 L12 5 L12 18 L22 5 L22 18',
  square: 'M2 18 L2 6 L12 6 L12 18 L22 18 L22 6',
  noise: 'M2 12 L4 7 L6 16 L8 9 L10 18 L12 5 L14 14 L16 8 L18 17 L20 10 L22 12',
};
const waveSvg = (w: Wave) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${WAVE_ICON[w]}"/></svg>`;
const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  load: svg('<path d="M4 17v3h16v-3"/><path d="M12 4v11M7 10l5 5 5-5"/>'),
  sampler: svg('<path d="M2 12h2l2-5 3 10 3-14 3 14 3-7 2 2h2"/>'),
  synth: svg('<path d="M3 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
};

function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}

// ---------------------------------------------------------------------------
// mini keyboard (2 octaves) for auditioning
// ---------------------------------------------------------------------------
function createKeyboard(channel: () => Channel | undefined) {
  let octave = 4; // FL naming: C5 = MIDI 60; default range C4..C6
  const keysEl = el('div', { class: 'cs-keys' });
  const octLbl = el('div', { class: 'cs-oct-l' });
  const down = el('button', { class: 'cs-oct-b', html: IC.minus, 'data-hint': 'Keyboard octave down' });
  const up = el('button', { class: 'cs-oct-b', html: IC.plus, 'data-hint': 'Keyboard octave up' });
  const root = el('div', { class: 'cs-kb' }, el('div', { class: 'cs-oct' }, down, octLbl, up), keysEl);
  const keyEls = new Map<number, HTMLElement>();
  let rootKey = -1;

  const build = () => {
    keysEl.textContent = '';
    keyEls.clear();
    const base = octave * 12;
    const whites: number[] = [];
    for (let k = base; k <= base + 24; k++) if (!isBlackKey(k)) whites.push(k);
    const ww = 100 / whites.length;
    whites.forEach((k, i) => {
      const e = el('div', { class: 'cs-key w' + (k % 12 === 0 ? ' c' : ''), 'data-k': String(k), style: { left: i * ww + '%', width: ww + '%' } }, k % 12 === 0 ? el('span', { text: noteName(k) }) : null);
      keyEls.set(k, e);
      keysEl.append(e);
    });
    for (let k = base; k <= base + 24; k++) {
      if (!isBlackKey(k)) continue;
      const wi = whites.indexOf(k - 1);
      const e = el('div', { class: 'cs-key b', 'data-k': String(k), style: { left: (wi + 1) * ww - ww * 0.3 + '%', width: ww * 0.6 + '%' } });
      keyEls.set(k, e);
      keysEl.append(e);
    }
    setText(octLbl, `${noteName(base)}–${noteName(base + 24)}`);
    rootKey = -1;
    update();
  };

  const update = () => {
    const c = channel();
    const rk = c?.type === 'sampler' ? c.sampler?.rootKey ?? -1 : -1;
    if (rk === rootKey) return;
    keyEls.get(rootKey)?.classList.remove('root');
    keyEls.get(rk)?.classList.add('root');
    rootKey = rk;
  };

  const HOLD = 'chsettings-kb';
  let held: { key: number; ch: ID } | null = null;
  const release = () => {
    if (!held) return;
    engine.noteOff(held.key, held.ch, HOLD);
    keyEls.get(held.key)?.classList.remove('down');
    held = null;
  };
  const press = (k: number, y: number, target: HTMLElement) => {
    const c = channel();
    if (!c) return;
    if (held?.key === k) return;
    release();
    const r = target.getBoundingClientRect();
    const vel = clamp(0.35 + 0.65 * ((y - r.top) / Math.max(1, r.height)), 0.2, 1);
    engine.noteOn(k, vel, c.id, HOLD);
    held = { key: k, ch: c.id };
    target.classList.add('down');
  };
  const keyAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest?.('.cs-key') as HTMLElement | null;
  keysEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = (e.target as HTMLElement).closest('.cs-key') as HTMLElement | null;
    if (!t) return;
    e.preventDefault();
    press(Number(t.dataset.k), e.clientY, t);
    const mv = (ev: PointerEvent) => {
      const k = keyAt(ev.clientX, ev.clientY);
      if (k && keysEl.contains(k)) press(Number(k.dataset.k), ev.clientY, k);
    };
    const upFn = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', upFn);
      window.removeEventListener('pointercancel', upFn);
      release();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', upFn);
    window.addEventListener('pointercancel', upFn);
  });
  keysEl.dataset.hint = 'Click (and slide) to audition the channel — lower on the key = louder';
  down.addEventListener('click', () => {
    octave = Math.max(0, octave - 1);
    build();
  });
  up.addEventListener('click', () => {
    octave = Math.min(8, octave + 1);
    build();
  });
  build();
  return { root, update, release };
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------
export function createChannelSettings(): PanelDef {
  const head = el('div', { class: 'cs-head' });
  const tabs = el('div', { class: 'cs-tabs' });
  const body = el('div', { class: 'cs-body' });
  const current = (): Channel | undefined => store.channel(store.ui.settingsChannel) ?? store.selectedChannel;
  const kb = createKeyboard(current);
  const root = el('div', { class: 'cs' }, head, tabs, body, kb.root);
  const visible = () => !!wm?.get('channelsettings')?.visible;

  let builtSig = '';
  let ups: (() => void)[] = [];
  let cleanups: (() => void)[] = [];
  let knobOpts: KnobOpts[] = [];
  let dirty = false;
  let lastTitle = '';

  function build(c: Channel | undefined) {
    for (const f of cleanups) f();
    cleanups = [];
    ups = [];
    knobOpts = [];
    head.textContent = '';
    tabs.textContent = '';
    body.textContent = '';
    kb.release();
    if (!c) {
      body.append(el('div', { class: 'cs-empty', text: 'No channel selected — add one in the Channel Rack (F6).' }));
      return;
    }
    const id = c.id;
    const ch = () => store.channel(id);
    const live = (fn: (x: Channel) => void) =>
      store.live((p) => {
        const x = p.channels.find((k) => k.id === id);
        if (x) fn(x);
      });
    const commit = (label: string, fn: (x: Channel) => void) =>
      store.commit(label, (p) => {
        const x = p.channels.find((k) => k.id === id);
        if (x) fn(x);
      });
    const begin = () => store.begin('Channel setting');
    const end = () => store.end();

    // knob cell with label + value read-out
    const kcell = (def: ParamDef, get: () => number, set: (x: Channel, v: number) => void, o: { label?: string; bipolar?: boolean; size?: number; automate?: 'vol' | 'pan' | 'cutoff'; color?: string; cls?: string } = {}) => {
      const val = el('div', { class: 'cs-kv' });
      const opts: KnobOpts = {
        def,
        size: o.size ?? 30,
        bipolar: o.bipolar,
        color: o.color,
        name: ch()?.name,
        get,
        set: (v) => live((x) => set(x, v)),
        begin,
        end,
        onAutomate: o.automate ? () => createAutomation({ scope: 'channel', id, param: o.automate! }) : undefined,
      };
      knobOpts.push(opts);
      const k: KnobEl = knob(opts);
      let last = NaN;
      ups.push(() => {
        const v = get();
        if (v === last) return;
        last = v;
        k.update();
        setText(val, fmtParam(def, v));
      });
      return el('div', { class: 'cs-k' + (o.cls ? ' ' + o.cls : '') }, k, el('div', { class: 'cs-kl', text: o.label ?? def.label }), val);
    };
    const toggle = (label: string, hint: string, get: () => boolean, set: (x: Channel, v: boolean) => void) => {
      const b = el('button', { class: 'cs-tog', 'data-hint': hint }, el('span', { class: 'cs-tog-led' }), el('span', { text: label }));
      b.addEventListener('click', () => commit(label, (x) => set(x, !get())));
      ups.push(() => b.classList.toggle('on', get()));
      return b;
    };
    const sel = <T extends string | number>(opts: { value: T; label: string }[], get: () => T, set: (x: Channel, v: T) => void, label: string, hint: string) => {
      const s = select(opts, get(), (v) => {
        commit(label, (x) => set(x, v));
        s.blur();
      }, hint);
      ups.push(() => {
        const v = String(get());
        if (s.value !== v && document.activeElement !== s) s.value = v;
      });
      return s;
    };
    const section = (title: string, cls = '', extra?: HTMLElement) => {
      const content = el('div', { class: 'cs-sec-b' });
      const sec = el('div', { class: 'cs-sec ' + cls }, el('div', { class: 'cs-sec-h' }, el('span', { text: title }), extra ?? null), content);
      return { sec, content };
    };
    const envRow = (get: () => Envelope | undefined, set: (x: Channel) => Envelope | undefined, cls = '') =>
      el(
        'div',
        { class: 'cs-krow ' + cls },
        ...(['a', 'd', 's', 'r'] as const).map((k) =>
          kcell(ENV_PARAMS[k], () => get()?.[k] ?? ENV_PARAMS[k].def, (x, v) => {
            const e = set(x);
            if (e) e[k] = v;
          }, { size: 28 }),
        ),
      );

    // ---------------- common header ----------------
    const swatch = el('button', { class: 'cs-swatch', 'data-hint': 'Channel color — click to change' });
    swatch.addEventListener('click', (e) => colorChannels([id], e.clientX, e.clientY));
    const nameIn = el('input', { class: 'input cs-name', type: 'text', spellcheck: false, 'data-hint': 'Channel name — type and press Enter' }) as HTMLInputElement;
    nameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameIn.blur();
      else if (e.key === 'Escape') {
        nameIn.value = ch()?.name ?? '';
        nameIn.blur();
      }
      e.stopPropagation();
    });
    nameIn.addEventListener('change', () => {
      const v = nameIn.value.trim();
      if (v && v !== ch()?.name) setName(id, v);
      else nameIn.value = ch()?.name ?? '';
    });
    const kind = el('div', { class: 'cs-kind' });
    const mixSel = el('select', { class: 'select cs-mixsel', 'data-hint': 'Mixer track this channel plays through' }) as HTMLSelectElement;
    mixSel.addEventListener('change', () => {
      setMixerTrack(id, Number(mixSel.value));
      mixSel.blur();
    });
    mixSel.addEventListener('keydown', (e) => e.stopPropagation());
    let mixSig = '';
    const led = el('div', { class: 'led cs-led' });
    led.addEventListener('click', () => toggleMute([id]));
    const ledLbl = el('span', { class: 'cs-led-l' });
    const muteBox = el('div', { class: 'cs-mute' }, led, ledLbl);
    muteBox.addEventListener('click', (e) => {
      if (e.target !== led) toggleMute([id]);
    });
    head.append(
      swatch,
      el('div', { class: 'cs-titles' }, kind, nameIn),
      el(
        'div',
        { class: 'cs-head-k' },
        kcell(CHANNEL_PARAMS.vol, () => ch()?.vol ?? 0.78, (x, v) => (x.vol = v), { size: 26, label: 'Volume', automate: 'vol' }),
        kcell(CHANNEL_PARAMS.pan, () => ch()?.pan ?? 0, (x, v) => (x.pan = v), { size: 26, label: 'Pan', bipolar: true, automate: 'pan' }),
        kcell(PITCH_DEF, () => ch()?.pitch ?? 0, (x, v) => (x.pitch = Math.round(v * 100) / 100), { size: 26, label: 'Pitch', bipolar: true }),
      ),
      el('div', { class: 'cs-head-r' }, el('label', { class: 'cs-lbl', text: 'Mixer' }), mixSel, muteBox),
    );
    ups.push(() => {
      const x = ch();
      if (!x) return;
      swatch.style.background = x.color;
      root.style.setProperty('--cc', x.color);
      if (document.activeElement !== nameIn && nameIn.value !== x.name) nameIn.value = x.name;
      setText(kind, x.type === 'synth' ? 'Tri-Osc synth' : x.audioClip ? 'Audio clip · sampler' : 'Sampler');
      const m = store.project.mixer;
      const s = m.map((t) => t.name).join('|');
      if (s !== mixSig) {
        mixSig = s;
        mixSel.textContent = '';
        m.forEach((t, i) => mixSel.append(el('option', { value: String(i), text: i === 0 ? 'Master' : `${i} · ${t.name}` })));
      }
      const v = String(clamp(x.mixer, 0, m.length - 1));
      if (mixSel.value !== v && document.activeElement !== mixSel) mixSel.value = v;
      led.classList.toggle('on', !x.mute);
      setText(ledLbl, x.mute ? 'Muted' : 'On');
      muteBox.dataset.hint = `${x.mute ? 'Muted' : 'Active'} — click to ${x.mute ? 'unmute' : 'mute'}`;
      for (const o of knobOpts) o.name = x.name;
    });

    // ---------------- tab strip ----------------
    const tabInfo = el('div', { class: 'cs-tab-i' });
    const tabRight = el('div', { class: 'cs-tab-r' }, tabInfo);
    tabs.append(el('div', { class: 'cs-tab on' }, el('span', { class: 'cs-tab-ic', html: c.type === 'synth' ? IC.synth : IC.sampler }), el('span', { text: c.type === 'synth' ? 'Tri-Osc Synth' : 'Sampler' })), el('div', { class: 'cs-tab-sp' }), tabRight);

    if (c.type === 'sampler') buildSampler();
    else buildSynth();

    // ---------------- sampler page ----------------
    function buildSampler() {
      const sp = () => ch()?.sampler;
      const page = el('div', { class: 'cs-page sampler' });

      // waveform
      const wave = el('div', { class: 'cs-wave', 'data-hint': 'Sample waveform — drag to set the start offset · drop a sample here to replace it' });
      const cv = el('canvas') as HTMLCanvasElement;
      const wname = el('div', { class: 'cs-wave-name' });
      const wempty = el('div', { class: 'cs-wave-empty', text: 'No sample — click “Load sample…” or drop audio here' });
      wave.append(cv, wname, wempty);
      let wsig = '';
      const draw = () => {
        const x = ch();
        const s = sp();
        if (!x || !s) return;
        const w = Math.max(10, wave.clientWidth), h = Math.max(10, wave.clientHeight);
        const dpr = window.devicePixelRatio || 1;
        const loaded = !!samples.get(s.sampleRef);
        const sig = `${w}x${h}@${dpr}|${s.sampleRef}|${s.reverse}|${s.startOffset.toFixed(4)}|${x.color}|${loaded}`;
        wempty.style.display = s.sampleRef ? 'none' : '';
        if (sig === wsig) return;
        wsig = sig;
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = w + 'px';
        cv.style.height = h + 'px';
        const g = cv.getContext('2d')!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        const mid = h / 2;
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(0, Math.round(mid), w, 1);
        const pk = s.sampleRef && loaded ? samples.peaks(s.sampleRef, Math.min(2048, Math.round(w))) : null;
        if (pk) {
          const nb = pk.length / 2;
          let m = 0.0001;
          for (let i = 0; i < pk.length; i++) m = Math.max(m, Math.abs(pk[i]));
          const amp = (mid - 6) / m;
          const grad = g.createLinearGradient(0, 0, 0, h);
          grad.addColorStop(0, shade(x.color, 0.45));
          grad.addColorStop(0.5, x.color);
          grad.addColorStop(1, shade(x.color, 0.45));
          g.fillStyle = grad;
          g.beginPath();
          for (let i = 0; i < nb; i++) {
            const k = s.reverse ? nb - 1 - i : i;
            g.lineTo((i / nb) * w, mid - pk[k * 2 + 1] * amp);
          }
          for (let i = nb - 1; i >= 0; i--) {
            const k = s.reverse ? nb - 1 - i : i;
            g.lineTo((i / nb) * w, mid - pk[k * 2] * amp);
          }
          g.closePath();
          g.fill();
        } else if (s.sampleRef) {
          g.fillStyle = 'rgba(255,255,255,0.35)';
          g.font = '11px sans-serif';
          g.fillText(samples.isMissing(s.sampleRef) ? 'Sample file not found' : 'Loading…', 10, mid + 4);
        }
        // start offset
        const sx = s.startOffset * w;
        if (sx > 0.5) {
          g.fillStyle = 'rgba(8,10,12,0.62)';
          g.fillRect(0, 0, sx, h);
        }
        g.fillStyle = '#f6a432';
        g.fillRect(Math.round(sx), 0, 2, h);
        g.beginPath();
        g.moveTo(sx, 0);
        g.lineTo(sx + 8, 0);
        g.lineTo(sx, 8);
        g.closePath();
        g.fill();
      };
      ups.push(() => {
        const s = sp();
        setText(wname, s?.sampleName ?? '');
        draw();
      });
      const ro = new ResizeObserver(() => draw());
      ro.observe(wave);
      cleanups.push(() => ro.disconnect());
      wave.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !sp()?.sampleRef) return;
        e.preventDefault();
        const r = wave.getBoundingClientRect();
        const at = (cx: number) => clamp((cx - r.left) / r.width, 0, 0.99);
        begin();
        live((x) => x.sampler && (x.sampler.startOffset = at(e.clientX)));
        drag(e, (_dx, _dy, ev) => live((x) => x.sampler && (x.sampler.startOffset = at(ev.clientX))), () => end());
      });
      const acceptDrop = (target: HTMLElement) => {
        target.addEventListener('dragover', (e) => {
          if (!hasType(e, DT_SAMPLE) && !hasType(e, 'Files')) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          target.classList.add('drop');
        });
        target.addEventListener('dragleave', () => target.classList.remove('drop'));
        target.addEventListener('drop', async (e) => {
          target.classList.remove('drop');
          if (!hasType(e, DT_SAMPLE) && !hasType(e, 'Files')) return;
          e.preventDefault();
          const list = await samplesFromDrop(e);
          if (list[0]) replaceSample(id, list[0]);
        });
      };
      acceptDrop(wave);

      // sample controls
      const loadBtn = el('button', { class: 'cs-btn', 'data-hint': 'Load an audio file into this sampler (other settings are kept)' }, el('span', { class: 'cs-btn-i', html: IC.load }), el('span', { text: 'Load sample…' }));
      loadBtn.addEventListener('click', async () => {
        const list = await pickSamples(false);
        if (list[0]) replaceSample(id, list[0]);
      });
      const rootKey = dragNumber({
        get: () => sp()?.rootKey ?? 60,
        set: (v) => live((x) => x.sampler && (x.sampler.rootKey = v)),
        begin,
        end,
        min: 0,
        max: 127,
        step: 1,
        pxPerStep: 5,
        fmt: (v) => noteName(v),
        hint: 'Root key — the note that plays the sample at its original pitch (drag, scroll, double-click to type a MIDI number)',
        cls: 'cs-num',
      });
      let lastRoot = NaN;
      ups.push(() => {
        const v = sp()?.rootKey ?? 60;
        if (v !== lastRoot) {
          lastRoot = v;
          rootKey.update();
        }
      });
      const cut = sel(
        [{ value: 0, label: 'None' }, ...Array.from({ length: 8 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))],
        () => sp()?.cutGroup ?? 0,
        (x, v) => x.sampler && (x.sampler.cutGroup = v),
        'Cut group',
        'Cut group — voices in the same group cut each other off (e.g. closed hat chokes open hat)',
      );
      const { sec: sSec, content: sCont } = section(
        'Sample',
        'wavecard',
        el('div', { class: 'cs-sec-act' }, loadBtn, toggle('Reverse', 'Play the sample backwards', () => !!sp()?.reverse, (x, v) => x.sampler && (x.sampler.reverse = v))),
      );
      sCont.append(wave);
      const { sec: pSec, content: pCont } = section('Playback', 'playback');
      pCont.append(
        el(
          'div',
          { class: 'cs-pb' },
          kcell(START_DEF, () => sp()?.startOffset ?? 0, (x, v) => x.sampler && (x.sampler.startOffset = v), { size: 28, label: 'Start' }),
          el('div', { class: 'cs-form' }, el('label', { class: 'cs-fl', text: 'Root key' }), rootKey, el('label', { class: 'cs-fl', text: 'Cut group' }), cut),
        ),
      );

      // envelope
      const envToggle = toggle('Enabled', 'Use the ADSR envelope (off = one-shot: the whole sample plays)', () => !!sp()?.envEnabled, (x, v) => x.sampler && (x.sampler.envEnabled = v));
      const { sec: eSec, content: eCont } = section('Amp envelope', '', envToggle);
      const er = envRow(() => sp()?.env, (x) => x.sampler?.env);
      eCont.append(er);
      ups.push(() => eSec.classList.toggle('off', !sp()?.envEnabled));

      // filter
      const { sec: fSec, content: fCont } = section('Filter');
      fCont.append(
        el(
          'div',
          { class: 'cs-krow' },
          kcell(CHANNEL_PARAMS.cutoff, () => sp()?.cutoff ?? 20000, (x, v) => x.sampler && (x.sampler.cutoff = v), { label: 'Cutoff', automate: 'cutoff', size: 28 }),
          kcell(RESO_DEF, () => sp()?.reso ?? 0.7, (x, v) => x.sampler && (x.sampler.reso = v), { size: 28 }),
        ),
      );

      page.append(sSec, el('div', { class: 'cs-grid' }, pSec, eSec, fSec));
      body.append(page);
      ups.push(() => {
        const s = sp();
        const b = s?.sampleRef ? samples.get(s.sampleRef) : undefined;
        setText(tabInfo, b ? `${b.duration.toFixed(2)} s · ${b.numberOfChannels === 1 ? 'mono' : 'stereo'} · ${(b.sampleRate / 1000).toFixed(1)} kHz` : s?.sampleRef ? 'loading…' : 'empty');
      });
    }

    // ---------------- synth page ----------------
    function buildSynth() {
      const sy = () => ch()?.synth;
      const page = el('div', { class: 'cs-page synth' });

      // preset
      const presetSel = el('select', { class: 'select cs-preset', 'data-hint': 'Load a preset — replaces every synth parameter (Ctrl+Z restores)' }) as HTMLSelectElement;
      presetSel.append(el('option', { value: '', text: 'Custom', disabled: true }));
      for (const p of SYNTH_PRESETS) presetSel.append(el('option', { value: p.name, text: p.name, title: p.desc }));
      presetSel.addEventListener('change', () => {
        if (presetSel.value) applyPreset(id, presetSel.value);
        presetSel.blur();
      });
      presetSel.addEventListener('keydown', (e) => e.stopPropagation());
      ups.push(() => {
        const x = ch();
        const v = x ? matchingPreset(x) ?? '' : '';
        if (presetSel.value !== v && document.activeElement !== presetSel) presetSel.value = v;
      });
      tabRight.append(el('label', { class: 'cs-lbl', text: 'Preset' }), presetSel);

      // oscillators
      const { sec: oSec, content: oCont } = section('Oscillators');
      oCont.append(el('div', { class: 'cs-osc head' }, el('span', { text: 'Wave' }), el('span', { text: 'Level' }), el('span', { text: 'Coarse' }), el('span', { text: 'Fine' })));
      for (let i = 0; i < 3; i++) {
        const o = () => sy()?.osc[i];
        const icon = el('span', { class: 'cs-wave-ic', 'data-hint': `Oscillator ${i + 1}` });
        let lastWave = '';
        ups.push(() => {
          const w = o()?.wave ?? 'sine';
          if (w !== lastWave) {
            lastWave = w;
            icon.innerHTML = waveSvg(w);
          }
          row.classList.toggle('silent', (o()?.level ?? 0) <= 0);
        });
        const waveSel = sel(WAVES, () => o()?.wave ?? 'sine', (x, v) => x.synth && (x.synth.osc[i].wave = v), `Osc ${i + 1} wave`, `Oscillator ${i + 1} waveform`);
        const coarse = dragNumber({
          get: () => o()?.coarse ?? 0,
          set: (v) => live((x) => x.synth && (x.synth.osc[i].coarse = v)),
          begin,
          end,
          min: -36,
          max: 36,
          step: 1,
          pxPerStep: 5,
          fmt: (v) => (v > 0 ? '+' : '') + v + ' st',
          hint: `Oscillator ${i + 1} coarse tuning in semitones (drag, scroll, double-click to type)`,
          cls: 'cs-num',
        });
        let lastCoarse = NaN;
        ups.push(() => {
          const v = o()?.coarse ?? 0;
          if (v !== lastCoarse) {
            lastCoarse = v;
            coarse.update();
          }
        });
        const row = el(
          'div',
          { class: 'cs-osc' },
          el('div', { class: 'cs-osc-w' }, icon, waveSel),
          kcell(LEVEL_DEF, () => o()?.level ?? 0, (x, v) => x.synth && (x.synth.osc[i].level = v), { size: 22, cls: 'mini' }),
          coarse,
          kcell(FINE_DEF, () => o()?.fine ?? 0, (x, v) => x.synth && (x.synth.osc[i].fine = Math.round(v)), { size: 22, bipolar: true, cls: 'mini' }),
        );
        oCont.append(row);
      }

      // voice
      oCont.append(el('div', { class: 'cs-subh', text: 'Voice' }));
      const vRow = oCont.appendChild(
        el(
          'div',
          { class: 'cs-krow' },
          kcell(UNISON_DEF, () => sy()?.unison ?? 1, (x, v) => x.synth && (x.synth.unison = Math.round(v)), { size: 28 }),
          kcell(DETUNE_DEF, () => sy()?.detune ?? 12, (x, v) => x.synth && (x.synth.detune = v), { size: 28 }),
          el('div', { class: 'cs-k tog' }, toggle('Mono', 'Monophonic: one note at a time, with glide between overlapping notes', () => !!sy()?.mono, (x, v) => x.synth && (x.synth.mono = v))),
          kcell(GLIDE_DEF, () => sy()?.glide ?? 0.05, (x, v) => x.synth && (x.synth.glide = v), { size: 28, cls: 'glide' }),
        ),
      );
      ups.push(() => vRow.querySelector('.glide')?.classList.toggle('off', !sy()?.mono));

      // amp envelope
      const { sec: aSec, content: aCont } = section('Amp envelope');
      aCont.append(envRow(() => sy()?.env, (x) => x.synth?.env));

      // filter
      const typeSel = sel(FILTERS, () => sy()?.filterType ?? 'lowpass', (x, v) => x.synth && (x.synth.filterType = v), 'Filter type', 'Filter type');
      const { sec: fSec, content: fCont } = section('Filter', '', typeSel);
      fCont.append(
        el(
          'div',
          { class: 'cs-krow' },
          kcell(SYN_CUT_DEF, () => sy()?.cutoff ?? 6000, (x, v) => x.synth && (x.synth.cutoff = v), { size: 28 }),
          kcell({ ...RESO_DEF, def: 1 }, () => sy()?.reso ?? 1, (x, v) => x.synth && (x.synth.reso = v), { size: 28 }),
          kcell(ENVAMT_DEF, () => sy()?.filterEnvAmt ?? 0, (x, v) => x.synth && (x.synth.filterEnvAmt = v), { size: 28, color: 'var(--accent2)' }),
        ),
      );
      const fenv = envRow(() => sy()?.filterEnv, (x) => x.synth?.filterEnv, 'fenv');
      fCont.append(el('div', { class: 'cs-subh', text: 'Filter envelope' }), fenv);
      ups.push(() => fenv.classList.toggle('off', (sy()?.filterEnvAmt ?? 0) <= 0));

      page.append(el('div', { class: 'cs-cols' }, oSec, aSec, fSec));
      body.append(page);
      ups.push(() => {
        const s = sy();
        if (!s) return;
        const n = s.osc.filter((o) => o.level > 0).length;
        tabInfo.dataset.hint = `${n} active oscillator${n === 1 ? '' : 's'} · ${s.unison > 1 ? s.unison + '× unison · ' : ''}${s.mono ? 'mono' : 'poly'}`;
      });
    }
  }

  function sync(force = false) {
    if (!store.project) return;
    if (!force && !visible()) {
      dirty = true;
      return;
    }
    dirty = false;
    const c = current();
    const sig = c ? `${c.id}|${c.type}` : '';
    if (sig !== builtSig) {
      builtSig = sig;
      build(c);
    }
    for (const u of ups) u();
    kb.update();
    const title = c ? `Channel settings — ${c.name}` : 'Channel settings';
    if (title !== lastTitle) {
      lastTitle = title;
      wm?.get('channelsettings')?.setTitle(title);
    }
  }

  store.on('project', () => sync());
  store.on('loaded', () => {
    builtSig = '';
    sync();
  });
  store.on('ui', (keys) => {
    // follow the rack selection while open (single selection only)
    if (keys.includes('selectedChannels') && visible()) {
      const s = store.ui.selectedChannels;
      if (s.length === 1 && s[0] !== store.ui.settingsChannel && store.channel(s[0])) {
        store.setUI({ settingsChannel: s[0] });
        return;
      }
    }
    if (keys.includes('settingsChannel') || keys.includes('selectedChannels')) sync();
  });
  samples.on('loaded', () => sync());

  return {
    body: root,
    onShow: () => sync(true),
    onHide: () => kb.release(),
    onResize: () => {
      if (dirty && visible()) sync(true);
    },
  };
}
