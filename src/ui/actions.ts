// Global commands with FL Studio default shortcuts.
import { commands, Command } from '../core/commands';
import { store } from '../core/store';
import { engine } from '../audio/engine';
import { wm } from './wm';
import * as files from './fileops';
import { promptDialog, toast, showMenu, MenuItem, colorMenu } from './widgets';
import { newPattern } from '../core/project';
import { PALETTE, uid, deepClone } from '../core/util';
import { Pattern } from '../core/types';

// Hooks filled in by other modules (avoids import cycles)
export const hooks = {
  openPluginPicker: () => {},
  openSettings: (_tab?: string) => {},
  openSongInfo: () => {},
  openHelp: () => {},
  openPalette: () => {},
  openHistory: () => {},
  toolSelector: () => {},
};

// ---------------- patterns ----------------
export function selectPattern(id: string) {
  store.setUI({ currentPattern: id, plSource: { kind: 'pattern', ref: id } });
}
export function selectPatternIndex(i: number) {
  const p = store.project.patterns[i];
  if (p) selectPattern(p.id);
  else toast(`Pattern ${i + 1} doesn't exist yet — press F4 for a new one`, 'info');
}
export function stepPattern(dir: 1 | -1) {
  const ps = store.project.patterns;
  const i = ps.findIndex((p) => p.id === store.ui.currentPattern);
  const n = i + dir;
  if (n < 0) return;
  if (n >= ps.length) {
    createPattern(false);
    return;
  }
  selectPattern(ps[n].id);
}
export function isEmptyPattern(p: Pattern) {
  return Object.values(p.notes).every((a) => !a.length);
}
export async function createPattern(ask = true) {
  // F4: go to next empty pattern (reuse an empty one after the current, else create)
  const ps = store.project.patterns;
  const cur = ps.findIndex((p) => p.id === store.ui.currentPattern);
  const empty = ps.find((p, i) => i > cur && isEmptyPattern(p) && !store.project.playlist.clips.some((c) => c.ref === p.id));
  let id = empty?.id;
  if (!id) {
    const np = newPattern(ps.length);
    id = np.id;
    store.commit('New pattern', (pr) => pr.patterns.push(np));
  }
  selectPattern(id);
  if (ask) {
    const p = store.pattern(id)!;
    const name = await promptDialog('New pattern', 'Pattern name', p.name);
    if (name !== null && name.trim()) store.commit('Rename pattern', (pr) => (pr.patterns.find((x) => x.id === id)!.name = name.trim()));
  }
}
export async function renamePattern(id = store.ui.currentPattern) {
  const p = store.pattern(id);
  if (!p) return;
  const name = await promptDialog('Rename pattern', 'Pattern name', p.name);
  if (name !== null && name.trim()) store.commit('Rename pattern', (pr) => (pr.patterns.find((x) => x.id === id)!.name = name.trim()));
}
export function clonePattern(id = store.ui.currentPattern) {
  const p = store.pattern(id);
  if (!p) return;
  const c: Pattern = deepClone(p);
  c.id = uid('p');
  c.name = p.name + ' #2';
  for (const arr of Object.values(c.notes)) for (const n of arr) n.id = uid('n');
  store.commit('Clone pattern', (pr) => pr.patterns.splice(pr.patterns.findIndex((x) => x.id === id) + 1, 0, c));
  selectPattern(c.id);
}
export function deletePattern(id = store.ui.currentPattern) {
  if (store.project.patterns.length <= 1) {
    toast('A project needs at least one pattern', 'warn');
    return;
  }
  const idx = store.project.patterns.findIndex((x) => x.id === id);
  store.commit('Delete pattern', (pr) => {
    pr.patterns = pr.patterns.filter((x) => x.id !== id);
    pr.playlist.clips = pr.playlist.clips.filter((c) => !(c.kind === 'pattern' && c.ref === id));
  });
  const next = store.project.patterns[Math.min(idx, store.project.patterns.length - 1)];
  selectPattern(next.id);
}
export function patternColor(id: string, x: number, y: number) {
  colorMenu(PALETTE, (c) => store.commit('Pattern color', (pr) => (pr.patterns.find((p) => p.id === id)!.color = c)), x, y);
}
export function patternMenu(x: number, y: number) {
  const items: MenuItem[] = store.project.patterns.map((p, i) => ({
    label: `${i + 1}. ${p.name}`,
    checked: p.id === store.ui.currentPattern,
    color: p.color,
    action: () => selectPattern(p.id),
  }));
  items.push({ sep: true }, { cmd: 'pat.new' }, { cmd: 'pat.rename' }, { cmd: 'pat.clone' }, { label: 'Color…', action: () => patternColor(store.ui.currentPattern, x, y) }, { cmd: 'pat.delete' });
  showMenu(items, x, y);
}

