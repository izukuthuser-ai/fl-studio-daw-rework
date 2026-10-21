// Plugin registry: instrument plugins, custom FX UIs, and the worklet modules they need.
import type { FxPluginUI, InstrumentPlugin } from './api';

const instruments = new Map<string, InstrumentPlugin>();
const fxUIs = new Map<string, FxPluginUI>();
const worklets = new Set<string>();
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

export function registerInstrument(p: InstrumentPlugin) {
  instruments.set(p.id, p);
  worklets.add(p.workletUrl);
}
export function getInstrument(id: string | undefined | null): InstrumentPlugin | undefined {
  return id ? instruments.get(id) : undefined;
}
export function allInstruments(): InstrumentPlugin[] {
  return [...instruments.values()];
}

export function registerFxUI(ui: FxPluginUI) {
  fxUIs.set(ui.type, ui);
}
export function getFxUI(type: string): FxPluginUI | undefined {
  return fxUIs.get(type);
}

/** Register an extra worklet module (FX processors, recorder…). */
export function registerWorklet(url: string) {
  worklets.add(url);
}

/** Load every registered worklet module into `ctx` (once per context). */
export function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    p = Promise.all(
      [...worklets].map((u) =>
        ctx.audioWorklet.addModule(u).catch((e) => {
          console.error('Failed to load audio worklet', u, e);
        }),
      ),
    ).then(() => undefined);
    loaded.set(ctx, p);
  }
  return p;
}
