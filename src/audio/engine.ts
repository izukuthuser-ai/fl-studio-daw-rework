// Live engine: AudioContext, look-ahead scheduler, transport, live input & recording.
import { store } from '../core/store';
import { Channel, ID, Note, STEP } from '../core/types';
import { barLen, uid } from '../core/util';
import { patternLen, secPerTick, songLen } from '../core/timing';
import { AudioGraph, Voice } from './graph';
import { samples } from './samples';
import { automatedTargets, scheduleSpan, startMidClips } from './sequencer';
import { Emitter } from '../core/util';

const LOOKAHEAD = 0.12;
const INTERVAL = 25;

interface Held {
  voice: Voice | null;
  channelId: ID;
  key: number;
  vel: number;
  recStart: number | null; // pattern tick
  recTime: number;
}

type EngineEvents = { state: null; recorded: null };

export class Engine extends Emitter<EngineEvents> {
  ctx!: AudioContext;
  graph!: AudioGraph;
  ready = false;
  playing = false;
  paused = false;
  waitingForInput = false;
  mode: 'pattern' | 'song' = 'pattern';
  songStart = 0; // song position marker (ticks)
  patStart = 0; // pattern-mode start position (ticks)
  stepPos = 0; // step-edit cursor
  private pausePos = 0;
  private anchors: { time: number; pos: number }[] = [];
  private nextTime = 0;
  private nextPos = 0;
  private timer: any = null;
  private autoInit = new Set<string>();
  private held = new Map<string, Held>();
  private takeStarted = false;
  private meterBuf = new Float32Array(512);
  peakHold: number[][] = [];

