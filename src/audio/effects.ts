// Built-in mixer effects, implemented with native Web Audio nodes so they work in both
// the live AudioContext and the OfflineAudioContext used for export.
import { FxSlot, FxType } from '../core/types';
import { DELAY_BEATS } from '../core/params';
import { dbToGain } from '../core/util';
import { kBiquad } from './nodes';
import { nodeLatency } from './latency';

export interface AutoParam {
  param: AudioParam;
  map: (real: number) => number;
}

export abstract class Effect {
  readonly input: GainNode;
  readonly output: GainNode;
  protected dry: GainNode;
  protected wet: GainNode;
  protected enabled = true;
  protected mix = 1;
  protected params: Record<string, number> = {};
  protected nodes: AudioNode[] = [];
  protected sources: AudioScheduledSourceNode[] = [];
  /** Processing delay of the wet path in seconds (used for plugin delay compensation). */
  latency = 0;
  private dryDelay: DelayNode | null = null;

  constructor(protected ctx: BaseAudioContext, public slot: FxSlot, protected bpm: number) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
  }

  /**
   * Declare the wet path's latency (samples). The dry path is delayed to match, so the effect's
   * delay stays the same whether it's bypassed, mixed or fully wet (no comb filtering, no timing jumps).
   */
  protected setLatency(samples: number) {
    const sec = Math.max(0, samples) / this.ctx.sampleRate;
    this.latency = sec;
    if (sec <= 0 && !this.dryDelay) return;
    if (!this.dryDelay) {
      this.dryDelay = this.ctx.createDelay(1);
      this.input.disconnect(this.dry);
      this.input.connect(this.dryDelay).connect(this.dry);
      this.nodes.push(this.dryDelay);
    }
    this.dryDelay.delayTime.value = sec;
  }

  /** Called once after subclass constructed its graph. */
  protected init() {
    this.update(this.slot, this.bpm, true);
  }

  update(slot: FxSlot, bpm: number, force = false) {
    const prev = this.params;
    this.slot = slot;
    this.params = { ...slot.params };
    const bpmChanged = bpm !== this.bpm;
    this.bpm = bpm;
    this.enabled = slot.enabled;
    this.mix = slot.mix;
    this.applyMix();
    this.apply(prev, force || bpmChanged);
  }

  protected applyMix() {
    const m = this.enabled ? this.mix : 0;
    const dry = m <= 0.5 ? 1 : 2 * (1 - m);
    const wet = m <= 0.5 ? 2 * m : 1;
    this.set(this.dry.gain, dry);
    this.set(this.wet.gain, wet);
  }

  protected set(p: AudioParam, v: number) {
    if (!isFinite(v)) return;
    if (this.ctx instanceof OfflineAudioContext || (this.ctx as AudioContext).state !== 'running') p.value = v;
    else p.setTargetAtTime(v, this.ctx.currentTime, 0.012);
  }

  protected abstract apply(prev: Record<string, number>, force: boolean): void;

  autoParam(_key: string): AutoParam | null {
    return null;
  }

  dispose() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    for (const n of [this.input, this.output, this.dry, this.wet, ...this.nodes]) {
      try {
        n.disconnect();
      } catch {}
    }
  }
}

