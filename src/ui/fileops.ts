// File operations: new/open/save/export, recent files, autosave & crash recovery.
import { store } from '../core/store';
import { Project, Note } from '../core/types';
import { basicProject, defaultUI, demoProject, emptyProject, newChannel, sanitizeProject } from '../core/project';
import { native, basename, isElectron } from '../core/native';
import { samples } from '../audio/samples';
import { encodeWav, peakDb, renderProject } from '../audio/render';
import { readMidi, writeMidi } from '../core/midi';
import { confirmDialog, modal, toast, select } from './widgets';
import { el, paletteColor } from '../core/util';
import { engine } from '../audio/engine';
import { patternLen } from '../core/timing';

const PROJ_FILTER = [{ name: 'LoopForge Project', extensions: ['lfproj'] }];

export function projectName(): string {
  if (store.filePath) return basename(store.filePath).replace(/\.lfproj$/i, '');
  return store.project.info.title || 'Untitled';
}

export function updateTitle() {
  native.setTitle(`${store.dirty ? '● ' : ''}${projectName()} — LoopForge Studio`);
}

export function getRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem('lf.recent') ?? '[]');
  } catch {
    return [];
  }
}
function addRecent(path: string) {
  if (!isElectron) return;
  const r = [path, ...getRecent().filter((p) => p !== path)].slice(0, 10);
  try {
    localStorage.setItem('lf.recent', JSON.stringify(r));
  } catch {}
}

/** Ask to save if dirty. Returns false if the user cancelled. */
export async function confirmDiscard(): Promise<boolean> {
  if (!store.dirty) return true;
  const r = await confirmDialog('Unsaved changes', `Save changes to "${projectName()}" first?`, [
    { label: 'Cancel', value: 'cancel' },
    { label: "Don't save", value: 'discard' },
    { label: 'Save', value: 'save', primary: true },
  ], 'cancel');
  if (r === 'cancel') return false;
  if (r === 'save') return saveProject();
  return true;
}

export function loadProject(p: Project, path: string | null) {
  engine.stop();
  store.load(p, defaultUI(p), path);
  store.validateUI();
  updateTitle();
}

export async function newProject(kind: 'empty' | 'basic' | 'demo' = 'basic') {
  if (!(await confirmDiscard())) return;
  const p = kind === 'demo' ? demoProject() : kind === 'basic' ? basicProject() : emptyProject();
  loadProject(p, null);
  toast(kind === 'demo' ? 'Demo project loaded' : 'New project', 'ok');
}

function collectRefs(p: Project) {
  return p.channels.map((c) => c.sampler?.sampleRef).filter(Boolean) as string[];
}

export async function serialize(embedFiles = false): Promise<string> {
  const p: Project = JSON.parse(JSON.stringify(store.project));
  const { map, rename } = await samples.exportEmbedded(collectRefs(p), embedFiles);
  for (const c of p.channels) if (c.sampler?.sampleRef && rename[c.sampler.sampleRef]) c.sampler.sampleRef = rename[c.sampler.sampleRef];
  const out: any = { ...p };
  if (Object.keys(map).length) out.embedded = map;
  return JSON.stringify(out);
}

export function parseProjectText(text: string): Project {
  const raw = JSON.parse(text);
  samples.importEmbedded(raw.embedded);
  delete raw.embedded;
  return sanitizeProject(raw);
}

export async function openProject(path?: string) {
  if (!(await confirmDiscard())) return;
  try {
    let text: string;
    let p: string | null;
    let files0Name = '';
    if (path) {
      const data = await native.readFile(path);
      if (!data) throw new Error('File not found: ' + path);
      text = new TextDecoder().decode(data);
      p = path;
    } else {
      const files = await native.openFile({ title: 'Open project', filters: PROJ_FILTER });
      if (!files) return;
      text = new TextDecoder().decode(files[0].data);
      files0Name = files[0].name.replace(/\.lfproj$/i, '');
      p = isElectron ? files[0].path : null;
    }
    const proj = parseProjectText(text);
    if (!p && files0Name) proj.info.title = files0Name;
    loadProject(proj, p);
    if (p) addRecent(p);
    const missing = collectRefs(proj).filter((r) => r.startsWith('file:'));
    await Promise.all(missing.map((r) => samples.ensure(r)));
    const lost = missing.filter((r) => samples.isMissing(r));
    if (lost.length) toast(`${lost.length} sample(s) could not be found`, 'warn', 4000);
    else toast('Opened ' + projectName(), 'ok');
  } catch (e: any) {
    toast('Could not open project: ' + (e?.message ?? e), 'error', 5000);
  }
}

