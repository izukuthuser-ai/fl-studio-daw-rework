// Standard MIDI File (SMF) reader & writer.
import { Note, PPQ } from './types';
import { uid } from './util';

export interface MidiTrackOut {
  name: string;
  channel: number; // 0..15
  notes: Note[];
}

function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const str = (s: string) => Array.from(new TextEncoder().encode(s));

export function writeMidi(tracks: MidiTrackOut[], bpm: number, timeSig: [number, number]): Uint8Array {
  const out: number[] = [];
  out.push(...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length + 1), ...u16(PPQ));
  // tempo track
  const t0: number[] = [];
  const mpq = Math.round(60000000 / bpm);
  t0.push(0, 0xff, 0x51, 3, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255);
  t0.push(0, 0xff, 0x58, 4, timeSig[0], Math.log2(timeSig[1]), 24, 8);
  t0.push(0, 0xff, 0x2f, 0);
  out.push(...str('MTrk'), ...u32(t0.length), ...t0);
  for (const tr of tracks) {
    const ev: { t: number; d: number[] }[] = [];
    const nameBytes = str(tr.name);
    ev.push({ t: 0, d: [0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes] });
    for (const n of tr.notes) {
      if (n.muted) continue;
      const vel = Math.max(1, Math.min(127, Math.round(n.vel * 127)));
      const key = Math.max(0, Math.min(127, n.key));
      ev.push({ t: n.start, d: [0x90 | tr.channel, key, vel] });
      ev.push({ t: n.start + Math.max(1, n.len), d: [0x80 | tr.channel, key, 0] });
    }
    ev.sort((a, b) => a.t - b.t || (a.d[0] & 0xf0) - (b.d[0] & 0xf0));
    const bytes: number[] = [];
    let last = 0;
    for (const e of ev) {
      bytes.push(...vlq(Math.max(0, Math.round(e.t - last))), ...e.d);
      last = Math.round(e.t);
    }
    bytes.push(0, 0xff, 0x2f, 0);
    out.push(...str('MTrk'), ...u32(bytes.length), ...bytes);
  }
  return new Uint8Array(out);
}

export interface MidiImport {
  bpm: number | null;
  tracks: { name: string; notes: Note[] }[];
}

export function readMidi(data: Uint8Array): MidiImport {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  const id = () => String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3]);
  if (id() !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = v.getUint32(4);
  const ntr = v.getUint16(10);
  const div = v.getUint16(12);
  if (div & 0x8000) throw new Error('SMPTE time division not supported');
  const scale = PPQ / div;
  p = 8 + hlen;
  let bpm: number | null = null;
  const tracks: MidiImport['tracks'] = [];
  for (let t = 0; t < ntr && p < data.length; t++) {
    if (id() !== 'MTrk') break;
    const len = v.getUint32(p + 4);
    let q = p + 8;
    const end = q + len;
    let tick = 0;
    let status = 0;
    let name = `Track ${t + 1}`;
    const open = new Map<number, { start: number; vel: number }>();
    const notes: Note[] = [];
    const readVlq = () => {
      let n = 0;
      for (;;) {
        const b = data[q++];
        n = (n << 7) | (b & 0x7f);
        if (!(b & 0x80)) return n;
      }
    };
    while (q < end) {
      tick += readVlq();
      let b = data[q];
      if (b & 0x80) {
        status = b;
        q++;
      }
      const type = status & 0xf0;
      if (status === 0xff) {
        const mt = data[q++];
        const ml = readVlq();
        if (mt === 0x51 && ml === 3 && bpm === null) bpm = Math.round(60000000 / ((data[q] << 16) | (data[q + 1] << 8) | data[q + 2]));
        if (mt === 0x03) name = new TextDecoder().decode(data.subarray(q, q + ml)) || name;
        q += ml;
      } else if (status === 0xf0 || status === 0xf7) {
        q += readVlq();
      } else if (type === 0x90 || type === 0x80) {
        const key = data[q++];
        const vel = data[q++];
        const k = ((status & 15) << 8) | key;
        if (type === 0x90 && vel > 0) open.set(k, { start: tick, vel });
        else {
          const o = open.get(k);
          if (o) {
            notes.push({ id: uid('n'), key, start: Math.round(o.start * scale), len: Math.max(1, Math.round((tick - o.start) * scale)), vel: o.vel / 127, pan: 0 });
            open.delete(k);
          }
        }
      } else if (type === 0xc0 || type === 0xd0) q += 1;
      else q += 2;
    }
    if (notes.length) tracks.push({ name, notes });
    p = end;
  }
  return { bpm, tracks };
}