// ---------------- toggles ----------------
function toggleUI(key: 'metronome' | 'typingPiano' | 'stepEdit' | 'blend' | 'precount' | 'waitInput' | 'recording', label: string) {
  store.setUI({ [key]: !store.ui[key] } as any);
  toast(`${label}: ${store.ui[key] ? 'on' : 'off'}`, 'info', 1100);
}

export function setSongMode(on: boolean) {
  store.setUI({ songMode: on });
}

function undo() {
  const l = store.classicUndo ? store.undoToggle() : store.undo();
  toast(l ? `Undo: ${l}` : 'Nothing to undo', 'info', 1000);
}
function redo() {
  const l = store.redo();
  toast(l ? `Redo: ${l}` : 'Nothing to redo', 'info', 1000);
}

export function registerGlobalCommands() {
  const g = (id: string, label: string, category: string, keys: string[], run: () => void, extra: Partial<Command> = {}): Command => ({ id, label, category, ctx: 'global', keys, run, ...extra });
  const list: Command[] = [
    // file
    g('file.new', 'New project (basic template)', 'File', [], () => files.newProject('basic')),
    g('file.newEmpty', 'New empty project', 'File', [], () => files.newProject('empty')),
    g('file.newDemo', 'New from demo song', 'File', [], () => files.newProject('demo')),
    g('file.open', 'Open…', 'File', ['Ctrl+O'], () => files.openProject()),
    g('file.save', 'Save', 'File', ['Ctrl+S'], () => files.saveProject()),
    g('file.saveAs', 'Save as…', 'File', ['Ctrl+Shift+S'], () => files.saveProjectAs()),
    g('file.saveEmbed', 'Save as (embed samples)…', 'File', [], () => files.saveProjectAs(true)),
    g('file.saveNewVersion', 'Save new version', 'File', ['Ctrl+N'], () => files.saveNewVersion()),
    g('file.exportWav', 'Export WAV…', 'File', ['Ctrl+R'], () => files.exportAudio('wav')),
    g('file.exportMp3', 'Export MP3…', 'File', ['Ctrl+Shift+R'], () => files.exportAudio('mp3')),
    g('file.exportMidi', 'Export MIDI…', 'File', ['Ctrl+Shift+M'], () => files.exportMidi()),
    ...Array.from({ length: 10 }, (_, i) => g('file.recent' + i, `Open recent project ${i}`, 'File', [`Alt+${i}`], () => files.openRecent(i), { hidden: true })),
    // edit
    g('edit.undo', 'Undo', 'Edit', ['Ctrl+Z'], undo, { repeat: true }),
    g('edit.undoStep', 'Undo (step back)', 'Edit', ['Ctrl+Alt+Z'], () => { const l = store.undo(); toast(l ? `Undo: ${l}` : 'Nothing to undo', 'info', 1000); }, { repeat: true }),
    g('edit.redo', 'Redo', 'Edit', ['Ctrl+Shift+Z', 'Ctrl+Y'], redo, { repeat: true }),
    g('edit.history', 'Undo history…', 'Edit', [], () => hooks.openHistory()),
    // transport
    g('transport.play', 'Play / stop', 'Transport', ['Space'], () => engine.togglePlay()),
    g('transport.playPause', 'Play / pause', 'Transport', ['Ctrl+Space'], () => engine.togglePause()),
    g('transport.stop', 'Stop', 'Transport', [], () => engine.stop()),
    g('transport.songMode', 'Toggle pattern / song mode', 'Transport', ['L'], () => setSongMode(!store.ui.songMode), { checked: () => store.ui.songMode }),
    g('transport.record', 'Toggle recording', 'Transport', ['R'], () => toggleUI('recording', 'Recording'), { checked: () => store.ui.recording }),
    g('transport.metronome', 'Metronome', 'Transport', ['Ctrl+M'], () => toggleUI('metronome', 'Metronome'), { checked: () => store.ui.metronome }),
    g('transport.precount', 'Recording precount', 'Transport', ['Ctrl+P'], () => toggleUI('precount', 'Precount'), { checked: () => store.ui.precount }),
    g('transport.waitInput', 'Wait for input to start recording', 'Transport', ['Ctrl+I'], () => toggleUI('waitInput', 'Wait for input'), { checked: () => store.ui.waitInput }),
    g('transport.stepEdit', 'Step edit mode', 'Transport', ['Ctrl+E'], () => toggleUI('stepEdit', 'Step edit'), { checked: () => store.ui.stepEdit }),
    g('transport.blend', 'Blend recording notes', 'Transport', ['Ctrl+B'], () => toggleUI('blend', 'Blend notes'), { checked: () => store.ui.blend }),
    g('transport.typing', 'Typing keyboard to piano', 'Transport', ['Ctrl+T'], () => toggleUI('typingPiano', 'Typing keyboard to piano'), { checked: () => store.ui.typingPiano }),
    g('transport.panic', 'Panic — stop all sound', 'Transport', ['Ctrl+H'], () => { engine.panic(); toast('All sound stopped', 'info', 1000); }),
    g('transport.snapToggle', 'Toggle snap Line / None', 'Transport', ['Backspace'], () => { store.setUI({ snap: store.ui.snap === 'none' ? 'line' : 'none' }); toast('Snap: ' + (store.ui.snap === 'none' ? 'none' : 'line'), 'info', 900); }),
    g('transport.home', 'Song position to start', 'Transport', [], () => engine.setPosition(0)),
    ...[2, 3, 4, 5, 6].map((n) => g('typing.octave' + n, `Typing keyboard octave ${n + 1}`, 'Transport', [`Alt+Num${n}`], () => { store.setUI({ pianoOctave: n + 1 }); toast('Keyboard octave ' + (n + 1), 'info', 900); }, { hidden: true })),
    // windows
    g('win.help', 'Help & shortcuts', 'View', ['F1'], () => hooks.openHelp()),
    g('win.playlist', 'Playlist', 'View', ['F5'], () => wm.toggle('playlist')),
    g('win.channelrack', 'Channel rack', 'View', ['F6'], () => wm.toggle('channelrack')),
    g('win.pianoroll', 'Piano roll', 'View', ['F7'], () => wm.toggle('pianoroll')),
    g('win.plugins', 'Plugin picker', 'View', ['F8'], () => hooks.openPluginPicker()),
    g('win.browser', 'Browser', 'View', ['Alt+F8'], () => wm.toggle('browser')),
    g('win.mixer', 'Mixer', 'View', ['F9'], () => wm.toggle('mixer')),
    g('win.settings', 'Settings (audio / MIDI / keys)', 'Options', ['F10'], () => hooks.openSettings()),
    g('win.songInfo', 'Project info', 'Options', ['F11'], () => hooks.openSongInfo()),
    g('win.closeAll', 'Close all windows', 'View', ['F12'], () => wm.closeAll()),
    g('win.close', 'Close focused window', 'View', ['Esc'], () => wm.closeFocused(), { hidden: true }),
    g('win.cycle', 'Cycle windows', 'View', ['Tab'], () => wm.cycle()),
    g('win.maxPlaylist', 'Maximize / restore playlist', 'View', ['Enter'], () => { const w = wm.get('playlist'); if (w) { w.show(); w.toggleMax(); } }),
    g('win.arrange', 'Arrange windows', 'View', ['Ctrl+Shift+H'], () => wm.arrange()),
    g('win.tools', 'Tool selector', 'View', ['F3'], () => hooks.toolSelector()),
    g('win.palette', 'Command palette', 'View', ['Ctrl+K', 'Ctrl+Shift+P'], () => hooks.openPalette()),
    // patterns
    ...Array.from({ length: 9 }, (_, i) => g('pat.select' + (i + 1), `Select pattern ${i + 1}`, 'Patterns', [String(i + 1)], () => selectPatternIndex(i), { hidden: true })),
    g('pat.next', 'Next pattern', 'Patterns', ['Num+'], () => stepPattern(1)),
    g('pat.prev', 'Previous pattern', 'Patterns', ['Num-'], () => stepPattern(-1)),
    g('pat.rename', 'Rename pattern…', 'Patterns', ['F2'], () => renamePattern()),
    g('pat.new', 'Next empty pattern…', 'Patterns', ['F4'], () => createPattern(true)),
    g('pat.clone', 'Clone pattern', 'Patterns', ['Ctrl+Shift+C'], () => clonePattern()),
    g('pat.delete', 'Delete pattern', 'Patterns', [], () => deletePattern()),
  ];
  commands.register(list);
}
