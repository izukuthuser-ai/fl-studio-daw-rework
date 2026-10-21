// FL-style plugin windows: one floating window per plugin channel ("plugin:<channelId>") and per mixer
// effect ("fx:<slotId>"). The wrapper shows presets, channel vol/pan/pitch/track (instruments) or
// bypass/mix (effects) above the plugin's own UI.
import { store } from '../core/store';
import { Channel, FxSlot } from '../core/types';
import { deepClone, el } from '../core/util';
import { CHANNEL_PARAMS, FX_DEFS, fmtParam, ParamDef } from '../core/params';
import { engine } from '../audio/engine';
import { getFxUI, getInstrument } from '../audio/plugins/registry';
import type { FxPluginUIApi, InstrumentPlugin, PluginPreset, PluginUI, PluginUIApi } from '../audio/plugins/api';
import { wm } from './wm';
import { knob, KnobEl, MenuItem, promptDialog, select, showMenu, toast } from './widgets';
import { createAutomation } from './ops';
import { ICONS } from './icons';
import './pluginWindow.css';

let cascade = 0;
function nextRect(w: number, h: number) {
  const ws = wm.workspace.getBoundingClientRect();
  const i = cascade++ % 8;
  return { x: Math.max(0, Math.min(ws.width - w, 260 + i * 26)), y: Math.max(0, Math.min(ws.height - h, 30 + i * 22)), w, h };
}

// ---------------- user presets (per plugin, stored locally) ----------------
function userPresets(pluginId: string): PluginPreset[] {
  try {
    return JSON.parse(localStorage.getItem('lf.presets.' + pluginId) ?? '[]');
  } catch {
    return [];
  }
}
function saveUserPreset(pluginId: string, p: PluginPreset) {
  const list = userPresets(pluginId).filter((x) => x.name !== p.name);
  list.push(p);
  try {
    localStorage.setItem('lf.presets.' + pluginId, JSON.stringify(list));
  } catch {}
}

function allPresets(plug: InstrumentPlugin): PluginPreset[] {
  return [...plug.presets(), ...userPresets(plug.id).map((p) => ({ ...p, category: 'User' }))];
}

// ---------------- instrument windows ----------------
function channelApi(channelId: string): PluginUIApi {
  const st = () => store.channel(channelId)?.plugin?.state;
  return {
    channelId,
    getState: () => st(),
    commit: (label, fn) =>
      store.commit(label, (p) => {
        const c = p.channels.find((x) => x.id === channelId);
        if (c?.plugin) fn(c.plugin.state);
      }),
    begin: (label) => store.begin(label),
    live: (fn) =>
      store.live((p) => {
        const c = p.channels.find((x) => x.id === channelId);
        if (c?.plugin) fn(c.plugin.state);
      }),
    end: () => store.end(),
    host: () => (engine.ready ? engine.graph.channels.get(channelId)?.host ?? null : null),
    noteOn: (key, vel = 0.8) => engine.noteOn(key, vel, channelId, 'pw:' + key),
    noteOff: (key) => engine.noteOff(key, channelId, 'pw:' + key),
    automate: (param) => createAutomation({ scope: 'channel', id: channelId, param }),
    onExternalChange: (fn) => store.on('project', () => fn()),
    bpm: () => store.project.bpm,
  };
}

function channelKnob(ch: () => Channel | undefined, key: 'vol' | 'pan' | 'pitch', label: string): KnobEl {
  const def: ParamDef = key === 'pitch' ? { ...CHANNEL_PARAMS.pitch, min: -24, max: 24 } : CHANNEL_PARAMS[key];
  const id = () => ch()?.id ?? '';
  return knob({
    def,
    get: () => (ch() as any)?.[key] ?? def.def,
    set: (v) => store.live((p) => {
      const c = p.channels.find((x) => x.id === id());
      if (c) (c as any)[key] = key === 'pitch' ? Math.round(v * 100) / 100 : v;
    }),
    begin: () => store.begin(label),
    end: () => store.end(),
    size: 26,
    label,
    bipolar: key !== 'vol',
    onAutomate: key === 'pitch' ? undefined : () => createAutomation({ scope: 'channel', id: id(), param: key }),
  });
}

