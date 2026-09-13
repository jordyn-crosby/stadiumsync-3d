# StadiumSync 3D

StadiumSync is a browser-based studio for designing stadium LED light shows. It lets you manage a venue database, build zone-based light patterns, sequence them on a timeline, preview the result on a real-time 3D stadium renderer, and export the finished show.

## Features

- **Venue Database** — browse, import, and manage stadium venue profiles (capacity, location, LED zone layout).
- **Show Designer** — organize LED layers and zones for a venue and inspect individual zones.
- **Pattern Library** — build and preview reusable LED patterns with configurable parameters.
- **Timeline Editor** — sequence patterns into cues across a show timeline.
- **3D Preview** — a real-time Three.js stadium renderer (bloom-enhanced LED bands, orbit camera) that mirrors the same brightness/color logic used elsewhere in the app.
- **Export** — render a video preview and export project documentation/metadata.

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
├── stadium3d.js    # Procedural 3D stadium renderer (Three.js)
└── vendor/         # Vendored third-party libraries
    ├── three.min.js
    ├── OrbitControls.js
    ├── postprocessing/   # EffectComposer, RenderPass, ShaderPass, UnrealBloomPass
    └── shaders/          # CopyShader, LuminosityHighPassShader
```

## Usage

Open the app in your browser and use the top navigation to move between **Venues**, **Show Designer**, **Patterns**, **Timeline**, **Preview**, and **Export**. Start by selecting or importing a venue, then build patterns, sequence them on the timeline, and preview the show in 3D before exporting.

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

- Stadium proportions and LED section layout referenced from the Jordan-Hare model's LED prefab data.
- Built with [Three.js](https://threejs.org/).
