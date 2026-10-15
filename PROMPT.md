# Master Build Prompt — LoopForge Studio

> Copy everything below the line into any AI coding agent (or hand it to a developer) to build the app from scratch.
> The code in this repo was built from this exact prompt.

---

## Role

You are a senior audio-software engineer. Build **LoopForge Studio**: a desktop digital audio workstation (DAW) whose workflow and keyboard shortcuts match FL Studio 21/2024 one-to-one, so an FL user can sit down and work at full speed on day one — but which fixes FL's long-standing annoyances. Ship it as a double-clickable executable.

**Legal guardrails.** LoopForge is an independent project, not affiliated with Image-Line. Do not copy FL Studio's name, logo, icons, artwork, skins, plugin names (e.g. "3x Osc", "Fruity …"), samples or presets. Re-implement the *workflow* and *shortcuts* (functional behaviour) with original visuals, original names and procedurally generated sounds.

## Tech stack (fixed)

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron 33 | One codebase → Windows `.exe`, macOS `.dmg`, Linux AppImage |
| UI | TypeScript + Vite, no framework, DOM for controls, `<canvas>` for Piano Roll / Playlist / meters | Fast redraws, small bundle, no virtual-DOM overhead on 60 fps grids |
| Audio | Web Audio API (`AudioContext` live, `OfflineAudioContext` for export) | Built into Chromium, sample-accurate scheduling, zero native deps |
| MIDI | Web MIDI API (input) + hand-written SMF reader/writer | |
| Packaging | electron-builder → Windows NSIS installer + portable `.exe`, Linux AppImage, macOS dmg | |

Process model: `electron/main.cjs` (window, native file dialogs, fs access through IPC) · `electron/preload.cjs` (exposes a narrow `window.native` API with `contextIsolation: true`) · `src/` renderer (everything else). The renderer must also run in a plain browser (fallbacks for file I/O) so it can be tested with Playwright.

## Timing model

- PPQ = 96 ticks per quarter note. One step = 1/16 note = 24 ticks. One bar (4/4) = 384 ticks.
- Note names use FL convention: MIDI 60 = **C5**.
- Default tempo 140 BPM, 4/4. Tempo range 10–522 BPM. Swing 0–100 % delays every odd 16th.

## Windows (all floating inside one workspace, like FL)

Every window can be dragged, resized, focused (focus decides which shortcuts apply), maximised, closed with Esc, and toggled with its F-key. `Ctrl+Shift+H` re-tiles all windows. Layout is remembered between sessions.

### 1. Toolbar / transport (always visible, top)
Menus: FILE, EDIT, ADD, PATTERNS, VIEW, OPTIONS, HELP. Transport: PAT/SONG toggle, Play/Pause, Stop, Record, tempo (drag, wheel, double-click to type), song position display (Bar:Step:Tick, click to toggle M:S:CS), pattern selector with "+" (new pattern), metronome, typing-keyboard-to-piano, step-edit, blend-notes, recording precount, master volume, master pitch, live CPU meter, peak oscilloscope, global snap selector, window toggle buttons. A **hint bar** shows a one-line description of whatever the mouse is over.

### 2. Channel Rack (F6)
- One row per channel: mute LED (click; right-click = solo), pan knob, volume knob, mixer-track number (drag/wheel to change routing), name button (click select, double-click opens Channel Settings, right-click context menu), step buttons.
- Steps are just notes: toggling a step adds/removes a 1-step note at C5. Channels that contain non-step notes show a mini piano-roll preview instead of steps (like FL).
- Left-drag paints steps, right-drag erases. Pattern length auto-grows; step count selectable (16/32/64…).
- Swing knob, channel-group filter, "+" button opens the instrument picker.
- Instruments: **Sampler** (any audio file or built-in sound; pitch, ADSR, filter, reverse, start offset) and **Tri-Osc Synth** (3 oscillators sine/tri/saw/square/noise, coarse/fine detune, mix, unison voices, filter + filter envelope, ADSR, glide, portamento).
- Channel Settings window: tabbed (Sample/Osc, Envelope, Filter, Misc) with real-time preview.

