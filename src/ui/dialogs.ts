// Help sheet, project info, undo history, settings (incl. keymap editor) and command palette.
import { commands, comboFromEvent, CTX_LABELS, displayCombo, KeyCtx, normCombo, Command } from '../core/commands';
import { store } from '../core/store';
import { el, fuzzyScore } from '../core/util';
import { modal, toast, confirmDialog } from './widgets';
import { hooks } from './actions';
import { engine } from '../audio/engine';
import { midiState } from './keys';
import { native, appVersion, isElectron } from '../core/native';
import './dialogs.css';

// ---------------- help / shortcut sheet (F1) ----------------
function openHelp() {
  const groups = new Map<KeyCtx, Command[]>();
  for (const c of commands.all.values()) {
    const keys = commands.keysFor(c.id);
    if (!keys.length) continue;
    if (!groups.has(c.ctx)) groups.set(c.ctx, []);
    groups.get(c.ctx)!.push(c);
  }
  const body = el('div', { class: 'help' });
  body.append(
    el('p', { class: 'help-intro', html: 'LoopForge uses FL Studio-compatible shortcuts. Shortcuts are <b>context-sensitive</b>: the focused window\'s keys are checked first, then global keys. Single-letter keys are disabled while <kbd>Ctrl+T</kbd> typing-keyboard-to-piano is on. Press <kbd>Ctrl+K</kbd> to search every command, or remap anything in <b>Options → Settings → Keyboard</b> (F10).' }),
  );
  const cols = el('div', { class: 'help-cols' });
  for (const ctx of ['global', 'channelrack', 'pianoroll', 'playlist', 'mixer', 'browser'] as KeyCtx[]) {
    const cs = groups.get(ctx);
    if (!cs) continue;
    const sec = el('div', { class: 'help-sec' }, el('h3', { text: CTX_LABELS[ctx] }));
    const seen = new Set<string>();
    for (const c of cs) {
      const label = c.hidden ? c.label.replace(/ \d+$/, ' N') : c.label;
      if (seen.has(label)) continue;
      seen.add(label);
      const keys = commands.keysFor(c.id).map(displayCombo);
      sec.append(el('div', { class: 'help-row' }, el('span', { text: label }), el('span', { class: 'help-keys' }, ...keys.map((k) => el('kbd', { text: c.hidden ? k.replace(/\d$/, 'N') : k })))));
    }
    cols.append(sec);
  }
  body.append(cols);
  body.append(
    el('div', { class: 'help-mouse' },
      el('h3', { text: 'Mouse (Piano roll & Playlist)' }),
      el('div', { html: '<b>Left-click</b> add / move · <b>Right-click</b> delete (drag to delete many) · <b>Ctrl+drag</b> box-select · <b>Shift+drag</b> selection duplicates · <b>Alt</b> bypasses snap · <b>Drag note end</b> resize · <b>Wheel</b> scroll · <b>Ctrl+wheel</b> zoom · <b>Alt+wheel</b> on note = velocity · <b>Double-click knob</b> reset · <b>Right-click knob</b> automation / type value' }),
    ),
  );
  modal('LoopForge Studio — keyboard shortcuts', body, [{ label: 'Close', value: null, primary: true }], { width: 980, cancelValue: null });
}

// ---------------- project info (F11) ----------------
async function openSongInfo() {
  const i = { ...store.project.info };
  const t = el('input', { class: 'input', value: i.title }) as HTMLInputElement;
  const a = el('input', { class: 'input', value: i.author }) as HTMLInputElement;
  const gen = el('input', { class: 'input', value: i.genre }) as HTMLInputElement;
  const c = el('textarea', { class: 'input', rows: 5, style: { resize: 'vertical' } }) as HTMLTextAreaElement;
  c.value = i.comments;
  const p = store.project;
  const stats = el('div', { class: 'help-intro', text: `${p.channels.length} channels · ${p.patterns.length} patterns · ${p.playlist.clips.length} clips · ${p.mixer.length - 1} mixer inserts · ${(store.songLength() / store.barTicks).toFixed(0)} bars` });
  const body = el('div', { class: 'form-grid' }, el('label', { text: 'Title' }), t, el('label', { text: 'Author' }), a, el('label', { text: 'Genre' }), gen, el('label', { text: 'Comments' }), c, el('span'), stats);
  const ok = await modal<boolean>('Project info', body, [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }], { cancelValue: false, width: 460 }).promise;
  if (ok) store.commit('Project info', (pr) => (pr.info = { title: t.value, author: a.value, genre: gen.value, comments: c.value }));
}

