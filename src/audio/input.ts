// Live audio input on mixer tracks (guitar, mic…) and recording armed inputs into audio clips.
import type { Project } from '../core/types';
import type { AudioGraph } from './graph';
import { encodeWav } from './render';
import { samples } from './samples';

export interface InputOption {
  value: string;
  label: string;
}

export interface RecordedTake {
  track: number; // mixer track index
  ref: string; // embedded sample ref
  name: string;
  startTick: number;
  seconds: number;
}

interface Link {
  dev: string;
  strip: AudioNode;
  gain: GainNode;
}

export class AudioInputManager {
  devices: InputOption[] = [];
  error: string | null = null;
  private streams = new Map<string, { stream: MediaStream; src: MediaStreamAudioSourceNode; latency: number }>();
  private opening = new Map<string, Promise<MediaStreamAudioSourceNode | null>>();
  private links = new Map<string, Link>(); // by mixer track id
  private takes: { track: number; trackId: string; node: AudioWorkletNode; l: Float32Array[]; r: Float32Array[]; startedAt: number; done: Promise<void> }[] = [];
  private recStartTick = 0;
  private listeners = new Set<() => void>();

  constructor(private ctx: AudioContext, private graph: AudioGraph) {
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.refresh());
    this.refresh();
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private lastSig = '';
  private changed() {
    const sig = JSON.stringify([this.devices, this.error, [...this.links.entries()].map(([k, l]) => [k, l.dev])]);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    for (const f of this.listeners) f();
  }