class EqFx extends Effect {
  private f: BiquadFilterNode[];
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    const types: BiquadFilterType[] = ['highpass', 'lowshelf', 'peaking', 'peaking', 'highshelf', 'lowpass'];
    this.f = types.map((t) => {
      const b = kBiquad(ctx);
      b.type = t;
      return b;
    });
    this.f[0].Q.value = 0.707;
    this.f[5].Q.value = 0.707;
    let prev: AudioNode = this.input;
    for (const b of this.f) {
      prev.connect(b);
      prev = b;
    }
    prev.connect(this.wet);
    this.nodes.push(...this.f);
    this.init();
  }
  protected apply() {
    const p = this.params;
    const [hp, ls, pk1, pk2, hs, lp] = this.f;
    this.set(hp.frequency, p.lowCut);
    this.set(ls.frequency, p.lowFreq);
    this.set(ls.gain, p.lowGain);
    this.set(pk1.frequency, p.midFreq);
    this.set(pk1.gain, p.midGain);
    this.set(pk1.Q, p.midQ);
    this.set(pk2.frequency, p.presFreq);
    this.set(pk2.gain, p.presGain);
    pk2.Q.value = 0.9;
    this.set(hs.frequency, p.highFreq);
    this.set(hs.gain, p.highGain);
    this.set(lp.frequency, p.highCut);
  }
  autoParam(key: string): AutoParam | null {
    const [hp, ls, pk1, pk2, hs, lp] = this.f;
    const id = (x: number) => x;
    const m: Record<string, AudioParam> = {
      lowCut: hp.frequency, lowFreq: ls.frequency, lowGain: ls.gain, midFreq: pk1.frequency, midGain: pk1.gain, midQ: pk1.Q,
      presFreq: pk2.frequency, presGain: pk2.gain, highFreq: hs.frequency, highGain: hs.gain, highCut: lp.frequency,
    };
    return m[key] ? { param: m[key], map: id } : null;
  }
}

class CompressorFx extends Effect {
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.comp = ctx.createDynamicsCompressor();
    this.makeup = ctx.createGain();
    this.input.connect(this.comp).connect(this.makeup).connect(this.wet);
    this.nodes.push(this.comp, this.makeup);
    this.setLatency(nodeLatency(ctx.sampleRate).comp);
    this.init();
  }
  protected apply() {
    const p = this.params;
    this.set(this.comp.threshold, p.threshold);
    this.set(this.comp.ratio, p.ratio);
    this.set(this.comp.attack, p.attack);
    this.set(this.comp.release, p.release);
    this.set(this.comp.knee, p.knee);
    this.set(this.makeup.gain, dbToGain(p.makeup));
  }
  autoParam(key: string): AutoParam | null {
    const c = this.comp;
    const m: Record<string, AutoParam> = {
      threshold: { param: c.threshold, map: (v) => v },
      ratio: { param: c.ratio, map: (v) => v },
      attack: { param: c.attack, map: (v) => v },
      release: { param: c.release, map: (v) => v },
      knee: { param: c.knee, map: (v) => v },
      makeup: { param: this.makeup.gain, map: dbToGain },
    };
    return m[key] ?? null;
  }
}

/** Hard clip at ±ceiling. */
function clipCurve(ceiling: number) {
  const n = 4097;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.max(-ceiling, Math.min(ceiling, x));
  }
  return c;
}

/** Transparent up to 90 % of the ceiling, then a smooth knee that approaches (never reaches) it. */
function softClipCurve(ceiling: number) {
  const n = 4097;
  const c = new Float32Array(n);
  const k = 0.9 * ceiling;
  const r = ceiling - k;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = a <= k ? x : Math.sign(x) * (k + r * Math.tanh((a - k) / r));
  }
  return c;
}

class LimiterFx extends Effect {
  private pre: GainNode;
  private comp: DynamicsCompressorNode;
  private soft: WaveShaperNode;
  private clip: WaveShaperNode;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.pre = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 0;
    this.comp.ratio.value = 20;
    this.comp.attack.value = 0.001;
    // 4x-oversampled soft knee (smooth, low aliasing), then a sample-exact brick wall: the
    // oversampler's filters ring a little above the knee, the final stage guarantees the ceiling.
    this.soft = ctx.createWaveShaper();
    this.soft.oversample = '4x';
    this.clip = ctx.createWaveShaper();
    this.clip.oversample = 'none';
    this.input.connect(this.pre).connect(this.comp).connect(this.soft).connect(this.clip).connect(this.wet);
    this.nodes.push(this.pre, this.comp, this.soft, this.clip);
    const L = nodeLatency(ctx.sampleRate);
    this.setLatency(L.comp + L.ws4x);
    this.init();
  }
  protected apply(prev: Record<string, number>, force: boolean) {
    const p = this.params;
    this.set(this.pre.gain, dbToGain(p.gain));
    this.set(this.comp.threshold, p.threshold);
    this.set(this.comp.release, p.release);
    if (force || prev.ceiling !== p.ceiling) {
      const c = dbToGain(p.ceiling);
      this.soft.curve = softClipCurve(c);
      this.clip.curve = clipCurve(c);
    }
  }
  autoParam(key: string): AutoParam | null {
    if (key === 'gain') return { param: this.pre.gain, map: dbToGain };
    if (key === 'threshold') return { param: this.comp.threshold, map: (v) => v };
    return null;
  }
}

