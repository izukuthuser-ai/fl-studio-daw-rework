// Audio graph shared by live playback and offline export:
// voice -> channel strip (vol/pan/filter/mute) -> mixer insert (FX -> width -> pan -> fader -> mute) -> route -> master -> out
import { AutoTarget, Channel, ID, MixerTrack, Project, Wave } from '../core/types';
import { chanVolToGain, clamp, dbToGain, midiToFreq } from '../core/util';
import { CHANNEL_PARAMS, FX_DEFS, MIXER_PARAMS, ParamDef, fromNorm } from '../core/params';
import { Effect, WidthNode, createEffect } from './effects';
import { SampleBank } from './samples';
import { kBiquad } from './nodes';
import { getInstrument } from './plugins/registry';
import { WorkletInstrumentHost } from './plugins/workletHost';
import type { InstrumentHost } from './plugins/api';

const isOffline = (ctx: BaseAudioContext) => typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;

function setSmooth(ctx: BaseAudioContext, p: AudioParam, v: number, tc = 0.012) {
  if (!isFinite(v)) return;
  if (isOffline(ctx) || (ctx as AudioContext).state !== 'running') p.value = v;
  else p.setTargetAtTime(v, ctx.currentTime, tc);
}

export class MixerStrip {
  input: GainNode;
  fxOut: GainNode;
  width: WidthNode;
  pan: StereoPannerNode;
  fader: GainNode;
  mute: GainNode;
  out: GainNode;
  analysers: AnalyserNode[] = [];
  private splitter: ChannelSplitterNode | null = null;
  effects: Effect[] = [];
  fxSig = '';
  dest: AudioNode | null = null;
  destKey = '';
  /** Total processing delay of this insert's effects (seconds). */
  get latency() {
    let l = 0;
    for (const e of this.effects) l += e.latency;
    return l;
  }

  constructor(private ctx: BaseAudioContext, public id: ID, meters: boolean) {
    this.input = ctx.createGain();
    this.fxOut = ctx.createGain();
    this.width = new WidthNode(ctx);
    this.pan = ctx.createStereoPanner();
    this.fader = ctx.createGain();
    this.mute = ctx.createGain();
    this.out = ctx.createGain();
    this.input.connect(this.fxOut);
    this.fxOut.connect(this.width.input);
    this.width.output.connect(this.pan).connect(this.fader).connect(this.mute).connect(this.out);
    if (meters) {
      this.splitter = ctx.createChannelSplitter(2);
      this.mute.connect(this.splitter);
      for (let i = 0; i < 2; i++) {
        const a = ctx.createAnalyser();
        a.fftSize = 512;
        a.smoothingTimeConstant = 0;
        this.splitter.connect(a, i);
        this.analysers.push(a);
      }
    }
  }

  setFx(slots: MixerTrack['fx'], bpm: number) {
    const sig = slots.map((s) => s.id + ':' + s.type).join('|');
    if (sig !== this.fxSig) {
      this.input.disconnect();
      for (const e of this.effects) e.dispose();
      this.effects = slots.map((s) => createEffect(this.ctx, s, bpm));
      let prev: AudioNode = this.input;
      for (const e of this.effects) {
        prev.connect(e.input);
        prev = e.output;
      }
      prev.connect(this.fxOut);
      this.fxSig = sig;
    } else {
      slots.forEach((s, i) => this.effects[i].update(s, bpm));
    }
  }

  connectTo(node: AudioNode, key: string) {
    if (key === this.destKey) return;
    this.out.disconnect();
    this.out.connect(node);
    this.dest = node;
    this.destKey = key;
  }

  dispose() {
    for (const e of this.effects) e.dispose();
    this.width.dispose();
    for (const n of [this.input, this.fxOut, this.pan, this.fader, this.mute, this.out, this.splitter, ...this.analysers]) {
      try {
        n?.disconnect();
      } catch {}
    }
  }
}

