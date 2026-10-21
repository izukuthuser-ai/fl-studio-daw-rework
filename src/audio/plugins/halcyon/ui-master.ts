// Halcyon UI — macros (automatable from the playlist), audition keyboard and master / voice settings.
import { el, isBlackKey, noteName } from '../../../core/util';
import { dragNumber } from '../../../ui/widgets';
import { GLIDE_MODES, VOICE_MODES } from './defs';
import { COL, Ctx, dbFmt, def, panel, pct, pknob, psel } from './ui-kit';

export function macroPanel(ctx: Ctx): HTMLElement {
  const color = COL.mac;
  const p = panel('hc-macros', el('span', { class: 'hc-title', style: { color } }, 'MACROS'));
  const bars: HTMLElement[] = [];
  for (let i = 0; i < 4; i++) {
    const k = pknob(ctx, {
      label: `MACRO ${i + 1}`,
      name: `Macro ${i + 1}`,
      def: def(`Value (plus playlist automation) — assign it in the mod matrix`, 0, 1, 0, pct),
      get: (s) => s.macros[i],
      set: (s, v) => (s.macros[i] = v),
      size: 28,
      color,
      onAutomate: () => ctx.api.automate('macro' + (i + 1)),
    });
    const bar = el('div', { class: 'hc-macbar' }, el('div', { class: 'hc-macfill' }));
    bars.push(bar);
    p.body.append(el('div', { class: 'hc-mac' }, k, bar));
  }
  let last = '';
  ctx.onFrame(() => {
    const m = ctx.viz?.mac ?? ctx.s.macros;
    const sig = m.map((x) => x.toFixed(3)).join();
    if (sig === last) return;
    last = sig;
    bars.forEach((b, i) => ((b.firstElementChild as HTMLElement).style.width = Math.round((m[i] ?? 0) * 100) + '%'));
  });
  return p.root;
}

export function keyboardPanel(ctx: Ctx): { el: HTMLElement; release: () => void } {
  let base = 48;
  const OCT = 3;
  const keys = el('div', { class: 'hc-keys' });
  const lbl = el('span', { class: 'hc-oct' });
  const down = el('button', { class: 'hc-tog hc-octb', html: '<svg viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>', 'data-hint': 'Keyboard octave down' }) as HTMLButtonElement;
  const up = el('button', { class: 'hc-tog hc-octb', html: '<svg viewBox="0 0 10 6"><path d="M1 5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>', 'data-hint': 'Keyboard octave up' }) as HTMLButtonElement;
  const wrap = el('div', { class: 'hc-kbwrap' }, el('div', { class: 'hc-kbside' }, up, lbl, down), keys);
  let held: number | null = null;
  const build = () => {
    keys.innerHTML = '';
    const whites: number[] = [];
    for (let k = base; k <= base + OCT * 12; k++) if (!isBlackKey(k)) whites.push(k);
    const ww = 100 / whites.length;
    whites.forEach((k, i) => {
      const d = el('div', { class: 'hc-wk', style: { left: i * ww + '%', width: ww + '%' } });
      d.dataset.key = String(k);
      if (k % 12 === 0) d.append(el('span', { text: noteName(k) }));
      keys.append(d);
    });
    for (let k = base; k < base + OCT * 12; k++) {
      if (!isBlackKey(k)) continue;
      const wi = whites.indexOf(k - 1);
      const d = el('div', { class: 'hc-bk', style: { left: (wi + 1) * ww - ww * 0.32 + '%', width: ww * 0.64 + '%' } });
      d.dataset.key = String(k);
      keys.append(d);
    }
    lbl.textContent = noteName(base);
  };
  const keyAt = (x: number, y: number): { key: number; vel: number } | null => {
    const t = document.elementFromPoint(x, y) as HTMLElement | null;
    const k = t?.closest?.('[data-key]') as HTMLElement | null;
    if (!k || !keys.contains(k)) return null;
    const r = k.getBoundingClientRect();
    const vel = Math.max(0.25, Math.min(1, 0.35 + 0.65 * ((y - r.top) / r.height)));
    return { key: +k.dataset.key!, vel };
  };
  const press = (key: number | null, vel = 0.8) => {
    if (key === held) return;
    if (held !== null) {
      ctx.api.noteOff(held);
      keys.querySelector(`[data-key="${held}"]`)?.classList.remove('on');
    }
    held = key;
    if (key !== null) {
      ctx.api.noteOn(key, vel);
      keys.querySelector(`[data-key="${key}"]`)?.classList.add('on');
    }
  };
  keys.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const k = keyAt(e.clientX, e.clientY);
    if (!k) return;
    try {
      keys.setPointerCapture(e.pointerId);
    } catch {}
    press(k.key, k.vel);
    const mv = (ev: PointerEvent) => {
      const kk = keyAt(ev.clientX, ev.clientY);
      if (kk && kk.key !== held) press(kk.key, kk.vel);
    };
    const fin = () => {
      keys.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', fin);
      window.removeEventListener('pointercancel', fin);
      press(null);
    };
    keys.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', fin);
    window.addEventListener('pointercancel', fin);
  });
  down.onclick = () => {
    base = Math.max(12, base - 12);
    build();
  };
  up.onclick = () => {
    base = Math.min(84, base + 12);
    build();
  };
  keys.dataset.hint = 'Audition keyboard — click or drag across the keys (lower on a key = louder)';
  build();
  return { el: wrap, release: () => press(null) };
}

