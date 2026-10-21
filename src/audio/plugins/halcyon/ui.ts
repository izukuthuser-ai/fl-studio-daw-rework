// Halcyon UI — assembles the panels, keeps them in sync with the patch and runs the live
// visualisation (viz messages from the processor) only while the window is shown.
import './halcyon.css';
import type { InstrumentHost, PluginUI, PluginUIApi } from '../api';
import { el } from '../../../core/util';
import { N_OSC } from './defs';
import { Ctx } from './ui-kit';
import { oscPanel, subNoisePanel } from './ui-osc';
import { filterPanel } from './ui-filter';
import { envPanel } from './ui-env';
import { lfoPanel } from './ui-lfo';
import { modPanel } from './ui-mod';
import { fxPanel } from './ui-fx';
import { keyboardPanel, macroPanel, masterPanel } from './ui-master';

export function createHalcyonUI(api: PluginUIApi): PluginUI {
  const ctx = new Ctx(api);
  const kb = keyboardPanel(ctx);
  const kbPanel = el('div', { class: 'hc-panel hc-kbpanel' }, kb.el);
  const inner = el(
    'div',
    { class: 'hc-in' },
    el('div', { class: 'hc-rowA' }, ...Array.from({ length: N_OSC }, (_, o) => oscPanel(ctx, o))),
    el('div', { class: 'hc-rowB' }, subNoisePanel(ctx), filterPanel(ctx, 0), filterPanel(ctx, 1), envPanel(ctx)),
    el('div', { class: 'hc-rowC' }, lfoPanel(ctx), modPanel(ctx), fxPanel(ctx)),
    el('div', { class: 'hc-rowD' }, macroPanel(ctx), kbPanel, masterPanel(ctx)),
  );
  const root = el('div', { class: 'hc' }, inner);
  ctx.refresh(true);
  const offExt = api.onExternalChange(() => ctx.refresh());

  // ---- live visualisation ----
  let shown = false;
  let raf = 0;
  let host: InstrumentHost | null = null;
  let offMsg: (() => void) | null = null;
  let lastCheck = 0;
  const detach = () => {
    if (host) {
      try {
        host.setViz(false);
      } catch {}
    }
    offMsg?.();
    offMsg = null;
    host = null;
  };
  const attach = () => {
    const h = api.host();
    if (h === host) return;
    detach();
    host = h;
    if (!h) return;
    h.setViz(true);
    offMsg = h.onMessage((m) => {
      if (m.t !== 'viz') return;
      ctx.viz = m.data;
      ctx.vizAt = performance.now();
    });
  };
  const loop = (now: number) => {
    if (!shown) return;
    if (now - lastCheck > 1000) {
      lastCheck = now;
      attach();
    }
    ctx.tick(now);
    raf = requestAnimationFrame(loop);
  };
  return {
    el: root,
    onShow() {
      shown = true;
      lastCheck = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    },
    onHide() {
      shown = false;
      cancelAnimationFrame(raf);
      detach();
      kb.release();
    },
    onResize() {},
    destroy() {
      shown = false;
      cancelAnimationFrame(raf);
      detach();
      kb.release();
      offExt();
    },
  };
}
