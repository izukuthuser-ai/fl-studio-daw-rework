// Halcyon UI — built-in FX chain: distortion → chorus → delay → reverb.
import { el } from '../../../core/util';
import { DELAY_DIVS, DIST_TYPES } from './defs';
import { COL, Ctx, def, panel, pct, pknob, psel, ptoggle } from './ui-kit';

const NAMES = ['DIST', 'CHORUS', 'DELAY', 'REVERB'];
const KEYS = ['dist', 'chorus', 'delay', 'reverb'] as const;
const DESC = [
  'Distortion — soft / hard clipping or wave folding with a tone filter',
  'Chorus — modulated stereo delay lines',
  'Delay — tempo-synced echoes, optional ping-pong',
  'Reverb — dense feedback-delay-network room / hall',
];

export function fxPanel(ctx: Ctx): HTMLElement {
  const color = COL.fx;
  let cur = 0;
  const tabBtns: HTMLElement[] = [];
  const leds: HTMLButtonElement[] = [];
  const pages: HTMLElement[] = [];
  const show = (i: number) => {
    cur = i;
    tabBtns.forEach((b, k) => b.classList.toggle('on', k === cur));
    pages.forEach((pg, k) => (pg.style.display = k === cur ? '' : 'none'));
  };
  const strip = el('div', { class: 'hc-fxtabs' });
  NAMES.forEach((n, i) => {
    const key = KEYS[i];
    const led = el('button', { class: 'hc-led', 'data-hint': `${n.toLowerCase()} on / off` }) as HTMLButtonElement;
    led.onclick = (e) => {
      e.stopPropagation();
      const v = !(ctx.s.fx as any)[key].on;
      ctx.commit(`${n} on/off`, (s) => ((s.fx as any)[key].on = v));
    };
    leds.push(led);
    const b = el('div', { class: 'hc-fxtab', 'data-hint': DESC[i] + ' — click to edit', onclick: () => show(i) }, led, el('span', { text: n }));
    tabBtns.push(b);
    strip.append(b);
    if (i < 3) strip.append(el('span', { class: 'hc-fxarrow', text: '›' }));
  });
  const p = panel('hc-fx', el('span', { class: 'hc-title', style: { color } }, 'FX'), strip);
  const K = (label: string, key: string, d: ReturnType<typeof def>, fx: (typeof KEYS)[number]) =>
    pknob(ctx, { label, name: NAMES[KEYS.indexOf(fx)].toLowerCase(), def: d, get: (s) => (s.fx as any)[fx][key], set: (s, v) => ((s.fx as any)[fx][key] = v), color, size: 30 });
  // distortion
  pages.push(
    el(
      'div',
      { class: 'hc-fxpage' },
      el('div', { class: 'hc-col hc-fxsel' }, el('label', { text: 'TYPE' }), psel(ctx, DIST_TYPES, (s) => s.fx.dist.type, (s, v) => (s.fx.dist.type = v), 'Distortion type', 'Distortion type')),
      K('DRIVE', 'drive', def('Drive', 0, 1, 0.35, (v) => '+' + (v * 36).toFixed(1) + ' dB'), 'dist'),
      K('TONE', 'tone', def('Tone', 0, 1, 0.75, pct), 'dist'),
      K('MIX', 'mix', def('Mix', 0, 1, 1, pct), 'dist'),
    ),
  );
  pages.push(
    el(
      'div',
      { class: 'hc-fxpage' },
      K('RATE', 'rate', def('Rate', 0, 1, 0.6, (v) => (0.05 + v * v * 4.95).toFixed(2) + ' Hz'), 'chorus'),
      K('DEPTH', 'depth', def('Depth', 0, 1, 0.5, pct), 'chorus'),
      K('FDBK', 'fb', def('Feedback', 0, 1, 0.15, pct), 'chorus'),
      K('MIX', 'mix', def('Mix', 0, 1, 0.5, pct), 'chorus'),
    ),
  );
  pages.push(
    el(
      'div',
      { class: 'hc-fxpage' },
      el(
        'div',
        { class: 'hc-col hc-fxsel' },
        el('label', { text: 'TIME' }),
        psel(ctx, DELAY_DIVS.map(([l], i) => ({ value: i, label: l })), (s) => s.fx.delay.div, (s, v) => (s.fx.delay.div = v), 'Delay time (tempo-synced)', 'Delay time'),
        ptoggle(ctx, 'PING-PONG', (s) => s.fx.delay.ping, (s, v) => (s.fx.delay.ping = v), 'Ping-pong: echoes bounce left ↔ right', 'Delay ping-pong'),
      ),
      K('FDBK', 'fb', def('Feedback', 0, 0.95, 0.35, pct), 'delay'),
      K('TONE', 'tone', def('Tone', 0, 1, 0.6, pct), 'delay'),
      K('MIX', 'mix', def('Mix', 0, 1, 0.22, pct), 'delay'),
    ),
  );
  pages.push(
    el(
      'div',
      { class: 'hc-fxpage' },
      K('SIZE', 'size', def('Size / decay', 0, 1, 0.6, (v) => (0.35 + v * v * 11).toFixed(1) + ' s'), 'reverb'),
      K('DAMP', 'damp', def('Damping', 0, 1, 0.45, pct), 'reverb'),
      K('WIDTH', 'width', def('Width', 0, 1, 1, pct), 'reverb'),
      K('MIX', 'mix', def('Mix', 0, 1, 0.25, pct), 'reverb'),
    ),
  );
  p.body.append(...pages);
  show(0);
  ctx.onUpdate(() => {
    KEYS.forEach((k, i) => {
      const on = (ctx.s.fx as any)[k].on;
      leds[i].classList.toggle('on', on);
      tabBtns[i].classList.toggle('lit', on);
    });
    pages.forEach((pg, i) => pg.classList.toggle('off', !(ctx.s.fx as any)[KEYS[i]].on));
  });
  return p.root;
}
