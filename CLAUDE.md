# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

StadiumSync 3D is a static, single-page web app for designing stadium LED light shows for one venue (Jordan-Hare — there is no venue picker): a zone-based pattern designer with per-seat painting, a timeline/cue sequencer, a real-time 3D stadium preview, and a project export view. The 3D stadium (Jordan-Hare, the only venue) and its 24,778 per-seat LEDs are ported from the team's Unity simulation (`../arenalighting-fall2026/stadium copy`). There is no build step, no package manager, and no test suite — everything is plain HTML/CSS/JS served as static files.

## Running the app

There is no build/install/test command. Serve the directory with any static file server and open it in a browser (WebGL required):

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`. Opening `index.html` directly via `file://` will break some features, so always serve it.

## Architecture

### File layout

- `index.html` — the entire application: markup, CSS (as `:root` custom-property design tokens), and application logic, all inside **one large IIFE** in a single `<script>` block near the bottom of the file (~2200 lines of JS). There is no module system and no separate `app.js`.
- `stadium3d.js` — the 3D stadium renderer, also a single IIFE, exposing one global: `window.Stadium3D.createStadium3D(canvas, opts)`.
- `assets/jordan-hare/` — **generated** venue assets: `stadium.glb` (meshopt-compressed), `leds.json` (per-LED position/zone/row/col/section), `cameras.json` (Unity camera presets), `show-first-demo.{json,bin}` (Spring '25 demo show). Don't hand-edit; regenerate with the pipeline in `tools/` (see `tools/README.md`).
- `tools/` — offline, one-time Unity → web export pipeline: `unity/StadiumWebExporter.cs` (Unity Editor script), `build_web_assets.py` (stdlib Python + `sips` + `npx gltfpack`), `zone_map.json` (which Unity sections belong to which of the 12 zones). Not used at runtime.
- `vendor/` — vendored third-party libraries loaded via plain `<script>` tags before `stadium3d.js`: `three.min.js` (r128), `OrbitControls.js`, `libs/meshopt_decoder.js` + `loaders/GLTFLoader.js` (r128, for the compressed `stadium.glb`), and a minimal postprocessing pipeline (`EffectComposer`, `RenderPass`, `ShaderPass`, `UnrealBloomPass` + `CopyShader`/`LuminosityHighPassShader`) used for LED bloom.

### State management

All app state lives as plain module-scoped `var` declarations inside the `index.html` IIFE (venues, current selection, pattern library, timeline tracks/cues, music-sync state, etc.) — there is no state library and no backend. Reloading the page resets everything to the hardcoded seed data (`venues` array, `patternLibrary` array, etc. defined near the top of the script), except for saved items:

- **Saved items (IndexedDB).** `savedStore` in `index.html` wraps an IndexedDB database `stadiumsync` with two object stores: `patterns` (whole pattern objects — user-created ones, plus edited copies of built-ins, keyed by `id`) and `songs` (imported audio files as Blobs with name/size). Saves stay in that browser on that computer. On startup `restoreSavedPatterns` merges saved patterns over the seed library and `restoreSavedSongs` lists songs and reloads the last one played (its id is in `localStorage` as `stadiumsync.lastSongId`). `builtInPatterns` keeps the untouched seed copies for "Reset to original". Every `savedStore` call resolves rather than rejects, so the app still runs where IndexedDB is unavailable. Timeline cues, zone settings and seat paint are not saved.

Views are swapped by toggling visibility of top-level sections and re-running per-view `render*()` functions (e.g. `renderLayers`, `renderInspector`, `renderPatternGrid`, `renderTimeline`, `renderExportView`) rather than any virtual-DOM diffing — each one rebuilds its section's `innerHTML` from current state.

### The shared LED math contract

`computeDotBrightness(pattern, col, t, totalCols, row, totalRows, around)` and `getDotColor(pattern, col, row, totalCols, totalRows)` (defined in `index.html`) are the single source of truth for what a pattern looks like at a given time/position. They are used to animate:
- the 2D LED matrix previews (zone inspector, timeline cues and scrubbing, and the hover preview on pattern cards in the library and under the timeline — `drawSwatchPreview`),
- the 3D stadium view — these two functions are passed **into** `stadium3d.js` via `createStadium3D(canvas, { computeDotBrightness, getDotColor })` rather than being reimplemented there. In 3D, `col`/`row`/`totalCols`/`totalRows` come from each LED's zone grid in `leds.json`, not from `LED_COLS`/`LED_ROWS` (flipped in `loadVenue` so row/col 0 is the top left as seen from the field, matching the 2D previews — `leds.json` itself counts from the front row, right to left), and the optional `around` (0–1, the LED's angle about the stadium center, precomputed per zone in `loadVenue`) lets stadium-spanning motions like The Wave (`motion: 'crowd-wave'`) travel around the whole bowl; callers without it (2D grids) fall back to column position.

The four stadium-wide patterns (Checkerboard + Streak, Sine Wave Split, Circulating Wave, Radar Sweep) color dots by position on the venue's 400×300 map instead: their math lives in `checkerboardStreakAt`/`sineWaveSplitAt`/`circulatingWaveAt`/`radarSweepAt` (dispatched by `venueWideColorAt`), wrapped per zone by the `get*Color(slug, …)` functions.

