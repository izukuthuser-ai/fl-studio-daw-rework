// Toolbar visualisers: master oscilloscope / spectrum + stereo peak meter, and the performance
// monitor (estimated load with history, polyphony, memory). Everything is HiDPI canvas, drawn
// from the toolbar's single animation loop.
import { store } from '../core/store';
import { engine } from '../audio/engine';
import { clamp, el } from '../core/util';
import { TB } from './toolbar-icons';

function loadPref(key: string, def: string): string {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}
function savePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {}
}

/** Size a canvas backing store to its CSS box × devicePixelRatio. Returns the 2D context in CSS px. */
function fit(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return null;
  // include CSS zoom (the toolbar scales up on wide screens) so the canvas stays sharp
  const zoom = c.getBoundingClientRect().width / w || 1;
  const dpr = (window.devicePixelRatio || 1) * zoom;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (c.width !== W) c.width = W;
  if (c.height !== H) c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

type ScopeMode = 'wave' | 'spectrum';

export interface MeterPanel {
  el: HTMLElement;
  frame(now: number): void;
}

/** Oscilloscope / spectrum (click to switch) + stereo peak meter; the eye turns the display off. */
export function scopePanel(): MeterPanel {
  const wave = el('canvas', { class: 'tb-scope-c', 'data-hint': 'Master output — click to switch oscilloscope / spectrum' }) as HTMLCanvasElement;
  const peak = el('canvas', { class: 'tb-peak-c', 'data-hint': 'Master peak level (left / right) with peak hold' }) as HTMLCanvasElement;
  const eye = el('button', { class: 'tb-eye', html: TB.eye, 'data-hint': 'Show / hide the output visualisers' });
  const root = el('div', { class: 'tb-scope' }, el('div', { class: 'tb-scope-a' }, wave), el('div', { class: 'tb-scope-b' }, peak, eye));
  let mode: ScopeMode = loadPref('lf.tb.scope', 'wave') === 'spectrum' ? 'spectrum' : 'wave';
  let on = loadPref('lf.tb.scopeOn', '1') !== '0';
  root.classList.toggle('off', !on);
  wave.addEventListener('click', () => {
    mode = mode === 'wave' ? 'spectrum' : 'wave';
    savePref('lf.tb.scope', mode);
  });
  eye.addEventListener('click', () => {
    on = !on;
    savePref('lf.tb.scopeOn', on ? '1' : '0');
    root.classList.toggle('off', !on);
    clear();
  });

  const tbuf = new Float32Array(512);
  const fbuf = new Uint8Array(256);
  const spec = new Float32Array(28);
  const level = [0, 0];
  const hold = [0, 0];
  const holdT = [0, 0];
  let idle = 0;

  function clear() {
    for (const c of [wave, peak]) {
      const f = fit(c);
      f?.g.clearRect(0, 0, f.w, f.h);
    }
    drawPeak(true);
  }

  function drawWave() {
    const f = fit(wave);
    if (!f) return;
    const { g, w, h } = f;
    g.clearRect(0, 0, w, h);
    const an = engine.ready ? engine.graph.master.analysers : [];
    if (mode === 'wave') {
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, Math.round(h / 2), w, 1);
      if (!an[0]) return;
      an[0].getFloatTimeDomainData(tbuf);
      // trigger on a rising zero crossing so the trace stands still for periodic sounds
      let start = 0;
      for (let i = 1; i < 200; i++)
        if (tbuf[i - 1] < 0 && tbuf[i] >= 0) {
          start = i;
          break;
        }
      const n = Math.min(tbuf.length - start, 300);
      g.beginPath();
      for (let x = 0; x <= w; x++) {
        const v = tbuf[start + Math.floor((x / w) * (n - 1))];
        const y = h / 2 - clamp(v, -1, 1) * (h / 2 - 1.5);
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = '#dff4fb';
      g.lineWidth = 1.2;
      g.lineJoin = 'round';
      g.shadowColor = 'rgba(160,220,255,0.6)';
      g.shadowBlur = 3;
      g.stroke();
      g.shadowBlur = 0;
    } else {
      if (!an[0]) return;
      an[0].getByteFrequencyData(fbuf);
      const bands = spec.length;
      const bw = w / bands;
      for (let b = 0; b < bands; b++) {
        const lo = Math.floor(Math.pow(fbuf.length, b / bands));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(fbuf.length, (b + 1) / bands)));
        let m = 0;
        for (let i = lo; i < hi && i < fbuf.length; i++) m = Math.max(m, fbuf[i]);
        const v = m / 255;
        spec[b] = v > spec[b] ? v : spec[b] * 0.86 + v * 0.14;
        const bh = Math.max(1, spec[b] * (h - 2));
        g.fillStyle = `rgba(206,238,250,${0.35 + spec[b] * 0.6})`;
        g.fillRect(b * bw + 1, h - bh, Math.max(1, bw - 2), bh);
      }
    }
  }

  function drawPeak(force = false) {
    const f = fit(peak);
    if (!f) return;
    const { g, w, h } = f;
    const m = engine.ready ? engine.readMeters()[0] ?? [0, 0] : [0, 0];
    const now = performance.now();
    let changed = force;
    for (let c = 0; c < 2; c++) {
      const v = on ? m[c] ?? 0 : 0;
      const nl = v > level[c] ? v : level[c] * 0.88;
      if (Math.abs(nl - level[c]) > 1e-4) changed = true;
      level[c] = nl < 1e-4 ? 0 : nl;
      if (v >= hold[c]) {
        hold[c] = v;
        holdT[c] = now;
      } else if (now - holdT[c] > 900) {
        const nh = hold[c] * 0.92;
        hold[c] = nh < 1e-4 ? 0 : nh;
        changed = true;
      }
    }
    if (!changed) return;
    g.clearRect(0, 0, w, h);
    const toX = (lin: number) => {
      const db = lin > 0 ? 20 * Math.log10(lin) : -60;
      return clamp((db + 48) / 51, 0, 1) * (w - 4);
    };
    const bh = Math.max(3, Math.floor((h - 9) / 2));
    // scale ticks: −36 −24 −12 −6 0 dB
    g.fillStyle = 'rgba(255,255,255,0.10)';
    for (const db of [-36, -24, -12, -6, 0]) g.fillRect(2 + Math.round(clamp((db + 48) / 51, 0, 1) * (w - 4)), 2, 1, h - 4);
    const grad = g.createLinearGradient(2, 0, w - 2, 0);
    grad.addColorStop(0, '#6fcf5a');
    grad.addColorStop(0.72, '#c6e35a');
    grad.addColorStop(0.86, '#f2c94a');
    grad.addColorStop(0.95, '#f2683f');
    for (let c = 0; c < 2; c++) {
      const y = 3 + c * (bh + 3);
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(2, y, w - 4, bh);
      const x = toX(level[c]);
      g.fillStyle = grad;
      if (x > 0) g.fillRect(2, y, x, bh);
      if (hold[c] > 0.0008) {
        const hx = toX(hold[c]);
        g.fillStyle = hold[c] >= 0.995 ? '#ff6a4d' : '#e8f4f8';
        g.fillRect(2 + Math.max(0, hx - 1), y, 2, bh);
      }
    }
  }

  return {
    el: root,
    frame() {
      if (!on || root.offsetParent === null) return;
      const quiet = !engine.playing && engine.voiceCount === 0 && level[0] + level[1] + hold[0] + hold[1] === 0;
      if (quiet) {
        if (idle++ > 3) return; // a few more frames to settle, then stop drawing while silent
      } else idle = 0;
      drawWave();
      drawPeak();
    },
  };
}

