// Riffstack parameter set: every control of the rack is a numeric FxSlot param (automation, undo,
// project files). Discrete choices (amp model, cab, mic, reverb type…) are stored as indices.
import { DELAY_DIVS, type FxDef, type ParamDef } from '../../../core/params';
import { fmtHz } from '../../../core/util';

export const AMP_MODELS = ['Glass', 'Amberglow', 'Hot Lead', 'Molten Core', 'Razor', 'Subterra'];
export const AMP_DESC = [
  'Glass — sparkling clean, scooped two-stage preamp with huge headroom',
  'Amberglow — late-60s style crunch: mid-forward, touch-sensitive, loose',
  'Hot Lead — smooth four-stage lead channel with singing sustain',
  'Molten Core — tight, saturated five-stage high gain for metal rhythm & lead',
  'Razor — modern djent voicing: ultra-tight low end, cutting upper mids',
  'Subterra — bass amp: deep clean path blended with gritty drive',
];
export const AMP_SHORT = ['GLASS', 'AMBER', 'HOT LEAD', 'MOLTEN', 'RAZOR', 'SUBTERRA'];
export const CAB_TYPES = ['1x12 Open', '2x12 Combo', '4x12 Vintage', '4x12 Modern', '1x15 Bass'];
export const CAB_DESC = [
  '1x12 open-back combo: airy, loose low end, wide dispersion',
  '2x12 combo: balanced, punchy, semi-open back',
  '4x12 closed back with vintage speakers: warm, mid-forward, smooth top',
  '4x12 closed back with modern speakers: tight bass thump, scooped low mids, cutting presence',
  '1x15 bass cab: deep extended lows, soft top end',
];
export const MIC_TYPES = ['Dynamic', 'Ribbon', 'Condenser'];
export const RVB_TYPES = ['Room', 'Hall', 'Plate'];
export const IN_SEL = ['Auto', 'L+R', 'Left', 'Right'];
export const EQ_FREQS = [80, 240, 750, 2200, 6600];
export const EQ_LABELS = ['80', '240', '750', '2.2k', '6.6k'];