/** Generates a stereo reverb impulse response. */
export function makeImpulse(ctx: BaseAudioContext, decay: number, size: number, damp: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * Math.min(decay * 1.1, 14)));
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 * 2 - 1;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    // early reflections
    const nRef = 6 + Math.floor(size * 10);
    for (let r = 0; r < nRef; r++) {
      const t = (0.004 + (r / nRef) * (0.015 + size * 0.06)) * (1 + c * 0.07);
      const idx = Math.floor(t * sr);
      if (idx < len) d[idx] += (rnd() > 0 ? 1 : -1) * (0.7 - r / nRef * 0.5);
    }
    const dampCoefBase = Math.exp((-2 * Math.PI * damp) / sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp((-6.9 * t) / decay);
      const fade = Math.min(1, t / (0.005 + size * 0.03));
      // progressively darker tail
      const coef = Math.min(0.995, dampCoefBase + (1 - dampCoefBase) * Math.min(1, t / decay) * 0.6);
      lp = lp * coef + rnd() * (1 - coef);
      d[i] += lp * env * fade * 2.2;
    }
  }
  return buf;
}

class ReverbFx extends Effect {
  private pre: DelayNode;
  private conv: ConvolverNode;
  private hp: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private irTimer: any = null;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.pre = ctx.createDelay(1);
    this.conv = ctx.createConvolver();
    this.conv.normalize = true;
    this.hp = kBiquad(ctx);
    this.hp.type = 'highpass';
    this.lp = kBiquad(ctx);
    this.lp.type = 'lowpass';
    this.input.connect(this.hp).connect(this.pre).connect(this.conv).connect(this.lp).connect(this.wet);
    this.nodes.push(this.pre, this.conv, this.hp, this.lp);
    this.init();
  }
  protected apply(prev: Record<string, number>, force: boolean) {
    const p = this.params;
    this.set(this.pre.delayTime, p.predelay);
    this.set(this.hp.frequency, p.lowcut);
    this.set(this.lp.frequency, p.damp);
    if (force || prev.decay !== p.decay || prev.size !== p.size) {
      const gen = () => (this.conv.buffer = makeImpulse(this.ctx, p.decay, p.size, p.damp));
      if (force || this.ctx instanceof OfflineAudioContext) gen();
      else {
        clearTimeout(this.irTimer);
        this.irTimer = setTimeout(gen, 120);
      }
    }
  }
  autoParam(key: string): AutoParam | null {
    if (key === 'damp') return { param: this.lp.frequency, map: (v) => v };
    if (key === 'lowcut') return { param: this.hp.frequency, map: (v) => v };
    if (key === 'predelay') return { param: this.pre.delayTime, map: (v) => v };
    return null;
  }
}

