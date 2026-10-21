// Riffstack AudioWorkletProcessor: thin wrapper around RiffDSP (gate, pedals, oversampled amp).
// Initial params arrive via processorOptions (so offline renders are correct from frame 0); later
// changes come as port messages and are applied immediately; automatable knobs are AudioParams.
import { AUTO_KEYS, AUTO_RANGES, RiffDSP } from './dsp';

class RiffstackProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return AUTO_KEYS.map((name) => ({ name, defaultValue: AUTO_RANGES[name][2], minValue: AUTO_RANGES[name][0], maxValue: AUTO_RANGES[name][1], automationRate: 'k-rate' }));
  }
  private dsp: RiffDSP;
  private alive = true;
  private viz = false;
  private vizCount = 0;
  private auto: Record<string, number> = {};
  private zeros = new Float32Array(128);

  constructor(options?: any) {
    super(options);
    this.dsp = new RiffDSP(sampleRate);
    const init = options?.processorOptions?.params;
    if (init) this.dsp.setParams(init);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.t === 'p') this.dsp.setParams(m.p);
      else if (m?.t === 'viz') this.viz = !!m.on;
      else if (m?.t === 'bye') this.alive = false;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    if (!this.alive) return false;
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;
    if (this.zeros.length < n) this.zeros = new Float32Array(n);
    const inp = inputs[0];
    const L = inp?.[0] ?? this.zeros;
    const R = inp?.[1] ?? L;
    for (const k of AUTO_KEYS) {
      const a = parameters[k];
      if (a && a.length) this.auto[k] = a[0];
    }
    this.dsp.process(L, R, out, n, this.auto);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (this.viz && ++this.vizCount >= 12) {
      this.vizCount = 0;
      this.port.postMessage({ t: 'viz', v: this.dsp.viz() });
    }
    return true;
  }
}

registerProcessor('lf-riffstack', RiffstackProcessor);