When changing pattern rendering logic, change it in these two functions only — do not add parallel logic inside `stadium3d.js`, or the 2D and 3D views will disagree. The same goes for the seat-level effects (seat paint, demo show, music gain): their color math lives in `index.html` (`paintedSeatRgb`, `applyDemoShowFrame`, `applyMusicLedGain`) and is handed to the renderer as buffers.

### `stadium3d.js` renderer

- `loadVenue(venue)` loads `venue.model = {glb, leds, cameras}` and returns a Promise. Assets are cached at module level, so the Designer and Preview instances fetch/parse them once. The stadium mesh and all LEDs share one coordinate space (Unity world space mirrored x → −x).
- All 24,778 LEDs are **one `InstancedMesh`** (unlit spheres, per-instance color; the all-white vertex-color attribute is required in r128 — see the comment in `buildLedMesh`). Venue zones are matched to `leds.json` zones **by name**, so `zoneData[].name` must match `tools/zone_map.json`.
- Each frame, LED color = (seat override if masked, else the zone pattern color written by `setZoneFrame`) × per-LED gain, with unlit LEDs of the `highlightZone` zone brightened. LED colors are kept ≤ 1 (clipping shifts hue, e.g. blue → cyan); bloom threshold is set so lit LEDs glow but the stadium texture doesn't.
- API: `loadVenue`, `setZoneFrame`, `highlightZone`, `setLedOverride(colors, mask)`, `setLedGain(gain)`, `getLedData()`, `pickLed(clientX, clientY)` (manual ray/sphere test → `{index, rowId, section, zone}`), `getCameraPresets`, `setCameraPreset`, `setCameraMode('orbit'|'aerial'|'free')`, `setAutoOrbit`, `setTimeOfDay`, `setFogDensity`, `onResize`, an `onFrame` hook setter, and `dispose`.
- `index.html` creates the Designer and Preview instances lazily, the first time each view is opened (`ensureDesignerStadium` / `ensurePreviewStadium`), and `setActiveStadiumView` calls `setActive(true|false)` on view switches — an inactive instance cancels its `requestAnimationFrame` loop entirely. Any code touching `designerStadium`/`previewStadium` must null-check them. Don't add always-on animation loops for hidden UI; the only per-frame work should belong to the visible view.

### Music sync

The Preview view can drive pattern playback from an uploaded audio file via the Web Audio API (`musicAudioCtx`/`musicAnalyser`/`musicFreqData`), with rolling per-band ceilings and separate kick/chant onset-detection histories used to trigger beat-synced flashes. This logic is entirely inline in `index.html` near the bottom of the script. Alongside it, `computeAudioPeerBands` ports the Unity sim's `AudioPeer` (8 octave bands with decay buffers and running-max normalization) to drive the per-seat Linear / Random / Amplitude music modes, and the Spring '25 demo show plays from `assets/jordan-hare/show-first-demo.*` on the Preview transport clock.

The Timeline reuses the loaded song too: `buildWaveform` decodes it once (via `OfflineAudioContext`) into 10ms peak frames for the waveform strip drawn under every track, and `detectBeatHits` finds onset times (log-energy flux, bass-weighted), plus the subset of "big beats" (hits ≥60% as strong as the strongest within ±2s). With the "Snap to beats" toggle on, dropped/moved/resized cue edges snap to big beats from 24px away, or to any hit from 8px. Cue edges always snap first to the playhead and to the song's bookmarks (12px). The playhead is moved by pressing/dragging on the Timeline ruler; clicking its knob (without dragging) toggles a bookmark at the playhead (`marksBySong`, in memory per song). Bookmarks are `.wave-mark` elements in the waveform strips; hovering one shows a × and clicking deletes it. The knob is outlined, and filled while the playhead sits on a bookmark.

## Conventions to preserve

- No new build tooling, package manager, or module bundler — keep the app dependency-free and directly servable as static files.
- New third-party code goes in `vendor/` as a plain script, loaded via a `<script>` tag in `index.html`, consistent with the existing Three.js/postprocessing setup.
- Design tokens (colors, spacing, radii) are CSS custom properties on `:root` in `index.html` — reuse them rather than hardcoding new values. The look follows auburn.edu: light grey-white surfaces (`--bg` `#e7e9ec`, white panels), Auburn navy `#0b2341` (`--primary`) for text and buttons, and Auburn orange `#e86100` (`--accent`; `#cc4e0b` as `--accent-text` for orange text on white) as the accent for selection, the sidebar's top rule and the playhead. Don't make the chrome all navy. The 3D view and LED previews stay dark so saturated color lives in the LED content.
- Type is Sweet Sans Pro (auburn.edu's licensed typeface) when installed, else the system font stack (`--font-ui`, with `--font-display` aliased to it) — no web fonts are loaded, so the app has no network dependencies and works offline for sponsor demos. UI copy is plain sentence case — no all-caps/tracked labels, no monospace labels, no `A // B` or `NAME_V1` styling.
- The sidebar collapses to an icon rail (`.app-shell.sidebar-collapsed`, remembered in `localStorage` as a UI preference only). Every nav item needs a `title` and a `.nav-label` span so the rail stays usable.
