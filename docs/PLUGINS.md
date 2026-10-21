# Writing LoopForge plugins

## Instruments (Halcyon, Rune, …)

An instrument = **an AudioWorkletProcessor** (DSP, runs on the audio thread, live *and* in offline export) + **a registration module** (presets + UI, main thread).

```
src/audio/plugins/<id>/index.ts          registerInstrument({...})  — imported by src/audio/plugins/index.ts
src/audio/plugins/<id>/<id>.worklet.ts   class X extends InstrumentProcessor; registerProcessor('lf-<id>', X)
```

### Processor side (`src/audio/worklets/kit.ts`)
Extend `InstrumentProcessor` and implement:

| method | when |
|---|---|
| `onState(state)` | whole patch replaced (initial state arrives from `processorOptions` on the first block) |
| `noteOn(id, key, vel)` | sample-accurate; `key` may be fractional (channel pitch knob); `vel` 0..1 |
| `noteOff(id)` | release the voice with that id |
| `kill(id)` | stop that voice now (≈5 ms fade) |
| `allOff(hard)` | release all (or hard-stop all) |
| `render(out, from, to, macros)` | **add** stereo audio into `out[0]`, `out[1]` for frames `[from, to)`; `macros` = 4 automatable values 0..1 |
| `onTempo(bpm)` / `this.bpm` | for tempo-synced LFOs / arps |
| `vizData()` | optional: small object posted ~30×/s while the UI asked for visualisation |

Events are split at their exact frame, so `render` is called for sub-blocks. Globals available: `sampleRate`, `currentTime`. No DOM, no `setTimeout`. Helpers: `mtof`, `clamp`, `Smoother`, `Rng`, `TWO_PI`. Keep CPU in check: avoid allocations in `render`, precompute tables in `onState`.

### Registration side (`src/audio/plugins/api.ts`)
```ts
import workletUrl from './myplug.worklet.ts?worker&url';
registerInstrument({ id, name, desc, category: 'Synth', color, icon, workletUrl, processor: 'lf-myplug',
  size: { w, h }, defaultState, presets, createUI(api) { … return { el, destroy, onShow, onHide, onResize }; } });
```
`api` (PluginUIApi): `getState()`, `commit(label, fn)`, `begin(label)` / `live(fn)` / `end()` (drag = one undo step), `host()` (for `setViz(true)` + `onMessage`), `noteOn/noteOff` (audition), `automate('macro1')`, `onExternalChange(fn)` (undo / preset load / anything — re-read state), `bpm()`.

The app provides the window chrome (preset ◀ ▶ + menu with save, vol/pan/pitch/track strip). Presets are plain state objects.

## Effects (Riffstack, …)
```ts
registerFxDef(def)                      // core/params.ts — name, desc, numeric params (UI knobs, automation)
registerEffectClass(type, EffectClass)  // audio/effects.ts — subclass of Effect (native nodes and/or a worklet)
registerWorklet(url)                    // audio/plugins/registry.ts — if the effect uses an AudioWorkletNode
registerFxUI({ type, size, createUI })  // audio/plugins/registry.ts — optional custom window UI
```
The FxType union in `core/types.ts` must contain the type. Non-numeric state can live in `FxSlot.data`.
Mixer slots open `openFxWindow(slotId)` (ui/pluginWindow.ts); without a custom UI a generic knob page is shown.

## Audio input & recording
`MixerTrack.input` = `''` | `'default'` | device id. `engine.inputs` (AudioInputManager) connects inputs to the track's FX chain (live monitoring), lists choices with `options()`, and records **armed** tracks while transport record is on. Takes become audio clips routed to the same insert.
