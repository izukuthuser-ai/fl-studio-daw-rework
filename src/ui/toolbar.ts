// Main toolbar, laid out like FL Studio 21's two-row toolbar (original artwork):
//   row 1  menu · master volume · PAT/SONG + transport · tempo · recording options · song position ·
//          oscilloscope / peak · performance monitor · utilities
//   row 2  hint & project panel · master pitch · song-position slider · option toggles · snap ·
//          pattern selector · window shortcuts · tips panel
// The left part is a grid so the two rows line up in columns (as in FL); the rest of each row is a
// flex strip whose lower-priority panels hide when the window gets narrow, so nothing ever overflows.
import './toolbar.css';
import { store } from '../core/store';
import { engine } from '../audio/engine';
import { commands } from '../core/commands';
import { el, SNAP_LABELS, clamp } from '../core/util';
import { Snap } from '../core/types';
import { basename } from '../core/native';
import { knob, KnobEl, MenuItem, closeMenus, menusOpen, mountHint, showMenu, toast } from './widgets';
import { patternMenu, renamePattern, selectPattern, stepPattern } from './actions';
import { linkChannelsToTrack } from './ops';
import { openPluginWindow } from './pluginWindow';
import { DT_PATTERN, setDragData } from './dnd';
import { wm } from './wm';
import { TB } from './toolbar-icons';
import { MENU_NAMES, MenuName, menuDefs } from './toolbar-menus';
import { positionSlider, songPosLCD, tempoLCD } from './toolbar-lcd';
import { monitorPanel, scopePanel } from './toolbar-meters';

const SNAP_ORDER: Snap[] = ['line', 'cell', 'none', '1/6step', '1/4step', '1/3step', '1/2step', 'step', '1/3beat', '1/2beat', 'beat', 'bar'];
const snapText = (s: Snap) => SNAP_LABELS[s].replace('(Main) ', '');

const TIPS: [string, string][] = [
  ['Shortcuts', 'Ctrl+K searches every command and shows its key'],
  ['Browser', 'Double-click a plugin in the Browser to add it'],
  ['Browser', 'Drag sounds onto the Channel rack or Playlist'],
  ['Transport', 'L switches between pattern and song mode'],
  ['Undo', 'Ctrl+Z undoes, Ctrl+Shift+Z redoes — history in EDIT'],
  ['Piano roll', 'Ctrl+Q quick-quantizes the selected notes'],
  ['Patterns', 'F4 jumps to the next empty pattern'],
  ['Mixer', 'Ctrl+L routes selected channels to free mixer tracks'],
  ['Typing keyboard', 'Ctrl+T plays notes from your computer keyboard'],
  ['Windows', 'Ctrl+Shift+H re-tiles every open window'],
  ['Tempo', 'Drag the tempo decimals for fine tempo changes'],
  ['Song position', 'Click the time display to switch B:S:T / M:S:CS'],
  ['Tools', 'TOOLS ▸ Macros purges unused channels in one go'],
  ['Browser', 'Star sounds and presets — they appear under STARRED'],
];

type Btn = HTMLButtonElement & { _key?: keyof typeof store.ui; _win?: string };

function btn(icon: string, hint: string, onclick: (e: MouseEvent) => void, cls = ''): Btn {
  const b = el('button', { class: 'tb-btn ' + cls, html: icon, 'data-hint': hint }) as Btn;
  b.addEventListener('click', onclick);
  return b;
}
const cmdHint = (cmd: string, fallback = '') => {
  const c = commands.all.get(cmd);
  const k = commands.shortcutLabel(cmd);
  return `${c?.label ?? fallback}${k ? ` (${k})` : ''}`;
};

