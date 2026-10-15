// Floating window manager (FL-style windows inside one workspace).
import { store } from '../core/store';
import { WindowId } from '../core/types';
import { el } from '../core/util';
import { drag } from './widgets';

export interface WinSpec {
  id: WindowId;
  title: string;
  icon?: string;
  rect: { x: number; y: number; w: number; h: number };
  min?: { w: number; h: number };
  body: HTMLElement;
  headerExtra?: HTMLElement;
  onResize?: () => void;
  onShow?: () => void;
  onHide?: () => void;
  visible?: boolean;
  docked?: boolean; // not a floating window (e.g. browser panel)
}

export class Win {
  root: HTMLElement;
  header: HTMLElement;
  titleEl: HTMLElement;
  visible = false;
  maximized = false;
  private prevRect: { x: number; y: number; w: number; h: number } | null = null;

  constructor(public spec: WinSpec, private wm: WindowManager) {
    this.titleEl = el('div', { class: 'win-title', text: spec.title });
    const btnMax = el('button', { class: 'win-btn', html: '<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>', 'data-hint': 'Maximize / restore window', onclick: () => this.toggleMax() });
    const btnClose = el('button', { class: 'win-btn close', html: '<svg viewBox="0 0 10 10"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.4"/></svg>', 'data-hint': 'Close window (Esc)', onclick: () => this.hide() });
    this.header = el('div', { class: 'win-header' }, spec.icon ? el('span', { class: 'win-icon', html: spec.icon }) : null, this.titleEl, el('div', { class: 'win-extra' }, spec.headerExtra ?? null), el('div', { class: 'win-btns' }, btnMax, btnClose));
    this.root = el('div', { class: 'win', 'data-win': spec.id }, this.header, el('div', { class: 'win-body' }, spec.body));
    for (const dir of ['e', 's', 'se', 'w', 'sw']) {
      const h = el('div', { class: 'win-rs rs-' + dir });
      h.addEventListener('pointerdown', (e) => this.startResize(e, dir));
      this.root.append(h);
    }
    this.header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button,input,select,.win-extra')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      this.focus();
      if (this.maximized) return;
      const r = this.rect();
      drag(e, (dx, dy) => this.setRect({ ...r, x: r.x + dx, y: Math.max(0, r.y + dy) }), () => wm.saveLayout());
    });
    this.header.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button,input,select,.win-extra')) return;
      this.toggleMax();
    });
    this.root.addEventListener('pointerdown', () => this.focus(), true);
    this.setRect(spec.rect);
    this.root.style.display = 'none';
  }

  rect() {
    return {
      x: parseFloat(this.root.style.left) || 0,
      y: parseFloat(this.root.style.top) || 0,
      w: parseFloat(this.root.style.width) || 400,
      h: parseFloat(this.root.style.height) || 300,
    };
  }

  setRect(r: { x: number; y: number; w: number; h: number }) {
    const min = this.spec.min ?? { w: 240, h: 140 };
    this.root.style.left = Math.round(r.x) + 'px';
    this.root.style.top = Math.round(r.y) + 'px';
    this.root.style.width = Math.round(Math.max(min.w, r.w)) + 'px';
    this.root.style.height = Math.round(Math.max(min.h, r.h)) + 'px';
    this.spec.onResize?.();
  }

  private startResize(e: PointerEvent, dir: string) {
    e.preventDefault();
    e.stopPropagation();
    this.focus();
    if (this.maximized) this.toggleMax();
    const r = this.rect();
    drag(
      e,
      (dx, dy) => {
        const n = { ...r };
        if (dir.includes('e')) n.w = r.w + dx;
        if (dir.includes('s')) n.h = r.h + dy;
        if (dir.includes('w')) {
          n.w = r.w - dx;
          n.x = r.x + dx;
        }
        this.setRect(n);
      },
      () => this.wm.saveLayout(),
    );
  }

  toggleMax() {
    if (this.maximized) {
      this.maximized = false;
      this.root.classList.remove('maximized');
      if (this.prevRect) this.setRect(this.prevRect);
    } else {
      this.prevRect = this.rect();
      this.maximized = true;
      this.root.classList.add('maximized');
      const ws = this.wm.workspace.getBoundingClientRect();
      this.setRect({ x: 0, y: 0, w: ws.width, h: ws.height });
    }
    this.spec.onResize?.();
    this.wm.saveLayout();
  }

  show() {
    if (!this.visible) {
      this.visible = true;
      this.root.style.display = '';
      this.keepInside();
      this.spec.onShow?.();
      this.spec.onResize?.();
      this.wm.emitChange();
    }
    this.focus();
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.root.style.display = 'none';
    this.root.classList.remove('focused');
    this.spec.onHide?.();
    if (store.ui.focused === this.spec.id) this.wm.focusTop();
    this.wm.emitChange();
    this.wm.saveLayout();
  }

  focus() {
    this.wm.bringToFront(this);
  }

  keepInside() {
    const ws = this.wm.workspace.getBoundingClientRect();
    if (this.maximized) {
      this.setRect({ x: 0, y: 0, w: ws.width, h: ws.height });
      return;
    }
    const r = this.rect();
    const w = Math.min(r.w, ws.width);
    const h = Math.min(r.h, ws.height);
    const x = Math.max(0, Math.min(r.x, ws.width - Math.min(w, 120)));
    const y = Math.max(0, Math.min(r.y, ws.height - 30));
    if (x !== r.x || y !== r.y || w !== r.w || h !== r.h) this.setRect({ x, y, w, h });
  }

  setTitle(t: string) {
    this.titleEl.textContent = t;
  }
}

