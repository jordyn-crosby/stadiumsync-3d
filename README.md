# StadiumSync 3D

StadiumSync is a browser-based studio for designing stadium LED light shows. It lets you manage a venue database, build zone-based light patterns, sequence them on a timeline, preview the result on a real-time 3D stadium renderer, and export the finished show.

## Features

- **Venue**: Jordan-Hare Stadium, with capacity, seat LEDs and zones.
- **Designer**: organize LED layers and zones for the venue, inspect individual zones, and **paint individual seats**. Click paints a seat, Shift-click a row, Alt-click a section; paint groups can be static, pulse, twinkle or random.
- **Patterns** — build and preview reusable LED patterns with configurable parameters.
- **Timeline** — sequence patterns into cues across a show timeline.
- **Preview**: the real Jordan-Hare stadium model with all 24,778 per-seat LEDs, ported from the team's Unity simulation. It includes:
  - Orbit, Aerial and Free-Fly (WASD) cameras, plus the Unity fixed camera views.
  - Bloom.
  - Music-to-light: beat sync, plus the Unity sim's 8-band per-seat modes.
  - The Spring '25 demo light show.
- **Export** — download a printable show sheet and a show data file (.json), including seat paint.

## Getting Started

This is a static, no-build-step web app — there's no package manager or bundler involved.

### Prerequisites

- A modern web browser with WebGL support (Chrome, Firefox, Safari, Edge).
- A local static file server (opening `index.html` directly via `file://` will block some browser features).

### Installation

```bash
git clone <this-repo-url>
cd stadiumsync-3d
```

### Running Locally

Serve the directory with any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

## Project Structure

```
.
├── index.html      # App shell, UI, styles, and application logic
├── stadium3d.js    # 3D stadium renderer (Three.js): stadium model + per-seat LEDs
├── assets/
│   └── jordan-hare/      # stadium.glb, leds.json, cameras.json, demo show (generated)
├── tools/          # Offline Unity → web export pipeline (see tools/README.md)
└── vendor/         # Vendored third-party libraries
    ├── three.min.js      # three.js r128
    ├── OrbitControls.js
    ├── loaders/          # GLTFLoader (r128)
    ├── libs/             # meshopt_decoder (for the compressed stadium.glb)
    ├── postprocessing/   # EffectComposer, RenderPass, ShaderPass, UnrealBloomPass
    └── shaders/          # CopyShader, LuminosityHighPassShader
```

## Usage

Open the app in your browser and use the sidebar (collapsible to an icon rail) to move between **Venue**, **Patterns**, **Designer**, **Timeline**, **Preview**, and **Export**. Start in the Designer to assign patterns to zones (or paint seats), then build patterns, sequence them on the timeline, and preview the show in 3D before exporting.

## Technology

- Vanilla HTML/CSS/JavaScript (no framework, no build step)
- [Three.js](https://threejs.org/) for 3D rendering, vendored locally in `vendor/`

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push to the branch and open a pull request

## License

No license has been specified for this project yet. All rights reserved unless a license is added.

## Acknowledgments

- The stadium model, seat LED layout, camera views, music-to-light behaviour and demo show come from the arena-lighting Unity project (Spring 2025 / Fall 2026 senior design teams). `tools/README.md` describes how they were exported.
- Built with [Three.js](https://threejs.org/).