export class ChannelStrip {
  input: GainNode;
  filter: BiquadFilterNode;
  vol: GainNode;
  pan: StereoPannerNode;
  mute: GainNode;
  /** Plugin delay compensation: delays this channel so every insert path reaches the master together. */
  pdc: DelayNode;
  pdcSec = 0;
  destId = '';
  /** Plugin instrument host (Halcyon, Rune, …) when the channel is a plugin channel. */
  host: InstrumentHost | null = null;
  hostType = '';
  /** Macro params that playlist automation may have touched (reset to "follow the knob" when it stops). */
  macroTouched = new Set<string>();
  constructor(ctx: BaseAudioContext, public id: ID) {
    this.input = ctx.createGain();
    this.filter = kBiquad(ctx);
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 20000;
    this.vol = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.mute = ctx.createGain();
    this.pdc = ctx.createDelay(2);
    this.pdc.delayTime.value = 0;
    this.input.connect(this.filter).connect(this.vol).connect(this.pan).connect(this.mute).connect(this.pdc);
  }
  dispose() {
    this.host?.dispose();
    this.host = null;
    for (const n of [this.input, this.filter, this.vol, this.pan, this.mute, this.pdc]) {
      try {
        n.disconnect();
      } catch {}
    }
  }
}

export interface Voice {
  channelId: ID;
  key: number;
  start: number;
  end: number; // scheduled end (Infinity while held)
  cutGroup: number;
  release(when: number): void;
  kill(when: number): void;
  plugin?: boolean; // voice lives inside a plugin worklet (no onended)
}

export class AudioGraph {
  readonly master: MixerStrip;
  readonly out: GainNode; // monitor volume (live only)
  strips = new Map<ID, MixerStrip>();
  stripOrder: MixerStrip[] = [];
  channels = new Map<ID, ChannelStrip>();
  voices = new Set<Voice>();
  private noise: AudioBuffer;
  private monoLast = new Map<ID, { key: number; voice: Voice | null }>();
  project!: Project;
  automated = new Set<string>();
  /** Longest insert → master latency (seconds). Every channel is delayed so it arrives this late. */
  pdcTotal = 0;

  /** Offline export: don't build mixer inserts that nothing audible feeds. */
  prune = false;
  constructor(public ctx: BaseAudioContext, public samples: SampleBank, private meters = true) {
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.master = new MixerStrip(ctx, '__master__', meters);
    // noise buffer for synth noise osc
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
  }

  get now() {
    return this.ctx.currentTime;
  }

