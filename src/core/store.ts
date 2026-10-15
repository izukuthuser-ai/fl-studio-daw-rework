import { Channel, ID, MixerTrack, Note, Pattern, Project, Snap, ToolId, WindowId } from './types';
import { Emitter, barLen } from './util';
import { patternLen, songLen } from './timing';

export interface ScaleState {
  root: number; // 0..11
  type: string;
  highlight: boolean;
  snap: boolean;
}

export interface UIState {
  currentPattern: ID;
  selectedChannels: ID[];
  pianoRollChannel: ID | null;
  songMode: boolean;
  recording: boolean;
  metronome: boolean;
  typingPiano: boolean;
  stepEdit: boolean;
  blend: boolean;
  precount: boolean;
  waitInput: boolean;
  snap: Snap;
  prTool: ToolId;
  plTool: ToolId;
  selectedMixer: number;
  selectedMixerTracks: number[];
  pianoOctave: number;
  loop: { start: number; end: number } | null;
  timeDisplay: 'bst' | 'time';
  channelGroup: string;
  ghost: boolean;
  scale: ScaleState;
  plSource: { kind: 'pattern' | 'audio' | 'automation'; ref: ID } | null;
  masterVol: number; // 0..1.25 linear
  focused: WindowId | null;
  editAutomation: ID | null;
  settingsChannel: ID | null;
}

interface Snapshot {
  label: string;
  json: string;
}

type StoreEvents = {
  project: string; // label of change
  ui: (keyof UIState)[];
  history: null;
  dirty: boolean;
  loaded: null;
};

export class Store extends Emitter<StoreEvents> {
  project!: Project;
  ui!: UIState;
  filePath: string | null = null;
  dirty = false;
  undoStack: Snapshot[] = [];
  redoStack: Snapshot[] = [];
  private liveBase: Snapshot | null = null;
  classicUndo = false;
  private lastToggle: 'undo' | 'redo' = 'redo';
  private emitQueued = false;
  private queuedLabel = '';

  load(project: Project, ui: UIState, path: string | null = null) {
    this.project = project;
    this.ui = ui;
    this.filePath = path;
    this.undoStack = [];
    this.redoStack = [];
    this.liveBase = null;
    this.setDirty(false);
    this.emit('loaded', null);
    this.emit('project', 'load');
    this.emit('history', null);
    this.emit('ui', Object.keys(ui) as (keyof UIState)[]);
  }

  private snap(label: string): Snapshot {
    return { label, json: JSON.stringify(this.project) };
  }

  private setDirty(d: boolean) {
    if (this.dirty !== d) {
      this.dirty = d;
      this.emit('dirty', d);
    }
  }

  markDirty() {
    this.setDirty(true);
  }

  markSaved(path: string | null) {
    this.filePath = path;
    this.setDirty(false);
  }

  /** Make an undoable change. */
  commit(label: string, fn: (p: Project) => void) {
    if (this.liveBase) {
      // inside a live edit: just apply
      fn(this.project);
      this.notify(label);
      return;
    }
    const before = this.snap(label);
    fn(this.project);
    if (before.json === JSON.stringify(this.project)) return;
    this.pushUndo(before);
    this.notify(label);
  }

  private lastGroup: string | null = null;
  private lastGroupSnap: Snapshot | null = null;
  private deferred: (() => void)[] = [];

  /**
   * Undoable change that merges with the previous change of the same group, as long as
   * nothing else was committed in between (used for a recording take: one undo step,
   * but a mute or knob tweak during the take stays its own step).
   */
  commitGrouped(label: string, group: string, fn: (p: Project) => void) {
    if (this.liveBase) {
      // a drag is in progress — apply after it ends so it doesn't swallow this change
      this.deferred.push(() => this.commitGrouped(label, group, fn));
      return;
    }
    const top = this.undoStack[this.undoStack.length - 1];
    if (this.lastGroup === group && top && top === this.lastGroupSnap) {
      fn(this.project);
      this.redoStack = [];
      this.notify(label);
      return;
    }
    const before = this.snap(label);
    fn(this.project);
    if (before.json === JSON.stringify(this.project)) return;
    this.pushUndo(before);
    this.lastGroup = group;
    this.lastGroupSnap = before;
    this.notify(label);
  }

  /** Start a continuous edit (drag). Changes made via live() are merged into one undo step on end(). */
  begin(label: string) {
    if (this.liveBase) this.end();
    this.liveBase = this.snap(label);
  }
  live(fn: (p: Project) => void, label = 'edit') {
    fn(this.project);
    this.notify(label);
  }
  end() {
    if (!this.liveBase) return;
    const base = this.liveBase;
    this.liveBase = null;
    if (base.json !== JSON.stringify(this.project)) {
      this.pushUndo(base);
      this.emit('history', null);
    }
    const d = this.deferred;
    this.deferred = [];
    for (const f of d) f();
  }
  get editing() {
    return !!this.liveBase;
  }

