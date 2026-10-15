// Offline export: renders the song (or a pattern) through the same graph used for live playback.
import { ID, Project, STEP } from '../core/types';
import { patternLen, secPerTick, songLen } from '../core/timing';
import { AudioGraph } from './graph';
import { samples } from './samples';
import { automatedTargets, scheduleSpan, startMidClips } from './sequencer';

export interface RenderOpts {
  mode: 'song' | 'pattern';
  patternId: ID;
  sampleRate: number;
  tail: number; // seconds of tail after the end
  range?: { start: number; end: number };
  onlyTracks?: number[]; // render specific mixer tracks (stems); undefined = full mix
}

export async function renderProject(project: Project, o: RenderOpts): Promise<AudioBuffer> {
  // make sure every sample is decoded
  const refs = project.channels.map((c) => c.sampler?.sampleRef).filter(Boolean) as string[];
  await Promise.all(refs.map((r) => samples.ensure(r)));

  const spt = secPerTick(project.bpm);
  const start = o.range?.start ?? 0;
  const end = o.range?.end ?? (o.mode === 'song' ? songLen(project) : patternLen(project.patterns.find((p) => p.id === o.patternId), project.timeSig));
  const lead = 0.01;
  const dur = (end - start) * spt + o.tail + lead;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * o.sampleRate), o.sampleRate);
  const g = new AudioGraph(ctx, samples, false);
  let proj = project;
  if (o.onlyTracks) {
    // solo the requested mixer tracks (and keep master)
    proj = JSON.parse(JSON.stringify(project));
    proj.mixer.forEach((m, i) => {
      if (i > 0 && !o.onlyTracks!.includes(i)) m.mute = true;
    });
  }
  g.automated = o.mode === 'song' ? automatedTargets(proj) : new Set();
  g.sync(proj);
  const autoInit = new Set<string>();
  if (o.mode === 'song') startMidClips(g, proj, start, lead, spt);
  for (let t = start; t < end; ) {
    const to = Math.min(end, (Math.floor(t / STEP) + 1) * STEP);
    scheduleSpan(g, proj, { mode: o.mode, patternId: o.patternId, from: t, to, time0: lead + (t - start) * spt, spt, autoInit });
    t = to;
  }
  const buf = await ctx.startRendering();
  return buf;
}

export function encodeWav(buf: AudioBuffer, bits: 16 | 24 | 32): Uint8Array {
  const nCh = buf.numberOfChannels;
  const len = buf.length;
  const bytesPer = bits / 8;
  const dataSize = len * nCh * bytesPer;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * nCh * bytesPer, true);
  v.setUint16(32, nCh * bytesPer, true);
  v.setUint16(34, bits, true);
  w(36, 'data');
  v.setUint32(40, dataSize, true);
  const chans = Array.from({ length: nCh }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      let s = chans[c][i];
      if (bits === 32) {
        v.setFloat32(o, s, true);
      } else if (bits === 16) {
        s += (Math.random() - Math.random()) / 65536; // TPDF dither
        s = Math.max(-1, Math.min(1, s));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      } else {
        s = Math.max(-1, Math.min(1, s));
        const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        v.setUint8(o, x & 0xff);
        v.setUint8(o + 1, (x >> 8) & 0xff);
        v.setUint8(o + 2, (x >> 16) & 0xff);
      }
      o += bytesPer;
    }
  }
  return new Uint8Array(ab);
}

export function peakDb(buf: AudioBuffer) {
  let m = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  }
  return m > 0 ? 20 * Math.log10(m) : -Infinity;
}