  /** Bring the node graph in line with the project. Cheap to call often. */
  sync(p: Project) {
    this.project = p;
    const ctx = this.ctx;
    const live = new Set<ID>();
    // ---- mixer ----
    const order: MixerStrip[] = [];
    let needed: Set<number> | null = null;
    if (this.prune) {
      needed = new Set([0]);
      for (const c of p.channels) {
        if (c.mute) continue;
        let cur = c.mixer;
        for (let guard = 0; cur > 0 && cur < p.mixer.length && !needed.has(cur) && guard < 256; guard++) {
          needed.add(cur);
          cur = p.mixer[cur].route;
        }
      }
    }
    p.mixer.forEach((t, i) => {
      let s: MixerStrip;
      if (needed && !needed.has(i)) {
        order.push(undefined as unknown as MixerStrip);
        return;
      }
      if (i === 0) {
        s = this.master;
        s.id = t.id;
      } else {
        s = this.strips.get(t.id) ?? new MixerStrip(ctx, t.id, this.meters);
        this.strips.set(t.id, s);
      }
      live.add(t.id);
      order.push(s);
    });
    for (const [id, s] of this.strips) if (!live.has(id)) {
      s.dispose();
      this.strips.delete(id);
    }
    this.stripOrder = order;
    const anySolo = false;
    p.mixer.forEach((t, i) => {
      const s = order[i];
      if (!s) return;
      s.setFx(t.fx, p.bpm);
      const k = (param: string) => this.automated.has(`mixer:${t.id}:${param}`);
      if (!k('volDb')) setSmooth(ctx, s.fader.gain, dbToGain(t.volDb));
      if (!k('pan')) setSmooth(ctx, s.pan.pan, t.pan);
      if (!k('width')) s.width.setWidth(t.width, !isOffline(ctx));
      setSmooth(ctx, s.mute.gain, t.mute || anySolo ? 0 : 1, 0.005);
      if (i === 0) s.connectTo(this.out, 'out');
      else {
        const r = this.routeOf(p, i);
        s.connectTo(order[r].input, order[r].id);
      }
    });
    // ---- plugin delay compensation: latency from each insert's input to the master output ----
    const pathLat = order.map((s, i) => {
      if (!s) return 0;
      let tot = 0;
      let cur = i;
      for (let guard = 0; guard < 256; guard++) {
        tot += order[cur]?.latency ?? 0;
        if (cur === 0) break;
        cur = this.routeOf(p, cur);
      }
      return tot;
    });
    this.pdcTotal = Math.max(0, ...pathLat);
    // ---- channels ----
    const liveCh = new Set<ID>();
    for (const c of p.channels) {
      liveCh.add(c.id);
      let cs = this.channels.get(c.id);
      if (!cs) {
        cs = new ChannelStrip(ctx, c.id);
        this.channels.set(c.id, cs);
      }
      const k = (param: string) => this.automated.has(`channel:${c.id}:${param}`);
      if (!k('vol')) setSmooth(ctx, cs.vol.gain, chanVolToGain(c.vol));
      if (!k('pan')) setSmooth(ctx, cs.pan.pan, c.pan);
      setSmooth(ctx, cs.mute.gain, c.mute ? 0 : 1, 0.005);
      if (c.type === 'sampler' && c.sampler) {
        if (!k('cutoff')) setSmooth(ctx, cs.filter.frequency, c.sampler.cutoff);
        setSmooth(ctx, cs.filter.Q, c.sampler.reso);
      } else {
        if (!k('cutoff')) setSmooth(ctx, cs.filter.frequency, 20000);
        cs.filter.Q.value = 0.7;
      }
      this.syncHost(c, cs, p.bpm);
      if (cs.host) {
        for (let i = 1; i <= 4; i++) {
          const key = 'macro' + i;
          if (k(key)) {
            cs.macroTouched.add(key);
            continue;
          }
          if (!cs.macroTouched.delete(key)) continue;
          const ap = cs.host.params.get(key);
          if (!ap) continue;
          // automation stopped or its clip was removed: hand the macro back to its knob
          ap.cancelScheduledValues(0);
          ap.setValueAtTime(-1, ctx.currentTime);
        }
      } else cs.macroTouched.clear();
      const destIdx = order[c.mixer] ? c.mixer : 0;
      const dest = order[destIdx] ?? this.master;
      if (cs.destId !== dest.id) {
        cs.pdc.disconnect();
        cs.pdc.connect(dest.input);
        cs.destId = dest.id;
      }
      const comp = Math.min(1.9, Math.max(0, this.pdcTotal - pathLat[destIdx]));
      if (Math.abs(comp - cs.pdcSec) > 1e-7) {
        cs.pdcSec = comp;
        cs.pdc.delayTime.value = comp;
      }
    }
    for (const [id, cs] of this.channels) if (!liveCh.has(id)) {
      cs.dispose();
      this.channels.delete(id);
    }
    this.hostBpm = p.bpm;
  }

  /** Insert index that mixer track `i` routes to (invalid / self routes fall back to the master). */
  private routeOf(p: Project, i: number) {
    let r = p.mixer[i]?.route ?? 0;
    if (r < 0 || r >= this.stripOrder.length || r === i || !this.stripOrder[r]) r = 0;
    return r;
  }

