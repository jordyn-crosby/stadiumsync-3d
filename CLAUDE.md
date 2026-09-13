# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

StadiumSync 3D is a static, single-page web app for designing stadium LED light shows: a venue database, a zone-based pattern designer, a timeline/cue sequencer, a real-time 3D stadium preview, and a project export view. There is no build step, no package manager, and no test suite — everything is plain HTML/CSS/JS served as static files.

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
- `vendor/` — vendored third-party libraries loaded via plain `<script>` tags before `stadium3d.js`: `three.min.js`, `OrbitControls.js`, and a minimal postprocessing pipeline (`EffectComposer`, `RenderPass`, `ShaderPass`, `UnrealBloomPass` + `CopyShader`/`LuminosityHighPassShader`) used for the bloom effect on LED bands.

### State management

All app state lives as plain module-scoped `var` declarations inside the `index.html` IIFE (venues, current selection, pattern library, timeline tracks/cues, music-sync state, etc.) — there is no state library, no `localStorage` persistence, and no backend. Reloading the page resets everything to the hardcoded seed data (`venues` array, `patternLibrary` array, etc. defined near the top of the script).

Views are swapped by toggling visibility of top-level sections and re-running per-view `render*()` functions (e.g. `renderVenues`, `renderLayers`, `renderInspector`, `renderPatternGrid`, `renderTimeline`, `renderCueInspector`, `renderExportView`) rather than any virtual-DOM diffing — each one rebuilds its section's `innerHTML` from current state.

### The shared LED math contract

`computeDotBrightness(pattern, col, t, totalCols, row, totalRows)` and `getDotColor(pattern, col, row, totalCols, totalRows)` (defined in `index.html`) are the single source of truth for what a pattern looks like at a given time/position. They are used to animate:
- the 2D LED matrix previews (pattern library cards, zone inspector, timeline scrubbing),
- the 3D stadium view — these two functions are passed **into** `stadium3d.js` via `createStadium3D(canvas, { computeDotBrightness, getDotColor })` rather than being reimplemented there.

When changing pattern rendering logic, change it in these two functions only — do not add parallel logic inside `stadium3d.js`, or the 2D and 3D views will disagree.

### `stadium3d.js` renderer

- Builds a procedural stadium bowl from a `TIERS` array (lower bowl / upper deck / press-suite level), each tier defined by inner/outer radius, base height, and tier height. Proportions are sourced from real Jordan-Hare LED prefab data and a real-world upper-deck rake angle — see the comment block at the top of the file before changing them.
- `classifyTier(name)` buckets a zone name into one of the three tiers via regex (`press|suite|club` → 2, `upper` → 1, else 0) — new zone-naming conventions must stay compatible with this classifier or zones will render in the wrong tier.
- Exposes an imperative API from `createStadium3D()`: `loadVenue`, `setZoneFrame`, `highlightZone`, `setCameraPreset`, `setAutoOrbit`, `setTimeOfDay`, `setFogDensity`, `onResize`, an `onFrame` hook setter, and `dispose`. `index.html` creates two independent instances — one for the Show Designer canvas, one for the Preview canvas.
- Bloom (`UnrealBloomPass`) is required for LED bands to read as light sources against the dark scene background; it's conditionally wired up only if `THREE.EffectComposer`/`THREE.UnrealBloomPass` are present.

### Music sync

The Preview view can drive pattern playback from an uploaded audio file via the Web Audio API (`musicAudioCtx`/`musicAnalyser`/`musicFreqData`), with rolling per-band ceilings and separate kick/chant onset-detection histories used to trigger beat-synced flashes. This logic is entirely inline in `index.html` near the bottom of the script.

## Conventions to preserve

- No new build tooling, package manager, or module bundler — keep the app dependency-free and directly servable as static files.
- New third-party code goes in `vendor/` as a plain script, loaded via a `<script>` tag in `index.html`, consistent with the existing Three.js/postprocessing setup.
- Design tokens (colors, spacing, radii) are CSS custom properties on `:root` in `index.html` — reuse them rather than hardcoding new values.
