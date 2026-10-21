// Plugin delay compensation helpers: latency (in samples) of the native nodes our effects use.
// Measured once per sample rate with a tiny offline impulse render; sensible Chromium defaults until then.

export interface NodeLatency {
  /** DynamicsCompressorNode look-ahead. */
  comp: number;
  /** WaveShaperNode with oversample = '2x' / '4x'. */
  ws2x: number;
  ws4x: number;
}

const cache = new Map<number, NodeLatency>();
const pending = new Map<number, Promise<NodeLatency>>();

const fallback = (sr: number): NodeLatency => ({ comp: Math.round(0.006 * sr), ws2x: 128, ws4x: 192 });

/** Latencies for a sample rate (measured values once measureNodeLatency() has run for it). */
export function nodeLatency(sr: number): NodeLatency {
  return cache.get(sr) ?? fallback(sr);
}

async function impulseDelay(sr: number, make: (ctx: OfflineAudioContext) => AudioNode): Promise<number> {
  const N = 4096;
  const at = 512;
  const ctx = new OfflineAudioContext(1, N, sr);
  const b = ctx.createBuffer(1, N, sr);
  b.getChannelData(0)[at] = 0.01; // well below any threshold
  const s = ctx.createBufferSource();
  s.buffer = b;
  const n = make(ctx);
  s.connect(n).connect(ctx.destination);
  s.start(0);
  const y = (await ctx.startRendering()).getChannelData(0);
  let bi = at;
  let bv = 0;
  for (let i = 0; i < y.length; i++) {
    const a = Math.abs(y[i]);
    if (a > bv) {
      bv = a;
      bi = i;
    }
  }
  return Math.max(0, bi - at);
}

/** Measure (once per sample rate) how late the compressor / oversampled shapers deliver their output. */
export function measureNodeLatency(sr: number): Promise<NodeLatency> {
  const have = cache.get(sr);
  if (have) return Promise.resolve(have);
  let p = pending.get(sr);
  if (p) return p;
  p = (async () => {
    const fb = fallback(sr);
    try {
      if (typeof OfflineAudioContext === 'undefined') return fb;
      const ws = (os: OverSampleType) => (ctx: OfflineAudioContext) => {
        const w = ctx.createWaveShaper();
        const c = new Float32Array(4097);
        for (let i = 0; i < c.length; i++) c[i] = i / 2048 - 1; // identity
        w.curve = c;
        w.oversample = os;
        return w;
      };
      const [comp, ws2x, ws4x] = await Promise.all([
        impulseDelay(sr, (ctx) => ctx.createDynamicsCompressor()),
        impulseDelay(sr, ws('2x')),
        impulseDelay(sr, ws('4x')),
      ]);
      const r = { comp, ws2x, ws4x };
      cache.set(sr, r);
      return r;
    } catch {
      return fb;
    } finally {
      pending.delete(sr);
    }
  })();
  pending.set(sr, p);
  return p;
}
