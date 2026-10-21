// Message protocol between the main thread (InstrumentHost) and instrument AudioWorkletProcessors.
// All times are AudioContext seconds (`currentTime` clock). Processors apply events sample-accurately.

export type HostMsg =
  /** Replace the whole patch (sent on creation via processorOptions too). */
  | { t: 'state'; state: any }
  /** Note on. `dur` (seconds) schedules the matching note-off; omit for held notes. `pan` = note pan −1..1. */
  | { t: 'on'; id: number; key: number; vel: number; time: number; dur?: number; pan?: number }
  /** Note off (enter release) for voice `id`. */
  | { t: 'off'; id: number; time: number }
  /** Hard stop of voice `id` with a ~5 ms fade. */
  | { t: 'kill'; id: number; time: number }
  /** Release (or hard-stop) everything at `time`. */
  | { t: 'alloff'; time: number; hard?: boolean }
  /** Drop every queued event whose time is > `after` and kill voices that start after it. */
  | { t: 'cancel'; after: number }
  /** Project tempo for tempo-synced LFOs / arpeggiators. */
  | { t: 'tempo'; bpm: number }
  /** Reply with { t: 'synced', n } once every earlier message has been processed. */
  | { t: 'sync'; n: number }
  /** Ask the processor to post visualisation data (e.g. current wavetable frame, LFO phases). */
  | { t: 'viz'; on: boolean };

export type ProcMsg =
  | { t: 'synced'; n: number }
  /** Free-form visualisation payload, rate-limited by the processor (~30 Hz). */
  | { t: 'viz'; data: any };

/** AudioParams every instrument processor must declare (automatable from the playlist). */
export const MACRO_PARAMS = ['macro1', 'macro2', 'macro3', 'macro4'] as const;