function buildInstrumentWindow(channelId: string, plug: InstrumentPlugin) {
  const ch = () => store.channel(channelId);
  const api = channelApi(channelId);
  // header: presets
  const presetName = el('span', { class: 'pw-preset-name' });
  const stepPreset = (dir: number) => {
    const list = allPresets(plug);
    const cur = ch()?.plugin?.preset;
    const i = list.findIndex((p) => p.name === cur);
    const n = list[(i + dir + list.length) % list.length];
    if (n) loadPreset(n);
  };
  const loadPreset = (pr: PluginPreset) => {
    store.commit('Load preset', (p) => {
      const c = p.channels.find((x) => x.id === channelId);
      if (!c?.plugin) return;
      const wasDefaultName = c.name === c.plugin.preset || c.name === plug.name || c.name === 'Init';
      c.plugin.state = deepClone(pr.state);
      c.plugin.preset = pr.name;
      if (wasDefaultName) c.name = pr.name === 'Init' ? plug.name : pr.name;
    });
  };
  const presetMenu = (x: number, y: number) => {
    const list = allPresets(plug);
    const cats = [...new Set(list.map((p) => p.category))];
    const items: MenuItem[] = cats.map((cat) => ({
      label: cat,
      submenu: list.filter((p) => p.category === cat).map((p) => ({ label: p.name, checked: p.name === ch()?.plugin?.preset, action: () => loadPreset(p) })),
    }));
    items.push({ sep: true }, {
      label: 'Save preset as…',
      action: async () => {
        const name = await promptDialog('Save preset', 'Preset name', ch()?.plugin?.preset ?? 'My preset');
        if (!name) return;
        saveUserPreset(plug.id, { name, category: 'User', state: deepClone(ch()?.plugin?.state) });
        store.commit('Name preset', (p) => {
          const c = p.channels.find((x) => x.id === channelId);
          if (c?.plugin) c.plugin.preset = name;
        });
        toast(`Preset "${name}" saved`, 'ok');
      },
    });
    showMenu(items, x, y);
  };
  const presetBox = el('div', { class: 'pw-presets' },
    el('button', { class: 'pw-arrow', html: '&#9664;', 'data-hint': 'Previous preset', onclick: () => stepPreset(-1) }),
    el('button', { class: 'pw-arrow', html: '&#9654;', 'data-hint': 'Next preset', onclick: () => stepPreset(1) }),
    el('button', { class: 'pw-preset', 'data-hint': 'Presets — click to browse, save your own', onclick: (e: MouseEvent) => presetMenu(e.clientX, e.clientY) }, presetName, el('span', { class: 'pw-caret', html: ICONS.chevronDown })),
  );

  // wrapper strip: channel settings like FL (pan / vol / pitch / mixer track)
  const kVol = channelKnob(ch, 'vol', 'VOL');
  const kPan = channelKnob(ch, 'pan', 'PAN');
  const kPitch = channelKnob(ch, 'pitch', 'PITCH');
  const trackSel = select(
    store.project.mixer.map((m, i) => ({ value: i, label: i === 0 ? 'Master' : `${i} · ${m.name}` })),
    ch()?.mixer ?? 0,
    (v) => store.commit('Route channel', (p) => {
      const c = p.channels.find((x) => x.id === channelId);
      if (c) c.mixer = v;
    }),
    'Mixer track this channel plays through',
  );
  const strip = el('div', { class: 'pw-strip' },
    el('div', { class: 'pw-plugname', style: { color: plug.color } }, el('span', { class: 'pw-plugicon', html: plug.icon }), plug.name),
    el('div', { class: 'pw-sp' }),
    kPan, kVol, kPitch,
    el('div', { class: 'pw-track' }, el('span', { class: 'pw-lbl', text: 'TRACK' }), trackSel),
  );

  let ui: PluginUI | null = null;
  try {
    ui = plug.createUI(api);
  } catch (e: any) {
    console.error(e);
    ui = { el: el('div', { class: 'empty-hint', text: 'Plugin UI failed to load: ' + (e?.message ?? e) }) };
  }
  const body = el('div', { class: 'pw' }, strip, el('div', { class: 'pw-ui' }, ui.el));

  const update = () => {
    const c = ch();
    if (!c) return;
    presetName.textContent = c.plugin?.preset ?? 'Init';
    kVol.update();
    kPan.update();
    kPitch.update();
    if (trackSel.options.length !== store.project.mixer.length) {
      trackSel.innerHTML = '';
      store.project.mixer.forEach((m, i) => trackSel.append(el('option', { value: String(i), text: i === 0 ? 'Master' : `${i} · ${m.name}` })));
    }
    trackSel.value = String(c.mixer);
    w.setTitle(`${c.name} (${plug.name})`);
  };
  const size = plug.size;
  const w = wm.add({
    id: 'plugin:' + channelId,
    title: plug.name,
    icon: plug.icon,
    body,
    headerExtra: presetBox,
    rect: nextRect(size.w, size.h + 24 + 46),
    min: { w: 360, h: 220 },
    onResize: () => ui?.onResize?.(),
    onShow: () => ui?.onShow?.(),
    onHide: () => ui?.onHide?.(),
  });
  const off = store.on('project', () => {
    if (!ch()) {
      off();
      ui?.destroy?.();
      wm.remove('plugin:' + channelId);
      return;
    }
    update();
  });
  update();
  return w;
}

