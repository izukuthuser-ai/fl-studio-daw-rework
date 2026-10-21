// Rune — plugin window UI (≈960×600): oscillators, filters, amp/voice, modulation (envelopes, LFOs,
// matrix), arpeggiator, effects, macros and an audition keyboard. Drags are begin/live/end, discrete edits
// are single commits; every control carries a hint; displays are HiDPI canvases animated only while shown.
import { el } from '../../../core/util';
import { knob, select, KnobEl, drag, lockHint } from '../../../ui/widgets';
import type { ParamDef } from '../../../core/params';
import type { PluginUI, PluginUIApi } from '../api';
import {
  normalize, repair, RuneState, OSC_TYPES, OSC_LABELS, FILTER_TYPES, FILTER_LABELS, FILTER_MODES, DIST_TYPES, DIST_LABELS,
  LFO_SHAPES, LFO_LABELS, LFO_DIVS, ARP_RATES, DELAY_DIVS, ARP_MODES, ARP_LABELS, VOICE_MODES, MOD_SOURCES, MOD_DESTS, MOD_SLOTS,
  DST_INDEX,
} from './defs';
import { canvas, Cv, drawEnv, drawFilter, drawLfo, drawScope } from './ui-draw';
import './rune.css';

export const COL = { osc: '#f4a83a', flt: '#3fd2c3', amp: '#a3e05f', env: '#b18cff', lfo: '#e48bff', mtx: '#8fa7ff', arp: '#ff6fa8', fx: '#5cb2ff', macro: '#ffd25e', voice: '#ffb37a' };

type Path = (string | number)[];
type Upd = () => void;
const getP = (o: any, p: Path) => p.reduce((a, k) => (a == null ? a : a[k]), o);
function setP(o: any, p: Path, v: any) {
  let a = o;
  for (let i = 0; i < p.length - 1; i++) a = a[p[i]];
  a[p[p.length - 1]] = v;
}

// ---------------- formatting ----------------
const pct = (v: number) => Math.round(v * 100) + '%';
const hz = (v: number) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : v >= 100 ? Math.round(v) + ' Hz' : v.toFixed(1) + ' Hz');
const sec = (v: number) => (v < 0.001 ? 'Off' : v < 1 ? (v < 0.01 ? (v * 1000).toFixed(1) : Math.round(v * 1000)) + ' ms' : v.toFixed(2) + ' s');
const sgn = (v: number, u = '') => (v > 0 ? '+' : '') + v + u;
const dB = (v: number) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
const panF = (v: number) => (Math.abs(v) < 0.01 ? 'C' : Math.round(Math.abs(v) * 100) + (v < 0 ? 'L' : 'R'));
const bip = (v: number) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%';
const def = (key: string, label: string, min: number, max: number, d: number, extra: Partial<ParamDef> = {}): ParamDef => ({ key, label, min, max, def: d, ...extra });

const waveName = (v: number) => {
  const names = ['Saw', 'Pulse', 'Triangle', 'Sine'];
  const i = Math.floor(v + 1e-6), f = v - i;
  if (f < 0.03 || i >= 3) return names[Math.min(3, i)];
  if (f > 0.97) return names[i + 1];
  return `${names[i]} → ${names[i + 1]} ${Math.round(f * 100)}%`;
};
const pmWaveName = (v: number) => {
  const names = ['Sine', 'Triangle', 'Saw', 'Square'];
  const i = Math.floor(v + 1e-6), f = v - i;
  if (f < 0.03 || i >= 3) return names[Math.min(3, i)];
  return `${names[i]} → ${names[i + 1]} ${Math.round(f * 100)}%`;
};
const VOWELS = ['A', 'E', 'I', 'O', 'U'];

// ---------------- binder ----------------
class Binder {
  cur: RuneState;
  constructor(public api: PluginUIApi) {
    this.cur = normalize(api.getState());
  }
  reread() {
    this.cur = normalize(this.api.getState());
  }
  get(p: Path) {
    return getP(this.cur, p);
  }
  live(p: Path, v: any) {
    setP(this.cur, p, v);
    this.api.live((s) => setP(repair(s), p, v));
  }
  commit(label: string, p: Path, v: any) {
    setP(this.cur, p, v);
    this.api.commit(label, (s) => setP(repair(s), p, v));
  }
  edit(label: string, fn: (s: RuneState) => void) {
    fn(this.cur);
    this.api.commit(label, (s) => fn(repair(s)));
  }
}

interface KOpts { size?: number; color: string; label?: string; bipolar?: boolean; name?: string; onAutomate?: () => void; cls?: string }

function K(b: Binder, ups: Upd[], p: Path, d: ParamDef, o: KOpts): KnobEl {
  let last: any = NaN;
  const k = knob({
    def: d,
    get: () => b.get(p),
    set: (v) => b.live(p, d.step ? Math.round(v / d.step) * d.step : v),
    begin: () => b.api.begin(`${o.name ? o.name + ' ' : ''}${d.label}`),
    end: () => b.api.end(),
    size: o.size ?? 26,
    label: o.label ?? d.label.toUpperCase(),
    bipolar: o.bipolar,
    color: o.color,
    name: o.name,
    onAutomate: o.onAutomate,
  });
  if (o.cls) k.classList.add(o.cls);
  ups.push(() => {
    const v = b.get(p);
    if (v !== last) {
      last = v;
      k.update();
    }
  });
  return k;
}

function Tog(b: Binder, ups: Upd[], p: Path, label: string, hint: string, color: string, cls = ''): HTMLElement {
  const t = cvar(el('button', { class: 'rn-tog ' + cls, text: label, 'data-hint': hint }), color);
  t.addEventListener('click', () => b.commit(hint.split(' — ')[0], p, !b.get(p)));
  ups.push(() => t.classList.toggle('on', !!b.get(p)));
  return t;
}

function Seg<T extends string | number>(b: Binder, ups: Upd[], p: Path, opts: { v: T; label: string; hint: string }[], color: string, label: string, cls = ''): HTMLElement {
  const wrap = cvar(el('div', { class: 'rn-seg ' + cls }), color);
  const btns = opts.map((o) => {
    const x = el('button', { text: o.label, 'data-hint': o.hint });
    x.addEventListener('click', () => b.commit(label, p, o.v));
    wrap.append(x);
    return x;
  });
  ups.push(() => {
    const v = b.get(p);
    btns.forEach((x, i) => x.classList.toggle('on', opts[i].v === v));
  });
  return wrap;
}

