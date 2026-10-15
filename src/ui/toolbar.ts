// Top toolbar: menus, transport, tempo, pattern selector, toggles, master controls, window buttons.
import { store } from '../core/store';
import { engine } from '../audio/engine';
import { commands } from '../core/commands';
import { el, fmtBST, fmtTime, SNAP_LABELS, clamp } from '../core/util';
import { Snap } from '../core/types';
import { ICONS } from './icons';
import { showMenu, MenuItem, mountHint, knob, dragNumber, iconBtn, select, toast } from './widgets';
import { patternMenu, hooks } from './actions';
import { getRecent } from './fileops';
import { basename, isElectron } from '../core/native';
import { SYNTH_PRESETS } from '../core/project';
import { addChannel, addMixerTrack, addPlaylistTrack } from './ops';
import { wm } from './wm';
import { BUILTIN_SOUNDS } from '../audio/sounds';
import './toolbar.css';

function menuDefs(): Record<string, () => MenuItem[]> {
  return {
    FILE: () => [
      { cmd: 'file.new' },
      { cmd: 'file.newEmpty' },
      { cmd: 'file.newDemo' },
      { sep: true },
      { cmd: 'file.open' },
      {
        label: 'Open recent',
        submenu: getRecent().length ? getRecent().map((p, i) => ({ label: basename(p), shortcut: `Alt+${i}`, action: () => commands.run('file.recent' + i) })) : [{ label: '(none yet)', disabled: true }],
      },
      { sep: true },
      { cmd: 'file.save' },
      { cmd: 'file.saveAs' },
      { cmd: 'file.saveNewVersion' },
      { cmd: 'file.saveEmbed' },
      { sep: true },
      { cmd: 'file.exportWav' },
      { cmd: 'file.exportMp3' },
      { cmd: 'file.exportMidi' },
      ...(isElectron ? [{ sep: true }, { label: 'Exit', action: () => window.close() }] : []),
    ],
    EDIT: () => [{ cmd: 'edit.undo' }, { cmd: 'edit.undoStep' }, { cmd: 'edit.redo' }, { cmd: 'edit.history' }, { sep: true }, { cmd: 'win.palette' }],
    ADD: () => [
      { label: 'Tri-Osc Synth', submenu: SYNTH_PRESETS.map((p) => ({ label: p.name, action: () => { addChannel('synth', { name: p.name === 'Init' ? 'Tri-Osc' : p.name, preset: p.name, group: 'Synths' }); wm.show('channelrack'); } })) },
      {
        label: 'Sampler',
        submenu: [
          { label: 'Empty sampler', action: () => { addChannel('sampler', { name: 'Sampler' }); wm.show('channelrack'); } },
          { sep: true },
          ...BUILTIN_SOUNDS.filter((s) => !['FX'].includes(s.category)).map((s) => ({ label: s.name, action: () => { addChannel('sampler', { sampleRef: 'builtin:' + s.id, group: s.category === '808s' ? 'Bass' : 'Drums' }); wm.show('channelrack'); } })),
        ],
      },
      { sep: true },
      { cmd: 'pat.new', label: 'Pattern…' },
      { label: 'Mixer insert track', action: () => { const i = addMixerTrack(); store.setUI({ selectedMixer: i, selectedMixerTracks: [i] }); wm.show('mixer'); } },
      { label: 'Playlist track', action: () => addPlaylistTrack() },
      { sep: true },
      { cmd: 'win.plugins', label: 'More… (plugin picker)' },
    ],
    PATTERNS: () => {
      const items: MenuItem[] = store.project.patterns.map((p, i) => ({ label: `${i + 1}. ${p.name}`, checked: p.id === store.ui.currentPattern, color: p.color, action: () => store.setUI({ currentPattern: p.id, plSource: { kind: 'pattern', ref: p.id } }) }));
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
    ],
    HELP: () => [
      { cmd: 'win.help', label: 'Keyboard shortcuts & mouse' },
      { cmd: 'win.palette' },
      { sep: true },
      { label: 'About LoopForge Studio', action: () => hooks.openSettings('general') },
    ],
  };
}