  async refresh() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      this.devices = list
        .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ value: d.deviceId, label: d.label || `Input ${i + 1}` }));
      this.changed();
    } catch {}
  }

  /** Choices for a mixer track's input selector. */
  options(): InputOption[] {
    return [{ value: '', label: '(none)' }, { value: 'default', label: 'Default input' }, ...this.devices];
  }

  private open(dev: string): Promise<MediaStreamAudioSourceNode | null> {
    const have = this.streams.get(dev);
    if (have) return Promise.resolve(have.src);
    let p = this.opening.get(dev);
    if (p) return p;
    p = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: dev === 'default' ? undefined : { exact: dev },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: { ideal: 2 },
            latency: { ideal: 0.003 },
          } as MediaTrackConstraints,
        });
        const src = this.ctx.createMediaStreamSource(stream);
        const latency = (stream.getAudioTracks()[0]?.getSettings() as any)?.latency ?? 0;
        this.streams.set(dev, { stream, src, latency: typeof latency === 'number' ? latency : 0 });
        this.error = null;
        this.refresh(); // labels become available after permission
        return src;
      } catch (e: any) {
        const name = e?.name ?? '';
        this.error =
          name === 'NotAllowedError'
            ? 'Microphone/line-in permission was denied'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'Audio input device not found (unplugged?)'
              : name === 'NotReadableError'
                ? 'Audio input is busy (used by another app?)'
                : `Could not open audio input${name ? ` (${name})` : ''}${e?.message ? ': ' + e.message : ''}`;
        this.changed();
        return null;
      } finally {
        this.opening.delete(dev);
      }
    })();
    this.opening.set(dev, p);
    return p;
  }

  /** Connect/disconnect inputs to mixer tracks to match the project. */
  async sync(p: Project) {
    const want = new Map<string, { dev: string; strip: AudioNode }>();
    p.mixer.forEach((m, i) => {
      const s = this.graph.stripOrder[i];
      if (m.input && s) want.set(m.id, { dev: m.input, strip: s.input });
    });
    for (const [id, l] of this.links) {
      const w = want.get(id);
      if (!w || w.dev !== l.dev || w.strip !== l.strip) {
        try {
          l.gain.disconnect();
        } catch {}
        this.links.delete(id);
      }
    }
    for (const [id, w] of want) {
      if (this.links.has(id)) continue;
      const src = await this.open(w.dev);
      if (!src || this.links.has(id)) continue;
      const gain = this.ctx.createGain();
      src.connect(gain);
      gain.connect(w.strip);
      this.links.set(id, { dev: w.dev, strip: w.strip, gain });
    }
    // close devices nobody uses
    const used = new Set([...this.links.values()].map((l) => l.dev));
    for (const [dev, s] of this.streams) {
      if (used.has(dev)) continue;
      s.stream.getTracks().forEach((t) => t.stop());
      try {
        s.src.disconnect();
      } catch {}
      this.streams.delete(dev);
    }
    this.changed();
  }

  /** Analyser-friendly node carrying a track's raw input (for tuners / meters). */
  inputNode(trackId: string): AudioNode | null {
    return this.links.get(trackId)?.gain ?? null;
  }

  isLive(trackId: string) {
    return this.links.has(trackId);
  }

  get recording() {
    return this.takes.length > 0;
  }

  /** Start recording every armed track that has a live input, from audio time `at`. */
  startRecording(p: Project, at: number, songTick: number): number {
    if (this.takes.length) return 0;
    this.recStartTick = songTick;
    p.mixer.forEach((m, i) => {
      const link = this.links.get(m.id);
      if (!m.armed || !link) return;
      let node: AudioWorkletNode;
      try {
        node = new AudioWorkletNode(this.ctx, 'lf-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      } catch {
        return;
      }
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      link.gain.connect(node);
      node.connect(sink).connect(this.ctx.destination);
      const take = { track: i, trackId: m.id, node, l: [] as Float32Array[], r: [] as Float32Array[], startedAt: at, done: Promise.resolve() };
      take.done = new Promise<void>((res) => {
        node.port.onmessage = (e: MessageEvent) => {
          const d = e.data;
          if (d.t === 'chunk') {
            take.l.push(d.l);
            take.r.push(d.r);
          } else if (d.t === 'started') take.startedAt = d.at;
          else if (d.t === 'done') res();
        };
      });
      node.port.postMessage({ t: 'start', at });
      this.takes.push(take);
    });
    return this.takes.length;
  }

  /** Stop recording; resolves with one take per recorded track. */
  async stopRecording(): Promise<RecordedTake[]> {
    if (!this.takes.length) return [];
    const takes = this.takes;
    this.takes = [];
    const at = this.ctx.currentTime;
    for (const t of takes) t.node.port.postMessage({ t: 'stop', at });
    await Promise.all(takes.map((t) => Promise.race([t.done, new Promise<void>((r) => setTimeout(r, 1500))])));
    const out: RecordedTake[] = [];
    const sr = this.ctx.sampleRate;
    for (const t of takes) {
      try {
        t.node.disconnect();
      } catch {}
      const len = t.l.reduce((a, c) => a + c.length, 0);
      // latency compensation: what you played lines up with what you heard
      const dev = this.links.get(t.trackId)?.dev;
      const inLat = dev ? this.streams.get(dev)?.latency ?? 0 : 0;
      // + plugin delay compensation: the backing track you played along to reached the speakers that much later
      const lat = (this.ctx.baseLatency ?? 0) + ((this.ctx as any).outputLatency ?? 0) + inLat + this.graph.pdcTotal;
      const skip = Math.min(len, Math.round(lat * sr));
      const n = len - skip;
      if (n < sr * 0.05) continue;
      const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      let o = -skip;
      t.l.forEach((chunk, ci) => {
        const rc = t.r[ci];
        for (let i = 0; i < chunk.length; i++, o++) {
          if (o < 0) continue;
          L[o] = chunk[i];
          R[o] = rc[i];
        }
      });
      const name = `Audio ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      const ref = await samples.addBytes(name + '.wav', encodeWav(buf, 24));
      if (ref) out.push({ track: t.track, ref, name, startTick: this.recStartTick, seconds: buf.duration });
    }
    return out;
  }

  dispose() {
    for (const s of this.streams.values()) s.stream.getTracks().forEach((t) => t.stop());
    this.streams.clear();
    this.links.clear();
  }
}