export function masterPanel(ctx: Ctx): HTMLElement {
  const color = COL.master;
  const voices = el('span', { class: 'hc-voices', 'data-hint': 'Voices currently sounding' });
  const mode = psel(ctx, VOICE_MODES, (s) => s.voice.mode, (s, v) => (s.voice.mode = v), 'Voice mode: Poly · Mono (retriggers envelopes) · Legato (overlapping notes glide without retriggering)', 'Voice mode', 'hc-vmode');
  const p = panel('hc-master', el('span', { class: 'hc-title', style: { color } }, 'MASTER'), mode, el('div', { class: 'hc-sp' }), voices);
  const kVol = pknob(ctx, { label: 'VOLUME', name: 'Master', def: def('Volume', 0, 1.5, 0.7, (v) => dbFmt(v * v * 2)), get: (s) => s.voice.vol, set: (s, v) => (s.voice.vol = v), size: 28, color });
  const kGlide = pknob(ctx, {
    label: 'GLIDE',
    name: 'Master',
    def: def('Glide (portamento) time', 0.001, 2, 0.001, (v) => (v <= 0.0012 ? 'Off' : v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s'), { curve: 'log' }),
    get: (s) => Math.max(0.001, s.voice.glide),
    set: (s, v) => (s.voice.glide = v <= 0.0012 ? 0 : v),
    size: 28,
    color,
  });
  const kVel = pknob(ctx, { label: 'VELOCITY', name: 'Master', def: def('Velocity sensitivity', 0, 1, 0.6, pct), get: (s) => s.voice.vel, set: (s, v) => (s.voice.vel = v), size: 28, color });
  const gmode = psel(ctx, GLIDE_MODES, (s) => s.voice.glideMode, (s, v) => (s.voice.glideMode = v), 'Glide: always, or only between overlapping (legato) notes', 'Glide mode');
  const poly = dragNumber({
    get: () => ctx.s.voice.poly,
    set: (v) => ctx.live((s) => (s.voice.poly = v)),
    begin: () => ctx.begin('Polyphony'),
    end: () => ctx.end(),
    min: 1,
    max: 32,
    step: 1,
    hint: 'Polyphony (max voices) — drag, wheel or double-click to type',
    cls: 'hc-poly',
    fmt: (v) => String(v),
  });
  ctx.onUpdate(() => poly.update());
  p.body.append(
    kVol,
    kGlide,
    kVel,
    el('div', { class: 'hc-col hc-vsel' }, el('div', { class: 'hc-polyrow' }, el('label', { text: 'VOICES' }), poly), gmode),
  );
  let lastN = -1;
  ctx.onFrame(() => {
    const n = ctx.viz && performance.now() - ctx.vizAt < 400 ? ctx.viz.n : 0;
    if (n === lastN) return;
    lastN = n;
    voices.textContent = n ? `${n} voice${n === 1 ? '' : 's'}` : '';
    voices.classList.toggle('on', n > 0);
  });
  return p.root;
}
