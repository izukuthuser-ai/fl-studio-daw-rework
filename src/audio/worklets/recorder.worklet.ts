// Records its input sample-accurately from a given AudioContext time and streams chunks to the main thread.
const CHUNK = 16384;

class RecorderProcessor extends AudioWorkletProcessor {
  private armedAt = -1;
  private recording = false;
  private stopAt = -1;
  private bufL = new Float32Array(CHUNK);
  private bufR = new Float32Array(CHUNK);
  private fill = 0;

  constructor(options?: any) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.t === 'start') {
        this.armedAt = m.at;
        this.recording = false;
        this.stopAt = -1;
        this.fill = 0;
      } else if (m.t === 'stop') {
        this.stopAt = m.at ?? 0;
        if (!this.recording) {
          this.armedAt = -1;
          this.port.postMessage({ t: 'done' });
        }
      }
    };
  }

  private flush() {
    if (!this.fill) return;
    const l = this.bufL.slice(0, this.fill);
    const r = this.bufR.slice(0, this.fill);
    this.port.postMessage({ t: 'chunk', l, r }, [l.buffer, r.buffer]);
    this.fill = 0;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0];
    const n = outputs[0]?.[0]?.length ?? 128;
    if (this.armedAt >= 0 || this.recording) {
      const t0 = currentTime;
      let from = 0;
      if (!this.recording) {
        const f = Math.round((this.armedAt - t0) * sampleRate);
        if (f < n) {
          this.recording = true;
          from = Math.max(0, f);
          this.port.postMessage({ t: 'started', at: t0 + from / sampleRate });
        }
      }
      if (this.recording) {
        let to = n;
        if (this.stopAt >= 0) to = Math.max(from, Math.min(n, Math.round((this.stopAt - t0) * sampleRate)));
        const L = inp?.[0];
        const R = inp?.[1] ?? L;
        for (let i = from; i < to; i++) {
          this.bufL[this.fill] = L ? L[i] : 0;
          this.bufR[this.fill] = R ? R[i] : 0;
          if (++this.fill === CHUNK) this.flush();
        }
        if (this.stopAt >= 0 && to < n) {
          this.flush();
          this.recording = false;
          this.armedAt = -1;
          this.stopAt = -1;
          this.port.postMessage({ t: 'done' });
        }
      }
    }
    for (const ch of outputs[0] ?? []) ch.fill(0);
    return true;
  }
}

registerProcessor('lf-recorder', RecorderProcessor);