export async function saveProject(): Promise<boolean> {
  if (isElectron && store.filePath) {
    const ok = await native.writeFile(store.filePath, await serialize());
    if (ok) {
      store.markSaved(store.filePath);
      updateTitle();
      toast('Saved', 'ok', 1200);
    } else toast('Save failed', 'error');
    return ok;
  }
  return saveProjectAs();
}

export async function saveProjectAs(embed = false): Promise<boolean> {
  const path = await native.saveFile({ title: 'Save project as', defaultPath: projectName() + '.lfproj', filters: PROJ_FILTER, data: await serialize(embed) });
  if (!path) return false;
  store.markSaved(isElectron ? path : null);
  if (!isElectron) store.project.info.title = basename(path).replace(/\.lfproj$/i, '');
  addRecent(path);
  updateTitle();
  toast('Saved ' + basename(path), 'ok');
  return true;
}

/** FL's Ctrl+N: save as a new numbered version next to the current file. */
export async function saveNewVersion() {
  if (!isElectron || !store.filePath) return saveProjectAs();
  const m = store.filePath.match(/^(.*?)(?:_(\d+))?\.lfproj$/i);
  const base = m ? m[1] : store.filePath.replace(/\.lfproj$/i, '');
  const n = m && m[2] ? parseInt(m[2]) + 1 : 2;
  const path = `${base}_${n}.lfproj`;
  if (await native.writeFile(path, await serialize())) {
    store.markSaved(path);
    addRecent(path);
    updateTitle();
    toast('Saved new version: ' + basename(path), 'ok');
  }
}

export async function openRecent(i: number) {
  const r = getRecent()[i];
  if (r) await openProject(r);
  else toast('No recent project in slot ' + i, 'info');
}

// ---------------- export ----------------
export async function exportAudio(format: 'wav' | 'mp3' = 'wav', stemsTracks?: number[]) {
  const st = { mode: (store.ui.songMode ? 'song' : 'pattern') as 'song' | 'pattern', sr: 44100, bits: 24 as 16 | 24 | 32, tail: 2 };
  const body = el(
    'div',
    { class: 'form-grid' },
    el('label', { text: 'Source' }),
    select([{ value: 'song', label: 'Song (playlist)' }, { value: 'pattern', label: 'Current pattern' }], st.mode, (v) => (st.mode = v as any)),
    el('label', { text: 'Sample rate' }),
    select([{ value: 44100, label: '44 100 Hz' }, { value: 48000, label: '48 000 Hz' }, { value: 96000, label: '96 000 Hz' }], st.sr, (v) => (st.sr = v)),
    el('label', { text: 'Bit depth' }),
    select([{ value: 16, label: '16-bit (dithered)' }, { value: 24, label: '24-bit' }, { value: 32, label: '32-bit float' }], st.bits, (v) => (st.bits = v as any)),
    el('label', { text: 'Tail' }),
    select([{ value: 0, label: 'Cut at end' }, { value: 2, label: '2 seconds' }, { value: 5, label: '5 seconds' }], st.tail, (v) => (st.tail = v)),
  );
  if (format === 'mp3') body.prepend(el('div', { class: 'modal-msg', style: { gridColumn: '1 / -1', color: 'var(--text-dim)' }, text: 'MP3 encoding is not bundled yet — the render will be saved as WAV.' }));
  const go = await modal<boolean>(stemsTracks ? 'Render armed tracks' : 'Export audio', body, [
    { label: 'Cancel', value: false },
    { label: 'Render', value: true, primary: true },
  ], { cancelValue: false, width: 420 }).promise;
  if (!go) return;
  toast('Rendering…', 'info', 1500);
  const t0 = performance.now();
  try {
    const name = projectName();
    const jobs = stemsTracks ? stemsTracks.map((t) => ({ tracks: [t], suffix: '_' + store.project.mixer[t].name.replace(/[^\w-]+/g, '_') })) : [{ tracks: undefined, suffix: '' }];
    for (const job of jobs) {
      const buf = await renderProject(store.project, { mode: st.mode, patternId: store.ui.currentPattern, sampleRate: st.sr, tail: st.tail, onlyTracks: job.tracks });
      const wav = encodeWav(buf, st.bits);
      const path = await native.saveFile({ title: 'Export WAV', defaultPath: name + job.suffix + '.wav', filters: [{ name: 'WAV audio', extensions: ['wav'] }], data: wav });
      if (!path) return;
      const pk = peakDb(buf);
      toast(`Exported ${basename(path)} — ${buf.duration.toFixed(1)} s, peak ${isFinite(pk) ? pk.toFixed(1) : '-inf'} dB (${((performance.now() - t0) / 1000).toFixed(1)} s)`, 'ok', 4500);
    }
  } catch (e: any) {
    console.error(e);
    toast('Export failed: ' + (e?.message ?? e), 'error', 5000);
  }
}

