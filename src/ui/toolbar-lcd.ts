// Toolbar displays: the light tempo LCD (106.512 style), the big song-position LCD and the
// long song-position slider of the second row.
import { store } from '../core/store';
import { engine } from '../audio/engine';
import { STEP } from '../core/types';
import { clamp, el, fmtBST, fmtTime } from '../core/util';
import { drag, lockHint, promptDialog, showMenu } from './widgets';
import { TB } from './toolbar-icons';

export interface Updatable extends HTMLElement {
  update(): void;
}

// ---------------- tempo ----------------
const MIN_BPM = 10;
const MAX_BPM = 522;
const q = (v: number) => clamp(Math.round(v * 1000) / 1000, MIN_BPM, MAX_BPM);

/** FL-style tempo display: big integer + small decimals. Drag / wheel (decimals = fine), double-click types. */
export function tempoLCD(): Updatable {
  const intEl = el('span', { class: 'tb-tempo-int', 'data-hint': 'Tempo (BPM) — drag up/down or scroll · Shift = fine · double-click to type · right-click for more' });
  const decEl = el('span', { class: 'tb-tempo-dec', 'data-hint': 'Tempo decimals — drag or scroll for fine tempo changes (0.01 BPM, Shift = 0.001)' });
  const up = el('button', { class: 'tb-spin', html: TB.spinUp, 'data-hint': 'Tempo +1 BPM (Shift: +0.01)' });
  const dn = el('button', { class: 'tb-spin', html: TB.spinDown, 'data-hint': 'Tempo −1 BPM (Shift: −0.01)' });
  const box = el('div', { class: 'tb-tempo' }, el('div', { class: 'tb-tempo-val' }, intEl, decEl), el('div', { class: 'tb-spins' }, up, dn)) as unknown as Updatable;
  let last = '';
  box.update = () => {
    const s = store.project.bpm.toFixed(3);
    if (s === last) return;
    last = s;
    const [i, d] = s.split('.');
    intEl.textContent = i;
    decEl.textContent = '.' + d;
  };
  const set = (v: number) => store.live((p) => (p.bpm = q(v)), 'tempo');
  const commitTo = (v: number, label = 'Tempo') => {
    if (q(v) === store.project.bpm) return;
    store.commit(label, (p) => (p.bpm = q(v)));
  };
  const hintNow = () => lockHint(`Tempo: ${store.project.bpm.toFixed(3)} BPM`);

  const startDrag = (e: PointerEvent, fine: boolean) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = store.project.bpm;
    store.begin('Tempo');
    box.classList.add('active');
    hintNow();
    drag(
      e,
      (_dx, dy, ev) => {
        const step = fine ? (ev.shiftKey ? 0.001 : 0.01) : ev.shiftKey ? 0.1 : 1;
        set(start - Math.round(dy / (fine ? 2 : 4)) * step);
        box.update();
        hintNow();
      },
      () => {
        store.end();
        box.classList.remove('active');
        lockHint(null);
      },
    );
  };
  intEl.addEventListener('pointerdown', (e) => startDrag(e, false));
  decEl.addEventListener('pointerdown', (e) => startDrag(e, true));
  const wheel = (fine: boolean) => (e: WheelEvent) => {
    e.preventDefault();
    const step = fine ? (e.shiftKey ? 0.001 : 0.01) : e.shiftKey ? 0.1 : 1;
    commitTo(store.project.bpm + (e.deltaY < 0 ? step : -step));
    box.update();
  };
  intEl.addEventListener('wheel', wheel(false), { passive: false });
  decEl.addEventListener('wheel', wheel(true), { passive: false });
  const typeIn = async () => {
    const v = await promptDialog('Tempo', `Tempo in BPM (${MIN_BPM} – ${MAX_BPM})`, String(+store.project.bpm.toFixed(3)));
    if (v === null) return;
    const n = parseFloat(v.replace(',', '.'));
    if (!isNaN(n)) commitTo(n);
  };
  box.addEventListener('dblclick', (e) => {
    if ((e.target as Element).closest('.tb-spin')) return;
    void typeIn();
  });
  const nudge = (dir: 1 | -1) => (e: MouseEvent) => commitTo(store.project.bpm + dir * (e.shiftKey ? 0.01 : 1));
  up.addEventListener('click', nudge(1));
  dn.addEventListener('click', nudge(-1));
  box.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const bpm = store.project.bpm;
    showMenu(
      [
        { label: 'Type in tempo…', action: () => void typeIn() },
        { sep: true },
        { label: `Round to ${Math.round(bpm)} BPM`, disabled: bpm === Math.round(bpm), action: () => commitTo(Math.round(bpm)) },
        { label: `Half time (${q(bpm / 2).toFixed(3)})`, action: () => commitTo(bpm / 2, 'Half tempo') },
        { label: `Double time (${q(bpm * 2).toFixed(3)})`, action: () => commitTo(bpm * 2, 'Double tempo') },
        { sep: true },
        ...[90, 120, 128, 140, 150, 174].map((v) => ({ label: `${v} BPM`, checked: bpm === v, action: () => commitTo(v) })),
      ],
      e.clientX,
      e.clientY,
    );
  });
  box.update();
  return box;
}

