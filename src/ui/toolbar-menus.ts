// Main menu definitions (FILE … HELP) for the toolbar, including the TOOLS menu and its macros.
import { store } from '../core/store';
import { commands } from '../core/commands';
import { SYNTH_PRESETS } from '../core/project';
import { FX_DEFS, FX_ORDER } from '../core/params';
import { basename, isElectron } from '../core/native';
import { clamp } from '../core/util';
import { BUILTIN_SOUNDS } from '../audio/sounds';
import { samples } from '../audio/samples';
import { allInstruments } from '../audio/plugins/registry';
import { MenuItem, confirmDialog, toast } from './widgets';
import { hooks, selectPattern } from './actions';
import { getRecent, importMidi } from './fileops';
import { addChannel, addFx, addMixerTrack, addPlaylistTrack, deleteChannels, routeToFreeTracks } from './ops';
import { openPluginWindow } from './pluginWindow';
import { wm } from './wm';

export const MENU_NAMES = ['FILE', 'EDIT', 'ADD', 'PATTERNS', 'VIEW', 'OPTIONS', 'TOOLS', 'HELP'] as const;
export type MenuName = (typeof MENU_NAMES)[number];

const stripExt = (n: string) => n.replace(/\.[^.\\/]+$/, '');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------- TOOLS macros ----------------
/** Channels that make no sound anywhere: no notes in any pattern and no audio clip in the playlist. */
function unusedChannels() {
  const p = store.project;
  const used = new Set<string>();
  for (const pt of p.patterns) for (const [cid, arr] of Object.entries(pt.notes)) if (arr.length) used.add(cid);
  for (const c of p.playlist.clips) if (c.kind === 'audio') used.add(c.ref);
  return p.channels.filter((c) => !used.has(c.id));
}

export async function purgeUnusedChannels() {
  const list = unusedChannels();
  if (!list.length) {
    toast('Every channel is used — nothing to purge', 'info', 1800);
    return;
  }
  const names = list.slice(0, 12).map((c) => '• ' + c.name).join('\n') + (list.length > 12 ? `\n… and ${list.length - 12} more` : '');
  const r = await confirmDialog(
    'Purge unused channels',
    `Delete ${plural(list.length, 'channel')} with no notes in any pattern and no audio clips?\n\n${names}\n\nYou can undo this (Ctrl+Z).`,
    [
      { label: 'Cancel', value: 'no' },
      { label: 'Delete', value: 'yes', primary: true },
    ],
    'no',
  );
  if (r !== 'yes') return;
  deleteChannels(list.map((c) => c.id));
  toast(`Purged ${plural(list.length, 'unused channel')}`, 'ok', 1600);
}

export function purgeUnusedPatterns() {
  const p = store.project;
  const onPlaylist = new Set(p.playlist.clips.filter((c) => c.kind === 'pattern').map((c) => c.ref));
  let gone = p.patterns.filter((pt) => !onPlaylist.has(pt.id) && Object.values(pt.notes).every((a) => !a.length)).map((x) => x.id);
  if (gone.length === p.patterns.length) gone = gone.slice(1); // a project keeps at least one pattern
  if (!gone.length) {
    toast('No empty, unplaced patterns to purge', 'info', 1800);
    return;
  }
  const kill = new Set(gone);
  store.commit('Purge unused patterns', (pr) => (pr.patterns = pr.patterns.filter((x) => !kill.has(x.id))));
  store.validateUI();
  if (kill.has(store.ui.currentPattern) || !store.pattern()) selectPattern(store.project.patterns[0].id);
  else store.emit('ui', ['currentPattern']);
  toast(`Purged ${plural(gone.length, 'empty pattern')}`, 'ok', 1600);
}

export function renameChannelsFromSamples() {
  let n = 0;
  store.commit('Rename channels from samples', (p) => {
    for (const c of p.channels) {
      const ref = c.type === 'sampler' ? c.sampler?.sampleRef : null;
      if (!ref) continue;
      const name = stripExt(c.sampler!.sampleName || samples.displayName(ref)).trim();
      if (name && c.name !== name) {
        c.name = name;
        n++;
      }
    }
  });
  toast(n ? `Renamed ${plural(n, 'channel')} after their samples` : 'Sampler channels already carry their sample names', n ? 'ok' : 'info', 1600);
}