export class WindowManager {
  wins = new Map<WindowId, Win>();
  private z = 10;
  private listeners: (() => void)[] = [];
  constructor(public workspace: HTMLElement) {
    window.addEventListener('resize', () => {
      for (const w of this.wins.values()) if (w.visible) w.keepInside();
    });
  }

  add(spec: WinSpec): Win {
    const w = new Win(spec, this);
    this.wins.set(spec.id, w);
    this.workspace.append(w.root);
    return w;
  }

  get(id: WindowId) {
    return this.wins.get(id);
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }
  emitChange() {
    for (const f of this.listeners) f();
  }

  bringToFront(w: Win) {
    if (store.ui.focused !== w.spec.id) store.setUI({ focused: w.spec.id });
    for (const o of this.wins.values()) o.root.classList.toggle('focused', o === w);
    if (parseInt(w.root.style.zIndex || '0') !== this.z) w.root.style.zIndex = String(++this.z);
    this.emitChange();
  }

  focusTop() {
    let best: Win | null = null;
    for (const w of this.wins.values()) if (w.visible && (!best || +w.root.style.zIndex > +best.root.style.zIndex)) best = w;
    if (best) this.bringToFront(best);
    else store.setUI({ focused: null });
  }

  /** FL behaviour: hidden -> show; visible but not focused -> focus; focused -> hide */
  toggle(id: WindowId) {
    const w = this.wins.get(id);
    if (!w) return;
    if (!w.visible) w.show();
    else if (store.ui.focused !== id) w.focus();
    else w.hide();
    this.saveLayout();
  }

  show(id: WindowId) {
    this.wins.get(id)?.show();
  }

  hide(id: WindowId) {
    this.wins.get(id)?.hide();
  }

  closeFocused() {
    const id = store.ui.focused;
    if (id && id !== 'playlist') this.wins.get(id)?.hide();
  }

  closeAll() {
    for (const w of this.wins.values()) w.hide();
  }

  cycle() {
    const vis = [...this.wins.values()].filter((w) => w.visible);
    if (!vis.length) return;
    const i = vis.findIndex((w) => w.spec.id === store.ui.focused);
    vis[(i + 1) % vis.length].focus();
  }

  /** Tile visible windows in a sensible FL-like layout. */
  arrange() {
    const ws = this.workspace.getBoundingClientRect();
    const W = ws.width, H = ws.height;
    const pl = this.wins.get('playlist');
    const cr = this.wins.get('channelrack');
    const pr = this.wins.get('pianoroll');
    const mx = this.wins.get('mixer');
    for (const w of [pl, cr, pr, mx]) if (w?.maximized) w.toggleMax();
    pl?.setRect({ x: 0, y: 0, w: W, h: H });
    if (cr?.visible) cr.setRect({ x: 12, y: 12, w: Math.min(760, W * 0.55), h: Math.min(360, H * 0.48) });
    if (pr?.visible) pr.setRect({ x: Math.round(W * 0.18), y: Math.round(H * 0.08), w: Math.round(W * 0.8), h: Math.round(H * 0.6) });
    if (mx?.visible) mx.setRect({ x: Math.round(W * 0.06), y: Math.round(H * 0.42), w: Math.round(W * 0.9), h: Math.round(H * 0.56) });
    this.saveLayout();
  }

  saveLayout() {
    const o: Record<string, any> = {};
    for (const [id, w] of this.wins) o[id] = { ...w.rect(), visible: w.visible, max: w.maximized };
    try {
      localStorage.setItem('lf.layout', JSON.stringify(o));
    } catch {}
  }

  restoreLayout(): boolean {
    let o: Record<string, any> | null = null;
    try {
      o = JSON.parse(localStorage.getItem('lf.layout') ?? 'null');
    } catch {}
    if (!o) return false;
    for (const [id, w] of this.wins) {
      const r = o[id];
      if (!r) continue;
      w.setRect(r);
      if (r.visible) w.show();
      if (r.max && !w.maximized) w.toggleMax();
    }
    return true;
  }
}

export let wm: WindowManager;
export function initWM(ws: HTMLElement) {
  wm = new WindowManager(ws);
  return wm;
}