export function createToolbar(): HTMLElement {
  // ================= row 1 =================
  // ---- main menu ----
  const menubar = el('div', { class: 'tb-menubar' });
  const menuBtns = new Map<MenuName, HTMLElement>();
  let openMenu: MenuName | null = null;
  let menuWasOpen = false;
  const openMenuFor = (name: MenuName) => {
    const b = menuBtns.get(name)!;
    const r = b.getBoundingClientRect();
    showMenu(menuDefs()[name](), r.left, r.bottom + 1);
    openMenu = name;
    for (const [n, e] of menuBtns) e.classList.toggle('open', n === name);
  };
  // the shared menu code closes menus on pointerdown (capture); remember whether ours was open first
  window.addEventListener('pointerdown', () => (menuWasOpen = !!openMenu && menusOpen()), true);
  for (const name of MENU_NAMES) {
    const b = el('button', { class: 'tb-menu', text: name, 'data-hint': `${name[0] + name.slice(1).toLowerCase()} menu` });
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (menuWasOpen && openMenu === name) {
        closeMenus();
        openMenu = null;
        b.classList.remove('open');
        return;
      }
      openMenuFor(name);
    });
    b.addEventListener('pointerenter', () => {
      if (openMenu && openMenu !== name && menusOpen()) openMenuFor(name);
    });
    menuBtns.set(name, b);
    menubar.append(b);
  }

  // ---- master volume ----
  const masterVol = knob({
    def: { key: 'mv', label: 'Master volume', min: 0, max: 1.25, def: 0.8, fmt: (v) => Math.round(v * 100) + '%' },
    get: () => store.ui.masterVol,
    set: (v) => store.setUI({ masterVol: v }),
    size: 30,
  });

  // ---- transport ----
  const patBtn = el('button', { class: 'tb-mode-btn pat', text: 'PAT', 'data-hint': 'Pattern mode — play the current pattern (L toggles)' });
  const songBtn = el('button', { class: 'tb-mode-btn song', text: 'SONG', 'data-hint': 'Song mode — play the playlist arrangement (L toggles)' });
  patBtn.addEventListener('click', () => store.setUI({ songMode: false }));
  songBtn.addEventListener('click', () => store.setUI({ songMode: true }));
  const playBtn = btn(TB.play, 'Play / stop (Space) · Play / pause (Ctrl+Space)', () => engine.togglePlay(), 'tb-tbtn play');
  const stopBtn = btn(TB.stop, 'Stop (Space while playing)', () => engine.stop(), 'tb-tbtn stop');
  const recBtn = btn(TB.record, 'Record (R) — record notes from the typing keyboard / MIDI, and armed mixer inputs', () => commands.run('transport.record'), 'tb-rec');
  const capsule = el('div', { class: 'tb-transport' }, el('div', { class: 'tb-mode' }, patBtn, songBtn), playBtn, stopBtn);
  const tempo = tempoLCD();

  // ---- recording options ----
  const tgl = (icon: string, cmd: string, key: keyof typeof store.ui) => {
    const b = btn(icon, cmdHint(cmd), () => commands.run(cmd), 'tb-opt');
    b._key = key;
    return b;
  };
  const recOpts = [
    tgl(TB.metronome, 'transport.metronome', 'metronome'),
    tgl(TB.waitInput, 'transport.waitInput', 'waitInput'),
    tgl(TB.countdown, 'transport.precount', 'precount'),
    tgl(TB.stepEdit, 'transport.stepEdit', 'stepEdit'),
    tgl(TB.blend, 'transport.blend', 'blend'),
  ];

  // ---- song position, visualisers, monitor ----
  const pos = songPosLCD();
  const scope = scopePanel();
  const monitor = monitorPanel();

  // ---- utilities ----
  const util = (icon: string, cmd: string, prio: number, cls = '') => {
    const b = btn(icon, cmdHint(cmd), () => commands.run(cmd), 'tb-util ' + cls);
    b.dataset.prio = String(prio);
    return b;
  };
  const utils = [
    util(TB.history, 'edit.history', 92),
    util(TB.undo, 'edit.undo', 60),
    util(TB.mic, 'win.settings', 70),
    util(TB.help, 'win.help', 55),
    util(TB.save, 'file.save', 40),
    util(TB.render, 'file.exportWav', 50),
    util(TB.palette, 'win.palette', 91),
    util(TB.open, 'file.open', 65, 'teal'),
  ];
  utils[1].dataset.hint = 'Undo (Ctrl+Z) — right-click for the undo history';
  utils[1].addEventListener('contextmenu', (e) => {
    e.preventDefault();
    commands.run('edit.history');
  });

  // ================= row 2 =================
  // ---- hint / project panel (mountHint target) ----
  const infoDot = el('span', { class: 'tb-info-dot' });
  const infoTitle = el('span', { class: 'tb-info-title' });
  const infoSub = el('span', { class: 'tb-info-sub' });
  const hint = el('span', { class: 'tb-hint' });
  const clock = el('span', { class: 'tb-clock' });
  const focusName = el('span', { class: 'tb-focus' });
  const focusIc = el('span', { class: 'tb-focus-ic' });
  const info = el(
    'div',
    { class: 'tb-info' },
    el('div', { class: 'tb-info-l1' }, infoDot, infoTitle, infoSub),
    el('div', { class: 'tb-info-l2' }, hint, clock, el('span', { class: 'tb-focus-wrap' }, focusName, focusIc)),
  );
  info.addEventListener('dblclick', () => commands.run('win.songInfo'));
  mountHint(hint);
  const updProj = () => {
    const t = store.filePath ? basename(store.filePath).replace(/\.lfproj$/i, '') : store.project.info.title || 'Untitled';
    infoTitle.textContent = t;
    const a = store.project.info.author;
    infoSub.textContent = a ? ' · ' + a : '';
    infoDot.classList.toggle('on', store.dirty);
    info.dataset.hint = `${t}${store.dirty ? ' (unsaved changes)' : ''} — double-click for project info (F11)`;
  };
  const updFocus = () => {
    const id = store.ui.focused;
    const w = id ? wm.get(id) : undefined;
    focusName.textContent = w?.visible ? w.titleEl.textContent ?? '' : '';
    const ic = w?.visible ? (w.root.querySelector('.win-icon') as HTMLElement | null)?.innerHTML ?? '' : '';
    if (focusIc.innerHTML !== ic) focusIc.innerHTML = ic;
  };

  // ---- master pitch ----
  let pitchBegin = false;
  const masterPitch = knob({
    def: { key: 'mp', label: 'Master pitch', min: -12, max: 12, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + ' st' },
    get: () => store.project.masterPitch,
    set: (v) => store.live((p) => (p.masterPitch = Math.round(v * 100) / 100)),
    begin: () => {
      pitchBegin = true;
      store.begin('Master pitch');
    },
    end: () => {
      if (pitchBegin) store.end();
      pitchBegin = false;
    },
    size: 28,
    bipolar: true,
  });

  // ---- song position slider ----
  const slider = positionSlider();

  // ---- option toggles (row 2) ----
  const typingBtn = tgl(TB.typing, 'transport.typing', 'typingPiano');
  const octBadge = el('span', { class: 'tb-oct' });
  typingBtn.append(octBadge);
  typingBtn.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      store.setUI({ pianoOctave: clamp(store.ui.pianoOctave + (e.deltaY < 0 ? 1 : -1), 1, 9) });
      toast('Typing keyboard octave ' + store.ui.pianoOctave, 'info', 700);
    },
    { passive: false },
  );
  const homeBtn = btn(TB.toStart, cmdHint('transport.home', 'Song position to start'), () => engine.setPosition(0, store.ui.songMode ? 'song' : 'pattern'), 'tb-opt');
  const ghostBtn = btn(TB.ghost, 'Ghost notes — show other channels in the Piano roll (Alt+V there)', () => store.setUI({ ghost: !store.ui.ghost }), 'tb-opt');
  ghostBtn._key = 'ghost';
  const linkBtn = btn(
    TB.link,
    'Link the selected channels to the selected mixer track',
    () => {
      if (!store.ui.selectedChannels.length) return toast('Select channels in the Channel rack first', 'warn');
      linkChannelsToTrack(store.ui.selectedMixer, store.ui.selectedChannels);
    },
    'tb-opt',
  );
  const panicBtn = btn(TB.panic, cmdHint('transport.panic'), () => commands.run('transport.panic'), 'tb-opt');
  const row2Opts = [typingBtn, homeBtn, ghostBtn, linkBtn, panicBtn];

  // ---- snap ----
  const snapMag = btn(TB.magnet, 'Snap on / off — toggles Line / (none) (Backspace)', () => commands.run('transport.snapToggle'), 'tb-magnet');
  const snapLbl = el('span', { class: 'tb-snap-lbl' });
  const snapBtn = el('button', { class: 'tb-snap', 'data-hint': 'Global snap — click to choose · scroll to change · Backspace toggles Line / (none)' }, snapLbl, el('span', { class: 'tb-snap-caret', html: TB.caret }));
  snapBtn.addEventListener('click', () => {
    const r = snapBtn.getBoundingClientRect();
    showMenu(
      SNAP_ORDER.map((s): MenuItem => ({ label: SNAP_LABELS[s], checked: store.ui.snap === s, action: () => store.setUI({ snap: s }) })),
      r.left,
      r.bottom + 1,
    );
  });
  snapBtn.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const i = SNAP_ORDER.indexOf(store.ui.snap);
      store.setUI({ snap: SNAP_ORDER[clamp(i + (e.deltaY > 0 ? 1 : -1), 0, SNAP_ORDER.length - 1)] });
    },
    { passive: false },
  );

  // ---- pattern selector ----
  const patMenuBtn = el('button', { class: 'tb-pat-menu', html: TB.caret, 'data-hint': 'Pattern menu — select, rename, clone, colour, delete' });
  const patSw = el('span', { class: 'tb-pat-sw' });
  const patName = el('span', { class: 'tb-pat-name' });
  const patNum = el('span', { class: 'tb-pat-num' });
  const patUp = el('button', { class: 'tb-spin', html: TB.spinUp, 'data-hint': 'Next pattern (Num+)' });
  const patDn = el('button', { class: 'tb-spin', html: TB.spinDown, 'data-hint': 'Previous pattern (Num−)' });
  const patBox = el(
    'div',
    { class: 'tb-pat', draggable: 'true', 'data-hint': 'Pattern selector — click for the list · scroll to change · double-click renames (F2) · drag onto the Playlist' },
    patSw,
    patName,
    patNum,
    el('div', { class: 'tb-spins' }, patUp, patDn),
  );
  const patAdd = el('button', { class: 'tb-pat-add', html: TB.plus, 'data-hint': cmdHint('pat.new', 'New pattern') });
  const openPatMenu = () => {
    const r = patBox.getBoundingClientRect();
    patternMenu(r.left, r.bottom + 1);
  };
  patMenuBtn.addEventListener('click', openPatMenu);
  patBox.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('.tb-spin')) openPatMenu();
  });
  patBox.addEventListener('dblclick', (e) => {
    if ((e.target as Element).closest('.tb-spin')) return;
    closeMenus();
    void renamePattern();
  });
  patBox.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const ps = store.project.patterns;
      const i = ps.findIndex((p) => p.id === store.ui.currentPattern);
      const n = clamp(i + (e.deltaY < 0 ? 1 : -1), 0, ps.length - 1);
      if (n !== i) selectPattern(ps[n].id);
    },
    { passive: false },
  );
  patBox.addEventListener('dragstart', (e) => {
    const p = store.currentPattern;
    if (p) setDragData(e, DT_PATTERN, { id: p.id, name: p.name });
  });
  patUp.addEventListener('click', () => stepPattern(1));
  patDn.addEventListener('click', () => stepPattern(-1));
  patAdd.addEventListener('click', () => commands.run('pat.new'));
  const updPat = () => {
    const p = store.currentPattern;
    const i = store.project.patterns.indexOf(p);
    patName.textContent = p?.name ?? '—';
    patNum.textContent = i >= 0 ? String(i + 1) : '';
    patSw.style.background = p?.color ?? '#555';
  };

  // ---- window shortcuts ----
  const winBtn = (icon: string, id: string, cmd: string, prio: number, extra = '') => {
    const b = btn(icon, cmdHint(cmd), () => commands.run(cmd), 'tb-win ' + extra);
    b._win = id;
    b.dataset.prio = String(prio);
    return b;
  };
  const instBtn = btn(
    TB.instrument,
    "Selected channel's instrument window (plugin / Channel settings)",
    () => {
      const ch = store.selectedChannel;
      if (ch) openPluginWindow(ch.id, 'toggle');
      else toast('No channel selected', 'warn');
    },
    'tb-win',
  );
  instBtn.dataset.prio = '74';
  const winBtns = [
    winBtn(TB.playlist, 'playlist', 'win.playlist', 0),
    winBtn(TB.pianoRoll, 'pianoroll', 'win.pianoroll', 0),
    winBtn(TB.channelRack, 'channelrack', 'win.channelrack', 0),
    winBtn(TB.mixer, 'mixer', 'win.mixer', 0),
    winBtn(TB.browser, 'browser', 'win.browser', 72),
    winBtn(TB.plugin, '', 'win.plugins', 76),
    instBtn,
    winBtn(TB.info, '', 'win.songInfo', 96),
    winBtn(TB.arrange, '', 'win.arrange', 97, 'teal'),
  ];
  const updWin = () => {
    for (const b of winBtns) if (b._win) b.classList.toggle('on', !!wm.get(b._win)?.visible);
    const ch = store.selectedChannel;
    instBtn.classList.toggle('on', !!ch && (!!wm.get('plugin:' + ch.id)?.visible || (!!wm.get('channelsettings')?.visible && store.ui.settingsChannel === ch.id)));
    updFocus();
  };
  wm.onChange(updWin);

  // ---- tips ("news") panel ----
  let tipI = Math.floor(Math.random() * TIPS.length);
  const tipHead = el('div', { class: 'tb-news-l1' });
  const tipText = el('div', { class: 'tb-news-l2' });
  const news = el('div', { class: 'tb-news', 'data-hint': 'Tips — click for the next one' }, el('div', { class: 'tb-news-tx' }, tipHead, tipText), el('span', { class: 'tb-news-ic', html: TB.bulb }));
  news.dataset.prio = '94';
  let tipAt = 0;
  const showTip = () => {
    const [cat, txt] = TIPS[tipI % TIPS.length];
    const d = new Date();
    tipHead.innerHTML = '';
    tipHead.append(el('span', { class: 'tb-news-date', text: `${d.getMonth() + 1}/${d.getDate()}` }), ` LOOPFORGE | ${cat}`);
    tipText.textContent = txt;
    tipAt = performance.now();
  };
  news.addEventListener('click', () => {
    tipI++;
    showTip();
  });

  // ================= assemble =================
  const sep = (cls: string, ...kids: (HTMLElement | null)[]) => el('div', { class: 'tb-cell ' + cls }, ...kids);
  const scopeWrap = el('div', { class: 'tb-group' }, scope.el);
  scopeWrap.dataset.prio = '80';
  const monWrap = el('div', { class: 'tb-group' }, monitor.el);
  monWrap.dataset.prio = '90';
  const rest1 = el(
    'div',
    { class: 'tb-rest r1' },
    el('div', { class: 'tb-group' }, pos),
    scopeWrap,
    monWrap,
    el('div', { class: 'tb-spacer' }),
    el('div', { class: 'tb-group tb-utils' }, ...utils),
  );
  const snapGroup = el('div', { class: 'tb-group tb-snapgrp' }, snapMag, snapBtn);
  const patGroup = el('div', { class: 'tb-group tb-patgrp' }, patMenuBtn, patBox, patAdd);
  const rest2 = el(
    'div',
    { class: 'tb-rest r2' },
    snapGroup,
    patGroup,
    el('div', { class: 'tb-group tb-wins' }, ...winBtns),
    el('div', { class: 'tb-spacer' }),
    news,
  );
  const recCell1 = sep('c-rec r1', el('div', { class: 'tb-opts' }, ...recOpts));
  const recCell2 = sep('c-rec r2', el('div', { class: 'tb-opts' }, ...row2Opts));
  const root = el(
    'div',
    { id: 'toolbar', class: 'tb' },
    el('div', { class: 'tb-grip r1' }),
    sep('c-menu r1', menubar),
    sep('c-knob r1', el('div', { class: 'tb-knob vol' }, masterVol)),
    sep('c-trans r1', capsule, recBtn, tempo),
    recCell1,
    rest1,
    el('div', { class: 'tb-grip r2' }),
    sep('c-menu r2', info),
    sep('c-knob r2', el('div', { class: 'tb-knob pitch' }, masterPitch)),
    sep('c-trans r2', slider),
    recCell2,
    rest2,
  );

  // ================= responsive fit =================
  // Each row hides its own panels by priority (highest data-prio first) until it fits; if a row
  // still overflows, the option-button columns of both rows go too (keeps the rows aligned).
  const byPrio = (row: HTMLElement) =>
    [...row.querySelectorAll<HTMLElement>('[data-prio]')].filter((e) => Number(e.dataset.prio) > 0).sort((a, b) => Number(b.dataset.prio) - Number(a.dataset.prio));
  const rows = [
    { rest: rest1, hide: byPrio(rest1) },
    { rest: rest2, hide: byPrio(rest2) },
  ];
  const over = (r: HTMLElement) => r.scrollWidth > r.clientWidth + 1;
  let fitRaf = 0;
  const fitNow = () => {
    fitRaf = 0;
    for (const c of [recCell1, recCell2]) c.classList.remove('tb-hidden');
    for (const r of rows) for (const e of r.hide) e.classList.remove('tb-hidden');
    const fitRow = (r: (typeof rows)[number]) => {
      for (const e of r.hide) {
        if (!over(r.rest)) return true;
        e.classList.add('tb-hidden');
      }
      return !over(r.rest);
    };
    const ok1 = fitRow(rows[0]);
    const ok2 = fitRow(rows[1]);
    if (!ok1 || !ok2) {
      for (const c of [recCell1, recCell2]) c.classList.add('tb-hidden');
      for (const r of rows) for (const e of r.hide) e.classList.remove('tb-hidden');
      fitRow(rows[0]);
      fitRow(rows[1]);
    }
  };
  const fitSoon = () => {
    if (!fitRaf) fitRaf = requestAnimationFrame(fitNow);
  };
  new ResizeObserver(fitSoon).observe(root);
  document.fonts?.ready.then(fitSoon).catch(() => {});

  // ================= state wiring =================
  const updTransport = () => {
    const ui = store.ui;
    patBtn.classList.toggle('on', !ui.songMode);
    songBtn.classList.toggle('on', ui.songMode);
    const playIcon = engine.playing ? TB.pause : TB.play;
    if (playBtn.dataset.icon !== (engine.playing ? 'pause' : 'play')) {
      playBtn.innerHTML = playIcon;
      playBtn.dataset.icon = engine.playing ? 'pause' : 'play';
    }
    playBtn.classList.toggle('on', engine.playing);
    playBtn.classList.toggle('waiting', engine.waitingForInput);
    recBtn.classList.toggle('on', ui.recording);
    for (const b of [...recOpts, ...row2Opts]) if (b._key) b.classList.toggle('on', !!ui[b._key]);
    octBadge.textContent = ui.typingPiano ? String(ui.pianoOctave) : '';
    typingBtn.dataset.hint = `${cmdHint('transport.typing')} — scroll to change octave (now ${ui.pianoOctave})`;
    snapLbl.textContent = snapText(ui.snap);
    snapMag.classList.toggle('on', ui.snap !== 'none');
    masterVol.update();
  };
  store.on('ui', (keys) => {
    updTransport();
    if (keys.includes('currentPattern')) updPat();
    if (keys.includes('focused') || keys.includes('selectedChannels') || keys.includes('settingsChannel')) updWin();
  });
  engine.on('state', updTransport);
  store.on('project', () => {
    tempo.update();
    (masterPitch as KnobEl).update();
    updPat();
    updProj();
  });
  store.on('loaded', () => {
    tempo.update();
    updPat();
    updTransport();
    updProj();
  });
  store.on('dirty', updProj);

  // ================= animation loop =================
  let lastClock = '';
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    pos.update();
    slider.update();
    scope.frame(now);
    monitor.frame(now);
    if (!menusOpen() && openMenu) {
      openMenu = null;
      for (const e of menuBtns.values()) e.classList.remove('open');
    }
    const d = new Date();
    const c = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    if (c !== lastClock) {
      lastClock = c;
      clock.textContent = c;
      if (now - tipAt > 15000) {
        tipI++;
        showTip();
      }
    }
  };
  requestAnimationFrame(frame);

  updTransport();
  updPat();
  updProj();
  updWin();
  showTip();
  return root;
}

export function attachToolbarShortcutsHelp() {
  toast('Tip: F1 shows every shortcut · Ctrl+K searches all commands', 'info', 4000);
}