### 3. Piano Roll (F7)
- Canvas grid, piano keys on the left (click to audition), ruler on top, velocity lane at the bottom (drag to paint velocities). Bar/beat/step lines, black-key row shading.
- Tools: Draw (P), Paint (B), Delete (D), Mute (T), Slice (C), Select (E), Zoom (Z), Playback (Y).
- Mouse: left-click empty = add note (last-used length), drag note = move, drag right edge = resize, right-click = delete (drag to delete many), Ctrl+drag = box select, Shift+drag selected = duplicate-drag, Alt held = bypass snap, double-click = note properties, wheel = scroll, Ctrl+wheel = horizontal zoom, Alt+wheel over note = velocity.
- Ghost notes from the pattern's other channels (Alt+V toggles).
- Snap: Line, Cell, 1/6 step … 4 bars, None (Backspace toggles Line/None).
- Tools menu with dialogs: Quantize, Arpeggiate, Strum, Chop, Flam, Randomize, Flip, Scale levels, Limit, Legato, Glue.
- **Better than FL:** scale highlighting + optional "snap to scale" (root + 14 scale types), chord stamp tool, unlimited zoom without blur (HiDPI canvas), note colour by velocity, live MIDI-input recording with optional input quantize.

### 4. Playlist (F5)
- Tracks (auto-grow, no 500 limit), each with name, colour, mute, solo, height. Track headers on the left; a clip picker (patterns + audio clips) on the far left.
- Clip types: **Pattern clips**, **Audio clips** (drag a sample from the Browser), **Automation clips** (right-click a knob → "Create automation clip"; editable points with curve).
- Tools: Draw (P), Paint (B), Delete (D), Mute (T), Slice (C), Select (E), Slip (S), Zoom (Z), Playback (Y).
- Timeline: click ruler = move playhead; Ctrl+drag on ruler = time selection, which becomes the playback loop.
- Song mode plays the arrangement; pattern mode loops the current pattern.

### 5. Mixer (F9)
- Master + inserts (default 16, add more with "+", no 125 limit). Strip: name, stereo peak meter with peak-hold, dB fader (−∞…+5.6 dB), pan, mute LED, solo, record-arm placeholder, routing arrow.
- Selected track panel: 10 FX slots (add/replace/remove/bypass/reorder, dry-wet per slot), "Route to" selector (any track except one that would form a loop), stereo width.
- Built-in effects (original designs): Parametric EQ (4 band + low/high cut), Compressor, Limiter, Reverb (algorithmic, generated IR), Delay (tempo-synced, ping-pong), Filter (LP/HP/BP + LFO), Distortion (soft/hard/fold), Bitcrusher, Chorus, Stereo Width, Gate.
- Channel → mixer routing via the channel's track number or `Ctrl+L`.

### 6. Browser (Alt+F8)
- Sections: Built-in sounds (procedurally generated kicks, snares, claps, hats, percs, 808s, FX), User folders (add any folder; recursive scan of .wav/.mp3/.ogg/.flac), Current project (channels, patterns), Recent files.
- Click = preview, drag onto Channel Rack = new Sampler channel, drag onto Playlist = audio clip, Enter = replace selected channel's sample, Shift+Up/Down = step through with preview.
- **Better than FL:** instant fuzzy search across everything, favourites (star), preview follows project tempo.

### 7. Plugin picker (F8)
Grid of instruments + effects; click or drag into Channel Rack / Mixer slot.

## Keyboard shortcuts (must match FL Studio)

Shortcuts are context-sensitive: the focused window's map is checked first, then the global map. Single-letter shortcuts are disabled while Typing-keyboard-to-piano (Ctrl+T) is on.

### Global & file
| Key | Action |
|---|---|
| Ctrl+N | Save new version |
| Ctrl+O | Open project |
| Ctrl+S | Save |
| Ctrl+Shift+S | Save as |
| Ctrl+R | Export WAV |
| Ctrl+Shift+R | Export MP3 (falls back to WAV until an encoder is added) |
| Ctrl+Shift+M | Export MIDI |
| Ctrl+Z | Undo (see "better" below) |
| Ctrl+Alt+Z | Undo step-by-step |
| Ctrl+Shift+H | Arrange windows |
| Alt+0…9 | Open recent project 0–9 |

