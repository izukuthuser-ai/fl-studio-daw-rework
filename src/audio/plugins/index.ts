// Registers every bundled plugin + worklet. Import once at startup (before the engine starts).
import recorderUrl from '../worklets/recorder.worklet.ts?worker&url';
import { registerWorklet } from './registry';
import './halcyon';
import './rune';
import './riffstack';

registerWorklet(recorderUrl);