class DelayFx extends Effect {
  private mono: GainNode;
  private dL: DelayNode;
  private dR: DelayNode;
  private fb: GainNode;
  private hp: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private merger: ChannelMergerNode;
  private ping = -1;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.mono = ctx.createGain();
    this.mono.channelCount = 1;
    this.mono.channelCountMode = 'explicit';
    this.mono.channelInterpretation = 'speakers';
    this.dL = ctx.createDelay(5);
    this.dR = ctx.createDelay(5);
    this.fb = ctx.createGain();
    this.hp = kBiquad(ctx);
    this.hp.type = 'highpass';
    this.lp = kBiquad(ctx);
    this.lp.type = 'lowpass';
    this.merger = ctx.createChannelMerger(2);
    this.input.connect(this.mono).connect(this.dL);
    this.dL.connect(this.hp).connect(this.lp);
    this.merger.connect(this.wet);
    this.nodes.push(this.mono, this.dL, this.dR, this.fb, this.hp, this.lp, this.merger);
    this.init();
  }
  private rewire(ping: boolean) {
    this.lp.disconnect();
    this.dR.disconnect();
    this.fb.disconnect();
    if (ping) {
      this.lp.connect(this.merger, 0, 0);
      this.lp.connect(this.dR);
      this.dR.connect(this.merger, 0, 1);
      this.dR.connect(this.fb);
    } else {
      this.lp.connect(this.merger, 0, 0);
      this.lp.connect(this.merger, 0, 1);
      this.lp.connect(this.fb);
    }
    this.fb.connect(this.dL);
  }
  protected apply() {
    const p = this.params;
    const ping = p.pingpong >= 0.5 ? 1 : 0;
    if (ping !== this.ping) {
      this.ping = ping;
      this.rewire(!!ping);
    }
    const beats = DELAY_BEATS[Math.round(p.time)] ?? 0.5;
    const sec = Math.min(4.9, (beats * 60) / this.bpm);
    this.set(this.dL.delayTime, sec);
    this.set(this.dR.delayTime, sec);
    this.set(this.fb.gain, p.feedback);
    this.set(this.lp.frequency, p.damp);
    this.set(this.hp.frequency, p.lowcut);
  }
  autoParam(key: string): AutoParam | null {
    if (key === 'feedback') return { param: this.fb.gain, map: (v) => v };
    if (key === 'damp') return { param: this.lp.frequency, map: (v) => v };
    if (key === 'lowcut') return { param: this.hp.frequency, map: (v) => v };
    return null;
  }
}

class FilterFx extends Effect {
  private f: BiquadFilterNode;
  private lfo: OscillatorNode;
  private depth: GainNode;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.f = kBiquad(ctx);
    this.lfo = ctx.createOscillator();
    this.depth = ctx.createGain();
    this.lfo.connect(this.depth).connect(this.f.detune);
    this.lfo.start();
    this.sources.push(this.lfo);
    this.input.connect(this.f).connect(this.wet);
    this.nodes.push(this.f, this.lfo, this.depth);
    this.init();
  }
  protected apply() {
    const p = this.params;
    this.f.type = (['lowpass', 'highpass', 'bandpass'] as BiquadFilterType[])[Math.round(p.type)] ?? 'lowpass';
    this.set(this.f.frequency, p.cutoff);
    this.set(this.f.Q, p.reso);
    this.set(this.lfo.frequency, p.lfoRate);
    this.set(this.depth.gain, p.lfoDepth * 2400);
  }
  autoParam(key: string): AutoParam | null {
    if (key === 'cutoff') return { param: this.f.frequency, map: (v) => v };
    if (key === 'reso') return { param: this.f.Q, map: (v) => v };
    if (key === 'lfoRate') return { param: this.lfo.frequency, map: (v) => v };
    if (key === 'lfoDepth') return { param: this.depth.gain, map: (v) => v * 2400 };
    return null;
  }
}

function driveCurve(mode: number, driveDb: number) {
  const n = 4096;
  const c = new Float32Array(n);
  const g = dbToGain(driveDb);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = x * g;
    if (mode === 1) c[i] = Math.max(-1, Math.min(1, y));
    else if (mode === 2) c[i] = Math.sin((y * Math.PI) / 2);
    else c[i] = Math.tanh(y);
  }
  return c;
}