// ---------------- undo history ----------------
function openHistory() {
  const list = el('div', { class: 'history' });
  const render = () => {
    list.innerHTML = '';
    const rows: { label: string; idx: number; current: boolean; future: boolean }[] = [];
    rows.push({ label: 'Opened project', idx: 0, current: store.undoStack.length === 0, future: false });
    store.undoStack.forEach((s, i) => rows.push({ label: s.label, idx: i + 1, current: i === store.undoStack.length - 1, future: false }));
    [...store.redoStack].reverse().forEach((s, i) => rows.push({ label: s.label, idx: store.undoStack.length + i + 1, current: false, future: true }));
    for (const r of rows) {
      list.append(el('div', { class: 'history-row' + (r.current ? ' current' : '') + (r.future ? ' future' : ''), text: r.label, onclick: () => { store.jumpTo(r.idx); render(); } }));
    }
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  };
  render();
  const off = store.on('history', render);
  modal('Undo history', list, [{ label: 'Close', value: null, primary: true }], { width: 360, cancelValue: null }).promise.then(off);
}

// ---------------- settings (F10) ----------------
function keymapEditor(): HTMLElement {
  const wrap = el('div', { class: 'keymap' });
  const search = el('input', { class: 'input', placeholder: 'Search commands or keys…' }) as HTMLInputElement;
  const list = el('div', { class: 'keymap-list' });
  const render = () => {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const cmds = [...commands.all.values()].filter((c) => !c.hidden || q);
    cmds.sort((a, b) => a.ctx.localeCompare(b.ctx) || a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
    let lastCtx = '';
    for (const c of cmds) {
      const keys = commands.keysFor(c.id);
      if (q && !(c.label.toLowerCase().includes(q) || keys.some((k) => k.toLowerCase().includes(q)) || c.category.toLowerCase().includes(q))) continue;
      if (c.ctx !== lastCtx) {
        list.append(el('div', { class: 'keymap-ctx', text: CTX_LABELS[c.ctx] }));
        lastCtx = c.ctx;
      }
      const isCustom = !!commands.overrides[c.id];
      const keyEls = keys.map((k) =>
        el('span', { class: 'keymap-key' }, el('kbd', { text: displayCombo(k) }), el('button', { class: 'keymap-x', text: '×', 'data-hint': 'Remove this shortcut', onclick: () => { commands.setKeys(c.id, keys.filter((x) => x !== k)); render(); } })),
      );
      list.append(
        el('div', { class: 'keymap-row' + (isCustom ? ' custom' : '') },
          el('span', { class: 'keymap-label', text: c.label }),
          el('span', { class: 'keymap-cat', text: c.category }),
          el('span', { class: 'keymap-keys' }, ...keyEls),
          el('button', { class: 'btn small', text: '+ Key', onclick: () => capture(c, keys) }),
          isCustom ? el('button', { class: 'btn small', text: 'Default', onclick: () => { commands.setKeys(c.id, c.keys); render(); } }) : el('span'),
        ),
      );
    }
  };
  const capture = async (c: Command, keys: string[]) => {
    let combo = '';
    const disp = el('div', { class: 'capture', text: 'Press a key combination…' });
    const warn = el('div', { class: 'capture-warn' });
    const dlg = modal<boolean>('Assign shortcut — ' + c.label, el('div', {}, disp, warn), [{ label: 'Cancel', value: false }, { label: 'Assign', value: true, primary: true }], {
      cancelValue: false,
      width: 380,
      onKey: (e) => {
        if (e.key === 'Escape' && !combo) return false;
        if (e.key === 'Enter' && combo) return false;
        e.preventDefault();
        e.stopPropagation();
        const k = comboFromEvent(e);
        if (!k || /^(Ctrl|Alt|Shift)(\+(Ctrl|Alt|Shift))*$/.test(k)) return true;
        combo = normCombo(k);
        disp.textContent = displayCombo(combo);
        const cf = commands.conflicts(c.ctx, combo, c.id);
        warn.textContent = cf.length ? `Already used by: ${cf.map((x) => x.label).join(', ')} — it will be removed there.` : '';
        return true;
      },
    });
    const ok = await dlg.promise;
    if (!ok || !combo) return;
    for (const other of commands.conflicts(c.ctx, combo, c.id)) commands.setKeys(other.id, commands.keysFor(other.id).filter((k) => normCombo(k) !== combo));
    commands.setKeys(c.id, [...keys, combo]);
    render();
  };
  search.addEventListener('input', render);
  const tools = el('div', { class: 'keymap-tools' },
    search,
    el('button', { class: 'btn small', text: 'Reset all to FL defaults', onclick: async () => { if ((await confirmDialog('Reset keymap', 'Reset every shortcut to the FL Studio defaults?', [{ label: 'Cancel', value: 'n' }, { label: 'Reset', value: 'y', primary: true }], 'n')) === 'y') { commands.resetAll(); render(); } } }),
    el('button', { class: 'btn small', text: 'Export…', onclick: () => native.saveFile({ defaultPath: 'loopforge-keymap.json', filters: [{ name: 'JSON', extensions: ['json'] }], data: JSON.stringify(commands.overrides, null, 2) }) }),
    el('button', { class: 'btn small', text: 'Import…', onclick: async () => { const f = await native.openFile({ filters: [{ name: 'JSON', extensions: ['json'] }] }); if (f) { try { commands.importMap(JSON.parse(new TextDecoder().decode(f[0].data))); render(); toast('Keymap imported', 'ok'); } catch { toast('Invalid keymap file', 'error'); } } } }),
  );
  wrap.append(tools, list);
  render();
  return wrap;
}

function openSettings(tab = 'general') {
  const tabs = ['general', 'audio', 'midi', 'keyboard'];
  const labels: Record<string, string> = { general: 'General', audio: 'Audio', midi: 'MIDI', keyboard: 'Keyboard' };
  const nav = el('div', { class: 'settings-nav' });
  const pane = el('div', { class: 'settings-pane' });
  const show = (t: string) => {
    nav.querySelectorAll('.settings-tab').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.t === t));
    pane.innerHTML = '';
    if (t === 'general') {
      const classic = el('input', { type: 'checkbox' }) as HTMLInputElement;
      classic.checked = store.classicUndo;
      classic.onchange = () => {
        store.classicUndo = classic.checked;
        try { localStorage.setItem('lf.classicUndo', classic.checked ? '1' : '0'); } catch {}
      };
      pane.append(
        el('h3', { text: 'Editing' }),
        el('label', { class: 'check' }, classic, el('span', { text: ' FL classic Ctrl+Z (toggle undo/redo of the last step instead of multi-level undo)' })),
        el('h3', { text: 'Projects' }),
        el('p', { class: 'muted', text: 'Unsaved work is autosaved every 60 seconds and offered for recovery if LoopForge closes unexpectedly.' }),
        el('div', { class: 'row' }, el('button', { class: 'btn', text: 'Reset window layout', onclick: () => { try { localStorage.removeItem('lf.layout'); } catch {} ; toast('Window layout will reset on next launch', 'ok'); } })),
        el('h3', { text: 'About' }),
        el('p', { class: 'muted', text: `LoopForge Studio ${appVersion} (${isElectron ? 'desktop' : 'web'}). Independent project — not affiliated with Image-Line or FL Studio.` }),
      );
    } else if (t === 'audio') {
      const ctx = engine.ready ? engine.ctx : null;
      pane.append(
        el('h3', { text: 'Output' }),
        el('div', { class: 'form-grid' },
          el('label', { text: 'Device' }), el('span', { text: 'System default output' }),
          el('label', { text: 'Sample rate' }), el('span', { text: ctx ? ctx.sampleRate + ' Hz' : '—' }),
          el('label', { text: 'Output latency' }), el('span', { text: ctx ? (((ctx.baseLatency ?? 0) + ((ctx as any).outputLatency ?? 0)) * 1000).toFixed(1) + ' ms' : '—' }),
          el('label', { text: 'Engine state' }), el('span', { text: ctx ? ctx.state : 'not started' }),
          el('label', { text: 'Active voices' }), el('span', { text: String(engine.voiceCount) }),
        ),
        el('p', { class: 'muted', text: 'Audio runs on a look-ahead scheduler (120 ms) for jitter-free timing; exports use an offline renderer with the same signal path.' }),
      );
    } else if (t === 'midi') {
      const en = el('input', { type: 'checkbox' }) as HTMLInputElement;
      en.checked = midiState.enabled;
      en.onchange = () => (midiState.enabled = en.checked);
      pane.append(
        el('h3', { text: 'MIDI input' }),
        el('label', { class: 'check' }, en, el('span', { text: ' Enable MIDI keyboards (play & record into the selected channel)' })),
        el('div', { class: 'midi-list' }, ...(midiState.available ? (midiState.inputs.length ? midiState.inputs.map((i) => el('div', { class: 'midi-dev', text: '🎹 ' + i.name })) : [el('div', { class: 'muted', text: 'No MIDI inputs detected. Plug one in — it will connect automatically.' })]) : [el('div', { class: 'muted', text: 'Web MIDI is not available in this environment.' })])),
      );
    } else if (t === 'keyboard') {
      pane.append(keymapEditor());
    }
  };
  for (const t of tabs) nav.append(el('button', { class: 'settings-tab', 'data-t': t, text: labels[t], onclick: () => show(t) }));
  const body = el('div', { class: 'settings' }, nav, pane);
  show(tab);
  modal('Settings', body, [{ label: 'Close', value: null, primary: true }], { width: 860, cancelValue: null });
}

