// Riffstack Effect: worklet (gate → comp → wah → fuzz → overdrive → amp, oversampled) followed by
// native nodes — cabinet ConvolverNode with procedural IRs, cab low/high cut, 5-band post EQ,
// tempo-synced delay, convolution reverb and the output stage. Exposes analysers for the UI.
import { Effect, type AutoParam } from '../../effects';
import type { FxSlot } from '../../../core/types';
import { DELAY_BEATS } from '../../../core/params';
import { cabIR, reverbIR } from './ir';
import { EQ_FREQS, RS_PARAM, WORKLET_AUTO, WORKLET_KEYS, rsDefaults } from './params';
import { RS_LATENCY, type RiffViz } from './dsp';

const dbG = (d: number) => Math.pow(10, d / 20);
const DEFAULTS = rsDefaults();

export class RiffstackFx extends Effect {
  /** Effect input (pre everything) — tuner + input meter. Null in offline renders. */
  analyser: AnalyserNode | null = null;
  /** Final output — output meter. Null in offline renders. */
  outAnalyser: AnalyserNode | null = null;
  node: AudioWorkletNode | null = null;
  /** Latest worklet visualisation state (gate, comp GR, wah, power-amp drive). */
  viz: RiffViz = { gate: 1, gr: 0, wah: 0.5, drive: 0 };
  /** Current cabinet IR (null until generated). */
  cabIr: Float32Array | null = null;
  readonly sampleRate: number;
  private vizOn = false;
  private sent: Record<string, number> = {};
  private realtime: boolean;
  private cabConv: ConvolverNode;
  private cabWet: GainNode;
  private cabDry: GainNode;
  private lowCut: BiquadFilterNode;
  private highCut: BiquadFilterNode;
  private eq: BiquadFilterNode[];
  private dlySend: GainNode;
  private dL: DelayNode;
  private dR: DelayNode;
  private dlyLp: BiquadFilterNode;
  private dlyHp: BiquadFilterNode;
  private dlyFb: GainNode;
  private dlyMerge: ChannelMergerNode;
  private dlyWet: GainNode;
  private rvbSend: GainNode;
  private rvbConv: ConvolverNode;
  private rvbWet: GainNode;
  private outGain: GainNode;
  private ping = -1;
  private cabKey = '';
  private rvbKey = '';
  private cabTimer: any = null;
  private rvbTimer: any = null;

  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.sampleRate = ctx.sampleRate;
    this.realtime = !(ctx instanceof OfflineAudioContext);
    const p = { ...DEFAULTS, ...slot.params };
    const n = this.nodes;
    const gain = (v = 1) => {
      const g = ctx.createGain();
      g.gain.value = v;
      n.push(g);
      return g;
    };
    const biq = (type: BiquadFilterType, f: number, q = 0.707) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      n.push(b);
      return b;
    };
    // --- worklet section
    const pre = gain();
    try {
      const parameterData: Record<string, number> = {};
      for (const k of WORKLET_AUTO) parameterData[k] = clampParam(k, p[k]);
      const init: Record<string, number> = {};
      for (const k of [...WORKLET_KEYS, ...WORKLET_AUTO]) init[k] = p[k];
      this.node = new AudioWorkletNode(ctx, 'lf-riffstack', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { params: init },
        parameterData,
      });
      for (const k of WORKLET_KEYS) this.sent[k] = p[k];
      this.node.port.onmessage = (e: MessageEvent) => {
        if (e.data?.t === 'viz') this.viz = e.data.v;
      };
      this.input.connect(this.node).connect(pre);
      n.push(this.node);
      this.setLatency(RS_LATENCY);
    } catch (e) {
      console.warn('Riffstack: amp worklet unavailable, passing through', e);
      this.node = null;
      this.input.connect(pre);
    }
    // --- cabinet
    this.cabConv = ctx.createConvolver();
    this.cabConv.normalize = false;
    n.push(this.cabConv);
    this.cabWet = gain(1);
    this.cabDry = gain(0);
    const cabSum = gain();
    pre.connect(this.cabConv).connect(this.cabWet).connect(cabSum);
    pre.connect(this.cabDry).connect(cabSum);
    this.lowCut = biq('highpass', p.cabLow, 0.6);
    this.highCut = biq('lowpass', p.cabHigh, 0.6);
    cabSum.connect(this.lowCut).connect(this.highCut);
    // --- post EQ
    this.eq = EQ_FREQS.map((f, i) => biq(i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking', f, 1.1));
    let last: AudioNode = this.highCut;
    for (const b of this.eq) last = last.connect(b);
    // --- delay (sends keep trails ringing when the unit is switched off)
    const dlyIn = gain();
    last.connect(dlyIn);
    this.dlySend = gain(0);
    this.dL = ctx.createDelay(4);
    this.dR = ctx.createDelay(4);
    n.push(this.dL, this.dR);
    this.dlyLp = biq('lowpass', 5000, 0.5);
    this.dlyHp = biq('highpass', 110, 0.5);
    this.dlyFb = gain(0);
    this.dlyMerge = ctx.createChannelMerger(2);
    n.push(this.dlyMerge);
    this.dlyWet = gain(0);
    dlyIn.connect(this.dlySend).connect(this.dL).connect(this.dlyLp).connect(this.dlyHp);
    this.dlyMerge.connect(this.dlyWet);
    const fxSum = gain();
    dlyIn.connect(fxSum);
    this.dlyWet.connect(fxSum);
    // --- reverb
    this.rvbSend = gain(0);
    this.rvbConv = ctx.createConvolver();
    this.rvbConv.normalize = false;
    n.push(this.rvbConv);
    this.rvbWet = gain(0);
    fxSum.connect(this.rvbSend).connect(this.rvbConv).connect(this.rvbWet);
    // --- output
    this.outGain = gain(1);
    // always stereo out (a mono amp + mono cab would otherwise hit the strip panner as mono, −3 dB)
    this.outGain.channelCount = 2;
    this.outGain.channelCountMode = 'explicit';
    this.outGain.channelInterpretation = 'speakers';
    fxSum.connect(this.outGain);
    this.rvbWet.connect(this.outGain);
    this.outGain.connect(this.wet);
    if (this.realtime) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0;
      this.input.connect(this.analyser);
      this.outAnalyser = ctx.createAnalyser();
      this.outAnalyser.fftSize = 2048;
      this.outAnalyser.smoothingTimeConstant = 0;
      this.outGain.connect(this.outAnalyser);
      n.push(this.analyser, this.outAnalyser);
    }
    this.init();
  }

  /** Ask the worklet for (or stop) ~30 Hz visualisation messages. */
  setViz(on: boolean) {
    if (on === this.vizOn) return;
    this.vizOn = on;
    this.node?.port.postMessage({ t: 'viz', on });
  }

  private rewireDelay(ping: boolean) {
    this.dlyHp.disconnect();
    this.dR.disconnect();
    this.dlyFb.disconnect();
    if (ping) {
      this.dlyHp.connect(this.dlyMerge, 0, 0);
      this.dlyHp.connect(this.dR);
      this.dR.connect(this.dlyMerge, 0, 1);
      this.dR.connect(this.dlyFb);
    } else {
      this.dlyHp.connect(this.dlyMerge, 0, 0);
      this.dlyHp.connect(this.dlyMerge, 0, 1);
      this.dlyHp.connect(this.dlyFb);
    }
    this.dlyFb.connect(this.dL);
  }

  private later(kind: 'cab' | 'rvb', force: boolean, fn: () => void) {
    if (force || !this.realtime) {
      fn();
      return;
    }
    if (kind === 'cab') {
      clearTimeout(this.cabTimer);
      this.cabTimer = setTimeout(fn, 40);
    } else {
      clearTimeout(this.rvbTimer);
      this.rvbTimer = setTimeout(fn, 90);
    }
  }

  protected apply(prevRaw: Record<string, number>, force: boolean) {
    const p = { ...DEFAULTS, ...this.params };
    const prev = { ...DEFAULTS, ...prevRaw };
    const ctx = this.ctx;
    // worklet params
    if (this.node) {
      for (const k of WORKLET_AUTO) {
        const ap = this.node.parameters.get(k);
        if (ap && (force || prev[k] !== p[k])) this.set(ap, clampParam(k, p[k]));
      }
      const msg: Record<string, number> = {};
      let any = false;
      for (const k of WORKLET_KEYS) {
        if (force || this.sent[k] !== p[k]) {
          msg[k] = p[k];
          this.sent[k] = p[k];
          any = true;
        }
      }
      if (any) this.node.port.postMessage({ t: 'p', p: msg });
    }
    // cabinet
    const cabOn = p.cabOn >= 0.5;
    this.set(this.cabWet.gain, cabOn ? 1 : 0);
    this.set(this.cabDry.gain, cabOn ? 0 : 1);
    const key = `${Math.round(p.cabType)}|${Math.round(p.micType)}|${p.micPos.toFixed(3)}|${p.micDist.toFixed(2)}`;
    if (key !== this.cabKey) {
      const first = !this.cabKey;
      this.cabKey = key;
      this.later('cab', force || first, () => {
        const ir = cabIR(ctx.sampleRate, { cab: p.cabType, mic: p.micType, pos: p.micPos, dist: p.micDist });
        const b = ctx.createBuffer(1, ir.length, ctx.sampleRate);
        b.getChannelData(0).set(ir);
        this.cabConv.buffer = b;
        this.cabIr = ir;
      });
    }
    this.set(this.lowCut.frequency, p.cabLow);
    this.set(this.highCut.frequency, p.cabHigh);
    // post EQ
    const eqOn = p.eqOn >= 0.5;
    this.eq.forEach((b, i) => this.set(b.gain, eqOn ? p['eq' + (i + 1)] : 0));
    // delay
    const ping = p.dlyPing >= 0.5 ? 1 : 0;
    if (ping !== this.ping) {
      this.ping = ping;
      this.rewireDelay(!!ping);
    }
    const beats = DELAY_BEATS[Math.round(p.dlyDiv)] ?? 0.75;
    const t = p.dlySync >= 0.5 ? (beats * 60) / Math.max(20, this.bpm) : p.dlyMs / 1000;
    this.set(this.dL.delayTime, Math.min(3.9, Math.max(0.005, t)));
    this.set(this.dR.delayTime, Math.min(3.9, Math.max(0.005, t)));
    this.set(this.dlySend.gain, p.dlyOn >= 0.5 ? 1 : 0);
    this.set(this.dlyFb.gain, p.dlyFb);
    this.set(this.dlyWet.gain, p.dlyMix);
    this.set(this.dlyLp.frequency, 1200 * Math.pow(10, p.dlyTone));
    // reverb
    this.set(this.rvbSend.gain, p.rvbOn >= 0.5 ? 1 : 0);
    this.set(this.rvbWet.gain, p.rvbMix);
    const rk = `${Math.round(p.rvbType)}|${p.rvbDecay.toFixed(2)}|${p.rvbTone.toFixed(2)}`;
    if (rk !== this.rvbKey && (p.rvbOn >= 0.5 || this.rvbKey)) {
      const first = !this.rvbKey;
      this.rvbKey = rk;
      this.later('rvb', force || first, () => {
        const [l, r] = reverbIR(ctx.sampleRate, p.rvbType, p.rvbDecay, p.rvbTone);
        const b = ctx.createBuffer(2, l.length, ctx.sampleRate);
        b.getChannelData(0).set(l);
        b.getChannelData(1).set(r);
        this.rvbConv.buffer = b;
      });
    }
    // output (tuner mute silences the rack while tuning)
    this.set(this.outGain.gain, p.tunerMute >= 0.5 ? 0 : dbG(p.outLevel));
  }

  autoParam(key: string): AutoParam | null {
    const id = (v: number) => v;
    if (this.node && WORKLET_AUTO.includes(key)) {
      const ap = this.node.parameters.get(key);
      return ap ? { param: ap, map: (v) => clampParam(key, v) } : null;
    }
    const m: Record<string, AutoParam> = {
      outLevel: { param: this.outGain.gain, map: dbG },
      dlyMix: { param: this.dlyWet.gain, map: id },
      dlyFb: { param: this.dlyFb.gain, map: id },
      rvbMix: { param: this.rvbWet.gain, map: id },
      cabLow: { param: this.lowCut.frequency, map: id },
      cabHigh: { param: this.highCut.frequency, map: id },
    };
    this.eq.forEach((b, i) => (m['eq' + (i + 1)] = { param: b.gain, map: id }));
    return m[key] ?? null;
  }

  dispose() {
    clearTimeout(this.cabTimer);
    clearTimeout(this.rvbTimer);
    try {
      this.node?.port.postMessage({ t: 'bye' });
    } catch {}
    super.dispose();
  }
}

function clampParam(k: string, v: number) {
  const d = RS_PARAM[k];
  if (!d || !isFinite(v)) return d?.def ?? 0;
  return Math.min(d.max, Math.max(d.min, v));
}