export function colorMixerFromChannels() {
  let n = 0;
  store.commit('Color mixer tracks from channels', (p) => {
    for (let i = 1; i < p.mixer.length; i++) {
      const ch = p.channels.find((c) => c.mixer === i);
      if (!ch) continue;
      const m = p.mixer[i];
      if (m.color !== ch.color) {
        m.color = ch.color;
        n++;
      }
      if (m.name === `Insert ${i}`) {
        m.name = ch.name;
        n++;
      }
    }
  });
  toast(n ? 'Mixer tracks now match their channels' : 'Mixer tracks already match their channels', n ? 'ok' : 'info', 1600);
}

export function routeAllToMixer() {
  const ids = store.project.channels.filter((c) => c.mixer === 0).map((c) => c.id);
  if (!ids.length) {
    toast('Every channel already has its own mixer track', 'info', 1800);
    return;
  }
  routeToFreeTracks(ids);
}

export function unmuteAllChannels() {
  const muted = store.project.channels.filter((c) => c.mute).length;
  if (!muted) {
    toast('No muted channels', 'info', 1200);
    return;
  }
  store.commit('Unmute all channels', (p) => p.channels.forEach((c) => (c.mute = false)));
  toast(`Unmuted ${plural(muted, 'channel')}`, 'ok', 1200);
}

export function closePluginWindows() {
  let n = 0;
  for (const [id, w] of wm.wins) {
    if ((String(id).startsWith('plugin:') || String(id).startsWith('fx:')) && w.visible) {
      w.hide();
      n++;
    }
  }
  toast(n ? `Closed ${plural(n, 'plugin window')}` : 'No plugin windows are open', 'info', 1200);
}

export function quickQuantizePiano() {
  const ch = store.pianoChannel;
  if (!ch) {
    toast('Select a channel first', 'warn');
    return;
  }
  commands.run('pr.quickQuantize');
  toast(`Quantized “${ch.name}” in ${store.currentPattern?.name ?? 'the current pattern'}`, 'ok', 1400);
}

// ---------------- menus ----------------
const addInstrument = (fn: () => string | void) => () => {
  fn();
  wm.show('channelrack');
};

