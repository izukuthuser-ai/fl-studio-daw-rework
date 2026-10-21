// Shared helpers for instrument AudioWorkletProcessors (imported only from *.worklet.ts files).
// Handles the message protocol, sample-accurate event scheduling, voice ids and sync replies,
// so a processor only implements voice DSP.
import type { HostMsg } from './protocol';

// AudioWorkletGlobalScope globals are declared in ./worklet-env.d.ts

export type NoteEvent =
  | { kind: 'on'; id: number; key: number; vel: number; time: number }
  | { kind: 'off'; id: number; time: number }
  | { kind: 'kill'; id: number; time: number }
  | { kind: 'alloff'; time: number; hard: boolean };

export interface MacroParams {
  macro1: Float32Array;
  macro2: Float32Array;
  macro3: Float32Array;
  macro4: Float32Array;
}

export const MACRO_DESCRIPTORS = [1, 2, 3, 4].map((i) => ({ name: 'macro' + i, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }));

/**
 * Base class for instrument processors.
 * Subclasses implement: onState(state), noteOn(id,key,vel), noteOff(id), kill(id), allOff(hard),
 * and render(out: Float32Array[], from: number, to: number, macros: number[]).
 */
export abstract class InstrumentProcessor extends AudioWorkletProcessor {
  protected bpm = 120;
  protected state: any = null;
  private queue: NoteEvent[] = [];
  private vizOn = false;
  private vizCountdown = 0;

  static get parameterDescriptors() {
    return MACRO_DESCRIPTORS;
  }

  constructor(options?: any) {
    super(options);
    const init = options?.processorOptions;
    if (init?.state) this.state = init.state;
    if (init?.bpm) this.bpm = init.bpm;
    this.port.onmessage = (e: MessageEvent<HostMsg>) => this.handle(e.data);
    // subclass fields aren't initialised yet inside this constructor: apply the initial state on the first block
    this.initPending = !!this.state;
  }
  private initPending = false;

  private handle(m: HostMsg) {
    if (this.initPending && this.state) {
      this.initPending = false;
      this.onState(this.state);
    }
    switch (m.t) {
      case 'state':
        this.state = m.state;
        this.onState(m.state);
        break;
      case 'on':
        this.push({ kind: 'on', id: m.id, key: m.key, vel: m.vel, time: m.time });
        if (m.dur !== undefined) this.push({ kind: 'off', id: m.id, time: m.time + Math.max(0.001, m.dur) });
        break;
      case 'off':
        this.push({ kind: 'off', id: m.id, time: m.time });
        break;
      case 'kill':
        this.push({ kind: 'kill', id: m.id, time: m.time });
        break;
      case 'alloff':
        // drop pending note-ons; apply the all-off at its time
        this.queue = this.queue.filter((e) => e.kind !== 'on' || e.time < m.time);
        this.push({ kind: 'alloff', time: m.time, hard: !!m.hard });
        break;
      case 'cancel': {
        const cancelled = new Set<number>();
        this.queue = this.queue.filter((e) => {
          if (e.time > m.after && e.kind === 'on') {
            cancelled.add(e.id);
            return false;
          }
          return !(e.time > m.after && (e.kind === 'off' || e.kind === 'kill') && cancelled.has(e.id));
        });
        break;
      }
      case 'tempo':
        this.bpm = m.bpm;
        this.onTempo(m.bpm);
        break;
      case 'sync':
        this.port.postMessage({ t: 'synced', n: m.n });
        break;
      case 'viz':
        this.vizOn = m.on;
        break;
    }
  }

  private push(e: NoteEvent) {
    // keep sorted by time (stable): most events arrive in order, so insert from the end
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].time > e.time) i--;
    this.queue.splice(i, 0, e);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    if (this.initPending) {
      this.initPending = false;
      this.onState(this.state);
    }
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    for (const ch of out) ch.fill(0);
    const macros = [params.macro1?.[0] ?? 0, params.macro2?.[0] ?? 0, params.macro3?.[0] ?? 0, params.macro4?.[0] ?? 0];
    const t0 = currentTime;
    const spf = 1 / sampleRate;
    let pos = 0;
    while (this.queue.length) {
      const e = this.queue[0];
      const frame = Math.floor((e.time - t0) / spf + 1e-6);
      if (frame >= n) break;
      const at = Math.max(pos, Math.min(n, frame));
      if (at > pos) {
        this.render(out, pos, at, macros);
        pos = at;
      }
      this.queue.shift();
      this.apply(e);
    }
    if (pos < n) this.render(out, pos, n, macros);
    if (this.vizOn && --this.vizCountdown <= 0) {
      this.vizCountdown = Math.max(1, Math.round(sampleRate / n / 30));
      const d = this.vizData();
      if (d !== undefined) this.port.postMessage({ t: 'viz', data: d });
    }
    return true;
  }

  private apply(e: NoteEvent) {
    if (e.kind === 'on') this.noteOn(e.id, e.key, e.vel);
    else if (e.kind === 'off') this.noteOff(e.id);
    else if (e.kind === 'kill') this.kill(e.id);
    else this.allOff(e.hard);
  }

  protected onTempo(_bpm: number) {}
  /** Return a small object to post to the UI (~30 Hz) while visualisation is on; undefined = nothing. */
  protected vizData(): any {
    return undefined;
  }
  protected abstract onState(state: any): void;
  protected abstract noteOn(id: number, key: number, vel: number): void;
  protected abstract noteOff(id: number): void;
  protected abstract kill(id: number): void;
  protected abstract allOff(hard: boolean): void;
  /** Add (+=) audio into out[0]/out[1] for frames [from, to). */
  protected abstract render(out: Float32Array[], from: number, to: number, macros: number[]): void;
}

// ---------------- small DSP helpers ----------------
export const TWO_PI = Math.PI * 2;
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const dbToGain = (db: number) => Math.pow(10, db / 20);

/** One-pole parameter smoother. */
export class Smoother {
  v: number;
  constructor(v = 0, private coef = 0.999) {
    this.v = v;
  }
  setTime(sec: number) {
    this.coef = Math.exp(-1 / Math.max(1, sec * sampleRate));
  }
  next(target: number) {
    this.v = target + (this.v - target) * this.coef;
    return this.v;
  }
}

/** Fast deterministic PRNG (xorshift32). */
export class Rng {
  constructor(private s = 0x9e3779b9) {}
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  bi() {
    return this.next() * 2 - 1;
  }
}