  init() {
    if (this.ready) return;
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    samples.decodeCtx = this.ctx;
    samples.sampleRate = this.ctx.sampleRate;
    this.graph = new AudioGraph(this.ctx, samples, true);
    this.graph.sync(store.project);
    this.graph.setMonitorVolume(store.ui.masterVol);
    this.ready = true;
    store.on('project', (label) => {
      this.graph.sync(store.project);
      if (label === 'tempo' && this.playing) this.reposition(this.position);
    });
    store.on('loaded', () => {
      this.stop();
      this.graph.sync(store.project);
    });
    store.on('ui', (keys) => {
      if (keys.includes('masterVol')) this.graph.setMonitorVolume(store.ui.masterVol);
      if (keys.includes('songMode') && this.playing) {
        this.stop();
        this.play();
      }
    });
    const resume = () => {
      if (this.ctx.state !== 'running') this.ctx.resume();
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  get spt() {
    return secPerTick(store.project.bpm);
  }

  private range(): { start: number; end: number } {
    if (this.mode === 'pattern') return { start: 0, end: patternLen(store.currentPattern, store.project.timeSig) };
    const loop = store.ui.loop;
    if (loop && loop.end > loop.start) return { start: loop.start, end: loop.end };
    return { start: 0, end: songLen(store.project) };
  }

  /** Current playback position in ticks. */
  get position(): number {
    if (!this.ready) return 0;
    if (!this.playing) return this.paused ? this.pausePos : store.ui.songMode ? this.songStart : this.patStart % patternLen(store.currentPattern, store.project.timeSig);
    const now = this.ctx.currentTime;
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.time <= now) a = x;
    if (!a) return 0;
    const pos = a.pos + Math.max(0, now - a.time) / this.spt;
    const r = this.range();
    return Math.min(pos, r.end);
  }

  /** Seconds since song start for the time display. */
  get seconds(): number {
    return this.position * this.spt;
  }

  togglePlay() {
    if (this.playing || this.waitingForInput) this.stop();
    else this.play();
  }

  togglePause() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.ready) this.init();
    if (this.ctx.state !== 'running') this.ctx.resume();
    const ui = store.ui;
    if (ui.recording && ui.waitInput && !this.waitingForInput) {
      this.waitingForInput = true;
      this.emit('state', null);
      return;
    }
    this.waitingForInput = false;
    this.mode = ui.songMode ? 'song' : 'pattern';
    const r = this.range();
    let pos = this.paused ? this.pausePos : this.mode === 'song' ? this.songStart : this.patStart;
    if (this.mode === 'pattern' && r.end > 0) pos = pos % r.end;
    if (pos < r.start || pos >= r.end) pos = r.start;
    let time0 = this.ctx.currentTime + 0.06;
    if (ui.recording && ui.precount) {
      const bl = barLen(store.project.timeSig);
      for (let b = 0; b < bl; b += 96) this.graph.click(time0 + b * this.spt, b === 0);
      time0 += bl * this.spt;
    }
    this.graph.automated = this.mode === 'song' ? automatedTargets(store.project) : new Set();
    this.graph.sync(store.project);
    this.anchors = [{ time: time0, pos }];
    this.nextTime = time0;
    this.nextPos = pos;
    this.autoInit.clear();
    this.takeStarted = false;
    if (this.mode === 'song') startMidClips(this.graph, store.project, pos, time0, this.spt);
    this.playing = true;
    this.paused = false;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), INTERVAL);
    this.pump();
    this.emit('state', null);
  }

  stop() {
    const was = this.playing || this.paused || this.waitingForInput;
    clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.paused = false;
    this.waitingForInput = false;
    if (this.ready) {
      this.graph.stopAll();
      this.graph.automated.clear();
      this.graph.sync(store.project);
    }
    this.finishHeldRecording();
    if (was) this.emit('state', null);
  }

  pause() {
    if (!this.playing) return;
    this.pausePos = this.position;
    clearInterval(this.timer);
    this.playing = false;
    this.paused = true;
    this.graph.stopAll();
    this.emit('state', null);
  }

  /** Move the song position marker (and the playhead if playing). */
  setPosition(tick: number) {
    tick = Math.max(0, Math.round(tick));
    if (store.ui.songMode) this.songStart = tick;
    else this.patStart = tick;
    this.stepPos = tick;
    if (this.paused) this.pausePos = tick;
    if (this.playing) {
      if (this.mode === 'pattern') tick = tick % this.range().end;
      this.reposition(tick);
    }
    this.emit('state', null);
  }

  private reposition(pos: number) {
    this.graph.cancelFuture();
    const t = this.ctx.currentTime + 0.03;
    this.anchors = [{ time: t, pos }];
    this.nextTime = t;
    this.nextPos = pos;
    this.autoInit.clear();
    if (this.mode === 'song') startMidClips(this.graph, store.project, pos, t, this.spt);
  }

  private pump() {
    if (!this.playing) return;
    const ahead = this.ctx.currentTime + LOOKAHEAD;
    const p = store.project;
    let guard = 0;
    while (this.nextTime < ahead && guard++ < 256) {
      const r = this.range();
      if (this.nextPos >= r.end || this.nextPos < r.start) {
        this.nextPos = r.start;
        this.anchors.push({ time: this.nextTime, pos: r.start });
        this.autoInit.clear();
      }
      const chunkEnd = Math.min(r.end, (Math.floor(this.nextPos / STEP) + 1) * STEP);
      scheduleSpan(this.graph, p, {
        mode: this.mode,
        patternId: store.ui.currentPattern,
        from: this.nextPos,
        to: chunkEnd,
        time0: this.nextTime,
        spt: this.spt,
        metronome: store.ui.metronome,
        autoInit: this.autoInit,
      });
      this.nextTime += (chunkEnd - this.nextPos) * this.spt;
      this.nextPos = chunkEnd;
      if (this.nextPos >= r.end) {
        this.nextPos = r.start;
        this.anchors.push({ time: this.nextTime, pos: r.start });
        this.autoInit.clear();
      }
    }
    // trim anchors
    const now = this.ctx.currentTime;
    while (this.anchors.length > 2 && this.anchors[1].time <= now) this.anchors.shift();
  }

  /** Notes currently held from the typing keyboard / MIDI / on-screen keys. */
  heldKeys(): { channelId: ID; key: number }[] {
    return [...this.held.values()].map((h) => ({ channelId: h.channelId, key: h.key }));
  }

  panic() {
    if (!this.ready) return;
    this.graph.stopAll(true);
    this.held.clear();
  }

  // ---------------- live input ----------------
  private targetChannel(channelId?: ID): Channel | undefined {
    return store.channel(channelId) ?? store.selectedChannel;
  }

  noteOn(key: number, vel = 0.78, channelId?: ID, holdId?: string) {
    if (!this.ready) this.init();
    if (this.ctx.state !== 'running') this.ctx.resume();
    const ch = this.targetChannel(channelId);
    if (!ch) return;
    const id = holdId ?? `${ch.id}:${key}`;
    if (this.held.has(id)) return;
    if (this.waitingForInput) {
      this.waitingForInput = false;
      this.play();
    }
    const voice = this.graph.noteOn(ch, key, vel, 0, this.ctx.currentTime, null);
    const ui = store.ui;
    let recStart: number | null = null;
    if (ui.recording && this.playing) {
      const len = patternLen(store.currentPattern, store.project.timeSig);
      recStart = Math.round(this.position) % len;
    } else if (ui.stepEdit && !this.playing) {
      this.stepInsert(ch.id, key, vel);
    }
    this.held.set(id, { voice, channelId: ch.id, key, vel, recStart, recTime: this.ctx.currentTime });
  }

  noteOff(key: number, channelId?: ID, holdId?: string) {
    const ch = this.targetChannel(channelId);
    if (!ch) return;
    const id = holdId ?? `${ch.id}:${key}`;
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    h.voice?.release(this.ctx.currentTime);
    if (h.recStart !== null) this.commitRecorded(h);
  }

  private finishHeldRecording() {
    for (const [id, h] of this.held) {
      if (h.recStart !== null) {
        this.commitRecorded(h);
        h.recStart = null;
      }
      this.held.set(id, h);
    }
  }

  private commitRecorded(h: Held) {
    if (h.recStart === null || !this.ready) return;
    const lenTicks = Math.max(6, Math.round((this.ctx.currentTime - h.recTime) / this.spt));
    const pat = store.currentPattern;
    const start = h.recStart;
    const blend = store.ui.blend;
    store.commit('Record notes', (p) => {
      const pt = p.patterns.find((x) => x.id === pat.id);
      if (!pt) return;
      const arr = (pt.notes[h.channelId] ??= []);
      if (!blend && !this.takeStarted) {
        // overwrite mode: remove overlapping notes on the same key region
        for (let i = arr.length - 1; i >= 0; i--) {
          const n = arr[i];
          if (n.start >= start && n.start < start + lenTicks) arr.splice(i, 1);
        }
      }
      arr.push({ id: uid('n'), key: h.key, start, len: lenTicks, vel: h.vel, pan: 0 });
    });
    this.emit('recorded', null);
  }

  private stepInsert(channelId: ID, key: number, vel: number) {
    const pat = store.currentPattern;
    const pos = this.stepPos;
    store.commit('Step edit', (p) => {
      const pt = p.patterns.find((x) => x.id === pat.id);
      if (!pt) return;
      const n: Note = { id: uid('n'), key, start: pos, len: STEP, vel, pan: 0 };
      (pt.notes[channelId] ??= []).push(n);
    });
    this.stepPos = pos + STEP;
    this.emit('state', null);
  }

  /** Audition a single note for a fixed duration (piano keys, note draw). */
  preview(channelId: ID, key: number, vel = 0.78, dur = 0.25) {
    if (!this.ready) this.init();
    if (this.ctx.state !== 'running') this.ctx.resume();
    const ch = store.channel(channelId);
    if (!ch) return;
    this.graph.noteOn(ch, key, vel, 0, this.ctx.currentTime, dur);
  }

  private previewSrc: AudioBufferSourceNode | null = null;
  async previewSample(ref: string) {
    if (!this.ready) this.init();
    if (this.ctx.state !== 'running') this.ctx.resume();
    this.stopPreview();
    const b = await samples.ensure(ref);
    if (!b) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    const g = this.ctx.createGain();
    g.gain.value = 0.8;
    src.connect(g).connect(this.graph.master.input);
    src.start();
    this.previewSrc = src;
  }
  stopPreview() {
    try {
      this.previewSrc?.stop();
    } catch {}
    this.previewSrc = null;
  }

  /** Peak levels per mixer strip, [L, R] in linear gain. */
  private meterCache: number[][] = [];
  private meterStamp = -1;
  readMeters(): number[][] {
    if (!this.ready) return [];
    const now = performance.now();
    if (now - this.meterStamp < 8) return this.meterCache;
    this.meterStamp = now;
    const out: number[][] = [];
    for (const s of this.graph.stripOrder) {
      const lr: number[] = [];
      for (const a of s.analysers) {
        a.getFloatTimeDomainData(this.meterBuf);
        let m = 0;
        for (let i = 0; i < this.meterBuf.length; i++) {
          const v = Math.abs(this.meterBuf[i]);
          if (v > m) m = v;
        }
        lr.push(m);
      }
      out.push(lr.length ? lr : [0, 0]);
    }
    this.meterCache = out;
    return out;
  }

  get voiceCount() {
    return this.ready ? this.graph.voices.size : 0;
  }
}

export const engine = new Engine();
