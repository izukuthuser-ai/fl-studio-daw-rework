// Reusable UI widgets: knobs, faders, menus, dialogs, toasts, hint bar.
import { ParamDef, fmtParam, fromNorm, toNorm } from '../core/params';
import { clamp, el } from '../core/util';
import { commands, displayCombo } from '../core/commands';

// ---------------- hint bar ----------------
let hintEl: HTMLElement | null = null;
let hintLock: string | null = null;
export function mountHint(target: HTMLElement) {
  hintEl = target;
  document.addEventListener('mouseover', (e) => {
    if (hintLock) return;
    const t = (e.target as HTMLElement).closest?.('[data-hint]') as HTMLElement | null;
    setHint(t?.dataset.hint ?? '');
  });
}
export function setHint(text: string) {
  if (hintEl) hintEl.textContent = text;
}
export function lockHint(text: string | null) {
  hintLock = text;
  if (text !== null) setHint(text);
}

// ---------------- drag helper ----------------
export function drag(e: PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void, up?: (ev: PointerEvent) => void) {
  const sx = e.clientX, sy = e.clientY;
  const target = e.target as Element;
  try {
    target.setPointerCapture?.(e.pointerId);
  } catch {}
  const mv = (ev: PointerEvent) => move(ev.clientX - sx, ev.clientY - sy, ev);
  const fin = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', fin);
    window.removeEventListener('pointercancel', fin);
    up?.(ev);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', fin);
  window.addEventListener('pointercancel', fin);
}

// ---------------- knob ----------------
export interface KnobOpts {
  def: ParamDef;
  get: () => number;
  set: (v: number) => void;
  begin?: () => void;
  end?: () => void;
  size?: number;
  label?: string;
  bipolar?: boolean;
  color?: string;
  name?: string; // hint prefix
  onAutomate?: () => void;
}

export interface KnobEl extends HTMLElement {
  update(): void;
}

const ARC = 270;
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const rad = (a: number) => ((a - 90) * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} ${sweep} ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

export function knob(o: KnobOpts): KnobEl {
  const size = o.size ?? 26;
  const wrap = el('div', { class: 'knob' + (o.label ? ' with-label' : '') }) as unknown as KnobEl;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 32 32');
  const track = document.createElementNS(ns, 'path');
  track.setAttribute('class', 'knob-track');
  track.setAttribute('d', arcPath(16, 16, 12, -ARC / 2, ARC / 2));
  const val = document.createElementNS(ns, 'path');
  val.setAttribute('class', 'knob-val');
  if (o.color) val.style.stroke = o.color;
  const body = document.createElementNS(ns, 'circle');
  body.setAttribute('class', 'knob-body');
  body.setAttribute('cx', '16');
  body.setAttribute('cy', '16');
  body.setAttribute('r', '8.5');
  const ptr = document.createElementNS(ns, 'line');
  ptr.setAttribute('class', 'knob-ptr');
  ptr.setAttribute('x1', '16');
  ptr.setAttribute('y1', '16');
  svg.append(track, val, body, ptr);
  wrap.append(svg);
  if (o.label) wrap.append(el('div', { class: 'knob-label', text: o.label }));
  const hintText = () => `${o.name ? o.name + ' — ' : ''}${o.def.label}: ${fmtParam(o.def, o.get())}`;
  wrap.update = () => {
    const n = clamp(toNorm(o.def, o.get()), 0, 1);
    const a = -ARC / 2 + n * ARC;
    const start = o.bipolar ? 0 : -ARC / 2;
    if (Math.abs(a - start) < 0.5) val.setAttribute('d', '');
    else val.setAttribute('d', arcPath(16, 16, 12, Math.min(start, a), Math.max(start, a)));
    const rad = ((a - 90) * Math.PI) / 180;
    ptr.setAttribute('x2', (16 + 7 * Math.cos(rad)).toFixed(2));
    ptr.setAttribute('y2', (16 + 7 * Math.sin(rad)).toFixed(2));
    wrap.dataset.hint = hintText();
  };
  const setNorm = (n: number) => {
    o.set(fromNorm(o.def, clamp(n, 0, 1)));
    wrap.update();
    lockHint(hintText());
  };
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) {
      o.begin?.();
      o.set(o.def.def);
      o.end?.();
      wrap.update();
      return;
    }
    const startN = toNorm(o.def, o.get());
    o.begin?.();
    wrap.classList.add('active');
    lockHint(hintText());
    drag(
      e,
      (_dx, dy, ev) => {
        const fine = ev.shiftKey || ev.ctrlKey ? 0.15 : 1;
        setNorm(startN - (dy / 180) * fine);
      },
      () => {
        wrap.classList.remove('active');
        lockHint(null);
        o.end?.();
      },
    );
  });
  wrap.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    o.begin?.();
    o.set(o.def.def);
    o.end?.();
    wrap.update();
  });
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const step = o.def.step ? 1 / ((o.def.max - o.def.min) / o.def.step) : e.shiftKey ? 0.005 : 0.025;
      o.begin?.();
      setNorm(toNorm(o.def, o.get()) + (e.deltaY < 0 ? step : -step));
      o.end?.();
      lockHint(null);
    },
    { passive: false },
  );
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      { label: 'Reset', action: () => { o.begin?.(); o.set(o.def.def); o.end?.(); wrap.update(); } },
      {
        label: 'Type in value…',
        action: async () => {
          const v = await promptDialog(o.def.label, `Value (${o.def.min} – ${o.def.max})`, String(+o.get().toFixed(4)));
          if (v === null) return;
          const num = parseFloat(v);
          if (!isNaN(num)) {
            o.begin?.();
            o.set(clamp(num, o.def.min, o.def.max));
            o.end?.();
            wrap.update();
          }
        },
      },
    ];
    if (o.onAutomate) items.push({ sep: true }, { label: 'Create automation clip', action: o.onAutomate });
    showMenu(items, e.clientX, e.clientY);
  });
  wrap.update();
  return wrap;
}