export function menuDefs(): Record<MenuName, () => MenuItem[]> {
  return {
    FILE: () => [
      { cmd: 'file.new' },
      { cmd: 'file.newEmpty' },
      { cmd: 'file.newDemo' },
      { sep: true },
      { cmd: 'file.open' },
      {
        label: 'Open recent',
        submenu: getRecent().length
          ? getRecent().map((p, i) => ({ label: basename(p), shortcut: `Alt+${i}`, action: () => commands.run('file.recent' + i) }))
          : [{ label: '(none yet)', disabled: true }],
      },
      { sep: true },
      { cmd: 'file.save' },
      { cmd: 'file.saveAs' },
      { cmd: 'file.saveNewVersion' },
      { cmd: 'file.saveEmbed' },
      { sep: true },
      { label: 'Import MIDI file…', action: () => void importMidi() },
      { cmd: 'file.exportWav' },
      { cmd: 'file.exportMp3' },
      { cmd: 'file.exportMidi' },
      ...(isElectron ? [{ sep: true }, { label: 'Exit', action: () => window.close() }] : []),
    ],
    EDIT: () => [{ cmd: 'edit.undo' }, { cmd: 'edit.undoStep' }, { cmd: 'edit.redo' }, { cmd: 'edit.history' }, { sep: true }, { cmd: 'win.palette' }],
    ADD: () => [
      ...allInstruments().map((pl) => ({
        label: pl.name,
        submenu: [
          {
            label: 'Init (default)',
            action: () => {
              const id = addChannel('plugin', { pluginType: pl.id, group: 'Synths' });
              wm.show('channelrack');
              openPluginWindow(id, 'show');
            },
          },
          { sep: true },
          ...[...new Set(pl.presets().map((x) => x.category))].map((cat) => ({
            label: cat,
            submenu: pl
              .presets()
              .filter((x) => x.category === cat)
              .map((x) => ({
                label: x.name,
                action: () => {
                  const id = addChannel('plugin', { pluginType: pl.id, preset: x.name, group: 'Synths' });
                  wm.show('channelrack');
                  openPluginWindow(id, 'show');
                },
              })),
          })),
        ],
      })),
      {
        label: 'Tri-Osc Synth',
        submenu: SYNTH_PRESETS.map((p) => ({ label: p.name, action: addInstrument(() => addChannel('synth', { name: p.name === 'Init' ? 'Tri-Osc' : p.name, preset: p.name, group: 'Synths' })) })),
      },
      {
        label: 'Sampler',
        submenu: [
          { label: 'Empty sampler', action: addInstrument(() => addChannel('sampler', { name: 'Sampler' })) },
          { sep: true },
          ...BUILTIN_SOUNDS.filter((s) => s.category !== 'FX').map((s) => ({
            label: s.name,
            action: addInstrument(() => addChannel('sampler', { sampleRef: 'builtin:' + s.id, group: s.category === '808s' ? 'Bass' : 'Drums' })),
          })),
        ],
      },
      {
        label: 'Effect (selected mixer track)',
        submenu: FX_ORDER.filter((t) => FX_DEFS[t]).map((t) => ({
          label: FX_DEFS[t].name,
          action: () => {
            addFx(clamp(store.ui.selectedMixer, 0, store.project.mixer.length - 1), t);
            wm.show('mixer');
          },
        })),
      },
      { sep: true },
      { cmd: 'pat.new', label: 'Pattern…' },
      {
        label: 'Mixer insert track',
        action: () => {
          const i = addMixerTrack();
          store.setUI({ selectedMixer: i, selectedMixerTracks: [i] });
          wm.show('mixer');
        },
      },
      { label: 'Playlist track', action: () => addPlaylistTrack() },
      { sep: true },
      { cmd: 'win.plugins', label: 'More… (plugin picker)' },
    ],
    PATTERNS: () => {
      const items: MenuItem[] = store.project.patterns.map((p, i) => ({
        label: `${i + 1}. ${p.name}`,
        checked: p.id === store.ui.currentPattern,
        color: p.color,
        action: () => selectPattern(p.id),
      }));
      return [{ cmd: 'pat.new' }, { cmd: 'pat.rename' }, { cmd: 'pat.clone' }, { cmd: 'pat.delete' }, { cmd: 'pat.next' }, { cmd: 'pat.prev' }, { sep: true }, ...items];
    },
    VIEW: () => [
      { cmd: 'win.playlist', checked: wm.get('playlist')?.visible },
      { cmd: 'win.channelrack', checked: wm.get('channelrack')?.visible },
      { cmd: 'win.pianoroll', checked: wm.get('pianoroll')?.visible },
      { cmd: 'win.mixer', checked: wm.get('mixer')?.visible },
      { cmd: 'win.browser', checked: wm.get('browser')?.visible },
      { cmd: 'win.plugins' },
      { sep: true },
      { cmd: 'win.arrange' },
      { cmd: 'win.maxPlaylist' },
      { cmd: 'win.closeAll' },
      { label: 'Close all plugin windows', action: closePluginWindows },
      { sep: true },
      { cmd: 'win.palette' },
    ],
    OPTIONS: () => [
      { cmd: 'win.settings' },
      { label: 'Keyboard shortcuts…', action: () => hooks.openSettings('keyboard') },
      { label: 'MIDI settings…', action: () => hooks.openSettings('midi') },
      { cmd: 'win.songInfo' },
      { sep: true },
      { cmd: 'transport.metronome' },
      { cmd: 'transport.typing' },
      { cmd: 'transport.stepEdit' },
      { cmd: 'transport.blend' },
      { cmd: 'transport.precount' },
      { cmd: 'transport.waitInput' },
      { sep: true },
      { label: 'Classic Ctrl+Z (undo / redo toggle)', checked: store.classicUndo, action: () => { store.classicUndo = !store.classicUndo; toast('Classic undo toggle: ' + (store.classicUndo ? 'on' : 'off'), 'info', 1200); } },
    ],
    TOOLS: () => [
      {
        label: 'Macros',
        submenu: [
          { label: 'Quick quantize (Piano roll channel)', shortcut: commands.shortcutLabel('pr.quickQuantize'), action: quickQuantizePiano },
          { sep: true },
          { label: 'Purge unused channels…', action: () => void purgeUnusedChannels() },
          { label: 'Purge unused patterns', action: purgeUnusedPatterns },
          { label: 'Rename channels from samples', action: renameChannelsFromSamples },
          { label: 'Unmute all channels', action: unmuteAllChannels },
          { sep: true },
          { label: 'Route unrouted channels to free mixer tracks', action: routeAllToMixer },
          { label: 'Color & name mixer tracks from channels', action: colorMixerFromChannels },
        ],
      },
      { sep: true },
      { label: 'Close all plugin windows', action: closePluginWindows },
      { cmd: 'transport.panic' },
      { cmd: 'transport.home' },
      { sep: true },
      { cmd: 'edit.history' },
      { cmd: 'win.palette' },
    ],
    HELP: () => [
      { cmd: 'win.help', label: 'Keyboard shortcuts & mouse' },
      { cmd: 'win.palette' },
      { sep: true },
      { label: 'About LoopForge Studio', action: () => hooks.openSettings('general') },
    ],
  };
}