/** Click on a channel button (FL): toggle its plugin window. Sampler / Tri-Osc use the Channel settings window. */
export function openPluginWindow(channelId: string, mode: 'toggle' | 'show' = 'toggle') {
  const c = store.channel(channelId);
  if (!c) return;
  if (c.type !== 'plugin') {
    const cs = wm.get('channelsettings');
    const same = store.ui.settingsChannel === channelId;
    store.setUI({ settingsChannel: channelId });
    if (mode === 'toggle' && cs?.visible && same && store.ui.focused === 'channelsettings') cs.hide();
    else wm.show('channelsettings');
    return;
  }
  const plug = getInstrument(c.plugin?.type);
  if (!plug) {
    toast(`Plugin "${c.plugin?.type}" is not available`, 'warn');
    return;
  }
  const id = 'plugin:' + channelId;
  const w = wm.get(id) ?? buildInstrumentWindow(channelId, plug);
  if (mode === 'toggle') wm.toggle(id);
  else w.show();
}

// ---------------- effect windows ----------------
function findSlot(slotId: string): { track: number; slot: FxSlot } | null {
  const mx = store.project.mixer;
  for (let i = 0; i < mx.length; i++) {
    const s = mx[i].fx.find((f) => f.id === slotId);
    if (s) return { track: i, slot: s };
  }
  return null;
}

function fxApi(slotId: string): FxPluginUIApi {
  const loc = () => findSlot(slotId);
  const mut = (fn: (s: FxSlot) => void) => (p: typeof store.project) => {
    for (const m of p.mixer) {
      const s = m.fx.find((f) => f.id === slotId);
      if (s) fn(s);
    }
  };
  return {
    get trackIndex() {
      return loc()?.track ?? -1;
    },
    slotId,
    getSlot: () => loc()?.slot,
    commit: (label, fn) => store.commit(label, mut(fn)),
    begin: (label) => store.begin(label),
    live: (fn) => store.live(mut(fn)),
    end: () => store.end(),
    effect: () => {
      if (!engine.ready) return null;
      for (const s of engine.graph.stripOrder) for (const e of s.effects) if (e.slot.id === slotId) return e;
      return null;
    },
    automate: (param) => createAutomation({ scope: 'fx', id: slotId, param }),
    onExternalChange: (fn) => store.on('project', () => fn()),
  };
}

