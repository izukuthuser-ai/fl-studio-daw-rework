import './styles.css';
import './audio/plugins';
import { store } from './core/store';
import { defaultUI, demoProject } from './core/project';
import { el } from './core/util';
import { engine } from './audio/engine';
import { createToolbar } from './ui/toolbar';
import { initWM, wm } from './ui/wm';
import { registerGlobalCommands, hooks } from './ui/actions';
import { initDialogs } from './ui/dialogs';
import { initKeys, initMidi } from './ui/keys';
import { checkRecovery, confirmDiscard, loadProject, openProject, parseProjectText, serialize, startAutosave, updateTitle } from './ui/fileops';
import { native } from './core/native';
import { ICONS } from './ui/icons';
import { createPianoRoll } from './ui/pianoRoll';
import { createPlaylist } from './ui/playlist';
import { createChannelRack } from './ui/channelRack';
import { createMixer } from './ui/mixer';
import { createBrowser } from './ui/browser';
import { createChannelSettings } from './ui/channelSettings';
import { initPluginPicker } from './ui/pluginPicker';
import { toast } from './ui/widgets';
import { PanelDef } from './ui/panel';
import { renderProject } from './audio/render';
import { placeRecordedAudio } from './ui/ops';
import { samples } from './audio/samples';
import { ensureWorklets } from './audio/plugins/registry';
import { createEffect } from './audio/effects';
import { encodeWav } from './audio/render';
import { openPluginWindow, openFxWindow } from './ui/pluginWindow';
import { WindowId } from './core/types';

async function boot() {
  registerGlobalCommands();
  initDialogs();
  const p = demoProject();
  store.load(p, defaultUI(p));
  await engine.init();
  engine.on('audioRecorded', (takes) => placeRecordedAudio(takes));

  const workspace = el('div', { id: 'workspace' });
  const app = document.getElementById('app')!;
  initWM(workspace);
  app.append(createToolbar(), el('div', { id: 'main' }, workspace));

  const W = workspace.clientWidth || 1400;
  const H = workspace.clientHeight || 800;
  const BW = 300;
  const add = (id: WindowId, title: string, icon: string, panel: PanelDef, rect: { x: number; y: number; w: number; h: number }, min?: { w: number; h: number }) =>
    wm.add({ id, title, icon, body: panel.body, headerExtra: panel.headerExtra, onResize: panel.onResize, onShow: panel.onShow, onHide: panel.onHide, rect, min });

  add('browser', 'Browser', ICONS.browser, createBrowser(), { x: 0, y: 0, w: BW, h: H }, { w: 180, h: 200 });
  add('playlist', 'Playlist — Arrangement', ICONS.playlist, createPlaylist(), { x: BW, y: 0, w: W - BW, h: H }, { w: 420, h: 220 });
  add('channelrack', 'Channel rack', ICONS.channelRack, createChannelRack(), { x: BW + 30, y: 26, w: Math.min(820, W - BW - 60), h: 360 }, { w: 420, h: 160 });
  add('pianoroll', 'Piano roll', ICONS.pianoRoll, createPianoRoll(), { x: BW + 60, y: 50, w: W - BW - 90, h: Math.round(H * 0.68) }, { w: 480, h: 240 });
  add('mixer', 'Mixer', ICONS.mixer, createMixer(), { x: BW + 20, y: Math.round(H * 0.36), w: W - BW - 40, h: Math.round(H * 0.62) }, { w: 520, h: 300 });
  add('channelsettings', 'Channel settings', ICONS.synth, createChannelSettings(), { x: Math.round(W * 0.32), y: 30, w: 640, h: 500 }, { w: 420, h: 320 });
  initPluginPicker();

  if (!wm.restoreLayout()) {
    wm.show('browser');
    wm.show('playlist');
    wm.show('channelrack');
  } else if (!wm.get('playlist')!.visible) wm.show('playlist');

  // keep the playlist docked next to the browser: widen it when the browser hides
  let browserVis = wm.get('browser')!.visible;
  wm.onChange(() => {
    const b = wm.get('browser')!;
    const pl = wm.get('playlist')!;
    if (b.visible === browserVis || pl.maximized) return;
    browserVis = b.visible;
    const r = pl.rect();
    const bw = b.rect().w;
    if (!b.visible && Math.abs(r.x - bw) < 8) pl.setRect({ ...r, x: 0, w: r.w + bw });
    else if (b.visible && r.x < 8) pl.setRect({ ...r, x: bw, w: Math.max(420, r.w - bw) });
  });

  initKeys();
  initMidi();
  updateTitle();
  store.on('dirty', updateTitle);

  // Electron: close confirmation & file association
  native.onRequestClose(async () => {
    if (await confirmDiscard()) native.confirmClose();
  });
  native.onOpenFile((path) => openProject(path));
  const launch = await native.getLaunchFile();
  const recovered = await checkRecovery();
  if (launch && !recovered) await openProject(launch);
  startAutosave();

  // global file drop fallback: projects open, audio becomes sampler channels
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    const proj = files.find((f) => /\.lfproj$/i.test(f.name));
    if (proj) {
      const path = native.pathForFile(proj);
      if (path) await openProject(path);
      else toast('Use File → Open to load projects in the web version', 'info');
    }
  });

  if (!recovered && !launch) toast('Demo song loaded — Space plays the pattern, L switches to Song mode · F1 = shortcuts', 'info', 5000);
  (window as any).__lf = { store, engine, wm, hooks, renderProject, samples, ensureWorklets, createEffect, encodeWav, openPluginWindow, openFxWindow, parseProjectText, serialize, loadProject };
}

boot().catch((e) => {
  console.error(e);
  document.body.append(el('pre', { style: { color: '#f66', padding: '20px' }, text: 'Startup error: ' + (e?.stack ?? e) }));
});
