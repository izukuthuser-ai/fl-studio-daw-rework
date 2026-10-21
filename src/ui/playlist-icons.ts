// Original track-header icons for the Playlist (24x24, currentColor) and the per-track icon choice
// (PlaylistTrack.icon, saved with the project and undoable); 'auto' derives an icon from the track's first clip.
import type { Project, ID } from '../core/types';
import { store } from '../core/store';

const s = (d: string, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const TRACK_ICONS: Record<string, { label: string; svg: string }> = {
  drum: { label: 'Drums', svg: s('<ellipse cx="11" cy="11" rx="8" ry="3.2"/><path d="M3 11v5.5c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V11"/><path d="M7 13.8v5M15 13.8v5"/><path d="M15.5 3.5l5 5M13 2.8l7.2 3.6"/>') },
  bass: { label: 'Bass', svg: s('<path d="M5 9.5a4.5 4.5 0 1 1 6.5 4c-2 1-4.5 3.3-6 6.5"/><circle cx="6.6" cy="9.4" r="1.2" fill="currentColor"/><circle cx="17" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="17" cy="13" r="1.1" fill="currentColor" stroke="none"/>') },
  keys: { label: 'Keys', svg: s('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M8 19v-5M12 19v-5M16 19v-5"/><rect x="6.6" y="5" width="2.6" height="9" rx=".4" fill="currentColor" stroke="none"/><rect x="10.7" y="5" width="2.6" height="9" rx=".4" fill="currentColor" stroke="none"/><rect x="14.8" y="5" width="2.6" height="9" rx=".4" fill="currentColor" stroke="none"/>', 1.5) },
  synth: { label: 'Synth', svg: s('<path d="M2.5 15l4.5-7v7l4.5-7v7l4.5-7v7l5.5-7"/>') },
  vocal: { label: 'Vocal', svg: s('<rect x="8.5" y="2.8" width="7" height="11" rx="3.5"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3.5M8.5 21h7"/>') },
  guitar: { label: 'Guitar', svg: s('<path d="M13.6 10.4l6.7-6.7M18.4 2.6l3 3"/><path d="M11.2 9.3c-1.5-.6-3.4-.2-4.6 1-.9.9-1 2.2-1.9 3-.8.7-2.2.8-2.9 1.6-1.1 1.4-.4 3.7 1.2 5.3 1.6 1.6 3.9 2.3 5.3 1.2.8-.7.9-2.1 1.6-2.9.8-.9 2.1-1 3-1.9 1.2-1.2 1.6-3.1 1-4.6"/><circle cx="9" cy="15" r="1.4"/>') },
  fx: { label: 'FX', svg: s('<path d="M12 2.5l1.7 5.1 5.3.1-4.3 3.2 1.6 5.1L12 13l-4.3 3 1.6-5.1L5 7.7l5.3-.1z"/><path d="M5 19.5h.01M19 19.5h.01M12 21h.01"/>') },
  automation: { label: 'Automation', svg: s('<path d="M3 18c3 0 4-9 7-9s3 6 6 6 3-8 5-10"/><circle cx="10" cy="9" r="1.5" fill="currentColor"/><circle cx="16" cy="15" r="1.5" fill="currentColor"/>') },
  wave: { label: 'Audio', svg: s('<path d="M2 12h2.5l1.5-4 2.5 9 3-13 3 15 2.5-10 1.5 3H22"/>') },
};
export const ICON_ORDER = ['drum', 'bass', 'keys', 'synth', 'vocal', 'guitar', 'fx', 'automation', 'wave'];

/** Level-bars glyph shown left of the mute LED (lit while a clip of the track plays). */
export const LEVEL_SVG = `<svg viewBox="0 0 12 12"><rect x="1" y="7" width="2" height="4" rx=".5"/><rect x="5" y="4" width="2" height="7" rx=".5"/><rect x="9" y="1" width="2" height="10" rx=".5"/></svg>`;

const KEY = 'lf.pl.trackIcons';
let map: Record<ID, string> | null = null;
function load(): Record<ID, string> {
  if (map) return map;
  try {
    map = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    map = {};
  }
  return map!;
}

/** The user's choice for a track: an icon id, 'none', or 'auto' (default). */
export function trackIconChoice(trackId: ID): string {
  // saved in the project (PlaylistTrack.icon); older local-only choices are still honoured
  const t = store.project?.playlist.tracks.find((x) => x.id === trackId);
  if (t?.icon) return t.icon;
  return load()[trackId] ?? 'auto';
}
export function setTrackIcon(trackId: ID, icon: string) {
  store.commit('Track icon', (p) => {
    const t = p.playlist.tracks.find((x) => x.id === trackId);
    if (!t) return;
    if (icon === 'auto') delete t.icon;
    else t.icon = icon;
  });
  const m = load();
  if (m[trackId]) {
    delete m[trackId];
    try {
      localStorage.setItem(KEY, JSON.stringify(m));
    } catch {}
  }
}

/** Guess an icon from a name ("Kick", "808 Bass", "Chords", "Vox"…). */
function fromName(n: string): string | null {
  const t = n.toLowerCase();
  if (/kick|snare|clap|hat|drum|beat|perc|loop|break|tom|cymbal|ride/.test(t)) return 'drum';
  if (/808|bass|sub/.test(t)) return 'bass';
  if (/chord|pad|piano|keys|organ|rhodes|string/.test(t)) return 'keys';
  if (/vox|vocal|voice|choir|sing|acapella/.test(t)) return 'vocal';
  if (/guitar|gtr|strum/.test(t)) return 'guitar';
  if (/fx|riser|impact|sweep|noise|crash|whoosh|drop/.test(t)) return 'fx';
  if (/lead|pluck|synth|arp|melody|saw|bell/.test(t)) return 'synth';
  return null;
}

/** Icon id shown for a track (resolving 'auto'), or '' for none. */
export function resolveTrackIcon(p: Project, trackIndex: number): string {
  const t = p.playlist.tracks[trackIndex];
  if (!t) return '';
  const c = trackIconChoice(t.id);
  if (c === 'none') return '';
  if (c !== 'auto') return TRACK_ICONS[c] ? c : '';
  let first: { kind: string; ref: ID; start: number } | null = null;
  for (const k of p.playlist.clips) if (k.track === trackIndex && (!first || k.start < first.start)) first = k;
  if (first?.kind === 'automation') return 'automation';
  const byName = fromName(t.name);
  if (byName && !/^track \d+$/i.test(t.name)) return byName;
  if (!first) return '';
  if (first.kind === 'audio') {
    const ch = p.channels.find((c) => c.id === first!.ref);
    return (ch && fromName(ch.name)) || 'wave';
  }
  const pt = p.patterns.find((x) => x.id === first!.ref);
  if (!pt) return '';
  const byPat = fromName(pt.name);
  if (byPat) return byPat;
  const chans = p.channels.filter((c) => pt.notes[c.id]?.length);
  if (chans.length && chans.every((c) => c.group === 'Drums')) return 'drum';
  if (chans.some((c) => c.group === 'Bass')) return 'bass';
  if (chans.some((c) => c.type !== 'sampler')) return 'synth';
  return '';
}
