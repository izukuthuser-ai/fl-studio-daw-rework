// Riffstack — guitar amp & effects rack (mixer effect). Registers the FxDef, the Effect class,
// its AudioWorklet module and the custom rack UI.
import workletUrl from './riffstack.worklet.ts?worker&url';
import { registerFxDef } from '../../../core/params';
import { registerEffectClass } from '../../effects';
import { registerFxUI, registerWorklet } from '../registry';
import { RS_DEF } from './params';
import { RiffstackFx } from './effect';
import { createRiffstackUI } from './ui';

registerFxDef(RS_DEF, true);
registerEffectClass('riffstack', RiffstackFx);
registerWorklet(workletUrl);
registerFxUI({ type: 'riffstack', size: { w: 980, h: 640 }, createUI: createRiffstackUI });