// ---------------- performance monitor ----------------
export function monitorPanel(): MeterPanel {
  const cpu = el('canvas', { class: 'tb-cpu-c' }) as HTMLCanvasElement;
  const cpuNum = el('span', { class: 'tb-mon-num' });
  const poly = el('span', { class: 'tb-mon-num' });
  const ram = el('span', { class: 'tb-mon-num' });
  const fx = el('span', { class: 'tb-mon-num' });
  const cpuHint = 'Estimated processing load — playing voices, active effects and interface frame time';
  const root = el(
    'div',
    { class: 'tb-mon' },
    el('div', { class: 'tb-mon-cpu', 'data-hint': cpuHint }, cpu),
    el('div', { class: 'tb-mon-cell', 'data-hint': cpuHint }, cpuNum, el('span', { class: 'tb-mon-lbl', text: 'CPU' })),
    el('div', { class: 'tb-mon-cell', 'data-hint': 'Memory used by the app (JavaScript heap)' }, ram, el('span', { class: 'tb-mon-lbl', text: 'RAM' })),
    el('div', { class: 'tb-mon-cell', 'data-hint': 'Polyphony — voices playing right now' }, poly, el('span', { class: 'tb-mon-lbl', text: 'POLY' })),
    el('div', { class: 'tb-mon-cell', 'data-hint': 'Effect slots active in the mixer' }, fx, el('span', { class: 'tb-mon-lbl', text: 'FX' })),
  );
  const hist = new Float32Array(60);
  let histI = 0;
  let lastT = 0;
  let uiBusy = 0;
  let load = 0;
  let lastSample = 0;
  let renderLoad = -1; // from AudioContext.renderCapacity where the runtime supports it
  let fxCount = 0;
  const countFx = () => {
    let n = 0;
    for (const m of store.project.mixer) for (const f of m.fx) if (f.enabled) n++;
    fxCount = n;
  };
  store.on('project', countFx);
  store.on('loaded', countFx);
  countFx();
  let rcTried = false;
  const tryRenderCapacity = () => {
    if (rcTried || !engine.ready) return;
    rcTried = true;
    const rc = (engine.ctx as any).renderCapacity;
    if (!rc?.start) return;
    try {
      rc.addEventListener('update', (e: any) => (renderLoad = clamp(Number(e.averageLoad) || 0, 0, 1)));
      rc.start({ updateInterval: 0.5 });
    } catch {
      renderLoad = -1;
    }
  };
  let lastTxt = '';

  function draw() {
    const f = fit(cpu);
    if (!f) return;
    const { g, w, h } = f;
    g.clearRect(0, 0, w, h);
    const barH = Math.round(h * 0.42);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, 0, w, barH);
    const bw = Math.max(2, Math.round((load / 100) * w));
    g.fillStyle = load > 85 ? '#ff7a5c' : load > 60 ? '#f3d36b' : '#e4ecef';
    g.fillRect(0, 0, bw, barH);
    // history graph
    g.beginPath();
    const gy0 = barH + 2;
    const gh = h - gy0 - 1;
    for (let i = 0; i < hist.length; i++) {
      const v = hist[(histI + i) % hist.length];
      const x = (i / (hist.length - 1)) * w;
      const y = gy0 + gh - (v / 100) * gh;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = 'rgba(205,228,236,0.75)';
    g.lineWidth = 1;
    g.stroke();
  }

  return {
    el: root,
    frame(now: number) {
      if (lastT) {
        const dt = now - lastT;
        const busy = dt > 0 ? clamp((dt - 16.7) / dt, 0, 1) : 0;
        uiBusy = uiBusy * 0.92 + busy * 0.08;
      }
      lastT = now;
      if (now - lastSample < 250 || root.offsetParent === null) return;
      lastSample = now;
      tryRenderCapacity();
      const voices = engine.voiceCount;
      const est = renderLoad >= 0 ? renderLoad * 100 : voices * 1.6 + (engine.playing ? 3 : 0.5) + fxCount * 0.9;
      const target = clamp(est + uiBusy * 30, 0, 100);
      load = load * 0.5 + target * 0.5;
      hist[histI] = load;
      histI = (histI + 1) % hist.length;
      const mem = (performance as any).memory?.usedJSHeapSize as number | undefined;
      const memTxt = mem ? `${Math.round(mem / 1048576)} MB` : '—';
      const txt = `${Math.round(load)}|${voices}|${memTxt}|${fxCount}`;
      if (txt !== lastTxt) {
        lastTxt = txt;
        cpuNum.textContent = Math.round(load) + '%';
        poly.textContent = String(voices);
        ram.textContent = memTxt;
        fx.textContent = String(fxCount);
      }
      draw();
    },
  };
}
