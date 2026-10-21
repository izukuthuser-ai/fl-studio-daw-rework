// Riffstack rack window: preset bar + signal-chain overview on top, then a scrollable rack of units
// (input/gate, tuner, pedalboard, amp head, mic'd cabinet, post EQ, delay, reverb, output).
import type { FxPluginUIApi, PluginUI } from '../api';
import { el } from '../../../core/util';
import { store } from '../../../core/store';
import { DELAY_DIVS } from '../../../core/params';
import { showMenu, promptDialog, confirmDialog, toast, lockHint, type MenuItem } from '../../../ui/widgets';
import { Binder, knob, toggle, seg, vslider, dragArea, LedMeter, analyserPeak } from './ui-controls';
import { TunerDisplay, detectPitch } from './tuner';
import { AMP_DESC, AMP_MODELS, CAB_DESC, EQ_LABELS, RS_PARAM } from './params';
import { allPresets, deleteUserPreset, presetParams, saveUserPreset, userPresets, type RsPreset } from './presets';
import { cabIR, irResponse } from './ir';
import type { RiffstackFx } from './effect';
import './riffstack.css';

const dbG = (d: number) => Math.pow(10, d / 20);

function screws() {
  return [el('div', { class: 'rs-screw' }), el('div', { class: 'rs-screw' })];
}

interface Unit {
  el: HTMLElement;
  face: HTMLElement;
}

/** A rack unit: ears with screws, faceplate with engraved title and optional power switch. */
function unit(b: Binder, id: string, title: string, cls: string, power: string | null, hint: string): Unit {
  const face = el('div', { class: 'rs-face' });
  const head = el('div', { class: 'rs-utitle', text: title, 'data-hint': hint });
  const u = el('div', { class: `rs-unit rs-u-${cls}`, 'data-unit': id }, el('div', { class: 'rs-ear' }, ...screws()), el('div', { class: 'rs-facewrap' }, head, face), el('div', { class: 'rs-ear' }, ...screws()));
  if (power) {
    const sw = toggle(b, power, title, 'power', undefined, `${title} on / bypass`);
    sw.el.classList.add('rs-upower');
    head.prepend(sw.el);
    b.add({ el: u, update: () => u.classList.toggle('off', !b.on(power)) }).update();
  }
  return { el: u, face };
}

const group = (label: string | null, ...kids: (HTMLElement | null)[]) => el('div', { class: 'rs-grp' }, ...kids, label ? el('div', { class: 'rs-grp-l', text: label }) : null);