const db = (v: number) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
const ms = (v: number) => (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms');
const sec = (v: number) => v.toFixed(v < 10 ? 2 : 1) + ' s';
const ten = (v: number) => v.toFixed(1);
const ped = (v: number) => (v * 10).toFixed(1);
const pct = (v: number) => Math.round(v * 100) + '%';
const onOff = ['Off', 'On'];
const lvl = (v: number) => db((v - 0.5) * 30);

const P = (key: string, label: string, min: number, max: number, def: number, extra: Partial<ParamDef> = {}): ParamDef => ({ key, label, min, max, def, ...extra });
const sw = (key: string, label: string, def: number): ParamDef => P(key, label, 0, 1, def, { step: 1, options: onOff });

export const RS_PARAMS: ParamDef[] = [
  // input + gate
  P('inGain', 'Input gain', -12, 24, 0, { fmt: db }),
  P('inSel', 'Input channel', 0, 3, 0, { step: 1, options: IN_SEL }),
  sw('gateOn', 'Gate', 1),
  P('gateThr', 'Gate threshold', -96, -20, -64, { fmt: (v) => v.toFixed(0) + ' dB' }),
  P('gateRel', 'Gate release', 5, 600, 90, { curve: 'log', fmt: ms }),
  P('gateHyst', 'Gate hysteresis', 0, 20, 6, { fmt: (v) => v.toFixed(1) + ' dB' }),
  // tuner
  P('tunerRef', 'Tuner A4', 425, 455, 440, { step: 1, fmt: (v) => Math.round(v) + ' Hz' }),
  sw('tunerMute', 'Tuner mute', 0),
  // compressor pedal
  sw('compOn', 'Comp', 0),
  P('compSus', 'Comp sustain', 0, 1, 0.5, { fmt: ped }),
  P('compAtk', 'Comp attack', 1, 50, 8, { curve: 'log', fmt: ms }),
  P('compLevel', 'Comp level', 0, 1, 0.5, { fmt: lvl }),
  // wah
  sw('wahOn', 'Wah', 0),
  P('wahPos', 'Wah position', 0, 1, 0.5, { fmt: pct }),
  P('wahAuto', 'Wah mode', 0, 1, 0, { step: 1, options: ['Pedal', 'Auto'] }),
  P('wahSens', 'Wah sensitivity', 0, 1, 0.5, { fmt: ped }),
  // fuzz / distortion pedal
  sw('fzOn', 'Fuzz', 0),
  P('fzGain', 'Fuzz gain', 0, 1, 0.6, { fmt: ped }),
  P('fzTone', 'Fuzz tone', 0, 1, 0.5, { fmt: ped }),
  P('fzLevel', 'Fuzz level', 0, 1, 0.5, { fmt: lvl }),
  // mid-boost overdrive
  sw('odOn', 'Overdrive', 0),
  P('odDrive', 'OD drive', 0, 1, 0.3, { fmt: ped }),
  P('odTone', 'OD tone', 0, 1, 0.5, { fmt: ped }),
  P('odLevel', 'OD level', 0, 1, 0.6, { fmt: lvl }),
  // amp head
  sw('ampOn', 'Amp', 1),
  P('ampModel', 'Amp model', 0, AMP_MODELS.length - 1, 1, { step: 1, options: AMP_MODELS }),
  P('gain', 'Gain', 0, 10, 5, { fmt: ten }),
  P('bass', 'Bass', 0, 10, 5, { fmt: ten }),
  P('middle', 'Middle', 0, 10, 5, { fmt: ten }),
  P('treble', 'Treble', 0, 10, 5, { fmt: ten }),
  P('presence', 'Presence', 0, 10, 5, { fmt: ten }),
  P('depth', 'Depth', 0, 10, 5, { fmt: ten }),
  P('master', 'Master', 0, 10, 5, { fmt: ten }),
  sw('bright', 'Bright', 0),
  sw('tight', 'Tight', 0),
  // cabinet + mic
  sw('cabOn', 'Cabinet', 1),
  P('cabType', 'Cabinet', 0, CAB_TYPES.length - 1, 2, { step: 1, options: CAB_TYPES }),
  P('micType', 'Mic', 0, MIC_TYPES.length - 1, 0, { step: 1, options: MIC_TYPES }),
  P('micPos', 'Mic position', 0, 1, 0.3, { fmt: (v) => (v < 0.05 ? 'Center' : v > 0.95 ? 'Edge' : Math.round(v * 100) + '% to edge') }),
  P('micDist', 'Mic distance', 1, 100, 4, { curve: 'log', fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' cm' }),
  P('cabLow', 'Low cut', 20, 400, 60, { curve: 'log', fmt: fmtHz }),
  P('cabHigh', 'High cut', 2000, 20000, 12000, { curve: 'log', fmt: fmtHz }),
  // post EQ
  sw('eqOn', 'Post EQ', 0),
  ...EQ_FREQS.map((f, i) => P('eq' + (i + 1), `EQ ${EQ_LABELS[i]}`, -12, 12, 0, { fmt: db })),
  // delay
  sw('dlyOn', 'Delay', 0),
  P('dlySync', 'Delay sync', 0, 1, 1, { step: 1, options: ['Free (ms)', 'Tempo'] }),
  P('dlyDiv', 'Delay note', 0, DELAY_DIVS.length - 1, 5, { step: 1, options: DELAY_DIVS }),
  P('dlyMs', 'Delay time', 10, 2000, 380, { curve: 'log', fmt: ms }),
  P('dlyFb', 'Delay feedback', 0, 0.95, 0.35, { fmt: pct }),
  P('dlyTone', 'Delay tone', 0, 1, 0.5, { fmt: ped }),
  P('dlyMix', 'Delay mix', 0, 1, 0.25, { fmt: pct }),
  P('dlyPing', 'Ping-pong', 0, 1, 0, { step: 1, options: onOff }),
  // reverb
  sw('rvbOn', 'Reverb', 0),
  P('rvbType', 'Reverb type', 0, RVB_TYPES.length - 1, 0, { step: 1, options: RVB_TYPES }),
  P('rvbDecay', 'Reverb decay', 0.2, 10, 1.6, { curve: 'log', fmt: sec }),
  P('rvbTone', 'Reverb tone', 0, 1, 0.5, { fmt: ped }),
  P('rvbMix', 'Reverb mix', 0, 1, 0.2, { fmt: pct }),
  // output
  P('outLevel', 'Output', -24, 12, 0, { fmt: db }),
];

export const RS_DEF: FxDef = {
  type: 'riffstack',
  name: 'Riffstack',
  desc: 'Guitar amp & effects rack: gate, pedals, amp head, mic’d cabinet, EQ, delay, reverb',
  defaultMix: 1,
  params: RS_PARAMS,
};

export const RS_PARAM: Record<string, ParamDef> = Object.fromEntries(RS_PARAMS.map((p) => [p.key, p]));

export function rsDefaults(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const p of RS_PARAMS) o[p.key] = p.def;
  return o;
}

/** Params driven by AudioParams of the worklet (automatable, sample-block accurate). */
export const WORKLET_AUTO = ['inGain', 'gain', 'bass', 'middle', 'treble', 'presence', 'depth', 'master', 'wahPos', 'odDrive', 'fzGain'];
/** Params handled inside the worklet (sent by message when they change). */
export const WORKLET_KEYS = [
  'inSel', 'gateOn', 'gateThr', 'gateRel', 'gateHyst',
  'compOn', 'compSus', 'compAtk', 'compLevel',
  'wahOn', 'wahAuto', 'wahSens',
  'fzOn', 'fzTone', 'fzLevel',
  'odOn', 'odTone', 'odLevel',
  'ampOn', 'ampModel', 'bright', 'tight',
];
/** Native-node params that can be automated. */
export const NATIVE_AUTO = ['outLevel', 'dlyMix', 'dlyFb', 'rvbMix', 'cabLow', 'cabHigh', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5'];
export const AUTOMATABLE = new Set([...WORKLET_AUTO, ...NATIVE_AUTO]);
