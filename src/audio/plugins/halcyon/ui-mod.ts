// Halcyon UI — modulation matrix: up to 16 slots (source → destination, bipolar amount).
import { el } from '../../../core/util';
import { drag, lockHint } from '../../../ui/widgets';
import { DESTS, MAX_MOD, PITCH_MOD_RANGE, SOURCES } from './defs';
import { COL, Ctx, panel } from './ui-kit';

function fmtAmt(dst: string, v: number) {
  if (dst === 'pitch' || dst.endsWith('.pitch')) {
    const st = v * PITCH_MOD_RANGE;
    return (st > 0 ? '+' : '') + (Math.abs(st) < 10 ? st.toFixed(1) : Math.round(st)) + ' st';
  }
  return (v > 0 ? '+' : '') + Math.round(v * 100) + '%';
}

function srcSelect(value: string, onchange: (v: string) => void): HTMLSelectElement {
  const s = el('select', { class: 'select hc-sel hc-msrc', 'data-hint': 'Modulation source' }) as HTMLSelectElement;
  for (const o of SOURCES) s.append(el('option', { value: o.id, text: o.label }));
  s.value = value;
  s.onchange = () => onchange(s.value);
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}
function dstSelect(value: string, onchange: (v: string) => void): HTMLSelectElement {
  const s = el('select', { class: 'select hc-sel hc-mdst', 'data-hint': 'Modulation destination' }) as HTMLSelectElement;
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const d of DESTS) {
    let g = groups.get(d.group);
    if (!g) {
      g = el('optgroup', { label: d.group }) as HTMLOptGroupElement;
      groups.set(d.group, g);
      s.append(g);
    }
    g.append(el('option', { value: d.id, text: d.label }));
  }
  s.value = value;
  s.onchange = () => onchange(s.value);
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

export function modPanel(ctx: Ctx): HTMLElement {
  const color = COL.mod;
  const count = el('span', { class: 'hc-count' });
  const add = el('button', { class: 'hc-tog hc-add', text: '+ ADD', 'data-hint': `Add a modulation slot (up to ${MAX_MOD})` }) as HTMLButtonElement;
  const p = panel('hc-mod', el('span', { class: 'hc-title', style: { color } }, 'MOD MATRIX'), count, el('div', { class: 'hc-sp' }), add);
  const list = el('div', { class: 'hc-mlist' });
  const empty = el('div', { class: 'hc-empty', text: 'No modulation yet. Click + ADD, then pick a source (envelope, LFO, velocity, macro…) and a destination.' });
  p.body.append(el('div', { class: 'hc-mhead' }, el('span', { text: 'SOURCE' }), el('span', { text: 'DESTINATION' }), el('span', { text: 'AMOUNT' })), list, empty);
  add.onclick = () => {
    const s = ctx.s;
    if (s.mod.length >= MAX_MOD) return;
    const used = new Set(s.mod.map((m) => m.src));
    const src = ['lfo1', 'env2', 'lfo2', 'm1', 'vel', 'lfo3', 'env3', 'm2'].find((x) => !used.has(x)) ?? 'lfo1';
    const dst = src.startsWith('env') ? 'f1.cutoff' : src === 'vel' ? 'f1.cutoff' : src.startsWith('m') ? 'o1.frame' : 'o1.frame';
    ctx.commit('Add modulation', (st) => st.mod.push({ src, dst, amt: 0.25 }));
  };
  interface Row {
    root: HTMLElement;
    src: HTMLSelectElement;
    dst: HTMLSelectElement;
    fill: HTMLElement;
    txt: HTMLElement;
    bar: HTMLElement;
  }
  let rows: Row[] = [];
  const build = () => {
    list.innerHTML = '';
    rows = ctx.s.mod.map((_, i) => {
      const src = srcSelect(ctx.s.mod[i].src, (v) => ctx.commit('Modulation source', (s) => (s.mod[i].src = v)));
      const dst = dstSelect(ctx.s.mod[i].dst, (v) => ctx.commit('Modulation destination', (s) => (s.mod[i].dst = v)));
      const fill = el('div', { class: 'hc-amt-fill' });
      const txt = el('span', { class: 'hc-amt-txt' });
      const bar = el('div', { class: 'hc-amt', 'data-hint': 'Amount (bipolar) — drag left / right (Shift = fine), double-click = 0, wheel = small steps' }, el('div', { class: 'hc-amt-mid' }), fill, txt);
      bar.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        const start = ctx.s.mod[i]?.amt ?? 0;
        const wpx = bar.getBoundingClientRect().width / 2;
        ctx.begin('Modulation amount');
        drag(
          ev,
          (dx, _dy, e) => {
            const v = Math.max(-1, Math.min(1, start + (dx / wpx) * (e.shiftKey ? 0.15 : 1)));
            const q = Math.round(v * 1000) / 1000;
            ctx.live((s) => (s.mod[i].amt = q));
            update();
            lockHint(`Amount: ${fmtAmt(ctx.s.mod[i].dst, q)}`);
          },
          () => {
            lockHint(null);
            ctx.end();
          },
        );
      });
      bar.addEventListener('dblclick', () => ctx.commit('Reset modulation amount', (s) => (s.mod[i].amt = 0)));
      bar.addEventListener(
        'wheel',
        (ev) => {
          ev.preventDefault();
          const v = Math.max(-1, Math.min(1, (ctx.s.mod[i]?.amt ?? 0) + (ev.deltaY < 0 ? 0.01 : -0.01) * (ev.shiftKey ? 0.25 : 1)));
          ctx.commit('Modulation amount', (s) => (s.mod[i].amt = Math.round(v * 10000) / 10000));
        },
        { passive: false },
      );
      const del = el('button', { class: 'hc-x', html: '&times;', 'data-hint': 'Remove this modulation', onclick: () => ctx.commit('Remove modulation', (s) => s.mod.splice(i, 1)) });
      const root = el('div', { class: 'hc-mrow' }, el('span', { class: 'hc-mi', text: String(i + 1) }), src, dst, bar, del);
      list.append(root);
      return { root, src, dst, fill, txt, bar };
    });
  };
  let sig = '';
  const update = () => {
    const mods = ctx.s.mod;
    const s2 = String(mods.length);
    if (s2 !== sig) {
      sig = s2;
      build();
    }
    count.textContent = `${mods.length}/${MAX_MOD}`;
    add.disabled = mods.length >= MAX_MOD;
    empty.style.display = mods.length ? 'none' : '';
    mods.forEach((m, i) => {
      const r = rows[i];
      if (!r) return;
      if (r.src.value !== m.src) r.src.value = m.src;
      if (r.dst.value !== m.dst) r.dst.value = m.dst;
      const v = Math.max(-1, Math.min(1, m.amt));
      r.fill.style.left = 50 + Math.min(0, v) * 50 + '%';
      r.fill.style.width = Math.abs(v) * 50 + '%';
      r.fill.classList.toggle('neg', v < 0);
      r.txt.textContent = fmtAmt(m.dst, v);
    });
  };
  ctx.onUpdate(update);
  return p.root;
}
