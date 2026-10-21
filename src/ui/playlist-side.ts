// Playlist side panels (FL 21 look): the clip picker — coloured pattern / audio / automation blocks
// with a mini preview of their content — and the coloured track headers (name, icon, level bars,
// mute LED).
import { store } from '../core/store';
import { ClipKind, ID, PlaylistTrack } from '../core/types';
import { PALETTE, clamp, el, hexToRgb } from '../core/util';
import { ICONS } from './icons';
import { MenuItem, colorMenu, confirmDialog, drag, promptDialog, showMenu, toast } from './widgets';
import { DT_PATTERN, pickSamples, setDragData } from './dnd';
import { clonePattern, createPattern, deletePattern, patternColor, renamePattern, selectPattern } from './actions';
import { addChannel, deleteChannels } from './ops';
import { wm } from './wm';
import {
  DEFAULT_TRACK_H,
  Source,
  TRACK_HEIGHTS,
  currentSource,
  deleteTrack,
  ensureTracks,
  firstClips,
  insertTrack,
  soloTrack,
  swapTracks,
  trackDisplayColor,
} from './playlist-model';
import { View, drawSourcePreview, previewSignature, trackHeight, trackTop } from './playlist-render';
import { ICON_ORDER, LEVEL_SVG, TRACK_ICONS, resolveTrackIcon, setTrackIcon, trackIconChoice } from './playlist-icons';

/** Drag type for clip sources dragged out of the picker: JSON { kind, ref }. */
export const DT_PLCLIP = 'application/x-loopforge-plclip';

/** The picker item currently being dragged (dataTransfer contents are unreadable during dragover). */
export let pickerDrag: Source | null = null;

function setText(e: HTMLElement, s: string) {
  if (e.textContent !== s) e.textContent = s;
}

export function setSource(kind: ClipKind, ref: ID) {
  if (kind === 'pattern') selectPattern(ref);
  else store.setUI({ plSource: { kind, ref } });
}

function rgbMix(hex: string, to: [number, number, number], t: number) {
  const c = hexToRgb(hex);
  return `rgb(${Math.round(c[0] + (to[0] - c[0]) * t)},${Math.round(c[1] + (to[1] - c[1]) * t)},${Math.round(c[2] + (to[2] - c[2]) * t)})`;
}
const WHITE: [number, number, number] = [255, 255, 255];
const DARK: [number, number, number] = [26, 34, 39];

// ---------------------------------------------------------------------------
// clip picker
// ---------------------------------------------------------------------------
export interface Picker {
  root: HTMLElement;
  sync(force?: boolean): void;
}

const PICK_KEY = 'lf.pl.pickerShow';
function loadShow(): Record<ClipKind, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(PICK_KEY) ?? '{}') ?? {};
    return { pattern: v.pattern !== false, audio: v.audio !== false, automation: v.automation !== false };
  } catch {
    return { pattern: true, audio: true, automation: true };
  }
}

interface PickItem {
  el: HTMLElement;
  cv: HTMLCanvasElement;
  kind: ClipKind;
  ref: ID;
  color: string;
  sig: string;
}

