// Sample bank: generates built-in sounds, loads user audio files, caches decoded buffers and waveform peaks.
import { BUILTIN_BY_ID } from './sounds';
import { native, basename } from '../core/native';
import { Emitter, uid } from '../core/util';

export interface EmbeddedSample {
  name: string;
  data: Uint8Array;
}

function toB64(u8: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export class SampleBank extends Emitter<{ loaded: string }> {
  private buffers = new Map<string, AudioBuffer>();
  private reversed = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  private peakCache = new Map<string, Float32Array>();
  private failed = new Set<string>();
  embedded = new Map<string, EmbeddedSample>();
  sampleRate = 48000;
  decodeCtx: BaseAudioContext | null = null;

  /** Synchronous access. Built-ins are generated on demand; files must be ensure()'d first. */
  get(ref: string | null | undefined): AudioBuffer | undefined {
    if (!ref) return undefined;
    const b = this.buffers.get(ref);
    if (b) return b;
    if (ref.startsWith('builtin:')) return this.genBuiltin(ref);
    if (!this.pending.has(ref) && !this.failed.has(ref)) this.ensure(ref);
    return undefined;
  }

  getReversed(ref: string): AudioBuffer | undefined {
    const r = this.reversed.get(ref);
    if (r) return r;
    const b = this.get(ref);
    if (!b) return undefined;
    const out = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
    }
    this.reversed.set(ref, out);
    return out;
  }

  private genBuiltin(ref: string): AudioBuffer | undefined {
    const s = BUILTIN_BY_ID.get(ref.slice(8));
    if (!s) return undefined;
    const chs = s.gen(this.sampleRate);
    const b = new AudioBuffer({ length: chs[0].length, numberOfChannels: chs.length, sampleRate: this.sampleRate });
    chs.forEach((d, i) => b.copyToChannel(d as Float32Array<ArrayBuffer>, i));
    this.buffers.set(ref, b);
    return b;
  }

  async ensure(ref: string | null | undefined): Promise<AudioBuffer | null> {
    if (!ref) return null;
    const have = this.buffers.get(ref) ?? (ref.startsWith('builtin:') ? this.genBuiltin(ref) : undefined);
    if (have) return have;
    const p = this.pending.get(ref);
    if (p) return p;
    const job = (async () => {
      let bytes: Uint8Array | null = null;
      if (ref.startsWith('embed:')) bytes = this.embedded.get(ref)?.data ?? null;
      else if (ref.startsWith('file:')) bytes = await native.readFile(ref.slice(5));
      if (!bytes) {
        this.failed.add(ref);
        return null;
      }
      try {
        const ctx = this.decodeCtx ?? new OfflineAudioContext(2, 1, this.sampleRate);
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const buf = await ctx.decodeAudioData(ab);
        this.buffers.set(ref, buf);
        this.emit('loaded', ref);
        return buf;
      } catch (e) {
        console.warn('decode failed', ref, e);
        this.failed.add(ref);
        return null;
      } finally {
        this.pending.delete(ref);
      }
    })();
    this.pending.set(ref, job);
    return job;
  }

  isMissing(ref: string | null | undefined) {
    return !!ref && this.failed.has(ref);
  }

  /** Register raw audio bytes (e.g. dropped in a browser) and return an embed: ref. */
  async addBytes(name: string, data: Uint8Array): Promise<string | null> {
    const ref = 'embed:' + uid('s');
    this.embedded.set(ref, { name, data });
    const b = await this.ensure(ref);
    if (!b) {
      this.embedded.delete(ref);
      return null;
    }
    return ref;
  }

  displayName(ref: string | null): string {
    if (!ref) return '(empty)';
    if (ref.startsWith('builtin:')) return BUILTIN_BY_ID.get(ref.slice(8))?.name ?? ref;
    if (ref.startsWith('embed:')) return this.embedded.get(ref)?.name ?? 'Embedded';
    return basename(ref.slice(5)).replace(/\.[^.]+$/, '');
  }

  /** Min/max peaks for waveform drawing. Returns 2*buckets floats (min,max pairs). */
  peaks(ref: string, buckets = 512): Float32Array | null {
    const key = ref + '|' + buckets;
    const c = this.peakCache.get(key);
    if (c) return c;
    const b = this.get(ref);
    if (!b) return null;
    const out = new Float32Array(buckets * 2);
    const d0 = b.getChannelData(0);
    const d1 = b.numberOfChannels > 1 ? b.getChannelData(1) : d0;
    const per = b.length / buckets;
    for (let i = 0; i < buckets; i++) {
      let mn = 0, mx = 0;
      const s = Math.floor(i * per), e = Math.min(b.length, Math.floor((i + 1) * per));
      for (let j = s; j < e; j++) {
        const v = (d0[j] + d1[j]) * 0.5;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      out[i * 2] = mn;
      out[i * 2 + 1] = mx;
    }
    this.peakCache.set(key, out);
    return out;
  }

  /** Serialize referenced embedded samples (and optionally file samples) for saving. */
  async exportEmbedded(refs: string[], embedFiles: boolean): Promise<{ map: Record<string, { name: string; data: string }>; rename: Record<string, string> }> {
    const map: Record<string, { name: string; data: string }> = {};
    const rename: Record<string, string> = {};
    for (const ref of new Set(refs)) {
      if (ref.startsWith('embed:')) {
        const e = this.embedded.get(ref);
        if (e) map[ref] = { name: e.name, data: toB64(e.data) };
      } else if (embedFiles && ref.startsWith('file:')) {
        const bytes = await native.readFile(ref.slice(5));
        if (bytes) {
          const nref = 'embed:' + uid('s');
          this.embedded.set(nref, { name: basename(ref.slice(5)), data: bytes });
          const b = this.buffers.get(ref);
          if (b) this.buffers.set(nref, b);
          map[nref] = { name: basename(ref.slice(5)), data: toB64(bytes) };
          rename[ref] = nref;
        }
      }
    }
    return { map, rename };
  }

  importEmbedded(map: Record<string, { name: string; data: string }> | undefined) {
    if (!map) return;
    for (const [ref, v] of Object.entries(map)) {
      try {
        this.embedded.set(ref, { name: v.name, data: fromB64(v.data) });
      } catch {}
    }
  }
}

export const samples = new SampleBank();