  private hostBpm = 0;
  private syncHost(c: Channel, cs: ChannelStrip, bpm: number) {
    const plug = c.type === 'plugin' ? getInstrument(c.plugin?.type) : undefined;
    if (!plug) {
      if (cs.host) {
        cs.host.dispose();
        cs.host = null;
        cs.hostType = '';
      }
      return;
    }
    if (!cs.host || cs.hostType !== plug.id) {
      cs.host?.dispose();
      try {
        cs.host = new WorkletInstrumentHost(this.ctx, plug.processor, c.plugin!.state, bpm);
        cs.host.output.connect(cs.input);
        cs.hostType = plug.id;
        cs.macroTouched.clear();
      } catch (e) {
        // worklet module not loaded yet — retried on the next sync
        cs.host = null;
        cs.hostType = '';
      }
      return;
    }
    cs.host.setState(c.plugin!.state);
    if (bpm !== this.hostBpm) cs.host.setTempo(bpm);
  }

  /** All live plugin hosts. */
  hosts(): InstrumentHost[] {
    const out: InstrumentHost[] = [];
    for (const cs of this.channels.values()) if (cs.host) out.push(cs.host);
    return out;
  }

  /** Resolve once every plugin processor has handled all queued messages (offline export). */
  syncHosts(): Promise<void> {
    return Promise.all(this.hosts().map((h) => h.sync())).then(() => undefined);
  }

  setMonitorVolume(v: number) {
    setSmooth(this.ctx, this.out.gain, chanVolToGain(v));
  }

  // ---------------- voices ----------------
  private velGain(vel: number) {
    return Math.pow(clamp(vel, 0, 1) / 0.78, 2);
  }

  private choke(group: number, when: number, except?: Voice) {
    if (!group) return;
    for (const v of this.voices) if (v !== except && v.cutGroup === group && v.start < when && v.end > when) v.kill(when);
  }

  /** Schedule a note. dur = seconds or null to hold until release(). */
  noteOn(ch: Channel, key: number, vel: number, pan: number, when: number, dur: number | null): Voice | null {
    const strip = this.channels.get(ch.id);
    if (!strip) return null;
    const pitch = (ch.pitch ?? 0) + (this.project?.masterPitch ?? 0);
    if (ch.type === 'synth' && ch.synth) return this.synthVoice(ch, strip, key, vel, pan, when, dur, pitch);
    if (ch.type === 'sampler' && ch.sampler) return this.samplerVoice(ch, strip, key, vel, pan, when, dur, pitch);
    if (ch.type === 'plugin' && strip.host) return this.pluginVoice(ch, strip.host, key, vel, pan, when, dur, pitch);
    return null;
  }

  private pluginVoice(ch: Channel, host: InstrumentHost, key: number, vel: number, pan: number, when: number, dur: number | null, pitch: number): Voice {
    const ctx = this.ctx;
    const t0 = Math.max(when, ctx.currentTime);
    const h = host.noteOn(key + pitch, vel, t0, dur, clamp(pan || 0, -1, 1));
    const voice: Voice = {
      channelId: ch.id,
      key,
      start: t0,
      end: dur === null ? Infinity : t0 + dur + 3,
      cutGroup: 0,
      plugin: true,
      release: (w: number) => {
        h.release(w);
        voice.end = Math.max(w, ctx.currentTime) + 3;
      },
      kill: (w: number) => {
        h.kill(w);
        voice.end = Math.max(w, ctx.currentTime) + 0.02;
      },
    };
    // prune finished plugin voices (they have no onended callback)
    const now = ctx.currentTime;
    for (const v of this.voices) if (v.plugin && v.end < now) this.voices.delete(v);
    this.voices.add(voice);
    return voice;
  }

