# Asset pipeline: Unity → web

The files in `assets/jordan-hare/` are generated once, offline, from the Unity arena-lighting
project (`arenalighting-fall2026/stadium copy`, Unity 6000.3.24f1). The app itself never runs
these tools — they're here so the assets can be regenerated (e.g. after regrouping zones or
changing the Unity scene).

## 1. Export from Unity

Copy `tools/unity/StadiumWebExporter.cs` into `<unity project>/Assets/Editor/`, then either open
`Assets/Scenes/SPRING25_Stadium.unity` and run **StadiumSync → Export for Web**, or run headless:

```bash
"/Applications/Unity/Hub/Editor/6000.3.24f1/Unity.app/Contents/MacOS/Unity" \
  -batchmode -quit -projectPath "<path>/stadium copy" \
  -executeMethod StadiumWebExporter.ExportBatch -exportDir <raw dir> -logFile <raw dir>/unity.log
```

This writes to `<raw dir>`:

- `stadium.glb`: the stadium FBX with world transforms baked in (~27 MB, uncompressed, texture referenced by URI).
- `leds_raw.json`: all 24,778 `LED`-tagged objects with world position, deck, section and row.

Everything is mirrored x → −x (Unity is left-handed, three.js right-handed). The mesh and LEDs are
mirrored together, so they stay aligned. Remove the script from the Unity project afterwards
(it needs no packages).

## 2. Build the web assets

```bash
python3 tools/build_web_assets.py --raw <raw dir> --unity "<path>/stadium copy"
```

Needs Python 3 (stdlib only), macOS `sips` (texture resize) and `npx` (runs `gltfpack` for meshopt
compression). Pass `--skip-glb` to only rebuild the JSON/show files. Outputs:

| File | Contents |
|---|---|
| `stadium.glb` | meshopt-compressed + quantized mesh with a 2048px texture embedded (~4 MB). Decoded by `vendor/libs/meshopt_decoder.js`. |
| `leds.json` | per-LED `pos` (flat xyz), `zone`, `row`, `col`, `section`, `rowId`; `zones[]` = `{name, cols, rows, count}`; `sections[]`; `center`, `radius`, `ledRadius`. |
| `cameras.json` | the 13 Unity fixed-camera presets (`position` + `target`), plus aerial-orbit and free-fly settings. |
| `show-first-demo.json` + `.bin` | Spring '25 light show: 93 frames at 2.3 fps. The `.bin` is one byte (group id, 255 = none) per LED per *unique* frame; the header maps frames → unique frames and lists each frame's group colors/effects. |

## Zones

`tools/zone_map.json` assigns each of the 84 Unity sections to one of the 12 Jordan-Hare zones
(the Designer layers), by deck plus the section's angle around the field (0° = +x/east,
90° = +z/north). Zone names must match `zoneData[].name` in `index.html`. Within a zone,
`row` counts up from the front row, stacking higher decks above lower ones, and `col` runs
along the zone's arc. `computeDotBrightness` and `getDotColor` receive this grid.
