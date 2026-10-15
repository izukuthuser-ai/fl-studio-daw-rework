# Engineering brief (shared by all window implementers)

LoopForge Studio is an Electron + TypeScript + Vite DAW that recreates FL Studio's workflow and keyboard shortcuts with original visuals (never use FL Studio branding, logos or plugin names). Spec: `PROMPT.md`.

## Architecture you build on (read these files before coding)
- `src/core/types.ts` — data model. PPQ = 96 ticks/quarter, `STEP` = 24 ticks (1/16), bar = 384 ticks in 4/4. Note names: MIDI 60 = "C5" (`noteName()` in `util.ts`).
- `src/core/store.ts` — `store.project` (undoable data) and `store.ui` (UI state: `currentPattern`, `selectedChannels`, `pianoRollChannel`, `snap`, `prTool`, `plTool`, `songMode`, `loop`, `scale`, `ghost`, `plSource`, `focused`, `settingsChannel`, `selectedMixer`…).
  - Mutate project data ONLY via `store.commit(label, p => {...})` (one undo step), or for drags `store.begin(label)` → repeated `store.live(p => {...})` → `store.end()` (merged into one undo step).
  - UI state: `store.setUI({...})`. Events: `store.on('project', label => …)`, `store.on('ui', changedKeys => …)`, `store.on('loaded', …)`, `store.on('history', …)`. Notifications are coalesced per microtask.
  - Helpers: `store.currentPattern`, `store.pattern(id)`, `store.channel(id)`, `store.selectedChannel`, `store.pianoChannel`, `store.patternLength(p)`, `store.songLength()`, `store.barTicks`.