export function createPicker(): Picker {
  const show = loadShow();
  const list = el('div', { class: 'pl-pk-list' });
  const head = el('div', { class: 'pl-pk-head' });
  const root = el('div', { class: 'pl-picker' }, head, list);
  let sig = '';
  let structSig = '';
  const items = new Map<string, PickItem>();

  // header: FL-like source filters (patterns / audio / automation) + new pattern
  const filt = (kind: ClipKind, icon: string, hint: string) => {
    const b = el('button', { class: 'pl-pk-f' + (show[kind] ? ' on' : ''), html: icon, 'data-hint': hint });
    b.addEventListener('click', () => {
      show[kind] = !show[kind];
      b.classList.toggle('on', show[kind]);
      try {
        localStorage.setItem(PICK_KEY, JSON.stringify(show));
      } catch {}
      sync(true);
    });
    return b;
  };
  const newPat = el('button', { class: 'pl-pk-f pl-pk-new', html: ICONS.plus, 'data-hint': 'New pattern (F4)' });
  newPat.addEventListener('click', () => createPattern(true));
  head.append(
    filt('pattern', ICONS.pianoRoll, 'Show / hide patterns in the picker'),
    filt('audio', ICONS.wave, 'Show / hide audio clips in the picker'),
    filt('automation', ICONS.automation, 'Show / hide automation clips in the picker'),
    el('div', { class: 'pl-pk-sp' }),
    newPat,
  );

  const addAudio = async () => {
    const got = await pickSamples(true);
    if (!got.length) return;
    let last: ID | null = null;
    store.begin('Add audio clip source');
    for (const s of got) last = addChannel('sampler', { sampleRef: s.ref, name: s.name, audioClip: true, group: 'Audio', mixer: 0 }, false);
    store.end();
    if (last) store.setUI({ plSource: { kind: 'audio', ref: last } });
  };

  const section = (title: string, kind: ClipKind, count: number, add?: () => void, addHint?: string) => {
    const h = el('div', { class: 'pl-pk-sec', 'data-kind': kind }, el('span', { class: 'pl-pk-sec-t', text: title }), el('span', { class: 'pl-pk-count', text: String(count) }));
    if (add) {
      const b = el('button', { class: 'pl-pk-add', html: ICONS.plus, 'data-hint': addHint ?? '' });
      b.addEventListener('click', add);
      h.append(b);
    }
    return h;
  };

  const glyph = (kind: ClipKind) => (kind === 'pattern' ? '<i class="pl-pk-pg"><b></b><b></b><b></b></i>' : kind === 'audio' ? ICONS.wave : ICONS.automation);

  const item = (kind: ClipKind, ref: ID, name: string, color: string, label: string, hint: string) => {
    const cv = el('canvas', { class: 'pl-pk-cv' }) as HTMLCanvasElement;
    const it = el(
      'div',
      { class: 'pl-pk-item k-' + kind, draggable: true, 'data-hint': hint, 'data-num': label },
      cv,
      el('span', { class: 'pl-pk-mark' }),
      el('span', { class: 'pl-pk-g', html: glyph(kind) }),
      el('span', { class: 'pl-pk-name', text: name }),
    );
    it.style.setProperty('--c', color);
    it.style.setProperty('--c1', rgbMix(color, WHITE, 0.08));
    it.style.setProperty('--c2', rgbMix(color, DARK, 0.22));
    it.addEventListener('click', () => setSource(kind, ref));
    it.addEventListener('dblclick', () => {
      if (kind === 'pattern') wm.show('channelrack');
      else if (kind === 'audio') {
        store.setUI({ settingsChannel: ref, selectedChannels: [ref] });
        wm.show('channelsettings');
      }
    });
    it.addEventListener('dragstart', (e) => {
      pickerDrag = { kind, ref };
      setDragData(e, DT_PLCLIP, { kind, ref, name });
      if (kind === 'pattern') e.dataTransfer?.setData(DT_PATTERN, JSON.stringify({ id: ref, name }));
    });
    it.addEventListener('dragend', () => (pickerDrag = null));
    it.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      itemMenu(kind, ref, e.clientX, e.clientY);
    });
    items.set(kind + ':' + ref, { el: it, cv, kind, ref, color, sig: '' });
    return it;
  };

  const itemMenu = (kind: ClipKind, ref: ID, x: number, y: number) => {
    let menu: MenuItem[] = [];
    if (kind === 'pattern') {
      menu = [
        { label: 'Rename…', action: () => renamePattern(ref) },
        { label: 'Color…', action: () => patternColor(ref, x, y) },
        { label: 'Clone', action: () => clonePattern(ref) },
        { sep: true },
        { label: 'Open in channel rack', action: () => (selectPattern(ref), wm.show('channelrack')) },
        { sep: true },
        { label: 'Delete pattern', action: () => deletePattern(ref) },
      ];
    } else if (kind === 'audio') {
      menu = [
        {
          label: 'Rename…',
          action: async () => {
            const ch = store.channel(ref);
            const n = ch && (await promptDialog('Rename audio clip', 'Name', ch.name));
            if (n && n.trim()) store.commit('Rename audio clip', (p) => (p.channels.find((c) => c.id === ref)!.name = n.trim()));
          },
        },
        { label: 'Color…', action: () => colorMenu(PALETTE, (c) => store.commit('Audio clip color', (p) => (p.channels.find((x) => x.id === ref)!.color = c)), x, y) },
        { label: 'Channel settings…', action: () => (store.setUI({ settingsChannel: ref, selectedChannels: [ref] }), wm.show('channelsettings')) },
        { sep: true },
        {
          label: 'Delete (removes its clips)',
          action: async () => {
            const used = store.project.playlist.clips.filter((c) => c.kind === 'audio' && c.ref === ref).length;
            if (used) {
              const r = await confirmDialog('Delete audio clip', `This removes the audio channel and its ${used} clip(s) from the playlist.`, [{ label: 'Cancel', value: 'no' }, { label: 'Delete', value: 'yes', primary: true }], 'no');
              if (r !== 'yes') return;
            }
            deleteChannels([ref]);
          },
        },
      ];
    } else {
      menu = [
        {
          label: 'Rename…',
          action: async () => {
            const a = store.project.automations.find((q) => q.id === ref);
            const n = a && (await promptDialog('Rename automation clip', 'Name', a.name));
            if (n && n.trim()) store.commit('Rename automation', (p) => (p.automations.find((q) => q.id === ref)!.name = n.trim()));
          },
        },
        { label: 'Color…', action: () => colorMenu(PALETTE, (c) => store.commit('Automation color', (p) => (p.automations.find((q) => q.id === ref)!.color = c)), x, y) },
        { sep: true },
        {
          label: 'Delete automation (and its clips)',
          action: () =>
            store.commit('Delete automation', (p) => {
              p.automations = p.automations.filter((q) => q.id !== ref);
              p.playlist.clips = p.playlist.clips.filter((c) => !(c.kind === 'automation' && c.ref === ref));
            }),
        },
      ];
    }
    showMenu(menu, x, y);
  };

  const rebuild = () => {
    const p = store.project;
    items.clear();
    list.textContent = '';
    if (show.pattern) {
      list.append(section('Patterns', 'pattern', p.patterns.length, () => createPattern(true), 'New pattern (F4)'));
      p.patterns.forEach((pt, i) =>
        list.append(item('pattern', pt.id, pt.name, pt.color, String(i + 1), `Pattern ${i + 1} "${pt.name}" — click: paint source + current pattern · drag onto a track · double-click: channel rack · right-click: options`)),
      );
    }
    const audio = p.channels.filter((c) => c.audioClip);
    if (show.audio) {
      list.append(section('Audio clips', 'audio', audio.length, addAudio, 'Load audio files as new audio clips'));
      if (!audio.length) list.append(el('div', { class: 'pl-pk-empty', text: 'Drop audio files from the Browser or your disk onto a track' }));
      for (const c of audio) list.append(item('audio', c.id, c.name, c.color, '', `Audio clip "${c.name}" — click: paint source · drag onto a track · double-click: channel settings`));
    }
    if (show.automation) {
      list.append(section('Automation', 'automation', p.automations.length));
      if (!p.automations.length) list.append(el('div', { class: 'pl-pk-empty', text: 'Right-click any knob → Create automation clip' }));
      for (const a of p.automations) list.append(item('automation', a.id, a.name, a.color, '', `Automation clip "${a.name}" — click: paint source · drag onto a track`));
    }
  };

  const drawPreviews = () => {
    const p = store.project;
    const dpr = window.devicePixelRatio || 1;
    for (const it of items.values()) {
      const w = it.el.clientWidth - 2, h = it.el.clientHeight - 2;
      if (w <= 4 || h <= 4) continue;
      const s = previewSignature(p, it.kind, it.ref) + `|${w}x${h}@${dpr}|${it.color}`;
      if (s === it.sig) continue;
      it.sig = s;
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (it.cv.width !== W || it.cv.height !== H) {
        it.cv.width = W;
        it.cv.height = H;
        it.cv.style.width = w + 'px';
        it.cv.style.height = h + 'px';
      }
      const g = it.cv.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSourcePreview(g, p, it.kind, it.ref, w, h, dpr, rgbMix(it.color, WHITE, 0.55));
    }
  };

  const sync = (force = false) => {
    if (!store.project) return;
    const p = store.project;
    const s =
      p.patterns.map((x) => x.id + x.name + x.color).join('|') +
      '#' +
      p.channels.filter((c) => c.audioClip).map((x) => x.id + x.name + x.color).join('|') +
      '#' +
      p.automations.map((x) => x.id + x.name + x.color).join('|');
    if (force || s !== structSig) {
      structSig = s;
      sig = '';
      rebuild();
    }
    drawPreviews();
    const src = currentSource();
    const sel = (src ? src.kind + ':' + src.ref : '') + '@' + store.ui.currentPattern;
    if (sel === sig) return;
    sig = sel;
    for (const [k, it] of items) {
      it.el.classList.toggle('on', !!src && k === src.kind + ':' + src.ref);
      it.el.classList.toggle('cur', k === 'pattern:' + store.ui.currentPattern);
    }
    const on = src ? items.get(src.kind + ':' + src.ref)?.el : null;
    if (on) {
      const r = on.getBoundingClientRect(), lr = list.getBoundingClientRect();
      if (lr.height && (r.top < lr.top || r.bottom > lr.bottom)) on.scrollIntoView({ block: 'nearest' });
    }
  };
  new ResizeObserver(() => drawPreviews()).observe(list);

  return { root, sync };
}

