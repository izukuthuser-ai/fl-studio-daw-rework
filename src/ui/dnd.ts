// Shared drag & drop formats between Browser, Channel rack and Playlist.
import { native } from '../core/native';
import { samples } from '../audio/samples';
import { toast } from './widgets';

export const DT_SAMPLE = 'application/x-loopforge-sample'; // JSON { ref, name }
export const DT_PRESET = 'application/x-loopforge-preset'; // JSON { preset }
export const DT_PATTERN = 'application/x-loopforge-pattern'; // JSON { id }

export interface DragSample {
  ref: string;
  name: string;
}

const AUDIO_RE = /\.(wav|mp3|ogg|flac|aif|aiff|m4a|opus|webm)$/i;
export const AUDIO_FILTER = [{ name: 'Audio files', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aif', 'aiff', 'm4a', 'opus'] }];

export function setDragData(e: DragEvent, type: string, data: unknown) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(type, JSON.stringify(data));
  e.dataTransfer.setData('text/plain', typeof data === 'object' && data && 'name' in (data as any) ? String((data as any).name) : type);
  e.dataTransfer.effectAllowed = 'copy';
}

export function hasType(e: DragEvent, type: string) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(type);
}

export function hasDroppable(e: DragEvent) {
  return hasType(e, DT_SAMPLE) || hasType(e, DT_PRESET) || hasType(e, DT_PATTERN) || hasType(e, 'Files');
}

export function readDrag<T>(e: DragEvent, type: string): T | null {
  try {
    const s = e.dataTransfer?.getData(type);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

/** Convert OS-dropped files into sample refs (file: refs in Electron, embedded in browser). */
export async function filesToSamples(files: File[]): Promise<DragSample[]> {
  const out: DragSample[] = [];
  for (const f of files) {
    if (!AUDIO_RE.test(f.name)) continue;
    const path = native.pathForFile(f);
    const name = f.name.replace(/\.[^.]+$/, '');
    if (path) {
      const ref = 'file:' + path;
      const b = await samples.ensure(ref);
      if (b) out.push({ ref, name });
      else toast('Could not decode ' + f.name, 'error');
    } else {
      const ref = await samples.addBytes(f.name, new Uint8Array(await f.arrayBuffer()));
      if (ref) out.push({ ref, name });
      else toast('Could not decode ' + f.name, 'error');
    }
  }
  return out;
}

/** Everything sample-like in a drop event (browser items or OS files). */
export async function samplesFromDrop(e: DragEvent): Promise<DragSample[]> {
  const s = readDrag<DragSample>(e, DT_SAMPLE);
  if (s) return [s];
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) return filesToSamples(files);
  return [];
}

/** Let the user pick audio files from disk. */
export async function pickSamples(multi = true): Promise<DragSample[]> {
  const files = await native.openFile({ title: 'Load audio', filters: AUDIO_FILTER, multi });
  if (!files) return [];
  const out: DragSample[] = [];
  for (const f of files) {
    const name = f.name.replace(/\.[^.]+$/, '');
    if (f.path && f.path !== f.name) {
      const ref = 'file:' + f.path;
      if (await samples.ensure(ref)) out.push({ ref, name });
    } else {
      const ref = await samples.addBytes(f.name, f.data);
      if (ref) out.push({ ref, name });
    }
  }
  return out;
}
