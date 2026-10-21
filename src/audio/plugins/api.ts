// Plugin API (main thread). Instruments run their DSP in an AudioWorkletProcessor built on
// `worklets/kit.ts`; the host side below talks to it with the protocol in `worklets/protocol.ts`.
import type { ProcMsg } from '../worklets/protocol';

export interface InstrumentVoiceHandle {
  release(when: number): void;
  kill(when: number): void;
}

export interface InstrumentHost {
  readonly output: AudioNode;
  /** Automatable AudioParams exposed by the processor (macro1..macro4). */
  readonly params: Map<string, AudioParam>;
  noteOn(key: number, vel: number, when: number, dur: number | null): InstrumentVoiceHandle;
  setState(state: any): void;
  setTempo(bpm: number): void;
  allOff(when: number, hard?: boolean): void;
  cancelAfter(time: number): void;
  /** Resolves once the processor has handled every message sent so far. */
  sync(): Promise<void>;
  /** Subscribe to processor messages (e.g. viz). Returns unsubscribe. */
  onMessage(fn: (m: ProcMsg) => void): () => void;
  setViz(on: boolean): void;
  dispose(): void;
}

export interface PluginPreset {
  name: string;
  category: string;
  state: any;
}

/** What a plugin UI gets to talk to the app. */
export interface PluginUIApi {
  channelId: string;
  getState(): any;
  /** One undoable change. */
  commit(label: string, fn: (state: any) => void): void;
  /** Continuous edits (knob drags): begin → live… → end = one undo step. */
  begin(label: string): void;
  live(fn: (state: any) => void): void;
  end(): void;
  /** Live host (null until the audio engine is ready) — e.g. for viz messages. */
  host(): InstrumentHost | null;
  /** Audition notes. */
  noteOn(key: number, vel?: number): void;
  noteOff(key: number): void;
  /** Create an automation clip for a macro (param = 'macro1'..'macro4'). */
  automate(param: string): void;
  /** Called by the app when the state changed from outside (undo, preset load, automation). */
  onExternalChange(fn: () => void): () => void;
  /** Current tempo. */
  bpm(): number;
}

export interface PluginUI {
  el: HTMLElement;
  destroy?(): void;
  onResize?(): void;
  /** Window shown / hidden (start / stop visualisations). */
  onShow?(): void;
  onHide?(): void;
}

export interface InstrumentPlugin {
  id: string; // stored in Channel.plugin.type
  name: string;
  desc: string;
  category: 'Synth' | 'Sampler' | 'Drums' | 'Other';
  color: string; // accent colour for tiles / channel buttons
  icon: string; // inline svg
  /** URL of the bundled worklet module (import url from './x.worklet.ts?worker&url'). */
  workletUrl: string;
  /** Processor name passed to registerProcessor. */
  processor: string;
  defaultState(): any;
  presets(): PluginPreset[];
  /** Preferred plugin window size. */
  size: { w: number; h: number };
  createUI(api: PluginUIApi): PluginUI;
}

export interface FxPluginUIApi {
  trackIndex: number;
  slotId: string;
  getSlot(): import('../../core/types').FxSlot | undefined;
  commit(label: string, fn: (slot: import('../../core/types').FxSlot) => void): void;
  begin(label: string): void;
  live(fn: (slot: import('../../core/types').FxSlot) => void): void;
  end(): void;
  /** The running Effect instance (null until the engine is ready). */
  effect(): any;
  automate(param: string): void;
  onExternalChange(fn: () => void): () => void;
  /** Current project tempo (for tempo-synced displays). */
  bpm(): number;
}

export interface FxPluginUI {
  type: string; // FxType
  size: { w: number; h: number };
  createUI(api: FxPluginUIApi): PluginUI;
}