// ---------------------------------------------------------------------------
// track headers
// ---------------------------------------------------------------------------
export interface Headers {
  root: HTMLElement;
  sync(v: View): void;
  /** Light the level bars of the tracks that are playing a clip (null = none). */
  setActive(tracks: Set<number> | null): void;
}

interface HeaderOpts {
  selectTrack: (i: number, add: boolean) => void;
  getView: () => View;
  onWheel: (e: WheelEvent) => void;
  refresh: () => void;
}

class TrackHead {
  root: HTMLElement;
  name: HTMLElement;
  icon: HTMLElement;
  lv: HTMLElement;
  led: HTMLElement;
  strip: HTMLElement;
  index = 0;
  id: ID;
  editing = false;
  private color = '';
  private iconId = '-';
  constructor(t: PlaylistTrack, private o: HeaderOpts) {
    this.id = t.id;
    this.strip = el('div', { class: 'pl-th-color', 'data-hint': 'Track color — click to change' });
    this.name = el('span', { class: 'pl-th-name' });
    this.icon = el('span', { class: 'pl-th-ic', 'data-hint': 'Track icon — right-click the header › Icon to change' });
    this.lv = el('span', { class: 'pl-th-lv', html: LEVEL_SVG });
    this.led = el('div', { class: 'led pl-th-led', 'data-hint': 'Track mute — click: mute / unmute · right-click or Ctrl+click: solo' });
    const rs = el('div', { class: 'pl-th-rs', 'data-hint': 'Drag to change the track height' });
    this.root = el(
      'div',
      { class: 'pl-th' },
      this.strip,
      el('div', { class: 'pl-th-main' }, this.name),
      this.icon,
      this.lv,
      el('div', { class: 'pl-th-ledcol' }, this.led),
      rs,
    );
    this.root.dataset.hint = 'Track — click: select its clips · double-click name: rename · right-click: track menu (color, icon, height…)';

    this.strip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      const r = this.strip.getBoundingClientRect();
      const id = this.id;
      colorMenu(PALETTE, (c) => store.commit('Track color', (p) => {
        const tr = p.playlist.tracks.find((x) => x.id === id);
        if (tr) tr.color = c;
      }), r.right + 2, r.top);
    });
    this.led.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const i = this.index;
      if (e.button === 2 || e.ctrlKey) store.commit('Solo track', (p) => soloTrack(p, i));
      else if (e.button === 0) store.commit(store.project.playlist.tracks[i]?.mute ? 'Unmute track' : 'Mute track', (p) => (p.playlist.tracks[i].mute = !p.playlist.tracks[i].mute));
    });
    this.led.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.editing) return;
      if ((e.target as HTMLElement).closest('.pl-th-rs')) return;
      o.selectTrack(this.index, e.ctrlKey || e.shiftKey);
    });
    this.name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.rename();
    });
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      trackMenu(this.index, e.clientX, e.clientY, () => this.rename(), o.refresh);
    });
    rs.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const i = this.index;
      const h0 = store.project.playlist.tracks[i]?.height ?? DEFAULT_TRACK_H;
      const vz = o.getView().vz;
      let began = false;
      drag(
        e,
        (_dx, dy) => {
          if (!began) {
            began = true;
            store.begin('Track height');
          }
          const h = Math.round(clamp(h0 + dy / vz, 22, 260));
          store.live((p) => {
            if (p.playlist.tracks[i]) p.playlist.tracks[i].height = h;
          });
        },
        () => began && store.end(),
      );
    });
    this.root.addEventListener('wheel', (e) => o.onWheel(e), { passive: false });
  }

  rename() {
    if (this.editing) return;
    const i = this.index;
    const t = store.project.playlist.tracks[i];
    if (!t) return;
    this.editing = true;
    const inp = el('input', { class: 'pl-th-input', value: t.name, type: 'text' }) as HTMLInputElement;
    this.name.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      this.editing = false;
      inp.replaceWith(this.name);
      const v = inp.value.trim();
      const id = this.id;
      if (ok && v && v !== t.name)
        store.commit('Rename track', (p) => {
          const tr = p.playlist.tracks.find((x) => x.id === id);
          if (tr) tr.name = v;
        });
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  update(t: PlaylistTrack, i: number, top: number, h: number, look: { color: string; plain: boolean; icon: string }) {
    this.index = i;
    this.id = t.id;
    const s = this.root.style;
    const tp = top + 'px', hp = h + 'px';
    if (s.top !== tp) s.top = tp;
    if (s.height !== hp) s.height = hp;
    this.root.classList.toggle('muted', t.mute);
    this.root.classList.toggle('compact', h < 44);
    this.root.classList.toggle('plain', look.plain);
    this.led.classList.toggle('on', !t.mute);
    if (this.color !== look.color) {
      this.color = look.color;
      s.setProperty('--tc', look.color);
      s.setProperty('--tc1', rgbMix(look.color, WHITE, 0.07));
      s.setProperty('--tc2', rgbMix(look.color, DARK, 0.16));
      s.setProperty('--tc3', rgbMix(look.color, DARK, 0.4));
      this.strip.style.background = t.color;
    }
    if (this.iconId !== look.icon) {
      this.iconId = look.icon;
      this.icon.innerHTML = look.icon ? TRACK_ICONS[look.icon]?.svg ?? '' : '';
    }
    if (!this.editing) setText(this.name, t.name);
  }
}