- `src/core/timing.ts` — `patternLen`, `songLen`, `secPerTick`, `autoValueAt`. `src/core/util.ts` — `el()` DOM helper, `uid()`, `clamp`, `noteName`, `isBlackKey`, `snapTicks(snap)`, `snapDown/snapRound`, `PALETTE`, `rgba()`, `shade()`, `fuzzyScore`, `fmtBST`.
- `src/core/project.ts` — factories (`newChannel`, `newPattern`, `newTrack`, `newFx`, `SYNTH_PRESETS`, `synthPreset`, `defaultSampler`).
- `src/core/params.ts` — `ParamDef`s: `CHANNEL_PARAMS`, `MIXER_PARAMS`, `ENV_PARAMS`, `FX_DEFS`, `FX_ORDER`, `fmtParam`, `toNorm/fromNorm`.
- `src/core/commands.ts` — `commands.register([{ id, label, category, ctx, keys, run, repeat?, enabled?, checked? }])`. `ctx` is `'global' | 'playlist' | 'channelrack' | 'pianoroll' | 'mixer' | 'browser'`; a ctx shortcut only fires while that window is focused and takes priority over global ones. Combo format: modifiers in order `Ctrl+Alt+Shift+` then key: `A`–`Z`, `0`–`9`, `Up/Down/Left/Right`, `Del`, `Ins`, `Home`, `End`, `PageUp`, `PageDown`, `Enter`, `Esc`, `Space`, `Backspace`, `F1`–`F12`, `Num0`–`Num9`, `Num+`, `Num-`. Use `repeat: true` for nudges/arrows. `MenuItem.cmd = '<command id>'` renders a menu row with the right label/shortcut.
- `src/audio/engine.ts` — `engine.preview(channelId, key, vel, durSec)`, `engine.noteOn(key, vel, channelId, holdId)` / `noteOff(key, channelId, holdId)`, `engine.previewSample(ref)`, `engine.stopPreview()`, `engine.playing`, `engine.position` (ticks; in pattern mode it's pattern-relative), `engine.setPosition(tick)`, `engine.play()/stop()`, `engine.on('state', cb)`, `engine.spt` (seconds per tick).
- `src/audio/samples.ts` — `samples.get(ref)` (AudioBuffer|undefined), `samples.ensure(ref)`, `samples.displayName(ref)`, `samples.peaks(ref, buckets)` (min/max pairs), `samples.on('loaded', ref => …)`. Built-in sounds: `BUILTIN_SOUNDS` in `src/audio/sounds.ts` (refs are `'builtin:<id>'`).
- `src/ui/widgets.ts` — `knob`, `fader`, `showMenu(items,x,y)`/`MenuItem` (submenu, checked, sep, color, cmd), `closeMenus`, `modal`, `promptDialog`, `confirmDialog`, `toast`, `iconBtn`, `select`, `dragNumber`, `colorMenu`, `drag(e, move, up)`, `setHint`. Any element with `data-hint="…"` shows that text in the app's hint bar — add hints to every control.
- `src/ui/ops.ts` — `addChannel`, `deleteChannels`, `cloneChannels`, `routeToFreeTracks`, `linkChannelsToTrack`, `addMixerTrack`, `addFx`, `addPlaylistTrack`, `createAutomation({scope,id,param})` (use as knob `onAutomate`).
- `src/ui/dnd.ts` — drag & drop formats shared by Browser / Channel rack / Playlist / Mixer: `DT_SAMPLE` `{ref,name}`, `DT_PRESET` `{preset}`, `DT_PATTERN` `{id}`, `DT_FX` `{type}`; helpers `setDragData`, `hasType`, `readDrag`, `samplesFromDrop(e)` (handles OS files too), `pickSamples()`, `AUDIO_FILTER`.
- `src/ui/fileops.ts` — `importMidi()`, `exportMidi()`, `exportAudio()`.
- `src/ui/actions.ts` — `hooks` (`openPluginPicker`, `openSettings`, …), `selectPattern(id)`, `createPattern()`, `renamePattern()`, `clonePattern()`, `deletePattern()`, `patternColor()`.
- `src/ui/wm.ts` — `wm.show(id)`, `wm.toggle(id)`, `wm.get(id)?.setTitle(t)`, `wm.get(id)?.visible`.
- `src/ui/panel.ts` — every window module exports `createX(): PanelDef` = `{ body, headerExtra?, onResize?, onShow?, onHide? }`; `src/main.ts` already wires it into the window manager (don't edit main.ts).
- `src/ui/icons.ts` — `ICONS`, `TOOL_ICONS` (svg strings).
- `src/styles.css` — theme variables (`--bg --bg2 --panel --panel2 --panel3 --panel4 --line --border --border2 --text --text-dim --text-faint --accent --accent2 --green --red --yellow --sel --mono`) and generic classes: `.wbar` (window toolbar strip; `.sep`, `.lbl`), `.tool-btn`(+`.on`), `.icon-btn`(+`.on`), `.led`(+`.on`), `.btn`(`.primary`,`.small`), `.input`, `.select`, `.form-grid`. Put your CSS in your own file imported from your module, scoped under your root class.
- `src/ui/mixer.ts` is a finished example of a window built on these APIs — read it for conventions (structure signature + in-place updates, hint text, menus, commands).

## Rules
1. Only create/edit the files you are assigned (plus new helper files with your module's prefix). Never edit shared files; if you need a shared change, describe it precisely in your final report. Other engineers are editing other windows right now — ignore TypeScript errors that come only from their files.
2. Canvas editors: support HiDPI (`devicePixelRatio`), redraw via `requestAnimationFrame` only when dirty, draw the playhead without redrawing everything if possible, and virtualize (only draw what's visible).
3. Don't rebuild DOM on every project change; rebuild structure only when a structural signature changes, otherwise update in place. Elements being dragged must survive updates.
4. Every user edit must be undoable (commit / begin-live-end). Never mutate `store.project` outside those.
5. Make it look polished and modern, consistent with the existing dark theme; original visuals.

## Verify before finishing
- `cd /home/claude/izukuthuser-ai/fl-studio-daw-rework && npx tsc --noEmit` — no errors in your files.
- Build to a private dir (never the default `dist/`): `npx vite build --outDir /tmp/claude-0/-home-claude/3f7a8a70-617c-5945-976a-9461d30834a8/scratchpad/<yourname>-dist --emptyOutDir`.
- Screenshot + drive the UI: `cd /tmp/claude-0/-home-claude/3f7a8a70-617c-5945-976a-9461d30834a8/scratchpad/harness && node shot.mjs <distDir> <out.png> [actions.mjs]` — `actions.mjs` is `export default async (page) => { … }`; in the page `window.__lf` = `{ store, engine, wm, hooks }`. Use real mouse/keyboard (`page.mouse`, `page.keyboard`) to test interactions, read state back with `page.evaluate`. The harness prints console errors; there must be none from your code (a favicon 404 is fine). Look at screenshots with the Read tool and iterate until it looks right.
- Final report (short): what you built, how you tested it, any shared-file changes you need, known gaps.