class DistortionFx extends Effect {
  private shaper: WaveShaperNode;
  private tone: BiquadFilterNode;
  private out: GainNode;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.tone = kBiquad(ctx);
    this.tone.type = 'lowpass';
    this.out = ctx.createGain();
    this.input.connect(this.shaper).connect(this.tone).connect(this.out).connect(this.wet);
    this.nodes.push(this.shaper, this.tone, this.out);
    this.setLatency(nodeLatency(ctx.sampleRate).ws4x);
    this.init();
  }
  protected apply(prev: Record<string, number>, force: boolean) {
    const p = this.params;
    if (force || prev.mode !== p.mode || prev.drive !== p.drive) this.shaper.curve = driveCurve(Math.round(p.mode), p.drive);
    this.set(this.tone.frequency, p.tone);
    this.set(this.out.gain, dbToGain(p.output));
  }
  autoParam(key: string): AutoParam | null {
    if (key === 'tone') return { param: this.tone.frequency, map: (v) => v };
    if (key === 'output') return { param: this.out.gain, map: dbToGain };
    return null;
  }
}

class BitcrusherFx extends Effect {
  private pre: GainNode;
  private shaper: WaveShaperNode;
  private tone: BiquadFilterNode;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.pre = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.tone = kBiquad(ctx);
    this.tone.type = 'lowpass';
    this.input.connect(this.pre).connect(this.shaper).connect(this.tone).connect(this.wet);
    this.nodes.push(this.pre, this.shaper, this.tone);
    this.init();
  }
  protected apply(prev: Record<string, number>, force: boolean) {
    const p = this.params;
    if (force || prev.bits !== p.bits) {
      const n = 8192;
      const c = new Float32Array(n);
      const steps = Math.pow(2, Math.round(p.bits) - 1);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = Math.round(x * steps) / steps;
      }
      this.shaper.curve = c;
    }
    this.set(this.pre.gain, dbToGain(p.drive));
    this.set(this.tone.frequency, p.tone);
  }
  autoParam(key: string): AutoParam | null {
    if (key === 'drive') return { param: this.pre.gain, map: dbToGain };
    if (key === 'tone') return { param: this.tone.frequency, map: (v) => v };
    return null;
  }
}

class ChorusFx extends Effect {
  private dL: DelayNode;
  private dR: DelayNode;
  private lfo: OscillatorNode;
  private gL: GainNode;
  private gR: GainNode;
  private merger: ChannelMergerNode;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.dL = ctx.createDelay(0.1);
    this.dR = ctx.createDelay(0.1);
    this.lfo = ctx.createOscillator();
    this.gL = ctx.createGain();
    this.gR = ctx.createGain();
    this.merger = ctx.createChannelMerger(2);
    this.lfo.connect(this.gL).connect(this.dL.delayTime);
    this.lfo.connect(this.gR).connect(this.dR.delayTime);
    this.lfo.start();
    this.sources.push(this.lfo);
    this.input.connect(this.dL).connect(this.merger, 0, 0);
    this.input.connect(this.dR).connect(this.merger, 0, 1);
    this.merger.connect(this.wet);
    this.nodes.push(this.dL, this.dR, this.lfo, this.gL, this.gR, this.merger);
    this.init();
  }
  protected apply() {
    const p = this.params;
    this.set(this.lfo.frequency, p.rate);
    this.set(this.dL.delayTime, p.delay);
    this.set(this.dR.delayTime, p.delay);
    const amt = p.depth * p.delay * 0.9;
    this.set(this.gL.gain, amt);
    this.set(this.gR.gain, -amt);
  }
  autoParam(key: string): AutoParam | null {
    if (key === 'rate') return { param: this.lfo.frequency, map: (v) => v };
    return null;
  }
}