function Sel<T extends string | number>(b: Binder, ups: Upd[], p: Path, opts: { value: T; label: string }[], label: string, hint: string, cls = ''): HTMLSelectElement {
  const s = select(opts, b.get(p), (v) => b.commit(label, p, v), hint);
  s.classList.add('rn-sel');
  if (cls) s.classList.add(cls);
  ups.push(() => {
    const v = String(b.get(p));
    if (s.value !== v) s.value = v;
  });
  return s;
}

function card(title: string, color: string, cls: string, ...head: (Node | null)[]): { root: HTMLElement; body: HTMLElement; head: HTMLElement } {
  const h = el('div', { class: 'rn-head' }, el('span', { class: 'rn-title', text: title }), ...head);
  const body = el('div', { class: 'rn-body' });
  const root = cvar(el('div', { class: 'rn-card ' + cls }, h, body), color);
  return { root, body, head: h };
}

const row = (...c: (Node | null)[]) => el('div', { class: 'rn-row' }, ...c);
/** Set the accent colour custom property (el() assigns styles as properties, which skips custom props). */
function cvar<T extends HTMLElement>(e: T, color: string): T {
  e.style.setProperty('--c', color);
  return e;
}

// =====================================================================================
export function createRuneUI(api: PluginUIApi): PluginUI {
  const b = new Binder(api);
  const ups: Upd[] = []; // static controls
  const redraws: (() => void)[] = []; // static canvases (redrawn when their inputs change)
  let viz: any = null;
  let shown = false;

  // ---------------- header ----------------
  const voiceLed = el('span', { class: 'rn-vcount', text: '0' });
  const logo = el('div', { class: 'rn-logo', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v18M7 4l8 4.5L7 13M7 13l9 8"/></svg><span>RUNE</span>` });
  const tagline = el('div', { class: 'rn-tag', text: 'ANALOG · SEMI-MODULAR · POLY' });
  const header = el('div', { class: 'rn-header' }, logo, tagline, el('div', { class: 'rn-sp' }),
    el('div', { class: 'rn-voices', 'data-hint': 'Voices currently sounding' }, el('span', { class: 'rn-led' }), 'VOICES', voiceLed));

  // ---------------- oscillators ----------------
  const oscCards = [0, 1, 2].map((k) => oscCard(k));
  const fltCards = [0, 1].map((j) => filterCard(j));

  function oscCard(k: number) {
    const c = COL.osc;
    const name = `Osc ${k + 1}`;
    const typeSel = Sel(b, ups, ['osc', k, 'type'], OSC_TYPES.map((t) => ({ value: t, label: OSC_LABELS[t] })), `${name} type`, `${name}: oscillator model`);
    const cd = card(`OSC ${k + 1}`, c, 'rn-osc', typeSel);
    const scope = canvas(174, 46);
    let scopeSig = '';
    redraws.push(() => {
      const o = b.cur.osc[k];
      const sig = JSON.stringify(o);
      if (sig === scopeSig) return;
      scopeSig = sig;
      drawScope(scope, o, c);
    });
    const P = (key: string): Path => ['osc', k, key];
    const common = row(
      K(b, ups, P('oct'), def('oct', 'Octave', -3, 3, 0, { step: 1, fmt: (v) => sgn(v) }), { color: c, name, label: 'OCT', bipolar: true }),
      K(b, ups, P('semi'), def('semi', 'Semitone', -12, 12, 0, { step: 1, fmt: (v) => sgn(v, ' st') }), { color: c, name, label: 'SEMI', bipolar: true }),
      K(b, ups, P('fine'), def('fine', 'Fine', -100, 100, 0, { fmt: (v) => sgn(Math.round(v), ' ct') }), { color: c, name, label: 'FINE', bipolar: true }),
      K(b, ups, P('level'), def('level', 'Level', 0, 1, 0.8, { fmt: pct }), { color: c, name, label: 'LEVEL' }),
      K(b, ups, P('pan'), def('pan', 'Pan', -1, 1, 0, { fmt: panF }), { color: c, name, label: 'PAN', bipolar: true }),
    );
    const typeRow = el('div', { class: 'rn-row rn-typerow' });
    let typeUps: Upd[] = [];
    let builtType = '';
    const buildType = () => {
      const t = b.cur.osc[k].type;
      if (t === builtType) return;
      builtType = t;
      typeUps = [];
      typeRow.innerHTML = '';
      const add = (...n: Node[]) => typeRow.append(...n);
      const kk = (key: string, d: ParamDef, label: string, bipolar = false) => K(b, typeUps, P(key), d, { color: c, name, label, bipolar });
      switch (t) {
        case 'analog':
          add(kk('wave', def('wave', 'Wave', 0, 3, 0, { fmt: waveName }), 'WAVE'), kk('pw', def('pw', 'Pulse width', 0.05, 0.95, 0.5, { fmt: pct }), 'PW'));
          break;
        case 'multi':
          add(
            kk('voices', def('voices', 'Voices', 2, 8, 7, { step: 1, fmt: (v) => String(v) }), 'VOICES'),
            kk('detune', def('detune', 'Detune', 0, 1, 0.3, { fmt: pct }), 'DETUNE'),
            kk('spread', def('spread', 'Stereo spread', 0, 1, 0.6, { fmt: pct }), 'SPREAD'),
            kk('wave', def('wave', 'Saw ↔ pulse', 0, 1, 0, { fmt: (v) => (v < 0.02 ? 'Saw' : v > 0.98 ? 'Pulse' : `Saw/Pulse ${Math.round(v * 100)}%`) }), 'SHAPE'),
          );
          break;
        case 'fm':
        case 'pm':
          add(
            kk('ratio', def('ratio', 'Mod ratio', 0.5, 16, 2, { step: 0.25, fmt: (v) => v.toFixed(2) }), 'RATIO'),
            kk('index', def('index', 'Mod index', 0, 10, 1.5, { fmt: (v) => v.toFixed(2) }), 'INDEX'),
            kk('fb', def('fb', 'Mod feedback', 0, 1, 0, { fmt: pct }), 'FDBK'),
          );
          if (t === 'pm') add(kk('wave', def('wave', 'Mod shape', 0, 3, 0, { fmt: pmWaveName }), 'MOD'));
          break;
        case 'chip':
          add(kk('duty', def('duty', 'Duty', 0, 3, 2, { step: 1, fmt: (v) => ['12.5% pulse', '25% pulse', '50% square', '4-bit triangle'][Math.round(v)] }), 'DUTY'));
          break;
        case 'noise':
          add(
            kk('noise', def('noise', 'Noise type', 0, 2, 0, { step: 1, fmt: (v) => ['White', 'Pink', 'Crackle'][Math.round(v)] }), 'TYPE'),
            kk('color', def('color', 'Colour', 0, 1, 0.5, { fmt: (v) => (Math.abs(v - 0.5) < 0.02 ? 'Neutral' : v < 0.5 ? `Dark ${Math.round((0.5 - v) * 200)}%` : `Bright ${Math.round((v - 0.5) * 200)}%`) }), 'COLOR'),
          );
          break;
        case 'vector':
          add(kk('x', def('x', 'Vector X (sine ↔ saw)', 0, 1, 0.5, { fmt: pct }), 'X'), kk('y', def('y', 'Vector Y (→ organ / vox)', 0, 1, 0.5, { fmt: pct }), 'Y'), vectorPad(k, typeUps));
          break;
        default:
          add(el('div', { class: 'rn-off', text: 'Oscillator off — pick a model above' }));
      }
      if (k > 0 && t !== 'off') add(K(b, typeUps, P('fm'), def('fm', `FM from osc ${k}`, 0, 1, 0, { fmt: pct }), { color: c, name, label: 'FM' }));
      typeUps.forEach((u) => u());
    };
    const routeSeg = Seg(b, ups, P('route'), [
      { v: 0, label: 'F1', hint: `${name} → filter 1` },
      { v: 1, label: 'F2', hint: `${name} → filter 2` },
      { v: 2, label: '1+2', hint: `${name} → both filters` },
    ], c, `${name} routing`, 'rn-route');
    const tools = row(
      routeSeg,
      el('div', { class: 'rn-sp' }),
      k > 0 ? Tog(b, ups, P('sync'), 'SYNC', `${name} hard sync — reset to oscillator 1 every cycle`, c) : null,
      Tog(b, ups, P('reset'), 'RST', `${name} phase reset — restart the waveform on every note`, c),
    );
    cd.body.append(scope.c, common, typeRow, tools);
    return { root: cd.root, update: () => { buildType(); typeUps.forEach((u) => u()); cd.root.classList.toggle('off', b.cur.osc[k].type === 'off'); } };
  }

  function vectorPad(k: number, scopeUps: Upd[]) {
    const pad = el('div', { class: 'rn-xy', 'data-hint': `Osc ${k + 1} vector pad — drag to morph sine / saw / organ / vox` },
      el('span', { class: 'c0', text: 'SIN' }), el('span', { class: 'c1', text: 'SAW' }), el('span', { class: 'c2', text: 'ORG' }), el('span', { class: 'c3', text: 'VOX' }));
    const dot = el('div', { class: 'rn-xy-dot' });
    pad.append(dot);
    const setFrom = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
      setP(b.cur, ['osc', k, 'x'], x);
      setP(b.cur, ['osc', k, 'y'], y);
      api.live((s) => {
        repair(s);
        s.osc[k].x = x;
        s.osc[k].y = y;
      });
      place();
      lockHint(`Vector X ${pct(x)} · Y ${pct(y)}`);
    };
    const place = () => {
      dot.style.left = b.cur.osc[k].x * 100 + '%';
      dot.style.top = (1 - b.cur.osc[k].y) * 100 + '%';
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.begin(`Osc ${k + 1} vector`);
      setFrom(e);
      drag(e, (_dx, _dy, ev) => setFrom(ev), () => {
        lockHint(null);
        api.end();
      });
    });
    scopeUps.push(place);
    return pad;
  }

  // ---------------- filters ----------------
  function filterCard(j: number) {
    const c = COL.flt;
    const name = `Filter ${j + 1}`;
    const P = (key: string): Path => ['flt', j, key];
    const typeSel = Sel(b, ups, P('type'), FILTER_TYPES.map((t) => ({ value: t, label: FILTER_LABELS[t] })), `${name} type`, `${name}: filter model`);
    const routing = j === 1
      ? Seg(b, ups, ['serial'], [
        { v: true as any, label: 'SER', hint: 'Serial: filter 1 feeds filter 2' },
        { v: false as any, label: 'PAR', hint: 'Parallel: both filters go straight to the amp' },
      ], c, 'Filter routing', 'rn-mini rn-routing')
      : null;
    const cd = card(`FILTER ${j + 1}`, c, 'rn-flt', typeSel);
    const curve = canvas(161, 52);
    let sig = '';
    redraws.push(() => {
      const f = b.cur.flt[j];
      const s = JSON.stringify(f);
      if (s === sig) return;
      sig = s;
      drawFilter(curve, f, c);
    });
    const modeArea = el('div', { class: 'rn-modearea' });
    const modeRow = el('div', { class: 'rn-row rn-moderow' }, modeArea, routing);
    const knobs1 = el('div', { class: 'rn-row' });
    const knobs2 = el('div', { class: 'rn-row' });
    let fUps: Upd[] = [];
    let built = '';
    const build = () => {
      const t = b.cur.flt[j].type;
      if (t === built) return;
      built = t;
      fUps = [];
      modeArea.innerHTML = '';
      knobs1.innerHTML = '';
      knobs2.innerHTML = '';
      const modes = FILTER_MODES[t];
      if (modes.length) modeArea.append(Seg(b, fUps, P('mode'), modes.map((m, i) => ({ v: i, label: m, hint: `${name} mode: ${m}` })), c, `${name} mode`));
      else modeArea.append(el('span', { class: 'rn-modehint', text: t === 'off' ? 'bypassed' : t === 'ladder' ? '24 dB · self-osc' : t === 'diode' ? '24 dB · squelch' : t === 'sem' ? 'LP→BP→HP→notch' : t === 'formant' ? 'vowels A E I O U' : t === 'ring' ? 'ring modulator' : '' }));
      const kk = (key: string, d: ParamDef, label: string, size = 24, bipolar = false) => K(b, fUps, P(key), d, { color: c, name, label, size, bipolar });
      const isComb = t === 'comb', isRing = t === 'ring';
      knobs1.append(
        kk('cutoff', def('cutoff', isComb || isRing ? 'Frequency' : 'Cutoff', 20, 20000, 6000, { curve: 'log', fmt: hz }), isComb || isRing ? 'FREQ' : 'CUTOFF', 34),
        kk('res', def('res', isComb ? 'Feedback' : isRing ? 'Mix' : 'Resonance', 0, 1, 0.15, { fmt: pct }), isComb ? 'FDBK' : isRing ? 'MIX' : 'RES', 28),
        kk('drive', def('drive', isRing ? 'Carrier shape' : 'Drive', 0, 1, 0, { fmt: pct }), isRing ? 'SHAPE' : 'DRIVE', 28),
      );
      if (t === 'sem' || t === 'formant')
        knobs1.append(kk('morph', def('morph', t === 'sem' ? 'Morph' : 'Vowel', 0, 1, 0, {
          fmt: t === 'sem' ? (v) => { const m = ['LP', 'BP', 'HP', 'Notch']; const x = Math.min(2.999, v * 3); const i = Math.floor(x); return `${m[i]} → ${m[i + 1]} ${Math.round((x - i) * 100)}%`; } : (v) => { const x = Math.min(3.999, v * 4); const i = Math.floor(x); return `${VOWELS[i]} → ${VOWELS[i + 1]} ${Math.round((x - i) * 100)}%`; },
        }), t === 'sem' ? 'MORPH' : 'VOWEL', 28));
      knobs2.append(
        kk('env', def('env', 'Env amount (ENV2)', -1, 1, 0, { fmt: (v) => sgn(Math.round(v * 72), ' st') }), 'ENV', 24, true),
        kk('key', def('key', 'Key tracking', 0, 1, 0.3, { fmt: pct }), 'KEY'),
        kk('vel', def('vel', 'Velocity amount', 0, 1, 0, { fmt: pct }), 'VEL'),
        kk('level', def('level', 'Output level', 0, 1, 1, { fmt: pct }), 'LEVEL'),
      );
      fUps.forEach((u) => u());
    };
    cd.body.append(modeRow, curve.c, knobs1, knobs2);
    return { root: cd.root, update: () => { build(); fUps.forEach((u) => u()); cd.root.classList.toggle('off', b.cur.flt[j].type === 'off'); } };
  }

  // ---------------- amp + voice ----------------
  const ampCard = (() => {
    const c = COL.amp;
    const cd = card('AMP', c, 'rn-amp', Sel(b, ups, ['amp', 'dist'], DIST_TYPES.map((t) => ({ value: t, label: DIST_LABELS[t] })), 'Distortion type', 'Amp: built-in distortion type'));
    cd.body.append(row(
      K(b, ups, ['amp', 'gain'], def('gain', 'Gain', -24, 12, 0, { fmt: dB }), { color: c, name: 'Amp', label: 'GAIN', size: 30, bipolar: true }),
      K(b, ups, ['amp', 'pan'], def('pan', 'Pan', -1, 1, 0, { fmt: panF }), { color: c, name: 'Amp', label: 'PAN', bipolar: true }),
      K(b, ups, ['amp', 'vel'], def('vel', 'Velocity sensitivity', 0, 1, 0.5, { fmt: pct }), { color: c, name: 'Amp', label: 'VEL' }),
      el('div', { class: 'rn-vsep' }),
      K(b, ups, ['amp', 'drive'], def('drive', 'Distortion drive', 0, 1, 0.3, { fmt: pct }), { color: '#ff9d5c', name: 'Amp', label: 'DRIVE' }),
      K(b, ups, ['amp', 'mix'], def('mix', 'Distortion mix', 0, 1, 1, { fmt: pct }), { color: '#ff9d5c', name: 'Amp', label: 'MIX' }),
    ));
    return cd.root;
  })();

  const voiceCard = (() => {
    const c = COL.voice;
    const cd = card('VOICE', c, 'rn-voice', Seg(b, ups, ['voice', 'mode'], [
      { v: 'poly', label: 'POLY', hint: 'Polyphonic' },
      { v: 'mono', label: 'MONO', hint: 'Monophonic, retriggers envelopes' },
      { v: 'legato', label: 'LEG', hint: 'Monophonic legato: overlapping notes glide without retriggering' },
    ], c, 'Voice mode', 'rn-mini'));
    const V = (key: string): Path => ['voice', key];
    cd.body.append(row(
      K(b, ups, V('voices'), def('voices', 'Polyphony', 1, 24, 12, { step: 1, fmt: (v) => v + ' voices' }), { color: c, name: 'Voice', label: 'POLY' }),
      K(b, ups, V('unison'), def('unison', 'Unison', 1, 4, 1, { step: 1, fmt: (v) => (v === 1 ? 'Off' : v + '× unison') }), { color: c, name: 'Voice', label: 'UNISON' }),
      K(b, ups, V('detune'), def('detune', 'Unison detune', 0, 1, 0.25, { fmt: pct }), { color: c, name: 'Voice', label: 'DETUNE' }),
      K(b, ups, V('spread'), def('spread', 'Unison stereo spread', 0, 1, 0.6, { fmt: pct }), { color: c, name: 'Voice', label: 'WIDTH' }),
      K(b, ups, V('glide'), def('glide', 'Glide time', 0, 2, 0, { curve: 'log', fmt: sec }), { color: c, name: 'Voice', label: 'GLIDE' }),
      K(b, ups, V('drift'), def('drift', 'Analog drift', 0, 1, 0.15, { fmt: pct }), { color: c, name: 'Voice', label: 'DRIFT' }),
      K(b, ups, ['master'], def('master', 'Master volume', -24, 6, 0, { fmt: dB }), { color: '#e8eef2', name: 'Rune', label: 'MASTER', size: 30, bipolar: true }),
    ));
    return cd.root;
  })();

  // ---------------- modulation tab: envelopes + LFOs ----------------
  const envCvs: Cv[] = [];
  const lfoCvs: Cv[] = [];
  const modPane = (() => {
    const envRow = el('div', { class: 'rn-envrow' });
    const names = ['ENV 1 · AMP', 'ENV 2 · FILTER', 'ENV 3 · MOD'];
    for (let e = 0; e < 3; e++) {
      const c = COL.env;
      const E = (key: string): Path => ['env', e, key];
      const nm = `Env ${e + 1}`;
      const cd = card(names[e], c, 'rn-env', Tog(b, ups, E('loop'), 'LOOP', `${nm} loop — repeat attack/decay while the note is held`, c, 'rn-tog-sm'));
      const cv = canvas(189, 44);
      envCvs.push(cv);
      cd.body.append(cv.c, row(
        K(b, ups, E('a'), def('a', 'Attack', 0.0005, 20, 0.004, { curve: 'log', fmt: sec }), { color: c, name: nm, label: 'A', size: 24 }),
        K(b, ups, E('d'), def('d', 'Decay', 0.001, 20, 0.3, { curve: 'log', fmt: sec }), { color: c, name: nm, label: 'D', size: 24 }),
        K(b, ups, E('s'), def('s', 'Sustain', 0, 1, 0.8, { fmt: pct }), { color: c, name: nm, label: 'S', size: 24 }),
        K(b, ups, E('r'), def('r', 'Release', 0.001, 20, 0.25, { curve: 'log', fmt: sec }), { color: c, name: nm, label: 'R', size: 24 }),
      ));
      envRow.append(cd.root);
    }
    const lfoRow = el('div', { class: 'rn-lforow' });
    for (let l = 0; l < 4; l++) {
      const c = COL.lfo;
      const L = (key: string): Path => ['lfo', l, key];
      const nm = `LFO ${l + 1}`;
      const shapeSel = Sel(b, ups, L('shape'), LFO_SHAPES.map((s) => ({ value: s, label: LFO_LABELS[s] })), `${nm} shape`, `${nm} waveform`, 'rn-sel-sm');
      const cd = card(`LFO ${l + 1}`, c, 'rn-lfo', shapeSel);
      const cv = canvas(136, 30);
      lfoCvs.push(cv);
      const rateK = K(b, ups, L('rate'), def('rate', 'Rate', 0.01, 50, 2, { curve: 'log', fmt: hz }), { color: c, name: nm, label: 'RATE', size: 24 });
      const divSel = Sel(b, ups, L('div'), LFO_DIVS.map((d, i) => ({ value: i, label: d.label })), `${nm} division`, `${nm} tempo-synced rate`, 'rn-sel-div');
      const rateBox = el('div', { class: 'rn-ratebox' }, rateK, divSel);
      ups.push(() => rateBox.classList.toggle('synced', !!b.cur.lfo[l].sync));
      cd.body.append(cv.c, row(
        rateBox,
        K(b, ups, L('fade'), def('fade', 'Fade-in', 0, 10, 0, { curve: 'log', fmt: sec }), { color: c, name: nm, label: 'FADE', size: 24 }),
        el('div', { class: 'rn-col' },
          Tog(b, ups, L('sync'), 'SYNC', `${nm} tempo sync`, c, 'rn-tog-sm'),
          Tog(b, ups, L('retrig'), 'RETRIG', `${nm} retrigger — restart on every note (off = free running)`, c, 'rn-tog-sm')),
      ));
      lfoRow.append(cd.root);
    }
    return el('div', { class: 'rn-pane rn-pane-mod' }, envRow, lfoRow);
  })();

  // ---------------- matrix tab ----------------
  const mtxPane = (() => {
    const c = COL.mtx;
    const srcOpts = MOD_SOURCES.map((s) => ({ value: s.id, label: s.label }));
    const compact = (l: string) => l.replace('Filter ', 'F').replace('Osc ', 'O').replace('pulse width / Y', 'PW / Y').replace('morph / vowel', 'morph').replace('resonance', 'res').replace('Distortion', 'Dist').replace('All osc pitch', 'Pitch (all)').replace('Unison detune', 'Uni detune');
    const dstOpts = MOD_DESTS.map((d) => ({ value: d.id, label: d.id === 'none' ? '—' : compact(d.label) }));
    const grid = el('div', { class: 'rn-mtx' });
    for (let col = 0; col < 2; col++)
      grid.append(el('div', { class: 'rn-mtx-h' }, el('span', { text: '#' }), el('span', { text: 'SOURCE' }), el('span', { text: 'DESTINATION' }), el('span', { text: 'AMOUNT' }), el('span', { text: 'VIA' })));
    for (let i = 0; i < MOD_SLOTS; i++) {
      const M = (key: string): Path => ['mod', i, key];
      const r = el('div', { class: 'rn-mtx-r' });
      const src = Sel(b, ups, M('src'), srcOpts, `Mod ${i + 1} source`, `Slot ${i + 1}: modulation source`);
      const dst = Sel(b, ups, M('dst'), dstOpts, `Mod ${i + 1} destination`, `Slot ${i + 1}: destination`);
      const via = Sel(b, ups, M('via'), srcOpts, `Mod ${i + 1} via`, `Slot ${i + 1}: scale the amount by a second source (— = none)`);
      const amt = amountBar(i, c);
      r.append(el('span', { class: 'rn-mtx-i', text: String(i + 1) }), src, dst, amt, via);
      ups.push(() => r.classList.toggle('live', b.cur.mod[i].src !== 'none' && b.cur.mod[i].dst !== 'none'));
      grid.append(r);
    }
    // order: fill column-major (slots 1-8 left, 9-16 right)
    const rows = Array.from(grid.querySelectorAll('.rn-mtx-r'));
    rows.forEach((r, i) => ((r as HTMLElement).style.order = String(i < 8 ? 2 + i * 2 : 3 + (i - 8) * 2)));
    (grid.children[0] as HTMLElement).style.order = '0';
    (grid.children[1] as HTMLElement).style.order = '1';
    return el('div', { class: 'rn-pane rn-pane-mtx' }, grid);
  })();

  function amountBar(i: number, color: string) {
    const bar = cvar(el('div', { class: 'rn-amt' }), color);
    const fill = el('div', { class: 'rn-amt-fill' });
    const txt = el('span', { class: 'rn-amt-txt' });
    bar.append(fill, txt);
    const show = () => {
      const v = b.cur.mod[i].amt;
      const d = MOD_DESTS[DST_INDEX[b.cur.mod[i].dst]] ?? MOD_DESTS[0];
      fill.style.left = (v < 0 ? 50 + v * 50 : 50) + '%';
      fill.style.width = Math.abs(v) * 50 + '%';
      const scaled = v * d.scale;
      txt.textContent = d.id === 'none' ? pct(v) : (scaled > 0 ? '+' : '') + (Math.abs(scaled) < 10 ? scaled.toFixed(1) : Math.round(scaled)) + (d.unit === '%' ? '%' : ' ' + d.unit);
      bar.dataset.hint = `Slot ${i + 1} amount: ${txt.textContent} (drag, double-click to reset)`;
    };
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const start = b.cur.mod[i].amt;
      api.begin(`Mod ${i + 1} amount`);
      drag(e, (dx, dy, ev) => {
        const fine = ev.shiftKey ? 0.15 : 1;
        const v = Math.round(Math.min(1, Math.max(-1, start + ((dx - dy) / 120) * fine)) * 1000) / 1000;
        b.live(['mod', i, 'amt'], v);
        show();
        lockHint(bar.dataset.hint ?? '');
      }, () => {
        lockHint(null);
        api.end();
      });
    });
    bar.addEventListener('dblclick', () => b.commit(`Mod ${i + 1} amount`, ['mod', i, 'amt'], 0));
    ups.push(show);
    return bar;
  }

  // ---------------- arp tab ----------------
  const stepLeds: HTMLElement[] = [];
  const arpPane = (() => {
    const c = COL.arp;
    const A = (key: string): Path => ['arp', key];
    const controls = el('div', { class: 'rn-arpctl' },
      Tog(b, ups, A('on'), 'ARP ON', 'Arpeggiator on/off', c, 'rn-tog-big'),
      el('label', { class: 'rn-lab', text: 'MODE' }), Sel(b, ups, A('mode'), ARP_MODES.map((m) => ({ value: m, label: ARP_LABELS[m] })), 'Arp mode', 'Arp note order'),
      el('label', { class: 'rn-lab', text: 'RATE' }), Sel(b, ups, A('rate'), ARP_RATES.map((r, i) => ({ value: i, label: r.label })), 'Arp rate', 'Arp step length (tempo synced)'),
      el('label', { class: 'rn-lab', text: 'OCT' }), Seg(b, ups, A('oct'), [1, 2, 3, 4].map((o) => ({ v: o, label: String(o), hint: `Arp range: ${o} octave${o > 1 ? 's' : ''}` })), c, 'Arp octaves'),
      K(b, ups, A('gate'), def('gate', 'Gate', 0.05, 1, 0.6, { fmt: pct }), { color: c, name: 'Arp', label: 'GATE', size: 26 }),
      K(b, ups, A('swing'), def('swing', 'Swing', 0, 1, 0, { fmt: pct }), { color: c, name: 'Arp', label: 'SWING', size: 26 }),
      K(b, ups, A('len'), def('len', 'Steps', 1, 16, 16, { step: 1, fmt: (v) => v + ' steps' }), { color: c, name: 'Arp', label: 'STEPS', size: 26 }),
      Tog(b, ups, A('latch'), 'LATCH', 'Latch — keep arpeggiating after the keys are released', c),
    );
    const steps = cvar(el('div', { class: 'rn-steps' }), c);
    for (let i = 0; i < 16; i++) {
      const led = el('div', { class: 'rn-step-led' });
      stepLeds.push(led);
      const gate = el('button', { class: 'rn-step-gate', 'data-hint': `Step ${i + 1}: play / rest` });
      gate.addEventListener('click', () => b.commit('Arp step', ['arp', 'steps', i], b.cur.arp.steps[i] ? 0 : 1));
      const valFill = el('div', { class: 'rn-step-fill' });
      const val = el('div', { class: 'rn-step-val', 'data-hint': `Step ${i + 1} value (mod source "Arp step value") — drag` }, valFill);
      val.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = val.getBoundingClientRect();
        api.begin('Arp step value');
        const set = (ev: PointerEvent) => {
          const v = Math.round(Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height)) * 100) / 100;
          b.live(['arp', 'vals', i], v);
          valFill.style.height = v * 100 + '%';
          lockHint(`Step ${i + 1} value: ${pct(v)}`);
        };
        set(e);
        drag(e, (_dx, _dy, ev) => set(ev), () => {
          lockHint(null);
          api.end();
        });
      });
      const cell = el('div', { class: 'rn-step' }, led, val, gate, el('span', { class: 'rn-step-n', text: String(i + 1) }));
      ups.push(() => {
        const a = b.cur.arp;
        gate.classList.toggle('on', a.steps[i] >= 0.5);
        valFill.style.height = a.vals[i] * 100 + '%';
        cell.classList.toggle('inactive', i >= a.len);
      });
      steps.append(cell);
    }
    const pane = el('div', { class: 'rn-pane rn-pane-arp' }, controls, steps);
    ups.push(() => pane.classList.toggle('off', !b.cur.arp.on));
    return pane;
  })();

  // ---------------- fx tab ----------------
  const fxPane = (() => {
    const c = COL.fx;
    const unit = (key: 'chorus' | 'phaser' | 'flanger' | 'delay' | 'reverb', title: string, desc: string, knobs: [string, ParamDef, boolean?][], extra?: HTMLElement[]) => {
      const F = (k: string): Path => ['fx', key, k];
      const power = el('button', { class: 'rn-power', 'data-hint': `${title} on/off` });
      power.addEventListener('click', () => b.commit(`${title} on/off`, F('on'), !b.cur.fx[key].on));
      ups.push(() => cardEl.classList.toggle('on', b.cur.fx[key].on));
      const cd = card(title.toUpperCase(), c, 'rn-fx', power);
      const cardEl = cd.root;
      const grid = el('div', { class: 'rn-fxgrid' });
      for (const [k, d, bp] of knobs) grid.append(K(b, ups, F(k), d, { color: c, name: title, label: d.label.toUpperCase().replace('FEEDBACK', 'FDBK'), size: 28, bipolar: bp }));
      cd.body.append(grid, ...(extra ?? []), el('div', { class: 'rn-sp' }), el('div', { class: 'rn-fxdesc', text: desc }));
      return cardEl;
    };
    return el('div', { class: 'rn-pane rn-pane-fx' },
      unit('chorus', 'Chorus', 'Four modulated taps, stereo', [['mix', def('mix', 'Mix', 0, 1, 0.4, { fmt: pct })], ['rate', def('rate', 'Rate', 0.05, 5, 0.5, { curve: 'log', fmt: hz })], ['depth', def('depth', 'Depth', 0, 1, 0.5, { fmt: pct })]]),
      unit('phaser', 'Phaser', 'Six all-pass stages, quadrature LFO', [['mix', def('mix', 'Mix', 0, 1, 0.6, { fmt: pct })], ['rate', def('rate', 'Rate', 0.02, 5, 0.25, { curve: 'log', fmt: hz })], ['depth', def('depth', 'Depth', 0, 1, 0.7, { fmt: pct })], ['fb', def('fb', 'Feedback', 0, 0.95, 0.5, { fmt: pct })]]),
      unit('flanger', 'Flanger', 'Short swept delay, ± feedback', [['mix', def('mix', 'Mix', 0, 1, 0.5, { fmt: pct })], ['rate', def('rate', 'Rate', 0.02, 5, 0.15, { curve: 'log', fmt: hz })], ['depth', def('depth', 'Depth', 0, 1, 0.6, { fmt: pct })], ['fb', def('fb', 'Feedback', -0.95, 0.95, 0.5, { fmt: bip }), true]]),
      unit('delay', 'Delay', 'Tempo-synced, filtered repeats', [['mix', def('mix', 'Mix', 0, 1, 0.25, { fmt: pct })], ['fb', def('fb', 'Feedback', 0, 0.95, 0.35, { fmt: pct })], ['tone', def('tone', 'Tone', 0, 1, 0.6, { fmt: pct })]], [
        row(Sel(b, ups, ['fx', 'delay', 'div'], DELAY_DIVS.map((d, i) => ({ value: i, label: d.label })), 'Delay time', 'Delay time (tempo synced)', 'rn-sel-sm'),
          Tog(b, ups, ['fx', 'delay', 'pingpong'], 'PING', 'Delay ping-pong — echoes alternate left / right', c, 'rn-tog-sm')),
      ]),
      unit('reverb', 'Reverb', '8-line feedback network', [['mix', def('mix', 'Mix', 0, 1, 0.22, { fmt: pct })], ['size', def('size', 'Size', 0, 1, 0.6, { fmt: pct })], ['damp', def('damp', 'Damping', 0, 1, 0.4, { fmt: pct })], ['pre', def('pre', 'Pre-delay', 0, 0.2, 0.01, { fmt: sec })]]),
    );
  })();

  // ---------------- tabs ----------------
  const panes: Record<string, HTMLElement> = { mod: modPane, mtx: mtxPane, arp: arpPane, fx: fxPane };
  const tabNames: [string, string, string][] = [['mod', 'ENV · LFO', COL.env], ['mtx', 'MATRIX', COL.mtx], ['arp', 'ARP / SEQ', COL.arp], ['fx', 'EFFECTS', COL.fx]];
  let tab = 'mod';
  try {
    tab = localStorage.getItem('lf.rune.tab') || 'mod';
  } catch {}
  if (!panes[tab]) tab = 'mod';
  const tabBtns = tabNames.map(([id, label, color]) => {
    const t = cvar(el('button', { class: 'rn-tab', text: label, 'data-hint': `Show ${label.toLowerCase()}` }), color);
    t.addEventListener('click', () => setTab(id));
    return t;
  });
  const badges: Record<string, HTMLElement> = {};
  tabNames.forEach(([id], i) => {
    const bd = el('span', { class: 'rn-badge' });
    badges[id] = bd;
    tabBtns[i].append(bd);
  });
  ups.push(() => {
    const n = b.cur.mod.filter((m) => m.src !== 'none' && m.dst !== 'none').length;
    badges.mtx.textContent = n ? String(n) : '';
    badges.arp.textContent = b.cur.arp.on ? 'ON' : '';
    const nf = Object.values(b.cur.fx).filter((f: any) => f.on).length;
    badges.fx.textContent = nf ? String(nf) : '';
  });
  const tabBar = el('div', { class: 'rn-tabs' }, ...tabBtns);
  const paneHost = el('div', { class: 'rn-panehost' }, ...Object.values(panes));
  function setTab(id: string) {
    tab = id;
    try {
      localStorage.setItem('lf.rune.tab', id);
    } catch {}
    for (const [k, p] of Object.entries(panes)) p.style.display = k === id ? '' : 'none';
    tabNames.forEach(([tid], i) => tabBtns[i].classList.toggle('on', tid === id));
  }
  setTab(tab);

  // ---------------- macros + keyboard ----------------
  const macroRings: HTMLElement[] = [];
  const macroCaps: HTMLElement[] = [];
  const macroBox = cvar(el('div', { class: 'rn-macros' }, el('div', { class: 'rn-mlabel', text: 'MACROS' })), COL.macro);
  for (let i = 0; i < 4; i++) {
    const k = K(b, ups, ['macros', i], def('macro' + (i + 1), `Macro ${i + 1}`, 0, 1, 0, { fmt: pct }), {
      color: COL.macro, name: 'Rune', label: `M${i + 1}`, size: 36, onAutomate: () => api.automate('macro' + (i + 1)),
    });
    const ring = el('div', { class: 'rn-mring', 'data-hint': `Macro ${i + 1}: knob + playlist automation (right-click the knob → automation clip)` });
    const cap = el('div', { class: 'rn-mcap' });
    macroRings.push(ring);
    macroCaps.push(cap);
    macroBox.append(el('div', { class: 'rn-macro' }, k, ring, cap));
  }
  const shortDest = (id: string) => {
    const d = MOD_DESTS[DST_INDEX[id]];
    if (!d || id === 'none') return '';
    return d.label.replace('Filter ', 'F').replace('Osc ', 'O').replace(' / vowel', '').replace(' / Y', '').replace('Distortion', 'Dist').replace('All osc pitch', 'Pitch').toUpperCase();
  };
  ups.push(() => {
    for (let i = 0; i < 4; i++) {
      const id = 'macro' + (i + 1);
      const tg = b.cur.mod.filter((m) => (m.src === id || m.via === id) && m.dst !== 'none').map((m) => shortDest(m.dst));
      macroCaps[i].textContent = tg.length ? tg[0] + (tg.length > 1 ? ` +${tg.length - 1}` : '') : 'unassigned';
      macroCaps[i].classList.toggle('none', !tg.length);
      macroCaps[i].dataset.hint = tg.length ? `Macro ${i + 1} → ${tg.join(', ')}` : `Macro ${i + 1} is not routed — use the matrix (source "Macro ${i + 1}")`;
    }
  });

  const kb = keyboard();

  function keyboard() {
    let base = 48;
    const held = new Map<number, number>(); // pointerId → key
    const keysEl = el('div', { class: 'rn-keys' });
    const octLbl = el('span', { class: 'rn-octlbl' });
    const build = () => {
      keysEl.innerHTML = '';
      const whites: number[] = [];
      for (let k = base; k < base + 36; k++) if (![1, 3, 6, 8, 10].includes(k % 12)) whites.push(k);
      const ww = 100 / whites.length;
      whites.forEach((k, i) => keysEl.append(el('div', { class: 'rn-key w', 'data-key': String(k), style: { left: i * ww + '%', width: ww + '%' } }, k % 12 === 0 ? el('span', { text: 'C' + (Math.floor(k / 12) - 1) }) : null)));
      for (let k = base; k < base + 36; k++) {
        if (![1, 3, 6, 8, 10].includes(k % 12)) continue;
        const wi = whites.indexOf(k - 1);
        keysEl.append(el('div', { class: 'rn-key b', 'data-key': String(k), style: { left: (wi + 1) * ww - ww * 0.32 + '%', width: ww * 0.64 + '%' } }));
      }
      octLbl.textContent = 'C' + (Math.floor(base / 12) - 1);
    };
    const keyAt = (e: PointerEvent) => {
      const t = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const k = t?.closest?.('.rn-key') as HTMLElement | null;
      return k && keysEl.contains(k) ? +k.dataset.key! : -1;
    };
    const press = (id: number, k: number) => {
      const prev = held.get(id);
      if (prev === k) return;
      if (prev !== undefined) release(id);
      if (k < 0) return;
      held.set(id, k);
      api.noteOn(k, 0.8);
      keysEl.querySelector(`[data-key="${k}"]`)?.classList.add('down');
    };
    const release = (id: number) => {
      const k = held.get(id);
      if (k === undefined) return;
      held.delete(id);
      api.noteOff(k);
      if (![...held.values()].includes(k)) keysEl.querySelector(`[data-key="${k}"]`)?.classList.remove('down');
    };
    keysEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      keysEl.setPointerCapture(e.pointerId);
      press(e.pointerId, keyAt(e));
    });
    keysEl.addEventListener('pointermove', (e) => {
      if (held.has(e.pointerId)) press(e.pointerId, keyAt(e));
    });
    const up = (e: PointerEvent) => release(e.pointerId);
    keysEl.addEventListener('pointerup', up);
    keysEl.addEventListener('pointercancel', up);
    const shift = (d: number) => {
      for (const id of [...held.keys()]) release(id);
      base = Math.min(84, Math.max(12, base + d));
      build();
    };
    build();
    const root = el('div', { class: 'rn-kb', 'data-hint': 'Audition keyboard — click / drag to play' },
      el('div', { class: 'rn-kboct' },
        el('button', { class: 'rn-tog rn-tog-sm', text: '◀', 'data-hint': 'Keyboard octave down', onclick: () => shift(-12) }),
        octLbl,
        el('button', { class: 'rn-tog rn-tog-sm', text: '▶', 'data-hint': 'Keyboard octave up', onclick: () => shift(12) })),
      keysEl);
    return { root, releaseAll: () => { for (const id of [...held.keys()]) release(id); }, keysEl };
  }

  // ---------------- layout ----------------
  const rowA = el('div', { class: 'rn-rowA' }, ...oscCards.map((o) => o.root), ...fltCards.map((f) => f.root));
  const left = el('div', { class: 'rn-left' }, tabBar, paneHost);
  const right = el('div', { class: 'rn-right' }, ampCard, voiceCard, macroBox);
  const rowB = el('div', { class: 'rn-rowB' }, left, right);
  const rowC = el('div', { class: 'rn-rowC' }, kb.root);
  const root = el('div', { class: 'rune' }, header, rowA, rowB, rowC);

  // ---------------- refresh ----------------
  const envSig: string[] = ['', '', ''];
  const lfoSig: string[] = ['', '', '', ''];
  const drawDynamic = (force = false) => {
    const live = shown && viz;
    for (let e = 0; e < 3; e++) {
      const en = b.cur.env[e];
      const lv = live ? viz.e?.[e] ?? -1 : -1, st = live ? viz.es?.[e] ?? 0 : 0;
      const sig = JSON.stringify(en) + (st ? `${lv.toFixed(3)}:${st}` : '');
      if (!force && sig === envSig[e]) continue;
      envSig[e] = sig;
      drawEnv(envCvs[e], en, COL.env, lv, st);
    }
    for (let l = 0; l < 4; l++) {
      const lf = b.cur.lfo[l];
      const ph = live ? viz.lp?.[l] ?? -1 : -1;
      const sig = JSON.stringify(lf) + (ph >= 0 ? ph.toFixed(3) : '');
      if (!force && sig === lfoSig[l]) continue;
      lfoSig[l] = sig;
      drawLfo(lfoCvs[l], lf, COL.lfo, ph, live ? viz.l?.[l] ?? 0 : 0);
    }
    const s = live ? viz.s ?? -1 : -1;
    stepLeds.forEach((led, i) => led.classList.toggle('on', i === s));
    voiceLed.textContent = String(live ? viz.v ?? 0 : 0);
    header.classList.toggle('active', !!(live && viz.v));
    for (let i = 0; i < 4; i++) {
      const m = live ? viz.m?.[i] ?? b.cur.macros[i] : b.cur.macros[i];
      macroRings[i].style.setProperty('--m', String(m));
    }
  };
  const refresh = () => {
    b.reread();
    oscCards.forEach((o) => o.update());
    fltCards.forEach((f) => f.update());
    ups.forEach((u) => u());
    redraws.forEach((r) => r());
    drawDynamic();
  };
  refresh();
  const offExt = api.onExternalChange(() => refresh());

  // ---------------- visualisation ----------------
  let raf = 0;
  let offMsg: (() => void) | null = null;
  let hostTimer = 0;
  const attach = () => {
    if (offMsg || !shown) return;
    const h = api.host();
    if (!h) {
      hostTimer = window.setTimeout(attach, 400);
      return;
    }
    h.setViz(true);
    const off = h.onMessage((m) => {
      if (m.t === 'viz') viz = m.data;
    });
    offMsg = () => {
      off();
      try {
        h.setViz(false);
      } catch {}
    };
  };
  const loop = () => {
    raf = requestAnimationFrame(loop);
    drawDynamic();
  };
  const onShow = () => {
    if (shown) return;
    shown = true;
    attach();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  };
  const onHide = () => {
    shown = false;
    clearTimeout(hostTimer);
    cancelAnimationFrame(raf);
    offMsg?.();
    offMsg = null;
    viz = null;
    kb.releaseAll();
    drawDynamic(true);
  };
  // the window may already be visible when the UI is created
  requestAnimationFrame(() => {
    if (root.isConnected && root.offsetParent !== null) onShow();
  });

  return {
    el: root,
    onShow,
    onHide,
    // fixed-size panel: the window wrapper scrolls if it is made smaller; just refresh the displays
    onResize: () => drawDynamic(true),
    destroy: () => {
      onHide();
      offExt();
    },
  };
}