  private register(v: Voice, endNode: AudioScheduledSourceNode, nodes: AudioNode[] = []) {
    this.voices.add(v);
    endNode.onended = () => {
      this.voices.delete(v);
      // release the voice's nodes so long sessions / exports don't accumulate idle graph
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {}
      }
    };
  }

  private samplerVoice(ch: Channel, strip: ChannelStrip, key: number, vel: number, pan: number, when: number, dur: number | null, pitch: number, audioClip?: { offset: number }): Voice | null {
    const sp = ch.sampler!;
    const buf = sp.reverse ? this.samples.getReversed(sp.sampleRef ?? '') : this.samples.get(sp.sampleRef);
    if (!buf) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = audioClip ? Math.pow(2, (ch.pitch ?? 0) / 12) : Math.pow(2, (key - sp.rootKey + pitch) / 12);
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    let last: AudioNode = g;
    const vnodes: AudioNode[] = [src, g];
    src.connect(g);
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      last = p;
      vnodes.push(p);
    }
    last.connect(strip.input);
    const peak = audioClip ? 1 : this.velGain(vel);
    const offset = audioClip ? audioClip.offset : sp.startOffset * buf.duration;
    const natural = (buf.duration - offset) / rate;
    const env = sp.envEnabled && !audioClip;
    const t0 = Math.max(when, ctx.currentTime);
    let end: number;
    if (env) {
      const { a, d, s, r } = sp.env;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + a);
      g.gain.setTargetAtTime(peak * s, t0 + a, Math.max(0.001, d / 3));
      if (dur !== null) {
        const off = t0 + Math.max(dur, 0.005);
        g.gain.cancelAndHoldAtTime(off);
        g.gain.setTargetAtTime(0, off, Math.max(0.002, r / 4));
        end = Math.min(t0 + natural, off + r * 1.5 + 0.02);
      } else end = Infinity;
    } else {
      g.gain.setValueAtTime(peak, t0);
      if (audioClip && dur !== null) {
        const off = t0 + dur;
        g.gain.setValueAtTime(peak, Math.max(t0, off - 0.006));
        g.gain.linearRampToValueAtTime(0, off);
        end = Math.min(t0 + natural, off + 0.002);
      } else end = t0 + natural;
    }
    try {
      src.start(t0, Math.min(offset, buf.duration - 0.001));
    } catch {
      return null;
    }
    if (isFinite(end)) src.stop(end + 0.01);
    const voice: Voice = {
      channelId: ch.id,
      key,
      start: t0,
      end,
      cutGroup: audioClip ? 0 : sp.cutGroup,
      release: (w: number) => {
        if (voice.end !== Infinity && voice.end <= w) return;
        const at = Math.max(w, ctx.currentTime);
        const r = env ? sp.env.r : 0.01;
        g.gain.cancelAndHoldAtTime(at);
        g.gain.setTargetAtTime(0, at, Math.max(0.002, r / 4));
        voice.end = at + r * 1.5 + 0.02;
        try {
          src.stop(voice.end);
        } catch {}
      },
      kill: (w: number) => {
        const at = Math.max(w, ctx.currentTime);
        g.gain.cancelAndHoldAtTime(at);
        g.gain.linearRampToValueAtTime(0, at + 0.006);
        voice.end = at + 0.008;
        try {
          src.stop(voice.end);
        } catch {}
      },
    };
    this.choke(voice.cutGroup, t0, voice);
    this.register(voice, src, vnodes);
    return voice;
  }

  playAudioClip(ch: Channel, when: number, offsetSec: number, durSec: number): Voice | null {
    const strip = this.channels.get(ch.id);
    if (!strip || !ch.sampler) return null;
    return this.samplerVoice(ch, strip, 60, 0.78, 0, when, durSec, 0, { offset: offsetSec });
  }

  private synthVoice(ch: Channel, strip: ChannelStrip, key: number, vel: number, pan: number, when: number, dur: number | null, pitch: number): Voice {
    const sp = ch.synth!;
    const ctx = this.ctx;
    const t0 = Math.max(when, ctx.currentTime);
    const amp = ctx.createGain();
    const filt = kBiquad(ctx);
    filt.type = sp.filterType;
    filt.frequency.value = sp.cutoff;
    filt.Q.value = sp.reso;
    filt.connect(amp);
    let last: AudioNode = amp;
    const vnodes: AudioNode[] = [filt, amp];
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      amp.connect(p);
      last = p;
      vnodes.push(p);
    }
    last.connect(strip.input);

    // mono / glide
    let fromKey: number | null = null;
    if (sp.mono) {
      const prev = this.monoLast.get(ch.id);
      if (prev?.voice && prev.voice.end > t0) {
        fromKey = prev.key;
        prev.voice.kill(t0);
      }
    }

    const sources: AudioScheduledSourceNode[] = [];
    const uni = Math.max(1, Math.min(6, Math.round(sp.unison)));
    const activeOsc = sp.osc.filter((o) => o.level > 0);
    const norm = 0.32 / Math.sqrt(Math.max(1, activeOsc.length)) / Math.sqrt(uni);
    for (const o of activeOsc) {
      for (let u = 0; u < uni; u++) {
        const spread = uni === 1 ? 0 : (u / (uni - 1)) * 2 - 1;
        const og = ctx.createGain();
        og.gain.value = o.level * norm;
        vnodes.push(og);
        let src: AudioScheduledSourceNode;
        if (o.wave === 'noise') {
          const n = ctx.createBufferSource();
          n.buffer = this.noise;
          n.loop = true;
          src = n;
          n.connect(og);
        } else {
          const osc = ctx.createOscillator();
          osc.type = o.wave as Exclude<Wave, 'noise'>;
          const target = midiToFreq(key + o.coarse + pitch);
          if (fromKey !== null && sp.glide > 0) {
            osc.frequency.setValueAtTime(midiToFreq(fromKey + o.coarse + pitch), t0);
            osc.frequency.exponentialRampToValueAtTime(target, t0 + sp.glide);
          } else osc.frequency.value = target;
          osc.detune.value = o.fine + spread * sp.detune;
          src = osc;
          osc.connect(og);
        }
        if (uni > 1) {
          const p = ctx.createStereoPanner();
          p.pan.value = spread * 0.6;
          vnodes.push(p);
          og.connect(p).connect(filt);
        } else og.connect(filt);
        sources.push(src);
      }
    }
    // amp envelope
    const peak = this.velGain(vel);
    const { a, d, s, r } = sp.env;
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(peak, t0 + Math.max(0.001, a));
    amp.gain.setTargetAtTime(peak * s, t0 + a, Math.max(0.001, d / 3));
    // filter envelope via detune (cents)
    const fe = sp.filterEnv;
    const amt = sp.filterEnvAmt * 7200;
    if (amt > 0) {
      filt.detune.setValueAtTime(0, t0);
      filt.detune.linearRampToValueAtTime(amt, t0 + Math.max(0.001, fe.a));
      filt.detune.setTargetAtTime(amt * fe.s, t0 + fe.a, Math.max(0.001, fe.d / 3));
    }
    let end = Infinity;
    const doRelease = (off: number) => {
      amp.gain.cancelAndHoldAtTime(off);
      amp.gain.setTargetAtTime(0, off, Math.max(0.002, r / 4));
      if (amt > 0) {
        filt.detune.cancelAndHoldAtTime(off);
        filt.detune.setTargetAtTime(0, off, Math.max(0.002, fe.r / 4));
      }
      return off + r * 1.6 + 0.03;
    };
    for (const src of sources) {
      if (src instanceof AudioBufferSourceNode) src.start(t0, Math.random() * 1.5);
      else src.start(t0);
    }
    if (dur !== null) {
      end = doRelease(t0 + Math.max(dur, 0.005));
      for (const src of sources) src.stop(end);
    }
    const voice: Voice = {
      channelId: ch.id,
      key,
      start: t0,
      end,
      cutGroup: 0,
      release: (w: number) => {
        if (voice.end !== Infinity && voice.end <= w) return;
        voice.end = doRelease(Math.max(w, ctx.currentTime));
        for (const src of sources) {
          try {
            src.stop(voice.end);
          } catch {}
        }
      },
      kill: (w: number) => {
        const at = Math.max(w, ctx.currentTime);
        amp.gain.cancelAndHoldAtTime(at);
        amp.gain.linearRampToValueAtTime(0, at + 0.008);
        voice.end = at + 0.01;
        for (const src of sources) {
          try {
            src.stop(voice.end);
          } catch {}
        }
      },
    };
    if (sp.mono) this.monoLast.set(ch.id, { key, voice });
    vnodes.push(...sources);
    if (sources.length) this.register(voice, sources[0], vnodes);
    return voice;
  }

  /** Stop every voice (scheduled or sounding). */
  stopAll(hard = false) {
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.plugin) continue;
      if (v.start > t) v.kill(t);
      else if (hard) v.kill(t);
      else v.release(t);
    }
    for (const h of this.hosts()) {
      h.cancelAfter(t);
      h.allOff(t, hard);
    }
    for (const v of this.voices) if (v.plugin) this.voices.delete(v);
    if (hard) this.voices.clear();
    this.monoLast.clear();
  }

  /** Cancel voices that were scheduled but haven't started yet (used on reposition/tempo change). */
  cancelFuture() {
    const t = this.ctx.currentTime;
    for (const v of this.voices) if (v.start > t + 0.001) {
      if (!v.plugin) v.kill(t);
      this.voices.delete(v);
    }
    for (const h of this.hosts()) h.cancelAfter(t + 0.001);
  }

  click(when: number, accent: boolean) {
    const ctx = this.ctx;
    when += this.pdcTotal; // in time with the (delay-compensated) music
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1180;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    o.connect(g).connect(this.out);
    o.start(when);
    o.stop(when + 0.06);
  }

  // ---------------- automation ----------------
  /** Resolve an automation target to {AudioParam, def} for scheduling. */
  resolveTarget(t: AutoTarget): { param: AudioParam; def: ParamDef; map: (real: number) => number } | null {
    const p = this.project;
    if (t.scope === 'channel') {
      const cs = this.channels.get(t.id);
      const def = CHANNEL_PARAMS[t.param];
      if (!cs || !def) return null;
      if (t.param === 'vol') return { param: cs.vol.gain, def, map: chanVolToGain };
      if (t.param === 'pan') return { param: cs.pan.pan, def, map: (v) => v };
      if (t.param === 'cutoff') return { param: cs.filter.frequency, def, map: (v) => v };
      const hp = cs.host?.params.get(t.param);
      if (hp) return { param: hp, def, map: (v) => v };
      return null;
    }
    if (t.scope === 'mixer' || t.scope === 'master') {
      const idx = p.mixer.findIndex((m) => m.id === t.id);
      const s = this.stripOrder[t.scope === 'master' ? 0 : idx];
      const def = MIXER_PARAMS[t.param];
      if (!s || !def) return null;
      if (t.param === 'volDb') return { param: s.fader.gain, def, map: dbToGain };
      if (t.param === 'pan') return { param: s.pan.pan, def, map: (v) => v };
      if (t.param === 'width') return { param: s.width.sideGain.gain, def, map: (v) => v };
      return null;
    }
    if (t.scope === 'fx') {
      for (const s of this.stripOrder) {
        for (const e of s.effects) {
          if (e.slot.id !== t.id) continue;
          const def = FX_DEFS[e.slot.type]?.params.find((d) => d.key === t.param);
          const ap = e.autoParam(t.param);
          if (!def || !ap) return null;
          return { param: ap.param, def, map: ap.map };
        }
      }
    }
    return null;
  }

  static targetKey(t: AutoTarget) {
    return `${t.scope === 'master' ? 'mixer' : t.scope}:${t.id}:${t.param}`;
  }

  /** Map normalized automation value to real param value */
  static denorm(def: ParamDef, v: number) {
    return fromNorm(def, v);
  }

  dispose() {
    this.stopAll(true);
    for (const s of this.strips.values()) s.dispose();
    this.master.dispose();
    for (const c of this.channels.values()) c.dispose();
  }
}
