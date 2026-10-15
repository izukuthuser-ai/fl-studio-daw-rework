// Command registry + remappable, context-sensitive keymap (FL Studio defaults).
import { Emitter, isMac } from './util';

export type KeyCtx = 'global' | 'playlist' | 'channelrack' | 'pianoroll' | 'mixer' | 'browser';

export const CTX_LABELS: Record<KeyCtx, string> = {
  global: 'Global',
  playlist: 'Playlist',
  channelrack: 'Channel Rack',
  pianoroll: 'Piano Roll',
  mixer: 'Mixer',
  browser: 'Browser',
};

export interface Command {
  id: string;
  label: string;
  category: string;
  ctx: KeyCtx;
  keys: string[]; // FL default combos
  run: () => void;
  enabled?: () => boolean;
  repeat?: boolean; // allow key auto-repeat
  hidden?: boolean; // hide from palette
  checked?: () => boolean;
}

const CODE_NAMES: Record<string, string> = {
  Space: 'Space', Escape: 'Esc', Delete: 'Del', Insert: 'Ins', Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter',
  NumpadEnter: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp',
  PageDown: 'PageDown', Home: 'Home', End: 'End', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
  NumpadAdd: 'Num+', NumpadSubtract: 'Num-', NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadDecimal: 'Num.',
};

export function keyName(code: string, key: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'Num' + code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_NAMES[code] ?? key;
}

export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = keyName(e.code, e.key);
  if (['Control', 'Alt', 'Shift', 'Meta', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(k) || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key))
    return parts.join('+');
  parts.push(k);
  return parts.join('+');
}

/** Normalise a user-written combo ("shift+ctrl+a") into canonical order. */
export function normCombo(c: string): string {
  // a trailing '+' is the key itself (e.g. "Num+", "Ctrl+Num+")
  const plusKey = c.endsWith('+');
  const parts = (plusKey ? c.slice(0, -1) : c).split('+').map((s) => s.trim()).filter(Boolean);
  if (plusKey) parts[parts.length - 1] = (parts[parts.length - 1] ?? '') + '+';
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  let key = parts[parts.length - 1] ?? '';
  if (key.length === 1) key = key.toUpperCase();
  const out: string[] = [];
  if (mods.has('ctrl') || mods.has('cmd')) out.push('Ctrl');
  if (mods.has('alt') || mods.has('opt')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  out.push(key);
  return out.join('+');
}

export function displayCombo(c: string): string {
  if (!isMac) return c;
  return c.replace('Ctrl', '⌘').replace('Alt', '⌥').replace('Shift', '⇧');
}

/** True when combo has no Ctrl/Alt modifier (disabled while typing-keyboard-to-piano is on). */
export function isSingleKey(c: string) {
  return /^(Shift\+)?([A-Z0-9]|[-=\[\];',./\\`])$/.test(c);
}

class Commands extends Emitter<{ changed: null }> {
  all = new Map<string, Command>();
  overrides: Record<string, string[]> = {};
  private index = new Map<string, string[]>(); // ctx|combo -> ids

  constructor() {
    super();
    try {
      this.overrides = JSON.parse(localStorage.getItem('lf.keymap') ?? '{}');
    } catch {
      this.overrides = {};
    }
  }

  register(cmds: Command[]) {
    for (const c of cmds) this.all.set(c.id, c);
    this.rebuild();
  }

  keysFor(id: string): string[] {
    return this.overrides[id] ?? this.all.get(id)?.keys ?? [];
  }

  private rebuild() {
    this.index.clear();
    for (const c of this.all.values()) {
      for (const k of this.keysFor(c.id)) {
        const key = c.ctx + '|' + normCombo(k);
        const arr = this.index.get(key) ?? [];
        arr.push(c.id);
        this.index.set(key, arr);
      }
    }
    this.emit('changed', null);
  }

  lookup(ctx: KeyCtx, combo: string): Command | undefined {
    const ids = this.index.get(ctx + '|' + combo);
    if (!ids) return undefined;
    for (const id of ids) {
      const c = this.all.get(id)!;
      if (!c.enabled || c.enabled()) return c;
    }
    return undefined;
  }

  run(id: string) {
    const c = this.all.get(id);
    if (c && (!c.enabled || c.enabled())) c.run();
  }

  setKeys(id: string, keys: string[]) {
    const def = this.all.get(id)?.keys ?? [];
    if (JSON.stringify(keys) === JSON.stringify(def)) delete this.overrides[id];
    else this.overrides[id] = keys.map(normCombo);
    this.persist();
  }

  resetAll() {
    this.overrides = {};
    this.persist();
  }

  importMap(map: Record<string, string[]>) {
    this.overrides = map;
    this.persist();
  }

  private persist() {
    try {
      localStorage.setItem('lf.keymap', JSON.stringify(this.overrides));
    } catch {}
    this.rebuild();
  }

  /** Find commands in the same context (or global vs. specific) bound to combo. */
  conflicts(ctx: KeyCtx, combo: string, exceptId?: string): Command[] {
    const n = normCombo(combo);
    const out: Command[] = [];
    for (const c of this.all.values()) {
      if (c.id === exceptId) continue;
      if (c.ctx !== ctx) continue;
      if (this.keysFor(c.id).map(normCombo).includes(n)) out.push(c);
    }
    return out;
  }

  shortcutLabel(id: string): string {
    const k = this.keysFor(id)[0];
    return k ? displayCombo(k) : '';
  }
}

export const commands = new Commands();