// ---------------- vertical fader ----------------
export interface FaderOpts {
  def: ParamDef;
  get: () => number;
  set: (v: number) => void;
  begin?: () => void;
  end?: () => void;
  height?: number;
  name?: string;
  toNorm?: (v: number) => number;
  fromNorm?: (n: number) => number;
  onAutomate?: () => void;
}
export function fader(o: FaderOpts): KnobEl {
  const h = o.height ?? 120;
  const tn = o.toNorm ?? ((v: number) => toNorm(o.def, v));
  const fn = o.fromNorm ?? ((n: number) => fromNorm(o.def, n));
  const wrap = el('div', { class: 'fader', style: { height: h + 'px' } }) as unknown as KnobEl;
  const groove = el('div', { class: 'fader-groove' });
  const cap = el('div', { class: 'fader-cap' });
  wrap.append(groove, cap);
  const hintText = () => `${o.name ? o.name + ' — ' : ''}${o.def.label}: ${fmtParam(o.def, o.get())}`;
  wrap.update = () => {
    const n = clamp(tn(o.get()), 0, 1);
    cap.style.top = (1 - n) * (h - 14) + 'px';
    wrap.dataset.hint = hintText();
  };
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) {
      o.begin?.();
      o.set(o.def.def);
      o.end?.();
      wrap.update();
      return;
    }
    const start = tn(o.get());
    o.begin?.();
    lockHint(hintText());
    drag(
      e,
      (_dx, dy, ev) => {
        const fine = ev.shiftKey || ev.ctrlKey ? 0.15 : 1;
        o.set(fn(clamp(start - (dy / (h - 14)) * fine, 0, 1)));
        wrap.update();
        lockHint(hintText());
      },
      () => {
        lockHint(null);
        o.end?.();
      },
    );
  });
  wrap.addEventListener('dblclick', () => {
    o.begin?.();
    o.set(o.def.def);
    o.end?.();
    wrap.update();
  });
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      o.begin?.();
      o.set(fn(clamp(tn(o.get()) + (e.deltaY < 0 ? 0.02 : -0.02), 0, 1)));
      o.end?.();
      wrap.update();
    },
    { passive: false },
  );
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items: MenuItem[] = [{ label: 'Reset', action: () => { o.begin?.(); o.set(o.def.def); o.end?.(); wrap.update(); } }];
    if (o.onAutomate) items.push({ label: 'Create automation clip', action: o.onAutomate });
    showMenu(items, e.clientX, e.clientY);
  });
  wrap.update();
  return wrap;
}