export function trackMenu(i: number, x: number, y: number, rename?: () => void, refresh?: () => void) {
  const p = store.project;
  const t = p.playlist.tracks[i];
  if (!t) return;
  const n = p.playlist.tracks.length;
  const height = (label: string, h: number): MenuItem => ({ label, checked: t.height === h, action: () => store.commit('Track height', (pp) => (pp.playlist.tracks[i].height = h)) });
  const choice = trackIconChoice(t.id);
  const icon = (id: string, label: string): MenuItem => ({
    label,
    checked: choice === id,
    action: () => {
      setTrackIcon(t.id, id);
      refresh?.();
    },
  });
  const items: MenuItem[] = [
    {
      label: 'Rename…',
      action:
        rename ??
        (async () => {
          const v = await promptDialog('Rename track', 'Track name', t.name);
          if (v && v.trim()) store.commit('Rename track', (pp) => (pp.playlist.tracks[i].name = v.trim()));
        }),
    },
    { label: 'Color…', action: () => colorMenu(PALETTE, (c) => store.commit('Track color', (pp) => (pp.playlist.tracks[i].color = c)), x, y) },
    {
      label: 'Icon',
      submenu: [icon('auto', 'Auto (from the clips)'), icon('none', 'None'), { sep: true }, ...ICON_ORDER.map((id) => icon(id, TRACK_ICONS[id].label))],
    },
    { sep: true },
    { label: 'Mute', checked: t.mute, action: () => store.commit(t.mute ? 'Unmute track' : 'Mute track', (pp) => (pp.playlist.tracks[i].mute = !pp.playlist.tracks[i].mute)) },
    { label: 'Solo', action: () => store.commit('Solo track', (pp) => soloTrack(pp, i)) },
    { label: 'Unmute all tracks', action: () => store.commit('Unmute all tracks', (pp) => pp.playlist.tracks.forEach((q) => (q.mute = false))) },
    { sep: true },
    { label: 'Insert track above', action: () => store.commit('Insert track', (pp) => insertTrack(pp, i)) },
    {
      label: 'Delete track',
      disabled: n <= 1,
      action: () => {
        const count = p.playlist.clips.filter((c) => c.track === i).length;
        store.commit('Delete track', (pp) => deleteTrack(pp, i));
        if (count) toast(`Deleted track ${i + 1} and its ${count} clip(s) — Ctrl+Z to undo`, 'info', 2200);
      },
    },
    { label: 'Move up', disabled: i === 0, action: () => store.commit('Move track up', (pp) => swapTracks(pp, i, i - 1)) },
    { label: 'Move down', disabled: i >= n - 1, action: () => store.commit('Move track down', (pp) => swapTracks(pp, i, i + 1)) },
    { sep: true },
    { label: 'Height', submenu: [height('Small', TRACK_HEIGHTS.small), height('Medium', TRACK_HEIGHTS.medium), height('Large', TRACK_HEIGHTS.large)] },
  ];
  showMenu(items, Math.min(x, innerWidth - 400), y);
}