### Transport & recording
| Key | Action |
|---|---|
| Space | Play / stop |
| Ctrl+Space | Play / pause |
| L | Toggle Pattern / Song mode |
| R | Toggle record |
| Ctrl+M | Metronome |
| Ctrl+P | Recording precount |
| Ctrl+I | Wait for input to start recording |
| Ctrl+E | Step edit mode |
| Ctrl+H | Panic — stop all sound |
| Ctrl+B | Blend notes (in Piano Roll / Playlist: duplicate) |
| Ctrl+T | Typing keyboard to piano |
| Backspace | Toggle snap Line / None |

### Windows
| Key | Action |
|---|---|
| F1 | Help / shortcut sheet |
| F5 | Playlist |
| F6 | Channel Rack |
| F7 | Piano Roll |
| F8 | Plugin picker |
| Alt+F8 | Browser |
| F9 | Mixer |
| F10 | MIDI / audio settings |
| F11 | Song info |
| F12 | Close all windows |
| Esc | Close focused window |
| Tab | Cycle windows |
| Enter | Maximise / restore Playlist |
| F3 | Tool selector for focused window |

### Patterns
| Key | Action |
|---|---|
| 1–9 | Select pattern 1–9 (when Channel Rack is not focused) |
| Numpad + / − | Next / previous pattern |
| F2 | Rename pattern (Mixer focused: rename track) |
| F4 | Next empty pattern (with name dialog) |

### Channel Rack
| Key | Action |
|---|---|
| Up / Down | Select channel above / below |
| Page Up / Page Down | Next / previous channel group |
| 1–0 | Mute / unmute channels 1–10 |
| Ctrl+1–0 | Solo channels 1–10 |
| Alt+C | Clone selected channels |
| Alt+Del | Delete selected channels |
| Alt+G | Group selected channels |
| Alt+Up / Alt+Down | Move selected channel up / down |
| Ctrl+C / Ctrl+V / Ctrl+X | Copy / paste / cut steps |
| Ctrl+L | Route selected channels to a free mixer track |
| Ctrl+Enter | Focus Playlist |

### Piano Roll
| Key | Action |
|---|---|
| P / B / D / T / C / E / Z / Y | Draw / Paint / Delete / Mute / Slice / Select / Zoom / Playback tool |
| Del | Delete selection |
| Ctrl+A / Ctrl+D | Select all / deselect |
| Ctrl+C / Ctrl+V / Ctrl+X | Copy / paste / cut |
| Ctrl+B | Duplicate selection (or all) to the right |
| Shift+Left / Shift+Right | Shift selection one snap step |
| Shift+Ctrl+Left / Right | Rotate left / right |
| Shift+Up / Shift+Down | Transpose ±1 semitone |
| Ctrl+Up / Ctrl+Down | Transpose ±1 octave |
| Alt+Arrows | Nudge without snap |
| Ctrl+Q | Quick quantize |
| Shift+Q | Quick quantize start times |
| Alt+Q | Quantize dialog |
| Ctrl+L | Quick legato |
| Alt+L | Articulate |
| Ctrl+U / Alt+U | Quick chop / Chop dialog |
| Ctrl+G | Glue |
| Alt+A | Arpeggiate |
| Alt+S | Strum |
| Alt+F | Flam |
| Alt+K | Limit |
| Alt+Y | Flip |
| Alt+R | Randomize |
| Alt+X | Scale levels |
| Alt+M / Alt+Shift+M | Mute / unmute selection |
| Shift+I | Invert selection |
| Shift+R / Shift+M | Select one / more at random |
| Shift+O | Select odd |
| Ctrl+Left / Ctrl+Right | Select previous / next time |
| Shift+D | Discard lengths |
| Ctrl+M / Shift+Ctrl+M | Import / export MIDI |
| Page Up / Page Down | Zoom in / out |
| Shift+1…4 | Quick zoom levels |
| Shift+0 | Centre on playhead |
| Alt+V | Ghost channels |