// ---------------- command palette (Ctrl+K) ----------------
function openPalette() {
  const inp = el('input', { class: 'input palette-input', placeholder: 'Type a command…' }) as HTMLInputElement;
  const list = el('div', { class: 'palette-list' });
  let items: Command[] = [];
  let sel = 0;
  const render = () => {
    const q = inp.value.trim();
    const all = [...commands.all.values()].filter((c) => !c.hidden && (!c.enabled || c.enabled()));
    items = q
      ? all.map((c) => ({ c, s: Math.max(fuzzyScore(q, c.label), fuzzyScore(q, c.category + ' ' + c.label) - 5) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.c)
      : all.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
    items = items.slice(0, 60);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = '';
    items.forEach((c, i) => {
      const row = el('div', { class: 'palette-row' + (i === sel ? ' sel' : '') },
        el('span', { class: 'palette-cat', text: c.ctx === 'global' ? c.category : CTX_LABELS[c.ctx] }),
        el('span', { class: 'palette-label', text: c.label + (c.checked ? (c.checked() ? '  ✓' : '') : '') }),
        el('span', { class: 'palette-key', text: commands.shortcutLabel(c.id) }),
      );
      row.addEventListener('click', () => go(i));
      list.append(row);
    });
    (list.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  };
  const dlg = modal<null>('Command palette', el('div', { class: 'palette' }, inp, list), [], {
    width: 560,
    cancelValue: null,
    onKey: (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); return true; }
      if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); return true; }
      if (e.key === 'Enter') { e.preventDefault(); go(sel); return true; }
      return false;
    },
  });
  const go = (i: number) => {
    const c = items[i];
    dlg.close(null);
    if (c) setTimeout(() => c.run(), 0);
  };
  inp.addEventListener('input', () => { sel = 0; render(); });
  render();
  setTimeout(() => inp.focus(), 0);
}

export function initDialogs() {
  hooks.openHelp = openHelp;
  hooks.openSongInfo = openSongInfo;
  hooks.openHistory = openHistory;
  hooks.openSettings = openSettings;
  hooks.openPalette = openPalette;
  try {
    store.classicUndo = localStorage.getItem('lf.classicUndo') === '1';
  } catch {}
}