// ---------------- song position ----------------
/** Big "1:01:00" display with a tiny B:S:T / M:S:CS label. Click toggles the time format. */
export function songPosLCD(): Updatable {
  const main = el('span', { class: 'tb-pos-main' });
  const tail = el('span', { class: 'tb-pos-tail' });
  const unit = el('span', { class: 'tb-pos-unit' });
  const box = el(
    'div',
    { class: 'tb-pos', 'data-hint': 'Song position — click to switch Bar:Step:Tick / Min:Sec:Centisec · right-click for options' },
    el('div', { class: 'tb-pos-val' }, main, tail),
    unit,
  ) as unknown as Updatable;
  let lastMain = '';
  let lastTail = '';
  let lastUnit = '';
  box.update = () => {
    const bst = store.ui.timeDisplay === 'bst';
    const s = bst ? fmtBST(engine.position, store.project.timeSig) : fmtTime(engine.seconds);
    const k = s.lastIndexOf(':');
    const m = s.slice(0, k);
    const t = s.slice(k);
    const u = bst ? 'B:S:T' : 'M:S:CS';
    if (m !== lastMain) main.textContent = lastMain = m;
    if (t !== lastTail) tail.textContent = lastTail = t;
    if (u !== lastUnit) unit.textContent = lastUnit = u;
  };
  box.addEventListener('click', () => store.setUI({ timeDisplay: store.ui.timeDisplay === 'bst' ? 'time' : 'bst' }));
  box.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(
      [
        { label: 'Bar : Step : Tick', checked: store.ui.timeDisplay === 'bst', action: () => store.setUI({ timeDisplay: 'bst' }) },
        { label: 'Minutes : Seconds : Centiseconds', checked: store.ui.timeDisplay === 'time', action: () => store.setUI({ timeDisplay: 'time' }) },
        { sep: true },
        { label: 'Song position to start', action: () => engine.setPosition(0, store.ui.songMode ? 'song' : 'pattern') },
      ],
      e.clientX,
      e.clientY,
    );
  });
  box.update();
  return box;
}

// ---------------- long slider (row 2) ----------------
type SliderMode = 'position' | 'volume';
function loadMode(): SliderMode {
  try {
    return localStorage.getItem('lf.tb.slider') === 'volume' ? 'volume' : 'position';
  } catch {
    return 'position';
  }
}

/** Long horizontal slider of row 2. Like FL it shows and scrubs the song position (the pattern in
 *  PAT mode); right-click switches it to a master-volume slider (remembered). */
export function positionSlider(): Updatable {
  const fill = el('div', { class: 'tb-slider-fill' });
  const handle = el('div', { class: 'tb-slider-handle' });
  const track = el('div', { class: 'tb-slider-track' }, fill);
  const box = el('div', { class: 'tb-slider' }, track, handle) as unknown as Updatable;
  let mode = loadMode();
  const MAXV = 1.25;
  const span = () => (store.ui.songMode ? Math.max(store.songLength(), store.barTicks * 4) : Math.max(store.patternLength(), store.barTicks));
  const setHint = () => {
    box.dataset.hint =
      mode === 'position'
        ? 'Song position — drag to move the playhead (Alt = no snap) · scroll steps one bar · right-click: use as master volume'
        : `Master volume: ${Math.round(store.ui.masterVol * 100)}% — drag or scroll · double-click resets · right-click: use as song position`;
    box.classList.toggle('vol', mode === 'volume');
  };
  let lastX = -1;
  box.update = () => {
    const w = track.clientWidth;
    if (!w) return;
    const n = mode === 'position' ? clamp(engine.position / span(), 0, 1) : clamp(store.ui.masterVol / MAXV, 0, 1);
    const x = Math.round(n * w * 2) / 2;
    if (x === lastX) return;
    lastX = x;
    handle.style.transform = `translateX(${x}px)`;
    fill.style.width = x + 'px';
  };
  const scope = () => (store.ui.songMode ? 'song' : 'pattern') as 'song' | 'pattern';
  const seek = (clientX: number, alt: boolean) => {
    const r = track.getBoundingClientRect();
    const n = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
    if (mode === 'volume') {
      store.setUI({ masterVol: Math.round(n * MAXV * 100) / 100 });
      lockHint(`Master volume: ${Math.round(store.ui.masterVol * 100)}%`);
    } else {
      let t = n * span();
      if (!alt) t = Math.round(t / STEP) * STEP;
      engine.setPosition(t, scope());
      lockHint(`Song position: ${fmtBST(engine.position, store.project.timeSig)}`);
    }
    box.update();
  };
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    box.classList.add('active');
    seek(e.clientX, e.altKey);
    drag(
      e,
      (_dx, _dy, ev) => seek(ev.clientX, ev.altKey),
      () => {
        box.classList.remove('active');
        lockHint(null);
        setHint();
      },
    );
  });
  box.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (mode === 'volume') {
        store.setUI({ masterVol: clamp(Math.round((store.ui.masterVol + (e.deltaY < 0 ? 0.02 : -0.02)) * 100) / 100, 0, MAXV) });
        setHint();
      } else {
        const bar = store.barTicks;
        const cur = Math.round(engine.position / bar) * bar;
        engine.setPosition(clamp(cur + (e.deltaY < 0 ? bar : -bar), 0, span()), scope());
      }
      box.update();
    },
    { passive: false },
  );
  box.addEventListener('dblclick', () => {
    if (mode === 'volume') store.setUI({ masterVol: 0.8 });
    setHint();
  });
  box.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const set = (m: SliderMode) => {
      mode = m;
      try {
        localStorage.setItem('lf.tb.slider', m);
      } catch {}
      lastX = -1;
      setHint();
      box.update();
    };
    showMenu(
      [
        { label: 'Song position slider', checked: mode === 'position', action: () => set('position') },
        { label: 'Master volume slider', checked: mode === 'volume', action: () => set('volume') },
      ],
      e.clientX,
      e.clientY,
    );
  });
  store.on('ui', (keys) => {
    if (mode === 'volume' && keys.includes('masterVol')) setHint();
  });
  setHint();
  return box;
}