export async function exportMidi() {
  const p = store.project;
  const tracks: { name: string; channel: number; notes: Note[] }[] = [];
  const song = store.ui.songMode && p.playlist.clips.some((c) => c.kind === 'pattern');
  p.channels.forEach((ch, i) => {
    const notes: Note[] = [];
    if (song) {
      for (const c of p.playlist.clips) {
        if (c.kind !== 'pattern' || c.muted) continue;
        const pat = p.patterns.find((x) => x.id === c.ref);
        if (!pat) continue;
        const plen = patternLen(pat, p.timeSig);
        for (let k = 0; k * plen < c.len + c.offset; k++)
          for (const n of pat.notes[ch.id] ?? []) {
            const st = c.start - c.offset + k * plen + n.start;
            if (st >= c.start && st < c.start + c.len) notes.push({ ...n, start: st, len: Math.min(n.len, c.start + c.len - st) });
          }
      }
    } else notes.push(...(store.currentPattern.notes[ch.id] ?? []));
    if (notes.length) tracks.push({ name: ch.name, channel: Math.min(15, i === 9 ? 10 : i % 16), notes });
  });
  if (!tracks.length) {
    toast('Nothing to export — no notes found', 'warn');
    return;
  }
  const data = writeMidi(tracks, p.bpm, p.timeSig);
  const path = await native.saveFile({ title: 'Export MIDI', defaultPath: projectName() + '.mid', filters: [{ name: 'MIDI file', extensions: ['mid', 'midi'] }], data });
  if (path) toast('Exported ' + basename(path), 'ok');
}

export async function importMidi() {
  const files = await native.openFile({ title: 'Import MIDI file', filters: [{ name: 'MIDI file', extensions: ['mid', 'midi'] }] });
  if (!files) return;
  try {
    const m = readMidi(files[0].data);
    if (!m.tracks.length) {
      toast('No notes in that MIDI file', 'warn');
      return;
    }
    const pat = store.currentPattern;
    store.commit('Import MIDI', (p) => {
      const pt = p.patterns.find((x) => x.id === pat.id)!;
      if (m.tracks.length === 1) {
        const ch = p.channels.find((c) => c.id === store.pianoChannel?.id) ?? p.channels[0];
        if (!ch) return;
        pt.notes[ch.id] = [...(pt.notes[ch.id] ?? []), ...m.tracks[0].notes];
      } else {
        m.tracks.forEach((t, i) => {
          const ch = newChannel('synth', { name: t.name, preset: 'Saw Lead', color: paletteColor(p.channels.length + i) }, p.channels.length);
          p.channels.push(ch);
          pt.notes[ch.id] = t.notes;
        });
      }
    });
    toast(`Imported ${m.tracks.reduce((a, t) => a + t.notes.length, 0)} notes`, 'ok');
  } catch (e: any) {
    toast('MIDI import failed: ' + (e?.message ?? e), 'error');
  }
}

// ---------------- autosave & recovery ----------------
export function startAutosave() {
  try {
    localStorage.setItem('lf.cleanExit', '0');
  } catch {}
  setInterval(async () => {
    if (!store.dirty) return;
    try {
      await native.autosaveWrite(JSON.stringify({ when: Date.now(), path: store.filePath, project: await serialize() }));
    } catch {}
  }, 60000);
  window.addEventListener('beforeunload', () => {
    try {
      localStorage.setItem('lf.cleanExit', '1');
    } catch {}
  });
}

export async function checkRecovery(): Promise<boolean> {
  let clean = '1';
  try {
    clean = localStorage.getItem('lf.cleanExit') ?? '1';
  } catch {}
  if (clean === '1') return false;
  const raw = await native.autosaveRead();
  if (!raw) return false;
  try {
    const a = JSON.parse(raw);
    const when = new Date(a.when).toLocaleString();
    const r = await confirmDialog('Recover unsaved work?', `LoopForge didn't close cleanly last time.\nAn autosave from ${when} is available.`, [
      { label: 'Discard', value: 'no' },
      { label: 'Recover', value: 'yes', primary: true },
    ], 'no');
    if (r !== 'yes') return false;
    const p = parseProjectText(a.project);
    loadProject(p, a.path ?? null);
    store.markDirty();
    toast('Recovered autosave', 'ok');
    return true;
  } catch {
    return false;
  }
}
