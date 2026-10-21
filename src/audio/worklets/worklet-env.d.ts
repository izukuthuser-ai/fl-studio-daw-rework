// Globals of the AudioWorkletGlobalScope (only valid inside *.worklet.ts processors).
declare var sampleRate: number;
declare var currentTime: number;
declare var currentFrame: number;
declare function registerProcessor(name: string, ctor: any): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: any);
}