export function createToolbar(): HTMLElement {
  const defs = menuDefs();
  const menubar = el('div', { class: 'tb-menus' });
  for (const name of Object.keys(defs)) {
    const b = el('button', { class: 'tb-menu', text: name });
    const open = () => {
      const r = b.getBoundingClientRect();
      showMenu(menuDefs()[name](), r.left, r.bottom + 1);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    menubar.append(b);
  }
  const hint = el('div', { class: 'tb-hint' });
  mountHint(hint);
  const projName = el('div', { class: 'tb-proj' });
  const updProj = () => (projName.textContent = (store.dirty ? '● ' : '') + (store.filePath ? basename(store.filePath).replace(/\.lfproj$/i, '') : store.project.info.title || 'Untitled'));
  store.on('dirty', updProj);
  store.on('loaded', updProj);
  store.on('project', updProj);

  // FL layout: main menu stacked above the hint bar on the far left
  const leftBlock = el(
    'div',
    { class: 'tb-left' },
    el('div', { class: 'tb-menurow' }, el('div', { class: 'tb-logo', html: ICONS.logo, 'data-hint': 'LoopForge Studio' }), menubar, projName),
    hint,
  );

  // ---- transport ----
  const patBtn = el('button', { class: 'tb-mode', text: 'PAT', 'data-hint': 'Pattern mode — play the current pattern (L)' });
  const songBtn = el('button', { class: 'tb-mode', text: 'SONG', 'data-hint': 'Song mode — play the playlist arrangement (L)' });
  patBtn.onclick = () => store.setUI({ songMode: false });
  songBtn.onclick = () => store.setUI({ songMode: true });
  const modeBox = el('div', { class: 'tb-modebox' }, patBtn, songBtn);
  const playBtn = iconBtn(ICONS.play, 'Play / stop (Space) · Play / pause (Ctrl+Space)', () => engine.togglePlay(), 'tb-big play');
  const stopBtn = iconBtn(ICONS.stop, 'Stop', () => engine.stop(), 'tb-big');
  const recBtn = iconBtn(ICONS.record, 'Record (R) — record notes from typing keyboard / MIDI into the current pattern', () => commands.run('transport.record'), 'tb-big rec');

  let tempoBegin = false;
  const tempo = dragNumber({
    get: () => store.project.bpm,
    set: (v) => store.live((p) => (p.bpm = v), 'tempo'),
    begin: () => {
      tempoBegin = true;
      store.begin('Tempo');
    },
    end: () => {
      if (tempoBegin) store.end();
      tempoBegin = false;
    },
    min: 10,
    max: 522,
    step: 1,
    fmt: (v) => v.toFixed(3),
    hint: 'Tempo (BPM) — drag, scroll or double-click to type',
    cls: 'tb-tempo',
  });
  const tempoBox = el('div', { class: 'tb-lcd tempo-box' }, tempo, el('span', { class: 'tb-lcd-unit', text: 'BPM' }));

  const timeEl = el('div', { class: 'tb-time', 'data-hint': 'Song position — click to toggle bar:step:tick / minutes:seconds' });
  const timeUnit = el('span', { class: 'tb-lcd-unit', text: 'B:S:T' });
  const timeBox = el('div', { class: 'tb-lcd time-box' }, timeEl, timeUnit);
  timeBox.onclick = () => store.setUI({ timeDisplay: store.ui.timeDisplay === 'bst' ? 'time' : 'bst' });

  // pattern selector
  const patName = el('span', { class: 'tb-pat-name' });
  const patSwatch = el('span', { class: 'tb-pat-swatch' });
  const patSel = el('button', { class: 'tb-pat', 'data-hint': 'Pattern selector — 1–9 select, Num+/Num- next/previous, F4 new, F2 rename' }, patSwatch, patName, el('span', { class: 'tb-caret', html: ICONS.chevronDown }));
  patSel.onclick = () => {
    const r = patSel.getBoundingClientRect();
    patternMenu(r.left, r.bottom + 1);
  };
  const patAdd = iconBtn(ICONS.plus, 'New pattern (F4)', () => commands.run('pat.new'));
  const updPat = () => {
    const p = store.currentPattern;
    const i = store.project.patterns.indexOf(p);
    patName.textContent = p ? `${i + 1}. ${p.name}` : '—';
    patSwatch.style.background = p?.color ?? '#555';
  };

  // toggles
  const tgl = (icon: string, cmd: string, key: keyof typeof store.ui) => {
    const b = iconBtn(icon, `${commands.all.get(cmd)?.label} (${commands.shortcutLabel(cmd)})`, () => commands.run(cmd));
    (b as any)._key = key;
    return b;
  };
  const toggles = [
    tgl(ICONS.metronome, 'transport.metronome', 'metronome'),
    tgl(ICONS.waitInput, 'transport.waitInput', 'waitInput'),
    tgl(ICONS.precount, 'transport.precount', 'precount'),
    tgl(ICONS.blend, 'transport.blend', 'blend'),
    tgl(ICONS.stepEdit, 'transport.stepEdit', 'stepEdit'),
    tgl(ICONS.keyboard, 'transport.typing', 'typingPiano'),
  ];
  const octave = dragNumber({ get: () => store.ui.pianoOctave, set: (v) => store.setUI({ pianoOctave: v }), min: 1, max: 9, step: 1, fmt: (v) => 'OCT ' + v, hint: 'Typing keyboard octave (drag / scroll)', cls: 'tb-oct', pxPerStep: 12 });

  const snapSel = select(
    (Object.keys(SNAP_LABELS) as Snap[]).map((s) => ({ value: s, label: SNAP_LABELS[s] })),
    store.ui.snap,
    (v) => store.setUI({ snap: v }),
    'Global snap (Backspace toggles Line / None)',
  );
  snapSel.classList.add('tb-snap');

  const masterVol = knob({
    def: { key: 'mv', label: 'Master volume', min: 0, max: 1.25, def: 0.8, fmt: (v) => Math.round(v * 100) + '%' },
    get: () => store.ui.masterVol,
    set: (v) => store.setUI({ masterVol: v }),
    size: 22,
  });
  let pitchBegin = false;
  const masterPitch = knob({
    def: { key: 'mp', label: 'Master pitch', min: -12, max: 12, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + ' st' },
    get: () => store.project.masterPitch,
    set: (v) => store.live((p) => (p.masterPitch = Math.round(v * 100) / 100)),
    begin: () => { pitchBegin = true; store.begin('Master pitch'); },
    end: () => { if (pitchBegin) store.end(); pitchBegin = false; },
    size: 22,
    bipolar: true,
  });
  const scope = el('canvas', { class: 'tb-scope', width: 128, height: 40, 'data-hint': 'Master output — waveform & peak level' }) as HTMLCanvasElement;
  const voices = el('div', { class: 'tb-voices', 'data-hint': 'Active voices (polyphony)' });

  const winBtn = (icon: string, id: string, cmd: string) => {
    const b = iconBtn(icon, `${commands.all.get(cmd)?.label} (${commands.shortcutLabel(cmd)})`, () => commands.run(cmd), 'tb-win');
    (b as any)._win = id;
    return b;
  };
  const winBtns = [
    winBtn(ICONS.playlist, 'playlist', 'win.playlist'),
    winBtn(ICONS.pianoRoll, 'pianoroll', 'win.pianoroll'),
    winBtn(ICONS.channelRack, 'channelrack', 'win.channelrack'),
    winBtn(ICONS.mixer, 'mixer', 'win.mixer'),
    winBtn(ICONS.browser, 'browser', 'win.browser'),
    iconBtn(ICONS.plugin, 'Plugin picker (F8)', () => commands.run('win.plugins'), 'tb-win'),
  ];
  const updWin = () => {
    for (const b of winBtns) {
      const id = (b as any)._win;
      if (id) b.classList.toggle('on', !!wm.get(id)?.visible);
    }
  };
  wm.onChange(updWin);

  const panel = (cls: string, ...kids: (HTMLElement | null)[]) => el('div', { class: 'tb-panel ' + cls }, ...kids);
  const recGrid = el('div', { class: 'tb-recgrid' }, ...toggles);
  const row2 = el(
    'div',
    { class: 'tb-main' },
    panel('tb-masters', el('div', { class: 'tb-mknob' }, masterVol, el('span', { text: 'VOL' })), el('div', { class: 'tb-mknob' }, masterPitch, el('span', { text: 'PITCH' }))),
    panel('tb-transport', modeBox, playBtn, stopBtn, recBtn),
    tempoBox,
    timeBox,
    panel('tb-rec', recGrid, octave),
    panel('tb-patsnap', el('div', { class: 'tb-patrow' }, patSel, patAdd), el('div', { class: 'tb-snaprow' }, el('span', { class: 'tb-icon', html: ICONS.magnet }), snapSel)),
    panel('tb-wins', ...winBtns),
    el('div', { class: 'tb-spacer' }),
    panel('tb-monitor', scope, voices),
    panel('tb-edit', iconBtn(ICONS.undo, 'Undo (Ctrl+Z)', () => commands.run('edit.undo')), iconBtn(ICONS.redo, 'Redo (Ctrl+Shift+Z)', () => commands.run('edit.redo')), iconBtn(ICONS.history, 'Undo history', () => commands.run('edit.history')), iconBtn(ICONS.palette, 'Command palette (Ctrl+K)', () => commands.run('win.palette'))),
  );

  const updTransport = () => {
    patBtn.classList.toggle('on', !store.ui.songMode);
    songBtn.classList.toggle('on', store.ui.songMode);
    playBtn.innerHTML = engine.playing ? ICONS.pause : ICONS.play;
    playBtn.classList.toggle('on', engine.playing);
    playBtn.classList.toggle('waiting', engine.waitingForInput);
    recBtn.classList.toggle('on', store.ui.recording);
    for (const b of toggles) b.classList.toggle('on', !!store.ui[(b as any)._key as keyof typeof store.ui]);
    octave.style.display = store.ui.typingPiano ? '' : 'none';
    snapSel.value = store.ui.snap;
    timeUnit.textContent = store.ui.timeDisplay === 'bst' ? 'B:S:T' : 'M:S:CS';
    masterVol.update();
    octave.update();
  };
  store.on('ui', () => {
    updTransport();
    updPat();
  });
  engine.on('state', updTransport);
  store.on('project', () => {
    tempo.update();
    masterPitch.update();
    updPat();
  });
  store.on('loaded', () => {
    tempo.update();
    updPat();
    updTransport();
  });

  // animation: time display, scope, voices
  const sctx = scope.getContext('2d')!;
  const buf = new Float32Array(512);
  let lastPeak = [0, 0];
  const frame = () => {
    requestAnimationFrame(frame);
    const pos = engine.position;
    timeEl.textContent = store.ui.timeDisplay === 'bst' ? fmtBST(pos, store.project.timeSig) : fmtTime(engine.seconds);
    const W = scope.width, H = scope.height;
    sctx.fillStyle = '#0e1215';
    sctx.fillRect(0, 0, W, H);
    if (engine.ready) {
      const an = engine.graph.master.analysers;
      if (an[0]) {
        an[0].getFloatTimeDomainData(buf);
        sctx.strokeStyle = '#4fc6e6';
        sctx.lineWidth = 1;
        sctx.beginPath();
        const mw = W - 14;
        for (let i = 0; i < mw; i++) {
          const v = buf[Math.floor((i / mw) * buf.length)];
          const y = H / 2 - clamp(v, -1, 1) * (H / 2 - 2);
          i ? sctx.lineTo(i, y) : sctx.moveTo(i, y);
        }
        sctx.stroke();
      }
      const m = engine.readMeters()[0] ?? [0, 0];
      for (let c = 0; c < 2; c++) {
        lastPeak[c] = Math.max(m[c] ?? 0, lastPeak[c] * 0.9);
        const db = lastPeak[c] > 0 ? 20 * Math.log10(lastPeak[c]) : -60;
        const h = clamp((db + 48) / 48, 0, 1) * (H - 2);
        sctx.fillStyle = db > -0.5 ? '#ec5a4c' : db > -6 ? '#ead14a' : '#79d85a';
        sctx.fillRect(W - 12 + c * 6, H - 1 - h, 5, h);
      }
      voices.textContent = engine.voiceCount + ' v';
    }
  };
  requestAnimationFrame(frame);

  updTransport();
  updPat();
  updProj();
  return el('div', { id: 'toolbar' }, leftBlock, row2);
}

export function attachToolbarShortcutsHelp() {
  toast('Tip: F1 shows every shortcut · Ctrl+K searches all commands', 'info', 4000);
}
