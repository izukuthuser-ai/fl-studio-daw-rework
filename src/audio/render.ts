// Offline export: renders the song (or a pattern) through the same graph used for live playback.
import { ID, Project, STEP } from '../core/types';
import { patternLen, secPerTick, songLen } from '../core/timing';
import { AudioGraph } from './graph';
import { ensureWorklets } from './plugins/registry';
import { measureNodeLatency } from './latency';
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
  const lead = 0; // exports start exactly on the grid
  const dur = (end - start) * spt + o.tail + lead;
  const outLen = Math.ceil(dur * o.sampleRate);
  // room for plugin delay compensation (the whole mix arrives `g.pdcTotal` late; trimmed below)
  const margin = Math.ceil(o.sampleRate * 0.5);
  await measureNodeLatency(o.sampleRate);
  const ctx = new OfflineAudioContext(2, outLen + margin, o.sampleRate);
  await ensureWorklets(ctx);
  const g = new AudioGraph(ctx, samples, false);
  g.prune = true;
  let proj = project;
  if (o.onlyTracks) {
    // solo the requested mixer tracks (and keep master)
    proj = JSON.parse(JSON.stringify(project));
    const sel = new Set(o.onlyTracks);
    // upstream: tracks that route into a selected track (recursively)
    const feeds = new Set(sel);
    for (let changed = true; changed; ) {
      changed = false;
      proj.mixer.forEach((m, i) => {
        if (i > 0 && !feeds.has(i) && feeds.has(m.route)) {
          feeds.add(i);
          changed = true;
        }
      });
    }
    // downstream: the buses the selected tracks flow through on their way to master
    const alive = new Set(feeds);
    for (const t of sel) {
      let cur = proj.mixer[t]?.route ?? 0;
      for (let guard = 0; cur > 0 && guard < 256; guard++) {
        alive.add(cur);
        cur = proj.mixer[cur]?.route ?? 0;
      }
    }
    proj.mixer.forEach((m, i) => {
      if (i > 0 && !alive.has(i)) m.mute = true;
    });
    // channels that feed a downstream bus directly would leak into the stem
    for (const c of proj.channels) if (!feeds.has(c.mixer)) c.mute = true;
  }
  g.automated = o.mode === 'song' ? automatedTargets(proj) : new Set();
  g.sync(proj);
  const autoInit = new Set<string>();
  if (o.mode === 'song') startMidClips(g, proj, start, lead, spt);
  // Schedule incrementally while rendering (suspend/resume) so only the voices that are
  // about to play exist in the graph — creating the whole song up front is ~10x slower.
  let t = start;
  const scheduleUntil = (sec: number) => {
    while (t < end && lead + (t - start) * spt < sec) {
      const to = Math.min(end, (Math.floor(t / STEP) + 1) * STEP);
      scheduleSpan(g, proj, { mode: o.mode, patternId: o.patternId, from: t, to, time0: lead + (t - start) * spt, spt, autoInit });
      t = to;
    }
  };
  const WINDOW = 0.5;
  scheduleUntil(WINDOW * 2);
  const quantum = 128 / o.sampleRate;
  const plugins = g.hosts().length > 0;
  // plugin worklets receive notes by message: make sure they have the first window before rendering starts
  if (plugins) await g.syncHosts();
  for (let s = WINDOW; s < dur - WINDOW; s += WINDOW) {
    const at = Math.round(s / quantum) * quantum;
    ctx.suspend(at).then(async () => {
      scheduleUntil(at + WINDOW * 2);
      if (plugins) await g.syncHosts();
      ctx.resume();
    });
  }
  const rendered = await ctx.startRendering();
  // drop the effects' look-ahead (delay compensation) so the export starts exactly on the grid
  const latency = Math.min(margin, Math.round(g.pdcTotal * o.sampleRate));
  const buf = new AudioBuffer({ length: outLen, numberOfChannels: rendered.numberOfChannels, sampleRate: rendered.sampleRate });
  for (let c = 0; c < rendered.numberOfChannels; c++) buf.copyToChannel(rendered.getChannelData(c).subarray(latency, latency + outLen), c);
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