/** Mid/side stereo width processor (also used by mixer tracks). */
export class WidthNode {
  readonly input: GainNode;
  readonly output: ChannelMergerNode;
  private split: ChannelSplitterNode;
  private mid: GainNode;
  private side: GainNode;
  private sideIn: GainNode;
  readonly sideGain: GainNode;
  private sideInv: GainNode;
  private sideSum: GainNode;
  private sideHp: BiquadFilterNode;
  private monoBass = false;
  private all: AudioNode[];
  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.split = ctx.createChannelSplitter(2);
    this.mid = ctx.createGain();
    this.mid.gain.value = 0.5;
    this.side = ctx.createGain();
    this.side.gain.value = 0.5;
    this.sideIn = ctx.createGain();
    this.sideIn.gain.value = -0.5;
    this.sideHp = kBiquad(ctx);
    this.sideHp.type = 'highpass';
    this.sideHp.frequency.value = 10;
    this.sideGain = ctx.createGain();
    this.sideInv = ctx.createGain();
    this.sideInv.gain.value = -1;
    this.output = ctx.createChannelMerger(2);
    this.input.connect(this.split);
    this.split.connect(this.mid, 0);
    this.split.connect(this.mid, 1);
    this.split.connect(this.side, 0);
    this.split.connect(this.sideIn, 1);
    // side = (L − R) / 2 → (optional mono-bass high-pass) → width gain. Without mono bass the side path
    // has no filter, so width 100 % rebuilds L/R exactly (a filter's phase shift would raise peaks after a limiter).
    this.sideSum = ctx.createGain();
    this.sideIn.connect(this.sideSum);
    this.side.connect(this.sideSum);
    this.sideSum.connect(this.sideGain);
    this.sideHp.frequency.value = 150;
    this.sideHp.connect(this.sideGain);
    this.mid.connect(this.output, 0, 0);
    this.mid.connect(this.output, 0, 1);
    this.sideGain.connect(this.output, 0, 0);
    this.sideGain.connect(this.sideInv).connect(this.output, 0, 1);
    this.all = [this.input, this.split, this.mid, this.side, this.sideIn, this.sideSum, this.sideHp, this.sideGain, this.sideInv, this.output];
  }
  setWidth(w: number, smooth = true) {
    if (smooth && !(this.ctx instanceof OfflineAudioContext)) this.sideGain.gain.setTargetAtTime(w, this.ctx.currentTime, 0.015);
    else this.sideGain.gain.value = w;
  }
  setMonoBass(on: boolean) {
    if (on === this.monoBass) return;
    this.monoBass = on;
    this.sideSum.disconnect();
    this.sideSum.connect(on ? this.sideHp : this.sideGain);
  }
  dispose() {
    for (const n of this.all) {
      try {
        n.disconnect();
      } catch {}
    }
  }
}

class WidthFx extends Effect {
  private w: WidthNode;
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.w = new WidthNode(ctx);
    this.input.connect(this.w.input);
    this.w.output.connect(this.wet);
    this.init();
  }
  protected apply() {
    this.w.setWidth(this.params.width);
    this.w.setMonoBass(this.params.monoBass >= 0.5);
  }
  autoParam(key: string): AutoParam | null {
    if (key === 'width') return { param: this.w.sideGain.gain, map: (v) => v };
    return null;
  }
  dispose() {
    super.dispose();
    this.w.dispose();
  }
}

type EffectCtor = new (ctx: BaseAudioContext, slot: FxSlot, bpm: number) => Effect;
const CLASSES: Partial<Record<FxType, EffectCtor>> = {
  eq: EqFx,
  compressor: CompressorFx,
  limiter: LimiterFx,
  reverb: ReverbFx,
  delay: DelayFx,
  filter: FilterFx,
  distortion: DistortionFx,
  bitcrusher: BitcrusherFx,
  chorus: ChorusFx,
  width: WidthFx,
};

/** Plugins register their Effect subclass here (e.g. the Riffstack amp rack). */
export function registerEffectClass(type: FxType, ctor: EffectCtor) {
  CLASSES[type] = ctor;
}

class PassthroughFx extends Effect {
  constructor(ctx: BaseAudioContext, slot: FxSlot, bpm: number) {
    super(ctx, slot, bpm);
    this.input.connect(this.wet);
    this.init();
  }
  protected apply() {}
}

export function createEffect(ctx: BaseAudioContext, slot: FxSlot, bpm: number): Effect {
  const C = CLASSES[slot.type];
  try {
    return C ? new C(ctx, slot, bpm) : new PassthroughFx(ctx, slot, bpm);
  } catch (e) {
    console.error('Effect failed to start', slot.type, e);
    return new PassthroughFx(ctx, slot, bpm);
  }
}
