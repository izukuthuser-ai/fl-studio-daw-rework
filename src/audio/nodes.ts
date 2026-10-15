// Small node factories shared by the graph and effects.

/** Biquads with k-rate params: coefficients update per 128-sample block instead of per sample (much cheaper). */
export function kBiquad(ctx: BaseAudioContext): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  for (const p of [b.frequency, b.detune, b.Q, b.gain]) {
    try {
      (p as any).automationRate = 'k-rate';
    } catch {}
  }
  return b;
}

