// Generic main-thread host for an instrument AudioWorkletProcessor built on worklets/kit.ts.
import type { InstrumentHost, InstrumentVoiceHandle } from './api';
import type { HostMsg, ProcMsg } from '../worklets/protocol';

let nextVoiceId = 1;

export class WorkletInstrumentHost implements InstrumentHost {
  readonly node: AudioWorkletNode;
  readonly output: AudioNode;
  readonly params = new Map<string, AudioParam>();
  private listeners = new Set<(m: ProcMsg) => void>();
  private syncN = 0;
  private waiters = new Map<number, () => void>();
  private lastState = '';

  constructor(private ctx: BaseAudioContext, processor: string, state: any, bpm: number) {
    this.lastState = JSON.stringify(state ?? null);
    this.node = new AudioWorkletNode(ctx, processor, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { state, bpm },
    });
    this.output = this.node;
    (this.node.parameters as any).forEach((p: AudioParam, name: string) => this.params.set(name, p));
    this.node.port.onmessage = (e: MessageEvent<ProcMsg>) => {
      const m = e.data;
      if (m.t === 'synced') {
        const w = this.waiters.get(m.n);
        if (w) {
          this.waiters.delete(m.n);
          w();
        }
        return;
      }
      for (const l of this.listeners) l(m);
    };
  }

  private send(m: HostMsg) {
    this.node.port.postMessage(m);
  }

  noteOn(key: number, vel: number, when: number, dur: number | null, pan = 0): InstrumentVoiceHandle {
    const id = nextVoiceId++;
    this.send(dur === null ? { t: 'on', id, key, vel, time: when, pan } : { t: 'on', id, key, vel, time: when, dur, pan });
    return {
      release: (w: number) => this.send({ t: 'off', id, time: Math.max(w, this.ctx.currentTime) }),
      kill: (w: number) => this.send({ t: 'kill', id, time: Math.max(w, this.ctx.currentTime) }),
    };
  }

  setState(state: any) {
    const s = JSON.stringify(state ?? null);
    if (s === this.lastState) return;
    this.lastState = s;
    this.send({ t: 'state', state });
  }

  setTempo(bpm: number) {
    this.send({ t: 'tempo', bpm });
  }

  allOff(when: number, hard = false) {
    this.send({ t: 'alloff', time: when, hard });
  }

  cancelAfter(time: number) {
    this.send({ t: 'cancel', after: time });
  }

  sync(): Promise<void> {
    const n = ++this.syncN;
    return new Promise((res) => {
      this.waiters.set(n, res);
      this.send({ t: 'sync', n });
      // never hang an export if a processor misbehaves
      setTimeout(() => {
        if (this.waiters.delete(n)) res();
      }, 2000);
    });
  }

  onMessage(fn: (m: ProcMsg) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setViz(on: boolean) {
    this.send({ t: 'viz', on });
  }

  dispose() {
    try {
      this.send({ t: 'alloff', time: 0, hard: true });
      this.node.disconnect();
      this.node.port.close();
    } catch {}
    this.listeners.clear();
  }
}