export function createHeaders(o: HeaderOpts): Headers {
  const addRow = el('div', { class: 'pl-th-add', 'data-hint': 'Add a playlist track (tracks are also created automatically when you drop clips below the last one)' }, el('span', { html: ICONS.plus }), el('span', { text: 'Add track' }));
  addRow.addEventListener('click', () => store.commit('Add track', (p) => ensureTracks(p, p.playlist.tracks.length + 1)));
  const inner = el('div', { class: 'pl-heads-in' }, addRow);
  const root = el('div', { class: 'pl-heads' }, inner);
  root.addEventListener('wheel', (e) => o.onWheel(e), { passive: false });
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  const heads = new Map<ID, TrackHead>();
  let idSig = '';
  let active = new Set<number>();

  const sync = (v: View) => {
    const p = store.project;
    const tracks = p.playlist.tracks;
    const ids = tracks.map((t) => t.id).join(',');
    if (ids !== idSig) {
      idSig = ids;
      const keep = new Set(tracks.map((t) => t.id));
      for (const [id, h] of heads) {
        if (!keep.has(id)) {
          h.root.remove();
          heads.delete(id);
        }
      }
      // create missing heads and keep DOM order == track order (only moves nodes that are out of place)
      let prev: ChildNode | null = addRow;
      for (const t of tracks) {
        let h = heads.get(t.id);
        if (!h) {
          h = new TrackHead(t, o);
          heads.set(t.id, h);
        }
        const expected: ChildNode | null = prev!.nextSibling;
        if (expected !== h.root) inner.insertBefore(h.root, expected);
        prev = h.root;
      }
    }
    const tf = `translateY(${-v.sy}px)`;
    if (inner.style.transform !== tf) inner.style.transform = tf;
    const y0 = v.sy - 200, y1 = v.sy + v.h + 200;
    const first = firstClips(p);
    tracks.forEach((t, i) => {
      const h = heads.get(t.id)!;
      const top = trackTop(v, i), hh = trackHeight(v, i);
      const vis = top + hh >= y0 && top <= y1;
      if (vis) {
        if (h.root.style.display) h.root.style.display = '';
        const look = trackDisplayColor(p, i, first);
        h.update(t, i, top, hh, { color: look.color, plain: look.plain, icon: resolveTrackIcon(p, i) });
        h.root.classList.toggle('act', active.has(i));
      } else {
        h.index = i;
        if (h.root.style.display !== 'none') h.root.style.display = 'none';
      }
    });
    const at = trackTop(v, tracks.length);
    addRow.style.top = at + 'px';
    addRow.style.height = Math.min(v.rowH, 34) + 'px';
    inner.style.height = at + v.rowH + 'px';
  };
  const setActive = (tracks: Set<number> | null) => {
    const next = tracks ?? new Set<number>();
    if (next.size === active.size && [...next].every((x) => active.has(x))) return;
    active = next;
    for (const h of heads.values()) h.root.classList.toggle('act', active.has(h.index));
  };
  return { root, sync, setActive };
}
