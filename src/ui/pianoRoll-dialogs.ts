// Small modal forms for the Piano Roll tools (quantize, arpeggiate, strum, …) with live preview.
import { clamp, el } from '../core/util';
import { modal } from './widgets';

export type Field =
  | { kind: 'select'; key: string; label: string; options: { value: string; label: string }[]; hint?: string; show?: (v: Record<string, any>) => boolean }
  | { kind: 'range'; key: string; label: string; min: number; max: number; step: number; unit?: string; hint?: string; show?: (v: Record<string, any>) => boolean }
  | { kind: 'number'; key: string; label: string; min: number; max: number; step: number; unit?: string; hint?: string; show?: (v: Record<string, any>) => boolean }
  | { kind: 'check'; key: string; label: string; hint?: string; show?: (v: Record<string, any>) => boolean }
  | { kind: 'note'; text: string };

/**
 * Show a form. `values` is edited in place; `onChange` runs after every edit (live preview).
 * Resolves true on OK, false on cancel.
 */
export async function formDialog(
  title: string,
  fields: Field[],
  values: Record<string, any>,
  onChange: (v: Record<string, any>) => void,
  opts: { width?: number; okLabel?: string; intro?: string } = {},
): Promise<boolean> {
  const grid = el('div', { class: 'form-grid pr-form' });
  const rows: { field: Field; nodes: HTMLElement[] }[] = [];
  const refreshVisibility = () => {
    for (const r of rows) {
      const show = 'show' in r.field && r.field.show ? r.field.show(values) : true;
      for (const n of r.nodes) n.style.display = show ? '' : 'none';
    }
  };
  const changed = () => {
    refreshVisibility();
    onChange(values);
  };
  for (const f of fields) {
    if (f.kind === 'note') {
      const n = el('div', { class: 'pr-form-note', text: f.text });
      grid.append(n);
      rows.push({ field: f, nodes: [n] });
      continue;
    }
    const label = el('label', { text: f.label });
    let ctl: HTMLElement;
    if (f.kind === 'select') {
      const s = el('select', { class: 'select' }) as HTMLSelectElement;
      for (const o of f.options) s.append(el('option', { value: o.value, text: o.label }));
      s.value = String(values[f.key]);
      s.addEventListener('change', () => {
        values[f.key] = s.value;
        changed();
      });
      ctl = s;
    } else if (f.kind === 'range') {
      const r = el('input', { type: 'range', class: 'pr-range', min: String(f.min), max: String(f.max), step: String(f.step) }) as HTMLInputElement;
      const box = el('input', { type: 'number', class: 'input pr-num', min: String(f.min), max: String(f.max), step: String(f.step) }) as HTMLInputElement;
      r.value = box.value = String(values[f.key]);
      r.addEventListener('input', () => {
        values[f.key] = parseFloat(r.value);
        box.value = r.value;
        changed();
      });
      box.addEventListener('input', () => {
        const n = parseFloat(box.value);
        if (isNaN(n)) return;
        values[f.key] = clamp(n, f.min, f.max);
        r.value = String(values[f.key]);
        changed();
      });
      ctl = el('div', { class: 'pr-range-row' }, r, box, f.unit ? el('span', { class: 'pr-unit', text: f.unit }) : null);
    } else if (f.kind === 'number') {
      const i = el('input', { type: 'number', class: 'input pr-num', min: String(f.min), max: String(f.max), step: String(f.step) }) as HTMLInputElement;
      i.value = String(values[f.key]);
      i.addEventListener('input', () => {
        const n = parseFloat(i.value);
        if (isNaN(n)) return;
        values[f.key] = clamp(n, f.min, f.max);
        changed();
      });
      ctl = el('div', { class: 'pr-range-row' }, i, f.unit ? el('span', { class: 'pr-unit', text: f.unit }) : null);
    } else {
      const c = el('input', { type: 'checkbox' }) as HTMLInputElement;
      c.checked = !!values[f.key];
      c.addEventListener('change', () => {
        values[f.key] = c.checked;
        changed();
      });
      ctl = el('label', { class: 'pr-check' }, c, el('span', { text: f.hint ?? '' }));
    }
    if (f.hint && f.kind !== 'check') ctl.dataset.hint = f.hint;
    grid.append(label, ctl);
    rows.push({ field: f, nodes: [label, ctl] });
  }
  refreshVisibility();
  const body = el('div', { class: 'pr-dlg' }, opts.intro ? el('div', { class: 'pr-dlg-intro', text: opts.intro }) : null, grid);
  onChange(values);
  const r = await modal<boolean>(title, body, [
    { label: 'Cancel', value: false },
    { label: opts.okLabel ?? 'Apply', value: true, primary: true },
  ], { cancelValue: false, width: opts.width ?? 400 }).promise;
  return r;
}