// ---------------- menus ----------------
export interface MenuItem {
  label?: string;
  action?: () => void;
  shortcut?: string;
  cmd?: string; // command id: label/shortcut/action derived from registry
  checked?: boolean;
  disabled?: boolean;
  sep?: boolean;
  submenu?: MenuItem[];
  color?: string;
}

let openMenus: HTMLElement[] = [];
export function closeMenus() {
  for (const m of openMenus) m.remove();
  openMenus = [];
}
document.addEventListener('pointerdown', (e) => {
  if (!openMenus.length) return;
  if (openMenus.some((m) => m.contains(e.target as Node))) return;
  closeMenus();
}, true);
window.addEventListener('blur', () => closeMenus());

export function showMenu(items: MenuItem[], x: number, y: number, level = 0): HTMLElement {
  if (level === 0) closeMenus();
  else openMenus.splice(level).forEach((m) => m.remove());
  const m = el('div', { class: 'menu' });
  for (const it of items) {
    if (it.sep) {
      m.append(el('div', { class: 'menu-sep' }));
      continue;
    }
    let label = it.label ?? '';
    let shortcut = it.shortcut ?? '';
    let action = it.action;
    let checked = it.checked;
    let disabled = it.disabled;
    if (it.cmd) {
      const c = commands.all.get(it.cmd);
      if (c) {
        label = label || c.label;
        shortcut = shortcut || commands.shortcutLabel(c.id);
        action = action ?? c.run;
        if (checked === undefined && c.checked) checked = c.checked();
        if (disabled === undefined && c.enabled) disabled = !c.enabled();
      }
    }
    const row = el(
      'div',
      { class: 'menu-item' + (disabled ? ' disabled' : '') + (it.submenu ? ' has-sub' : '') },
      el('span', { class: 'menu-check', text: checked ? '✓' : '' }),
      it.color ? el('span', { class: 'menu-swatch', style: { background: it.color } }) : null,
      el('span', { class: 'menu-label', text: label }),
      el('span', { class: 'menu-shortcut', text: it.submenu ? '▸' : shortcut ? displayCombo(shortcut) : '' }),
    );
    if (it.submenu) {
      row.addEventListener('pointerenter', () => {
        const r = row.getBoundingClientRect();
        showMenu(it.submenu!, r.right - 2, r.top - 4, level + 1);
      });
    } else {
      row.addEventListener('pointerenter', () => openMenus.splice(level + 1).forEach((mm) => mm.remove()));
      row.addEventListener('click', () => {
        if (disabled) return;
        closeMenus();
        action?.();
      });
    }
    m.append(row);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(0, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(0, Math.min(y, innerHeight - r.height - 4)) + 'px';
  openMenus[level] = m;
  return m;
}

// ---------------- dialogs ----------------
let dialogDepth = 0;
export const isDialogOpen = () => dialogDepth > 0;

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
}

export function modal<T>(title: string, body: HTMLElement, buttons: DialogButton<T>[], opts: { width?: number; cancelValue?: T; onKey?: (e: KeyboardEvent) => boolean } = {}): { promise: Promise<T>; close: (v: T) => void; root: HTMLElement } {
  dialogDepth++;
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  const overlay = el('div', { class: 'modal-overlay' });
  const box = el('div', { class: 'modal', style: { width: (opts.width ?? 380) + 'px' } });
  const btns = el('div', { class: 'modal-buttons' });
  const close = (v: T) => {
    if (!overlay.isConnected) return;
    overlay.remove();
    window.removeEventListener('keydown', onKey, true);
    dialogDepth--;
    resolve(v);
  };
  for (const b of buttons) btns.append(el('button', { class: 'btn' + (b.primary ? ' primary' : ''), text: b.label, onclick: () => close(b.value) }));
  box.append(el('div', { class: 'modal-title', text: title }), el('div', { class: 'modal-body' }, body), btns);
  overlay.append(box);
  document.body.append(overlay);
  const onKey = (e: KeyboardEvent) => {
    if (opts.onKey && opts.onKey(e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(opts.cancelValue as T);
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      const p = buttons.find((b) => b.primary);
      if (p) {
        e.preventDefault();
        e.stopPropagation();
        close(p.value);
      }
    } else e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close(opts.cancelValue as T);
  });
  setTimeout(() => (box.querySelector('input,select,textarea,button.primary') as HTMLElement | null)?.focus(), 0);
  return { promise, close, root: box };
}

export async function promptDialog(title: string, label: string, value = ''): Promise<string | null> {
  const inp = el('input', { class: 'input', value, type: 'text' }) as HTMLInputElement;
  const body = el('div', { class: 'form' }, el('label', { text: label }), inp);
  setTimeout(() => inp.select(), 10);
  const r = await modal<string | null>(title, body, [
    { label: 'Cancel', value: null },
    { label: 'OK', value: '__ok__', primary: true },
  ], { cancelValue: null }).promise;
  return r === '__ok__' ? inp.value : null;
}

export async function confirmDialog<T extends string>(title: string, message: string, buttons: { label: string; value: T; primary?: boolean }[], cancel: T): Promise<T> {
  return modal<T>(title, el('div', { class: 'modal-msg', text: message }), buttons, { cancelValue: cancel }).promise;
}

// ---------------- toast ----------------
let toastWrap: HTMLElement | null = null;
export function toast(msg: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info', ms = 2400) {
  if (!toastWrap) {
    toastWrap = el('div', { class: 'toasts' });
    document.body.append(toastWrap);
  }
  const t = el('div', { class: 'toast ' + kind, text: msg });
  toastWrap.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// ---------------- misc controls ----------------
export function iconBtn(icon: string, hint: string, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return el('button', { class: 'icon-btn ' + cls, html: icon, 'data-hint': hint, onclick }) as HTMLButtonElement;
}

export function select<T extends string | number>(options: { value: T; label: string }[], value: T, onchange: (v: T) => void, hint = ''): HTMLSelectElement {
  const s = el('select', { class: 'select', 'data-hint': hint }) as HTMLSelectElement;
  for (const o of options) s.append(el('option', { value: String(o.value), text: o.label }));
  s.value = String(value);
  s.addEventListener('change', () => {
    const o = options.find((x) => String(x.value) === s.value);
    if (o) onchange(o.value);
  });
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

/** Numeric drag-field (like FL's tempo display): drag up/down, wheel, double-click to type. */
export function dragNumber(o: { get: () => number; set: (v: number) => void; min: number; max: number; step: number; fmt?: (v: number) => string; hint: string; cls?: string; begin?: () => void; end?: () => void; pxPerStep?: number }): KnobEl {
  const e = el('div', { class: 'dragnum ' + (o.cls ?? ''), 'data-hint': o.hint }) as unknown as KnobEl;
  e.update = () => (e.textContent = o.fmt ? o.fmt(o.get()) : String(o.get()));
  const setv = (v: number) => {
    o.set(clamp(Math.round(v / o.step) * o.step, o.min, o.max));
    e.update();
  };
  e.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const start = o.get();
    o.begin?.();
    drag(ev, (_dx, dy, m) => setv(start - Math.round(dy / (o.pxPerStep ?? 4)) * o.step * (m.shiftKey ? 0.1 : 1)), () => o.end?.());
  });
  e.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    o.begin?.();
    setv(o.get() + (ev.deltaY < 0 ? o.step : -o.step));
    o.end?.();
  }, { passive: false });
  e.addEventListener('dblclick', async () => {
    const v = await promptDialog(o.hint, `Value (${o.min} – ${o.max})`, String(o.get()));
    if (v === null) return;
    const n = parseFloat(v);
    if (!isNaN(n)) {
      o.begin?.();
      setv(n);
      o.end?.();
    }
  });
  e.update();
  return e;
}

export function colorMenu(colors: string[], onPick: (c: string) => void, x: number, y: number) {
  const m = el('div', { class: 'menu color-menu' });
  for (const c of colors) m.append(el('div', { class: 'color-cell', style: { background: c }, onclick: () => { closeMenus(); onPick(c); } }));
  closeMenus();
  document.body.append(m);
  m.style.left = Math.min(x, innerWidth - 180) + 'px';
  m.style.top = Math.min(y, innerHeight - 120) + 'px';
  openMenus[0] = m;
}
