// Global keyboard dispatcher, typing-keyboard-to-piano, and Web MIDI input.
import { commands, comboFromEvent, isSingleKey, KeyCtx } from '../core/commands';
import { store } from '../core/store';
import { engine } from '../audio/engine';
import { isDialogOpen, closeMenus, toast } from './widgets';

// FL layout: lower row starts one octave below the upper row.
const LOWER: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
};
const UPPER: Record<string, number> = {
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28, BracketLeft: 29, Equal: 30, BracketRight: 31,
};

export function pianoKeyFor(code: string): number | null {
  const off = LOWER[code] ?? UPPER[code];
  if (off === undefined) return null;
  return (store.ui.pianoOctave - 1) * 12 + off;
}

const heldPiano = new Map<string, number>();

function isEditable(t: EventTarget | null) {
  const e = t as HTMLElement | null;
  if (!e) return false;
  return e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable;
}

function ctxFor(): KeyCtx {
  const f = store.ui.focused;
  switch (f) {
    case 'playlist':
    case 'automation':
      return 'playlist';
    case 'channelrack':
    case 'channelsettings':
      return 'channelrack';
    case 'pianoroll':
      return 'pianoroll';
    case 'mixer':
      return 'mixer';
    case 'browser':
      return 'browser';
    default:
      return 'global';
  }
}

export function initKeys() {
  window.addEventListener(
    'keydown',
    (e) => {
      if (isDialogOpen()) return;
      if (isEditable(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === 'Escape') closeMenus();
      const combo = comboFromEvent(e);
      // typing keyboard to piano
      if (store.ui.typingPiano && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const k = pianoKeyFor(e.code);
        if (k !== null) {
          e.preventDefault();
          if (!e.repeat && !heldPiano.has(e.code)) {
            heldPiano.set(e.code, k);
            engine.noteOn(k, 0.78, undefined, 'kb:' + e.code);
          }
          return;
        }
      }
      const ctx = ctxFor();
      const cmd = (ctx !== 'global' ? commands.lookup(ctx, combo) : undefined) ?? commands.lookup('global', combo);
      if (!cmd) {
        // keep browser defaults (zoom/reload etc.) out of the way
        if (e.key === 'Tab' || e.key === ' ' || /^F\d+$/.test(e.key)) e.preventDefault();
        return;
      }
      if (store.ui.typingPiano && isSingleKey(combo)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && !cmd.repeat) return;
      cmd.run();
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      const k = heldPiano.get(e.code);
      if (k !== undefined) {
        heldPiano.delete(e.code);
        engine.noteOff(k, undefined, 'kb:' + e.code);
      }
    },
    true,
  );
  window.addEventListener('blur', () => {
    for (const [code, k] of heldPiano) engine.noteOff(k, undefined, 'kb:' + code);
    heldPiano.clear();
  });
  // prevent ctrl+wheel page zoom
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
}

// ---------------- Web MIDI ----------------
export const midiState = { inputs: [] as { id: string; name: string }[], enabled: true, available: false };

export async function initMidi() {
  const nav = navigator as any;
  if (!nav.requestMIDIAccess) return;
  try {
    const access = await nav.requestMIDIAccess({ sysex: false });
    midiState.available = true;
    const attach = () => {
      midiState.inputs = [];
      access.inputs.forEach((inp: any) => {
        midiState.inputs.push({ id: inp.id, name: inp.name });
        inp.onmidimessage = (m: any) => {
          if (!midiState.enabled) return;
          const [st, d1, d2] = m.data;
          const type = st & 0xf0;
          if (type === 0x90 && d2 > 0) engine.noteOn(d1, d2 / 127, undefined, 'midi:' + d1);
          else if (type === 0x80 || (type === 0x90 && d2 === 0)) engine.noteOff(d1, undefined, 'midi:' + d1);
        };
      });
    };
    attach();
    access.onstatechange = (ev: any) => {
      attach();
      if (ev.port?.type === 'input' && ev.port.state === 'connected') toast('MIDI input connected: ' + ev.port.name, 'ok');
    };
  } catch {
    midiState.available = false;
  }
}
