// PLACEHOLDER processor (replaced by the real Halcyon wavetable engine): simple poly saw with ADSR.
import { InstrumentProcessor, mtof } from '../../worklets/kit';

interface V { id: number; key: number; vel: number; ph: number; env: number; stage: 0 | 1 | 2 | 3; }

class HalcyonProcessor extends InstrumentProcessor {
  private voices: V[] = [];
  private cutoff = 0.5;
  protected onState(s: any) {
    this.cutoff = s?.cutoff ?? 0.5;
  }
  protected noteOn(id: number, key: number, vel: number) {
    this.voices.push({ id, key, vel, ph: 0, env: 0, stage: 0 });
  }
  protected noteOff(id: number) {
    for (const v of this.voices) if (v.id === id) v.stage = 3;
  }
  protected kill(id: number) {
    this.voices = this.voices.filter((v) => v.id !== id);
  }
  protected allOff(hard: boolean) {
    if (hard) this.voices = [];
    else for (const v of this.voices) v.stage = 3;
  }
  protected render(out: Float32Array[], from: number, to: number, macros: number[]) {
    const [L, R] = out;
    const lp = Math.min(0.99, this.cutoff * (0.5 + macros[0]));
    for (const v of this.voices) {
      const inc = mtof(v.key) / sampleRate;
      let y = 0;
      for (let i = from; i < to; i++) {
        if (v.stage === 0) { v.env += 0.002; if (v.env >= 1) { v.env = 1; v.stage = 1; } }
        else if (v.stage === 3) v.env *= 0.9995;
        v.ph += inc;
        if (v.ph >= 1) v.ph -= 1;
        const s = (2 * v.ph - 1) * v.env * v.vel * 0.25;
        y += lp * (s - y);
        L[i] += y;
        R[i] += y;
      }
    }
    this.voices = this.voices.filter((v) => !(v.stage === 3 && v.env < 1e-4));
  }
}

registerProcessor('lf-halcyon', HalcyonProcessor);