  private pushUndo(s: Snapshot) {
    this.lastGroup = null;
    this.lastGroupSnap = null;
    this.undoStack.push(s);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.lastToggle = 'redo';
    this.setDirty(true);
    this.emit('history', null);
  }

  /** Coalesce change notifications into one per microtask. */
  private notify(label: string) {
    this.setDirty(true);
    this.queuedLabel = label;
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.emit('project', this.queuedLabel);
    });
  }

  undo(): string | null {
    this.end();
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(this.snap(s.label));
    this.project = JSON.parse(s.json);
    this.afterHistoryJump();
    return s.label;
  }
  redo(): string | null {
    this.end();
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(this.snap(s.label));
    this.project = JSON.parse(s.json);
    this.afterHistoryJump();
    return s.label;
  }
  /** FL classic Ctrl+Z: toggles between undo and redo of the last step. */
  undoToggle(): string | null {
    if (this.lastToggle === 'redo' || !this.redoStack.length) {
      this.lastToggle = 'undo';
      return this.undo();
    }
    this.lastToggle = 'redo';
    return this.redo();
  }
  jumpTo(undoIndex: number) {
    // move so that undoStack.length === undoIndex
    while (this.undoStack.length > undoIndex) if (!this.undo()) break;
    while (this.undoStack.length < undoIndex) if (!this.redo()) break;
  }

  private afterHistoryJump() {
    this.validateUI();
    this.setDirty(true);
    this.emit('project', 'history');
    this.emit('history', null);
    this.emit('ui', ['currentPattern', 'selectedChannels']);
  }

  setUI(patch: Partial<UIState>) {
    const keys: (keyof UIState)[] = [];
    for (const k of Object.keys(patch) as (keyof UIState)[]) {
      if (this.ui[k] !== patch[k]) {
        (this.ui as any)[k] = patch[k];
        keys.push(k);
      }
    }
    if (keys.length) this.emit('ui', keys);
  }

  /** Make sure UI references still exist after undo/load. */
  validateUI() {
    const p = this.project;
    if (!p.patterns.find((x) => x.id === this.ui.currentPattern)) this.ui.currentPattern = p.patterns[0]?.id ?? '';
    this.ui.selectedChannels = this.ui.selectedChannels.filter((id) => p.channels.some((c) => c.id === id));
    if (!this.ui.selectedChannels.length && p.channels[0]) this.ui.selectedChannels = [p.channels[0].id];
    if (this.ui.pianoRollChannel && !p.channels.some((c) => c.id === this.ui.pianoRollChannel))
      this.ui.pianoRollChannel = this.ui.selectedChannels[0] ?? null;
    if (this.ui.selectedMixer >= p.mixer.length) this.ui.selectedMixer = 0;
    const src = this.ui.plSource;
    if (src) {
      const ok =
        src.kind === 'pattern' ? p.patterns.some((x) => x.id === src.ref) : src.kind === 'audio' ? p.channels.some((c) => c.id === src.ref) : p.automations.some((a) => a.id === src.ref);
      if (!ok) this.ui.plSource = p.patterns[0] ? { kind: 'pattern', ref: p.patterns[0].id } : null;
    }
    if (this.ui.editAutomation && !p.automations.some((a) => a.id === this.ui.editAutomation)) this.ui.editAutomation = null;
    if (this.ui.settingsChannel && !p.channels.some((c) => c.id === this.ui.settingsChannel)) this.ui.settingsChannel = null;
  }

  // ---------- queries ----------
  pattern(id: ID = this.ui.currentPattern): Pattern | undefined {
    return this.project.patterns.find((p) => p.id === id);
  }
  get currentPattern(): Pattern {
    return this.pattern() ?? this.project.patterns[0];
  }
  channel(id: ID | null | undefined): Channel | undefined {
    return id ? this.project.channels.find((c) => c.id === id) : undefined;
  }
  get selectedChannel(): Channel | undefined {
    return this.channel(this.ui.selectedChannels[0]) ?? this.project.channels[0];
  }
  get pianoChannel(): Channel | undefined {
    return this.channel(this.ui.pianoRollChannel) ?? this.selectedChannel;
  }
  notes(patternId: ID, channelId: ID): Note[] {
    const p = this.pattern(patternId);
    if (!p) return [];
    return p.notes[channelId] ?? [];
  }
  mixerTrack(i: number): MixerTrack | undefined {
    return this.project.mixer[i];
  }
  get barTicks() {
    return barLen(this.project.timeSig);
  }
  patternLength(p: Pattern | undefined = this.currentPattern): number {
    return patternLen(p, this.project.timeSig);
  }
  songLength(): number {
    return songLen(this.project);
  }
}

export const store = new Store();