function genericFxUI(api: FxPluginUIApi): PluginUI {
  const slot = api.getSlot();
  const def = slot ? FX_DEFS[slot.type] : null;
  const grid = el('div', { class: 'pw-fxgrid' });
  const knobs: KnobEl[] = [];
  const sels: { s: HTMLSelectElement; key: string }[] = [];
  for (const p of def?.params ?? []) {
    if (p.options) {
      const s = select(p.options.map((o, i) => ({ value: i, label: o })), api.getSlot()?.params[p.key] ?? p.def, (v) => api.commit(p.label, (sl) => (sl.params[p.key] = v)), p.label);
      sels.push({ s, key: p.key });
      grid.append(el('div', { class: 'pw-fxsel' }, el('label', { text: p.label }), s));
    } else {
      const k = knob({
        def: p,
        get: () => api.getSlot()?.params[p.key] ?? p.def,
        set: (v) => api.live((sl) => (sl.params[p.key] = v)),
        begin: () => api.begin(p.label),
        end: () => api.end(),
        size: 38,
        label: p.label,
        bipolar: p.min < 0 && p.max > 0,
        onAutomate: () => api.automate(p.key),
      });
      knobs.push(k);
      grid.append(k);
    }
  }
  const off = api.onExternalChange(() => {
    knobs.forEach((k) => k.update());
    for (const { s, key } of sels) s.value = String(api.getSlot()?.params[key] ?? 0);
  });
  return { el: el('div', { class: 'pw-generic' }, el('div', { class: 'pw-fxdesc', text: def?.desc ?? '' }), grid), destroy: off };
}

function buildFxWindow(slotId: string) {
  const api = fxApi(slotId);
  const loc = findSlot(slotId);
  if (!loc) return null;
  const def = FX_DEFS[loc.slot.type];
  const custom = getFxUI(loc.slot.type);
  const bypass = el('button', { class: 'pw-bypass', 'data-hint': 'Enable / bypass this effect' });
  bypass.onclick = () => api.commit('Toggle effect', (s) => (s.enabled = !s.enabled));
  const mix = knob({
    def: { key: 'mix', label: 'Mix', min: 0, max: 1, def: def?.defaultMix ?? 1, fmt: (v) => Math.round(v * 100) + '%' },
    get: () => api.getSlot()?.mix ?? 1,
    set: (v) => api.live((s) => (s.mix = v)),
    begin: () => api.begin('Effect mix'),
    end: () => api.end(),
    size: 26,
    label: 'MIX',
  });
  const strip = el('div', { class: 'pw-strip' }, bypass, el('div', { class: 'pw-plugname', text: def?.name ?? loc.slot.type }), el('div', { class: 'pw-sp' }), mix);
  let ui: PluginUI;
  try {
    ui = custom ? custom.createUI(api) : genericFxUI(api);
  } catch (e: any) {
    console.error(e);
    ui = { el: el('div', { class: 'empty-hint', text: 'Effect UI failed to load: ' + (e?.message ?? e) }) };
  }
  const size = custom?.size ?? { w: Math.max(380, Math.min(720, (def?.params.length ?? 4) * 74 + 40)), h: 210 };
  const update = () => {
    const l = findSlot(slotId);
    if (!l) return;
    bypass.classList.toggle('on', l.slot.enabled);
    bypass.textContent = l.slot.enabled ? 'ON' : 'OFF';
    mix.update();
    w.setTitle(`${FX_DEFS[l.slot.type]?.name ?? l.slot.type} (${store.project.mixer[l.track]?.name ?? ''})`);
  };
  const w = wm.add({
    id: 'fx:' + slotId,
    title: def?.name ?? 'Effect',
    icon: ICONS.mixer,
    body: el('div', { class: 'pw' }, strip, el('div', { class: 'pw-ui' }, ui.el)),
    rect: nextRect(size.w, size.h + 24 + 46),
    min: { w: 320, h: 180 },
    onResize: () => ui.onResize?.(),
    onShow: () => ui.onShow?.(),
    onHide: () => ui.onHide?.(),
  });
  const off = store.on('project', () => {
    if (!findSlot(slotId)) {
      off();
      ui.destroy?.();
      wm.remove('fx:' + slotId);
      return;
    }
    update();
  });
  update();
  return w;
}

/** Open (or toggle) the window of a mixer effect slot. */
export function openFxWindow(slotId: string, mode: 'toggle' | 'show' = 'toggle') {
  const id = 'fx:' + slotId;
  const w = wm.get(id) ?? buildFxWindow(slotId);
  if (!w) return;
  if (mode === 'toggle') wm.toggle(id);
  else w.show();
}

export { fmtParam };