### Playlist
| Key | Action |
|---|---|
| P / B / D / T / C / E / S / Z / Y | Draw / Paint / Delete / Mute / Slice / Select / Slip / Zoom / Playback tool |
| Ctrl+A / Ctrl+D | Select all / deselect |
| Ctrl+C / Ctrl+V / Ctrl+X | Copy / paste / cut |
| Ctrl+B | Duplicate selection |
| Ctrl+Left / Ctrl+Right | Select time before / after |
| Del | Delete selected clips |
| Home | Playhead to start |
| Insert | Slice clips at playhead |
| Shift+0 | Centre on playhead |
| Shift+1…4 | Zoom levels |
| Shift+Q | Quick quantize clip starts |
| Shift+G | Group clips |

### Mixer
| Key | Action |
|---|---|
| S | Solo current track |
| Alt+S | Solo track + its routing |
| Ctrl+A | Select all tracks |
| Ctrl+L | Link selected channels to the selected track |
| Alt+Left / Alt+Right | Move track left / right |
| Alt+R | Render armed tracks to WAV |
| F2 | Rename track |

### Typing keyboard to piano (when Ctrl+T is on)
Lower octave: `Z S X D C V G B H N J M , L . ; /` · Upper octave: `Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P [ = ]` · Octave down/up: Alt+numpad, or `-`/`=` in this mode.

## "Just better" — improvements over FL Studio

1. **Real multi-level undo by default.** Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo, Ctrl+Alt+Z still steps back. An "FL classic Ctrl+Z toggle" option exists for purists. A History panel lists every step.
2. **Command palette** (Ctrl+K): fuzzy-search every action, shows its shortcut.
3. **Fully remappable shortcuts** with conflict detection, export/import keymaps, "reset to FL defaults".
4. **Crash-safe autosave** every 60 s plus recovery prompt on next launch.
5. **No arbitrary limits:** unlimited mixer inserts, playlist tracks, patterns.
6. **Scale tools in the Piano Roll:** highlight, snap-to-scale, chord stamps.
7. **Fuzzy search everywhere** in the Browser, with favourites.
8. **Modern, high-DPI, resizable UI** with a consistent dark theme and readable fonts; everything is vector or canvas-drawn.
9. **Hint bar + hover shortcut tooltips** on every control.
10. **One-file project format** (`.lfproj`, JSON) with an option to embed user samples so projects never break when moved.

## Audio engine requirements

- Look-ahead scheduler: a 25 ms timer schedules every event that falls in the next ~120 ms on the `AudioContext` clock (sample-accurate, no jitter from UI load).
- Same graph-building code drives the live context and the `OfflineAudioContext` used for export, so exports sound identical to playback.
- Graph: voice → channel (vol, pan) → mixer insert (FX chain → pan → fader → mute) → master (FX → fader) → limiter → output. Analysers on every track for meters.
- Built-in drum kit and synth presets are generated procedurally at startup (no bundled third-party samples).
- Metronome click on beats (accent on bar).
- Automation clips write parameter values with `setValueAtTime`/`linearRampToValueAtTime`.
- Export: WAV 16/24/32-float, 44.1/48 kHz, song or pattern, with tail; MIDI export (SMF type 1).

## Project file (`.lfproj`)
JSON: `{ format: "loopforge", version, name, bpm, timeSig, swing, channels[], patterns[], playlist{tracks[], clips[]}, mixer[], automation[], settings }`. Samples referenced by path or embedded as base64 when "embed samples" is on.

## Acceptance criteria

1. `npm run dev` opens the app; `npm run dist:win` produces `LoopForge Studio <version>.exe` (installer) and a portable `.exe`.
2. A new project opens with a demo beat (kick/clap/hat/bass) in pattern 1 that plays on Space.
3. Every shortcut in the tables above performs its action in the right context.
4. Draw notes in the Piano Roll, place the pattern in the Playlist, switch to Song mode (L), press Space → it plays.
5. Mixer FX audibly change the sound; meters move; mute/solo work.
6. Ctrl+R exports a WAV that matches what you hear.
7. Save, close, reopen → identical project.
8. Undo/redo works for every edit.