export function createRiffstackUI(api: FxPluginUIApi): PluginUI {
  const b = new Binder(api);
  const root = el('div', { class: 'rs' });
  const scroll = el('div', { class: 'rs-scroll' });
  const rack = el('div', { class: 'rs-rack' });
  scroll.append(rack);
  const eff = () => api.effect() as RiffstackFx | null;

  // ------------------------------------------------------------ header: presets + chain + I/O
  const presetName = el('span', { class: 'rs-pname' });
  const presetMod = el('span', { class: 'rs-pmod', text: '•', 'data-hint': 'Edited since the preset was loaded' });
  const curName = () => (api.getSlot()?.data?.preset as string | undefined) ?? 'Init';
  const load = (p: RsPreset) =>
    api.commit(`Riffstack preset: ${p.name}`, (s) => {
      s.params = presetParams(p);
      s.data = { ...(s.data ?? {}), preset: p.name };
    });
  const step = (dir: number) => {
    const list = allPresets();
    const i = list.findIndex((p) => p.name === curName());
    load(list[(i + dir + list.length) % list.length]);
  };
  const modified = () => {
    const p = allPresets().find((x) => x.name === curName());
    if (!p) return false;
    const full = presetParams(p);
    const cur = api.getSlot()?.params ?? {};
    return Object.keys(full).some((k) => Math.abs((cur[k] ?? RS_PARAM[k]?.def ?? 0) - full[k]) > 1e-6);
  };
  const saveAs = async () => {
    const name = (await promptDialog('Save Riffstack preset', 'Preset name', curName() === 'Init' ? 'My rig' : curName()))?.trim();
    if (!name) return;
    if (!saveUserPreset(name, { ...(api.getSlot()?.params ?? {}) })) {
      toast('Could not save the preset (storage unavailable)', 'warn');
      return;
    }
    api.commit('Name preset', (s) => (s.data = { ...(s.data ?? {}), preset: name }));
    toast(`Preset "${name}" saved`, 'ok');
  };
  const presetMenu = (x: number, y: number) => {
    const list = allPresets();
    const ORDER = ['Clean', 'Crunch', 'Lead', 'High Gain', 'Bass', 'Ambient', 'Utility', 'User'];
    const rank = (c: string) => (ORDER.includes(c) ? ORDER.indexOf(c) : 50);
    const cats = [...new Set(list.map((p) => p.category))].sort((x, y) => rank(x) - rank(y));
    const cur = curName();
    const items: MenuItem[] = cats.map((cat) => ({
      label: cat,
      submenu: list.filter((p) => p.category === cat).map((p) => ({ label: p.name, checked: p.name === cur, action: () => load(p) })),
    }));
    items.push({ sep: true }, { label: 'Save preset as…', action: saveAs });
    const users = userPresets();
    if (users.length)
      items.push({
        label: 'Delete user preset',
        submenu: users.map((p) => ({
          label: p.name,
          action: async () => {
            const r = await confirmDialog('Delete preset', `Delete the user preset "${p.name}"?`, [{ label: 'Delete', value: 'yes', primary: true }, { label: 'Cancel', value: 'no' }], 'no');
            if (r === 'yes') deleteUserPreset(p.name);
          },
        })),
      });
    showMenu(items, x, y);
  };
  const headIn = new LedMeter(64, 5, false, 16);
  const headOut = new LedMeter(64, 5, false, 16);
  const chain: [string, string, string][] = [
    ['GATE', 'gateOn', 'input'], ['COMP', 'compOn', 'pedals'], ['WAH', 'wahOn', 'pedals'], ['FUZZ', 'fzOn', 'pedals'], ['OD', 'odOn', 'pedals'],
    ['AMP', 'ampOn', 'amp'], ['CAB', 'cabOn', 'cab'], ['EQ', 'eqOn', 'eq'], ['DLY', 'dlyOn', 'delay'], ['VERB', 'rvbOn', 'reverb'],
  ];
  const chainEl = el('div', { class: 'rs-chain' });
  chain.forEach(([label, key, unitId], i) => {
    const led = el('span', { class: 'rs-cled' });
    const chip = el('button', { class: 'rs-chip', 'data-hint': `${label}: click to toggle on/off, double-click to jump to the unit` }, led, el('span', { text: label }));
    chip.addEventListener('click', () => b.toggle(key, label));
    chip.addEventListener('dblclick', () => rack.querySelector(`[data-unit="${unitId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    if (i) chainEl.append(el('span', { class: 'rs-carrow', text: '›' }));
    chainEl.append(chip);
    b.add({ el: chip, update: () => chip.classList.toggle('on', b.on(key)) }).update();
  });
  const header = el(
    'div',
    { class: 'rs-head' },
    el('div', { class: 'rs-brand', 'data-hint': 'Riffstack — guitar amp & effects rack' }, el('span', { class: 'rs-brand-r', text: 'RIFF' }), el('span', { text: 'STACK' })),
    el(
      'div',
      { class: 'rs-presets' },
      el('button', { class: 'rs-parrow', html: '&#9664;', 'data-hint': 'Previous preset', onclick: () => step(-1) }),
      el('button', { class: 'rs-parrow', html: '&#9654;', 'data-hint': 'Next preset', onclick: () => step(1) }),
      el('button', { class: 'rs-pbox', 'data-hint': 'Rig presets — click to browse factory and user presets', onclick: (e: MouseEvent) => presetMenu(e.clientX, e.clientY) }, presetName, presetMod, el('span', { class: 'rs-pcaret', text: '▾' })),
      el('button', { class: 'rs-pbtn', text: 'SAVE', 'data-hint': 'Save the current rig as a user preset', onclick: saveAs }),
    ),
    chainEl,
    el('div', { class: 'rs-hio' }, el('div', { class: 'rs-hio-r', 'data-hint': 'Input level (after input gain)' }, el('span', { text: 'IN' }), headIn.el), el('div', { class: 'rs-hio-r', 'data-hint': 'Output level' }, el('span', { text: 'OUT' }), headOut.el)),
  );
  b.add({
    el: header,
    update: () => {
      presetName.textContent = curName();
      presetMod.style.visibility = modified() ? 'visible' : 'hidden';
    },
  }).update();

  // ------------------------------------------------------------ input + gate
  const uIn = unit(b, 'input', 'INPUT', 'input', null, 'Input stage: level, channel and noise gate');
  const inMeter = new LedMeter(150, 9, false, 26);
  const sigLed = el('div', { class: 'rs-led-s', 'data-hint': 'Signal present' });
  const clipLed = el('div', { class: 'rs-led-s clip', 'data-hint': 'Input clipping — lower the input gain' });
  const gateLed = el('div', { class: 'rs-gate-led', 'data-hint': 'Gate state: green = open, red = closed (silencing)' });
  uIn.face.append(
    group('GAIN', knob(b, { key: 'inGain', unit: 'Input', kind: 'rack', label: '' }).el),
    el('div', { class: 'rs-col rs-inmeter' },
      el('div', { class: 'rs-row-s' }, sigLed, el('span', { class: 'rs-mini', text: 'SIG' }), clipLed, el('span', { class: 'rs-mini', text: 'CLIP' })),
      inMeter.el,
      el('div', { class: 'rs-scale' }, ...['-60', '-40', '-20', '-12', '-6', '0'].map((t) => el('span', { text: t }))),
      seg(b, 'inSel', 'Input', undefined, 'rs-seg-xs', ['Auto: use whichever channel carries signal', 'Average of left and right', 'Left channel only', 'Right channel only']).el,
    ),
    el('div', { class: 'rs-vsep' }),
    el('div', { class: 'rs-col rs-gatehead' }, el('div', { class: 'rs-sublabel', text: 'NOISE GATE' }), el('div', { class: 'rs-row-s' }, toggle(b, 'gateOn', 'Noise gate', 'led', 'ON').el, gateLed)),
    group('THRESH', knob(b, { key: 'gateThr', unit: 'Gate', kind: 'rack', size: 34, label: '' }).el),
    group('RELEASE', knob(b, { key: 'gateRel', unit: 'Gate', kind: 'rack', size: 34, label: '' }).el),
    group('HYST', knob(b, { key: 'gateHyst', unit: 'Gate', kind: 'rack', size: 34, label: '' }).el),
  );
  b.add({ el: uIn.el, update: () => uIn.el.classList.toggle('gate-off', !b.on('gateOn')) }).update();

  // ------------------------------------------------------------ tuner
  const uTun = unit(b, 'tuner', 'TUNER', 'tuner', null, 'Chromatic tuner on the rack input');
  const tuner = new TunerDisplay(236, 66);
  const refVal = el('div', { class: 'rs-ref-v' });
  const refStep = (d: number) => b.commit('Tuner reference', 'tunerRef', Math.max(425, Math.min(455, Math.round(b.get('tunerRef')) + d)));
  uTun.face.append(
    el('div', { class: 'rs-lcd-wrap' }, tuner.el),
    el(
      'div',
      { class: 'rs-col rs-tun-side' },
      el('div', { class: 'rs-mini', text: 'A4 REF' }),
      el('div', { class: 'rs-ref', 'data-hint': 'Tuner reference pitch (A4)' }, el('button', { class: 'rs-ref-b', text: '–', onclick: () => refStep(-1) }), refVal, el('button', { class: 'rs-ref-b', text: '+', onclick: () => refStep(1) })),
      toggle(b, 'tunerMute', 'Tuner', 'led', 'MUTE', 'Mute the rack output while tuning').el,
    ),
  );
  b.add({ el: refVal, update: () => (refVal.textContent = Math.round(b.get('tunerRef')) + ' Hz') }).update();

  rack.append(el('div', { class: 'rs-pair' }, uIn.el, uTun.el));

  // ------------------------------------------------------------ pedalboard
  const board = el('div', { class: 'rs-board', 'data-unit': 'pedals' });
  const pedal = (cls: string, name: string, sub: string, key: string, knobs: HTMLElement[], extra?: HTMLElement) => {
    const led = el('div', { class: 'rs-pled' });
    const p = el(
      'div',
      { class: `rs-pedal ${cls}` },
      el('div', { class: 'rs-jack l' }),
      el('div', { class: 'rs-jack r' }),
      el('div', { class: 'rs-pscrews' }, ...[0, 1, 2, 3].map(() => el('i'))),
      el('div', { class: 'rs-pknobs' }, ...knobs),
      el('div', { class: 'rs-pname', 'data-hint': sub }, el('div', { class: 'rs-pname-t', text: name }), el('div', { class: 'rs-pname-s', text: sub })),
      extra ?? null,
      led,
      toggle(b, key, name, 'foot', undefined, `${name} on / off`).el,
    );
    b.add({ el: p, update: () => p.classList.toggle('on', b.on(key)) }).update();
    return p;
  };
  const grBar = el('div', { class: 'rs-grbar', 'data-hint': 'Compression (gain reduction)' }, ...[0, 1, 2, 3, 4].map(() => el('i')));
  const comp = pedal('rs-p-comp', 'SUSTAINER', 'optical-style compressor', 'compOn', [
    knob(b, { key: 'compLevel', unit: 'Sustainer', kind: 'pedal', label: 'LEVEL', noValue: true }).el,
    knob(b, { key: 'compAtk', unit: 'Sustainer', kind: 'pedal', label: 'ATTACK', noValue: true }).el,
    knob(b, { key: 'compSus', unit: 'Sustainer', kind: 'pedal', label: 'SUSTAIN', noValue: true }).el,
  ], grBar);
  // wah: treadle you drag up/down
  const treadle = el('div', { class: 'rs-treadle', 'data-hint': 'Sweep wah — drag the treadle up/down (heel = bass, toe = treble)' }, el('div', { class: 'rs-tread-rubber' }));
  const wahMode = seg(b, 'wahAuto', 'Sweep wah', ['PEDAL', 'AUTO'], 'rs-seg-xs', ['Position set by the treadle', 'Envelope follower opens the filter as you play']);
  const wahSens = knob(b, { key: 'wahSens', unit: 'Sweep wah', kind: 'mini', size: 22, label: 'SENS', noValue: true });
  const wahLed = el('div', { class: 'rs-pled' });
  const wahFoot = toggle(b, 'wahOn', 'Sweep wah', 'foot', undefined, 'Sweep wah on / off');
  const wah = el(
    'div',
    { class: 'rs-pedal rs-p-wah' },
    el('div', { class: 'rs-jack l' }),
    el('div', { class: 'rs-jack r' }),
    el('div', { class: 'rs-wah-top' }, wahMode.el, wahSens.el),
    el('div', { class: 'rs-wah-body' }, treadle),
    el('div', { class: 'rs-pname rs-wah-name' }, el('div', { class: 'rs-pname-t', text: 'SWEEP' })),
    el('div', { class: 'rs-wah-bottom' }, wahLed, wahFoot.el),
  );
  const updTreadle = (pos?: number) => {
    const p = pos ?? b.get('wahPos');
    treadle.style.setProperty('--tilt', `${(18 - p * 36).toFixed(1)}deg`);
    treadle.style.setProperty('--pos', p.toFixed(3));
  };
  dragArea(b, treadle, 'wahPos', 'Sweep wah', () => updTreadle(), 110);
  b.add({ el: wah, update: () => { wah.classList.toggle('on', b.on('wahOn')); wah.classList.toggle('auto', b.on('wahAuto')); updTreadle(); } }).update();
  const fuzz = pedal('rs-p-fuzz', 'TAR PIT', 'fuzz / distortion', 'fzOn', [
    knob(b, { key: 'fzLevel', unit: 'Tar Pit fuzz', kind: 'pedal', label: 'LEVEL', noValue: true }).el,
    knob(b, { key: 'fzTone', unit: 'Tar Pit fuzz', kind: 'pedal', label: 'TONE', noValue: true }).el,
    knob(b, { key: 'fzGain', unit: 'Tar Pit fuzz', kind: 'pedal', label: 'GAIN', noValue: true }).el,
  ]);
  const od = pedal('rs-p-od', 'HOWLER', 'mid-boost overdrive', 'odOn', [
    knob(b, { key: 'odDrive', unit: 'Howler overdrive', kind: 'pedal', label: 'DRIVE', noValue: true }).el,
    knob(b, { key: 'odTone', unit: 'Howler overdrive', kind: 'pedal', label: 'TONE', noValue: true }).el,
    knob(b, { key: 'odLevel', unit: 'Howler overdrive', kind: 'pedal', label: 'LEVEL', noValue: true }).el,
  ]);
  const cables = el('div', { class: 'rs-cables' });
  {
    const PW = 166, GAP = 54, y = 15;
    const seg = (x0: number, x1: number, sag: number) => `M${x0},${y} C${x0 + 16},${y + sag} ${x1 - 16},${y + sag} ${x1},${y}`;
    const paths = [seg(-60, -7, 6)];
    for (let i = 0; i < 3; i++) paths.push(seg(PW * (i + 1) + GAP * i + 7, PW * (i + 1) + GAP * (i + 1) - 7, 42));
    paths.push(seg(4 * PW + 3 * GAP + 7, 4 * PW + 3 * GAP + 66, 6));
    cables.innerHTML = `<svg viewBox="-60 0 946 70">${paths.map((d) => `<path class="rs-cable" d="${d}"/><path class="rs-cable-hi" d="${d}"/>`).join('')}</svg>`;
  }
  board.append(
    el('div', { class: 'rs-board-tray' }, el('div', { class: 'rs-pedals' }, cables, comp, wah, fuzz, od)),
    el('div', { class: 'rs-board-lip' }, el('span', { text: 'PEDALBOARD' }), el('span', { class: 'rs-board-flow', text: 'guitar ⟶ sustainer ⟶ sweep ⟶ tar pit ⟶ howler ⟶ amp' })),
  );
  rack.append(board);

  // ------------------------------------------------------------ amp head
  const amp = el('div', { class: 'rs-amp', 'data-unit': 'amp' });
  const badge = el('div', { class: 'rs-badge' });
  const glow = el('div', { class: 'rs-glow' }, el('i'), el('i'), el('i'), el('i'));
  const grille = el('div', { class: 'rs-grille' }, glow, el('div', { class: 'rs-logo', text: 'Riffstack' }), badge);
  const jewel = el('div', { class: 'rs-jewel', 'data-hint': 'Pilot lamp — the amp is on' });
  const ampKnob = (key: string, label: string) => {
    const k = knob(b, { key, unit: 'Amp', kind: 'chicken', label });
    k.el.classList.add('rs-ampk');
    return k.el;
  };
  amp.append(
    el('div', { class: 'rs-amp-top' }, grille),
    el(
      'div',
      { class: 'rs-amp-panel' },
      el('div', { class: 'rs-amp-power' }, jewel, toggle(b, 'ampOn', 'Amp', 'toggle', 'POWER', 'Amp head on / bypassed').el),
      el('div', { class: 'rs-amp-knobs' }, ampKnob('gain', 'GAIN'), ampKnob('bass', 'BASS'), ampKnob('middle', 'MIDDLE'), ampKnob('treble', 'TREBLE'), el('div', { class: 'rs-amp-div' }), ampKnob('presence', 'PRESENCE'), ampKnob('depth', 'DEPTH'), ampKnob('master', 'MASTER')),
      el('div', { class: 'rs-amp-sw' }, toggle(b, 'bright', 'Amp', 'toggle', 'BRIGHT', 'Bright switch: treble boost, strongest at low gain').el, toggle(b, 'tight', 'Amp', 'toggle', 'TIGHT', 'Tight switch: high-pass in front of the preamp for a firmer low end').el),
      voiceSelector(b),
    ),
  );
  b.add({
    el: amp,
    update: () => {
      const m = Math.round(b.get('ampModel'));
      amp.className = `rs-amp m${m}${b.on('ampOn') ? '' : ' off'}`;
      badge.textContent = AMP_MODELS[m] ?? '';
      badge.dataset.hint = AMP_DESC[m] ?? '';
    },
  }).update();
  rack.append(el('div', { class: 'rs-amp-wrap' }, amp));

  // ------------------------------------------------------------ cabinet
  const uCab = unit(b, 'cab', 'CABINET', 'cab', 'cabOn', 'Speaker cabinet with a close mic (convolution)');
  const cabBox = el('div', { class: 'rs-cabbox' });
  const cabGrille = el('div', { class: 'rs-cabgrille' });
  const mic = el('div', { class: 'rs-mic', 'data-hint': 'Microphone — drag left/right for center ↔ edge, up/down for distance' }, el('div', { class: 'rs-mic-arm' }), el('div', { class: 'rs-mic-head' }));
  const micRange = el('div', { class: 'rs-mic-range' });
  cabBox.append(cabGrille);
  const cabView = el('div', { class: 'rs-cabview' }, cabBox, mic);
  const cabCanvas = el('canvas', { class: 'rs-cabresp', 'data-hint': 'Frequency response of the mic’d cabinet (incl. low / high cut)' });
  let speakers: HTMLElement[] = [];
  let lastCab = -1;
  const layoutCab = () => {
    const t = Math.round(b.get('cabType'));
    if (t !== lastCab) {
      lastCab = t;
      cabGrille.innerHTML = '';
      cabBox.className = `rs-cabbox c${t}`;
      const pos: [number, number, number][] = t === 0 ? [[50, 52, 30]] : t === 1 ? [[28, 50, 22], [72, 50, 22]] : t === 4 ? [[50, 50, 38]] : [[29, 29, 17.5], [71, 29, 17.5], [29, 72, 17.5], [71, 72, 17.5]];
      speakers = pos.map(([x, y, r]) => {
        const s = el('div', { class: 'rs-spk' }, el('div', { class: 'rs-spk-cone' }), el('div', { class: 'rs-spk-cap' }));
        s.dataset.x = String(x);
        s.dataset.y = String(y);
        s.dataset.r = String(r);
        return s;
      });
      cabGrille.append(...speakers, micRange);
    }
    // mic position over the first speaker
    const s = speakers[0];
    if (!s) return;
    const W = cabBox.offsetWidth || 260, H = cabBox.offsetHeight || 190;
    const sx = (+s.dataset.x! / 100) * W, sy = (+s.dataset.y! / 100) * H, sr = (+s.dataset.r! / 100) * W;
    for (const sp of speakers) {
      const r = (+sp.dataset.r! / 100) * W;
      sp.style.width = sp.style.height = 2 * r + 'px';
      sp.style.left = (+sp.dataset.x! / 100) * W - r + 'px';
      sp.style.top = (+sp.dataset.y! / 100) * H - r + 'px';
    }
    micRange.style.left = sx + 'px';
    micRange.style.top = sy - 1 + 'px';
    micRange.style.width = sr * 0.92 + 'px';
    const pos = b.get('micPos'), dist = b.get('micDist');
    const near = 1 - Math.log10(Math.max(1, dist)) / 2; // 1 cm → 1 … 100 cm → 0
    const size = 16 + 22 * near;
    mic.style.setProperty('--size', size + 'px');
    mic.style.left = cabBox.offsetLeft + sx + pos * sr * 0.92 + 'px';
    mic.style.top = cabBox.offsetTop + sy + 'px';
    mic.style.opacity = String(0.55 + 0.45 * near);
  };
  // drag the mic: x = position, y = distance
  mic.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const s = speakers[0];
    if (!s) return;
    const W = cabBox.offsetWidth || 260;
    const sr = (+s.dataset.r! / 100) * W * 0.92;
    const p0 = b.get('micPos'), d0 = Math.log10(b.get('micDist'));
    api.begin('Move mic');
    mic.classList.add('active');
    const mv = (ev: PointerEvent) => {
      const pos = Math.max(0, Math.min(1, p0 + (ev.clientX - e.clientX) / sr));
      const dist = Math.max(1, Math.min(100, Math.pow(10, d0 - (e.clientY - ev.clientY) / 90)));
      api.live((sl) => {
        sl.params.micPos = Math.round(pos * 1000) / 1000;
        sl.params.micDist = Math.round(dist * 10) / 10;
      });
      layoutCab();
      lockHint(`Mic — ${b.fmt('micPos')}, ${b.fmt('micDist')}`);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      mic.classList.remove('active');
      lockHint(null);
      api.end();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  const cabList = seg(b, 'cabType', 'Cabinet', undefined, 'rs-seg-v', CAB_DESC);
  const micSeg = seg(b, 'micType', 'Mic', undefined, 'rs-seg-xs', ['Dynamic: presence bump, tight lows', 'Ribbon: dark and warm, big low end', 'Condenser: open, extended, airy']);
  uCab.face.append(
    cabView,
    el('div', { class: 'rs-col rs-cab-list' }, el('div', { class: 'rs-sublabel', text: 'SPEAKER CAB' }), cabList.el),
    el(
      'div',
      { class: 'rs-col rs-cab-mic' },
      el('div', { class: 'rs-sublabel', text: 'MICROPHONE' }),
      micSeg.el,
      el('div', { class: 'rs-row-s rs-cab-knobs' },
        group('POSITION', knob(b, { key: 'micPos', unit: 'Mic', kind: 'rack', size: 34, label: '' }).el),
        group('DISTANCE', knob(b, { key: 'micDist', unit: 'Mic', kind: 'rack', size: 34, label: '' }).el)),
      el('div', { class: 'rs-row-s rs-cab-knobs' },
        group('LOW CUT', knob(b, { key: 'cabLow', unit: 'Cabinet', kind: 'rack', size: 34, label: '' }).el),
        group('HIGH CUT', knob(b, { key: 'cabHigh', unit: 'Cabinet', kind: 'rack', size: 34, label: '' }).el)),
    ),
    el('div', { class: 'rs-col rs-cab-resp' }, el('div', { class: 'rs-sublabel', text: 'RESPONSE' }), cabCanvas),
  );
  // response curve (recomputed from the same IR model the audio uses)
  let respKey = '';
  let resp: number[] = [];
  let respTimer: any = null;
  const RF: number[] = [];
  for (let f = 30; f <= 18000; f *= 1.045) RF.push(f);
  const drawResp = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 232, H = 132;
    if (cabCanvas.width !== W * dpr) {
      cabCanvas.width = W * dpr;
      cabCanvas.height = H * dpr;
      cabCanvas.style.width = W + 'px';
      cabCanvas.style.height = H + 'px';
    }
    const c = cabCanvas.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const fx = (f: number) => (Math.log(f / 30) / Math.log(18000 / 30)) * W;
    const dy = (d: number) => H / 2 - (d / 30) * (H / 2);
    c.strokeStyle = 'rgba(160,220,255,0.08)';
    c.lineWidth = 1;
    c.fillStyle = 'rgba(160,220,255,0.35)';
    c.font = '9px system-ui, sans-serif';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(fx(f)) + 0.5;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, H);
      c.stroke();
      if ([100, 1000, 10000].includes(f)) c.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, H - 3);
    }
    for (const d of [-24, -12, 0, 12]) {
      const y = Math.round(dy(d)) + 0.5;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
      c.fillText((d > 0 ? '+' : '') + d, 2, y - 2);
    }
    const on = b.on('cabOn');
    const lo = b.get('cabLow'), hi = b.get('cabHigh');
    const cut = (f: number) => {
      const a = (f / lo) ** 2, h = (f / hi) ** 2;
      return 10 * Math.log10((a * a) / ((1 - a) ** 2 + a / 0.36)) + 10 * Math.log10(1 / ((1 - h) ** 2 + h / 0.36));
    };
    c.beginPath();
    RF.forEach((f, i) => {
      const v = (on && resp.length ? resp[i] : 0) + cut(f);
      const x = fx(f), y = dy(Math.max(-40, Math.min(30, v)));
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.strokeStyle = on ? '#8fd8ff' : 'rgba(143,216,255,0.45)';
    c.lineWidth = 2;
    c.shadowColor = '#4cc3ff';
    c.shadowBlur = on ? 6 : 0;
    c.stroke();
    c.shadowBlur = 0;
    c.lineTo(W, H);
    c.lineTo(0, H);
    c.closePath();
    c.fillStyle = 'rgba(80,190,255,0.08)';
    c.fill();
    if (!on) {
      c.fillStyle = 'rgba(200,230,255,0.6)';
      c.font = '600 10px system-ui, sans-serif';
      c.fillText('CAB BYPASSED (DI)', W / 2 - 50, 16);
    }
  };
  const updResp = () => {
    const key = `${Math.round(b.get('cabType'))}|${Math.round(b.get('micType'))}|${b.get('micPos').toFixed(3)}|${b.get('micDist').toFixed(1)}`;
    if (key !== respKey) {
      respKey = key;
      clearTimeout(respTimer);
      respTimer = setTimeout(() => {
        const ir = cabIR(48000, { cab: b.get('cabType'), mic: b.get('micType'), pos: b.get('micPos'), dist: b.get('micDist') });
        const r = irResponse(ir, 48000, RF);
        // normalise the curve to its 100 Hz – 5 kHz average
        let s = 0, n = 0;
        RF.forEach((f, i) => { if (f > 100 && f < 5000) { s += r[i]; n++; } });
        resp = r.map((v) => v - s / n);
        drawResp();
      }, resp.length ? 60 : 0);
    }
    drawResp();
  };
  b.add({ el: cabView, update: () => { layoutCab(); updResp(); } });
  rack.append(uCab.el);

  // ------------------------------------------------------------ post EQ + delay
  const uEq = unit(b, 'eq', 'POST EQ', 'eq', 'eqOn', '5-band graphic EQ after the cabinet');
  uEq.face.append(
    el('div', { class: 'rs-eqscale' }, ...['+12', '+6', '0', '-6', '-12'].map((t) => el('span', { text: t }))),
    ...EQ_LABELS.map((l, i) => vslider(b, 'eq' + (i + 1), 'Post EQ', l, 78).el),
  );
  const uDly = unit(b, 'delay', 'DELAY', 'delay', 'dlyOn', 'Tempo-synced delay (trails ring out when switched off)');
  const dlyLcd = el('div', { class: 'rs-lcd', 'data-hint': 'Delay time' });
  const kDiv = knob(b, { key: 'dlyDiv', unit: 'Delay', kind: 'rack', label: '', noValue: true });
  const kMs = knob(b, { key: 'dlyMs', unit: 'Delay', kind: 'rack', label: '', noValue: true });
  const taps: number[] = [];
  const tap = el('button', { class: 'rs-tap', text: 'TAP', 'data-hint': 'Tap tempo: tap twice or more to set the delay time (switches to free ms)' });
  tap.addEventListener('click', () => {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(t);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) {
      const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      api.commit('Tap delay', (s) => {
        s.params.dlyMs = Math.round(Math.max(10, Math.min(2000, avg)));
        s.params.dlySync = 0;
      });
    }
  });
  const timeGrp = group('TIME', kDiv.el, kMs.el);
  uDly.face.append(
    el('div', { class: 'rs-col rs-dly-l' }, dlyLcd, el('div', { class: 'rs-row-s' }, seg(b, 'dlySync', 'Delay', ['MS', 'SYNC'], 'rs-seg-xs', ['Free time in milliseconds', 'Synced to the project tempo']).el, tap), toggle(b, 'dlyPing', 'Delay', 'led', 'PING-PONG').el),
    timeGrp,
    group('FEEDBACK', knob(b, { key: 'dlyFb', unit: 'Delay', kind: 'rack', label: '' }).el),
    group('TONE', knob(b, { key: 'dlyTone', unit: 'Delay', kind: 'rack', label: '' }).el),
    group('MIX', knob(b, { key: 'dlyMix', unit: 'Delay', kind: 'rack', label: '' }).el),
  );
  b.add({
    el: dlyLcd,
    update: () => {
      const sync = b.on('dlySync');
      kDiv.el.style.display = sync ? '' : 'none';
      kMs.el.style.display = sync ? 'none' : '';
      const bpm = store.project.bpm || 120;
      const div = Math.round(b.get('dlyDiv'));
      const beats = [1 / 8, 1 / 4, 3 / 8, 1 / 3, 1 / 2, 3 / 4, 2 / 3, 1, 1.5, 2, 4][div] ?? 0.75;
      const ms = sync ? (beats * 60000) / bpm : b.get('dlyMs');
      dlyLcd.textContent = sync ? `${DELAY_DIVS[div] ?? ''}  ${Math.round(ms)} ms` : `${Math.round(ms)} ms`;
    },
  }).update();
  rack.append(el('div', { class: 'rs-pair' }, uEq.el, uDly.el));

  // ------------------------------------------------------------ reverb + output
  const uRvb = unit(b, 'reverb', 'REVERB', 'reverb', 'rvbOn', 'Convolution reverb: room, hall or plate');
  const rvbLcd = el('div', { class: 'rs-lcd', 'data-hint': 'Reverb type and decay' });
  uRvb.face.append(
    el('div', { class: 'rs-col rs-dly-l' }, rvbLcd, seg(b, 'rvbType', 'Reverb', ['ROOM', 'HALL', 'PLATE'], 'rs-seg-xs', ['Room: short, dense early reflections', 'Hall: pre-delay and a long, smooth tail', 'Plate: bright, instant, dense']).el),
    group('DECAY', knob(b, { key: 'rvbDecay', unit: 'Reverb', kind: 'rack', label: '' }).el),
    group('TONE', knob(b, { key: 'rvbTone', unit: 'Reverb', kind: 'rack', label: '' }).el),
    group('MIX', knob(b, { key: 'rvbMix', unit: 'Reverb', kind: 'rack', label: '' }).el),
  );
  b.add({ el: rvbLcd, update: () => (rvbLcd.textContent = `${['ROOM', 'HALL', 'PLATE'][Math.round(b.get('rvbType'))]}  ${b.get('rvbDecay').toFixed(1)} s`) }).update();
  const uOut = unit(b, 'output', 'OUTPUT', 'output', null, 'Output level and meter');
  const outMeter = new LedMeter(196, 10, false, 30);
  const outPk = el('div', { class: 'rs-lcd rs-outpk', 'data-hint': 'Output peak (click to reset)' });
  const outClip = el('div', { class: 'rs-led-s clip', 'data-hint': 'Output clip indicator' });
  const muteNote = el('div', { class: 'rs-mutenote', text: 'TUNER MUTE', 'data-hint': 'The tuner mute is silencing the output' });
  let outHold = -90;
  outPk.addEventListener('click', () => (outHold = -90));
  uOut.face.append(
    group('LEVEL', knob(b, { key: 'outLevel', unit: 'Output', kind: 'rack', size: 44, label: '' }).el),
    el('div', { class: 'rs-col rs-outm' }, el('div', { class: 'rs-row-s' }, outPk, outClip, el('span', { class: 'rs-mini', text: 'CLIP' }), muteNote), outMeter.el, el('div', { class: 'rs-scale' }, ...['-60', '-40', '-20', '-12', '-6', '0'].map((t) => el('span', { text: t })))),
  );
  b.add({ el: muteNote, update: () => (muteNote.style.display = b.on('tunerMute') ? '' : 'none') }).update();
  rack.append(el('div', { class: 'rs-pair' }, uRvb.el, uOut.el));
  rack.append(el('div', { class: 'rs-foot', text: 'Riffstack · original amp & cabinet models · drag knobs, scroll to fine-tune, right-click to automate' }));

  root.append(header, scroll);

  // ------------------------------------------------------------ live analysis (only while shown)
  let raf = 0;
  let lastT = 0;
  let lastEff: RiffstackFx | null = null;
  let frame = 0;
  const bufIn = new Float32Array(1024);
  const bufOut = new Float32Array(1024);
  const bufTun = new Float32Array(4096);
  const grLeds = [...grBar.children] as HTMLElement[];
  const tick = (t: number) => {
    raf = requestAnimationFrame(tick);
    if (!root.isConnected) return;
    const dt = Math.min(0.1, lastT ? (t - lastT) / 1000 : 0.016);
    lastT = t;
    frame++;
    const e = eff();
    if (e !== lastEff) {
      lastEff?.setViz?.(false);
      e?.setViz?.(true);
      lastEff = e;
    }
    let pin = 0, pout = 0;
    if (e?.analyser && e.outAnalyser) {
      pin = analyserPeak(e.analyser, bufIn) * dbG(b.get('inGain'));
      pout = analyserPeak(e.outAnalyser, bufOut);
      if (frame % 2 === 0) {
        e.analyser.getFloatTimeDomainData(bufTun as any);
        tuner.feed(detectPitch(bufTun, e.sampleRate), Math.round(b.get('tunerRef')), dt * 2);
      }
      const v = e.viz;
      gateLed.classList.toggle('open', b.on('gateOn') && v.gate > 0.5);
      gateLed.classList.toggle('closed', b.on('gateOn') && v.gate <= 0.5);
      const gr = b.on('compOn') ? v.gr : 0;
      grLeds.forEach((l, i) => l.classList.toggle('on', gr > 1 + i * 3));
      if (b.on('wahOn') && b.on('wahAuto')) updTreadle(v.wah);
      amp.style.setProperty('--glow', String(b.on('ampOn') ? 0.35 + 0.65 * Math.min(1, v.drive * 1.6) : 0));
    } else if (frame % 2 === 0) tuner.feed(null, Math.round(b.get('tunerRef')), dt * 2);
    inMeter.push(pin, dt);
    headIn.push(pin, dt);
    outMeter.push(pout, dt);
    headOut.push(pout, dt);
    sigLed.classList.toggle('on', pin > 0.003);
    clipLed.classList.toggle('on', inMeter.peakDb > -0.5);
    const pdb = 20 * Math.log10(Math.max(pout, 1e-5));
    if (pdb > outHold) outHold = pdb;
    outPk.textContent = outHold <= -89 ? '-∞ dB' : `${outHold.toFixed(1)} dB`;
    outClip.classList.toggle('on', outMeter.peakDb > -0.3);
  };
  const start = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    lastT = 0;
    lastEff?.setViz?.(false);
    lastEff = null;
  };
  const off = api.onExternalChange(() => b.update());
  requestAnimationFrame(() => b.update());
  return {
    el: root,
    destroy() {
      stop();
      off();
      clearTimeout(respTimer);
    },
    onShow() {
      b.update();
      start();
    },
    onHide: stop,
    onResize() {
      layoutCab();
    },
  };
}

/** Amp voice selector: a rotary switch with the model names around it. */
function voiceSelector(b: Binder): HTMLElement {
  const n = AMP_MODELS.length;
  const ang = (i: number) => -125 + (i * 250) / (n - 1);
  const rot = el('div', { class: 'rs-vs-rot' });
  const knobEl = el('div', { class: 'rs-voice-knob', 'data-hint': 'Amp voice — drag, scroll or click a name' }, el('div', { class: 'rs-kcap' }), rot);
  const labels = AMP_MODELS.map((name, i) => {
    const a = (ang(i) * Math.PI) / 180;
    const right = Math.sin(a) > 0;
    const l = el('button', { class: 'rs-voice-l ' + (right ? 'rgt' : 'lft'), text: name, 'data-hint': AMP_DESC[i] });
    const x = 120 + Math.sin(a) * 40, y = 64 - Math.cos(a) * 40;
    if (right) l.style.left = `${(x + 6).toFixed(1)}px`;
    else l.style.right = `${(236 - x + 6).toFixed(1)}px`;
    l.style.top = `${y.toFixed(1)}px`;
    l.addEventListener('click', () => b.commit('Amp voice: ' + name, 'ampModel', i));
    return l;
  });
  const wrap = el('div', { class: 'rs-voice' }, ...labels, knobEl, el('div', { class: 'rs-voice-t', text: 'VOICE' }));
  const update = () => {
    const v = Math.round(b.get('ampModel'));
    rot.style.transform = `rotate(${ang(v)}deg)`;
    labels.forEach((l, i) => l.classList.toggle('on', i === v));
  };
  knobEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const v0 = Math.round(b.get('ampModel'));
    const sy = e.clientY;
    let cur = v0;
    const mv = (ev: PointerEvent) => {
      const v = Math.max(0, Math.min(n - 1, v0 + Math.round((sy - ev.clientY) / 28)));
      if (v !== cur) {
        cur = v;
        b.commit('Amp voice: ' + AMP_MODELS[v], 'ampModel', v);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });
  knobEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const v = Math.max(0, Math.min(n - 1, Math.round(b.get('ampModel')) + (e.deltaY < 0 ? 1 : -1)));
      b.commit('Amp voice: ' + AMP_MODELS[v], 'ampModel', v);
    },
    { passive: false },
  );
  b.add({ el: wrap, update }).update();
  return wrap;
}

