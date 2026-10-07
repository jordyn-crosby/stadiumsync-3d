#!/usr/bin/env python3
"""Turn the raw Unity export into the runtime files under assets/jordan-hare/.

Offline, one-time tool (stdlib only). See tools/README.md for the full pipeline.

    python3 tools/build_web_assets.py --raw <export dir> --unity "<path to stadium copy>"

Inputs
  <raw>/leds_raw.json, <raw>/stadium.glb    written by tools/unity/StadiumWebExporter.cs
  <unity>/Assets/Art/Models/.../auburnStadium_diffuse.jpg
  <unity>/Assets/Camera Data/Resources/FixedCameraControlData.json
  <unity>/Assets/Resources/first_demo/<n>.json   (Spring '25 light show)
  tools/zone_map.json

Outputs (assets/jordan-hare/)
  stadium.glb         meshopt-compressed via `npx gltfpack`, texture embedded (2048px)
  leds.json           per-LED position / zone / row / col / section + zone grid sizes
  cameras.json        Unity fixed-camera presets + aerial orbit settings
  show-first-demo.json + .bin   the Spring '25 show, one byte (group id) per LED per frame
"""
import argparse
import glob
import json
import math
import os
import shutil
import subprocess
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DECK_ORDER = ['Lower Deck', 'Upper Deck', 'Top Deck']
TEXTURE_REL = 'Assets/Art/Models/AuburnArena/Auburn-Stadium-Part3/auburnStadium_diffuse.jpg'
CAMERAS_REL = 'Assets/Camera Data/Resources/FixedCameraControlData.json'
SHOW_REL = 'Assets/Resources/first_demo'
SHOW_FPS = 2.3            # GlobalController: frame = floor(2.3 * (time - start))
NO_GROUP = 255


def wrap_deg(a):
    return (a + 180.0) % 360.0 - 180.0


def mean(xs):
    return sum(xs) / len(xs)


def build_leds(raw_leds, zone_map):
    xs = [l['pos'][0] for l in raw_leds]
    zs = [l['pos'][2] for l in raw_leds]
    cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2

    def theta(x, z):
        return math.degrees(math.atan2(z - cz, x - cx))

    # sections, keyed by the Unity instance id
    sections = defaultdict(list)
    for i, l in enumerate(raw_leds):
        sections[l['section']].append(i)

    zone_names = zone_map['zoneOrder']
    sec_list = []
    for sid, idxs in sections.items():
        l0 = raw_leds[idxs[0]]
        th = theta(mean([raw_leds[i]['pos'][0] for i in idxs]), mean([raw_leds[i]['pos'][2] for i in idxs]))
        zone = None
        for r in zone_map['rules']:
            if r['deck'] != l0['deck']:
                continue
            if 'thetaMin' in r and not (r['thetaMin'] <= th < r['thetaMax']):
                continue
            zone = r['zone']
            break
        if zone is None:
            sys.exit('no zone rule matches section %s (%s, theta %.1f)' % (l0['sectionName'], l0['deck'], th))
        # rows ranked by height: row 0 = front (lowest) row of the section
        rows = defaultdict(list)
        for i in idxs:
            rows[raw_leds[i]['row']].append(i)
        ordered = sorted(rows.values(), key=lambda r: mean([raw_leds[i]['pos'][1] for i in r]))
        sec_list.append({'uid': sid, 'name': l0['sectionName'].strip(), 'deck': l0['deck'],
                         'zone': zone, 'theta': th, 'rows': ordered})
    sec_list.sort(key=lambda s: (DECK_ORDER.index(s['deck']), s['theta']))

    n = len(raw_leds)
    out_zone, out_row, out_col, out_sec, out_rowid = [0] * n, [0] * n, [0] * n, [0] * n, [0] * n
    row_id = 0
    for si, s in enumerate(sec_list):
        for ri, r in enumerate(s['rows']):
            for i in r:
                out_sec[i] = si
                out_rowid[i] = row_id
            row_id += 1

    zones = []
    for zi, zname in enumerate(zone_names):
        zsecs = [s for s in sec_list if s['zone'] == zname]
        if not zsecs:
            sys.exit('zone %r has no sections' % zname)
        # stacked decks: rows of higher decks sit above all rows of lower decks in this zone
        offset, deck_offset = 0, {}
        for deck in DECK_ORDER:
            ds = [s for s in zsecs if s['deck'] == deck]
            if ds:
                deck_offset[deck] = offset
                offset += max(len(s['rows']) for s in ds)
        total_rows = offset
        # circular mean direction of the zone so angles don't wrap at +/-180 (west side)
        mdir = math.degrees(math.atan2(sum(math.sin(math.radians(s['theta'])) for s in zsecs),
                                       sum(math.cos(math.radians(s['theta'])) for s in zsecs)))
        zone_rows = defaultdict(list)          # zone row index -> [led index]
        for s in zsecs:
            for ri, r in enumerate(s['rows']):
                zone_rows[deck_offset[s['deck']] + ri].extend(r)
        cols = max(len(v) for v in zone_rows.values())
        for zr, idxs in zone_rows.items():
            # columns sweep left→right as seen from the field (decreasing angle)
            rel = [(-wrap_deg(theta(raw_leds[i]['pos'][0], raw_leds[i]['pos'][2]) - mdir), i) for i in idxs]
            lo, hi = min(a for a, _ in rel), max(a for a, _ in rel)
            span = (hi - lo) or 1.0
            for a, i in rel:
                out_zone[i] = zi
                out_row[i] = zr
                out_col[i] = int(round((a - lo) / span * (cols - 1)))
        zones.append({'name': zname, 'cols': cols, 'rows': total_rows,
                      'count': sum(len(v) for v in zone_rows.values())})

    pos = []
    for l in raw_leds:
        pos.extend(round(v, 3) for v in l['pos'])
    ys = [l['pos'][1] for l in raw_leds]
    return {
        'count': n,
        'center': [round(cx, 3), round(min(ys), 3), round(cz, 3)],
        'radius': round(max(math.hypot(l['pos'][0] - cx, l['pos'][2] - cz) for l in raw_leds), 3),
        'ledRadius': 0.125,
        'zones': zones,
        'sections': [{'name': s['name'], 'deck': s['deck'], 'zone': zone_names.index(s['zone'])} for s in sec_list],
        'pos': pos, 'zone': out_zone, 'row': out_row, 'col': out_col,
        'section': out_sec, 'rowId': out_rowid,
    }


def build_cameras(unity, center):
    raw = json.load(open(os.path.join(unity, CAMERAS_REL)))
    presets = []
    for name, c in raw.items():
        p, r = c['position'], c['rotation']
        rx, ry = math.radians(r['x']), math.radians(r['y'])
        # Unity Euler (ZXY, roll 0) forward = (sin y cos x, -sin x, cos y cos x); mirror x for web
        fwd = (-math.sin(ry) * math.cos(rx), -math.sin(rx), math.cos(ry) * math.cos(rx))
        pos = (-p['x'], p['y'], p['z'])
        dist = 20.0
        presets.append({'name': name,
                        'position': [round(v, 3) for v in pos],
                        'target': [round(pos[k] + fwd[k] * dist, 3) for k in range(3)]})
    return {
        'presets': presets,
        # DynamicCameraControl: yaw 3 deg/s, pitch 45 deg, 56 units from the stadium root (0,0,-6.82)
        'aerial': {'target': [0, 0, -6.82], 'distance': 56, 'pitchDeg': 45, 'yawDegPerSec': 3},
        # FreeCameraControl: speed 20 (shift 100)
        'free': {'speed': 20, 'fastSpeed': 100},
    }


def build_show(unity, raw_leds, out_dir):
    files = sorted(glob.glob(os.path.join(unity, SHOW_REL, '[0-9]*.json')),
                   key=lambda f: int(os.path.basename(f).split('.')[0]))
    if not files:
        print('  (no first_demo frames found, skipping show)')
        return
    by_upos = defaultdict(list)
    for i, l in enumerate(raw_leds):
        by_upos[tuple(l['upos'])].append(i)

    def key(p):
        return (round(p['x'], 3), round(p['y'], 3), round(p['z'], 3))

    def lookup(k):
        # Unity rounds to 3 decimals in float32; allow ±0.001 on each axis
        if k in by_upos:
            return by_upos[k]
        for dx in (-0.001, 0, 0.001):
            for dy in (-0.001, 0, 0.001):
                for dz in (-0.001, 0, 0.001):
                    hit = by_upos.get((round(k[0] + dx, 3), round(k[1] + dy, 3), round(k[2] + dz, 3)))
                    if hit:
                        return hit
        return None

    unique, frame_index, groups_per_frame = [], [], []
    seen = {}
    missing = set()
    for f in files:
        data = json.load(open(f))
        buf = bytearray([NO_GROUP]) * len(raw_leds)
        groups = {}
        for g in data['groups']:
            c = g['color']
            groups[str(g['id'])] = {
                'color': '#%02x%02x%02x' % tuple(max(0, min(255, int(round(c[k] * 255)))) for k in 'rgb'),
                'twinkle': g['isTwinkleActive'], 'pulse': g['isPulseActive'], 'static': g['isStaticActive'],
            }
            for p in g['LEDPositions']:
                idxs = lookup(key(p))
                if not idxs:
                    missing.add(key(p))
                    continue
                for i in idxs:
                    buf[i] = g['id']
        b = bytes(buf)
        if b not in seen:
            seen[b] = len(unique)
            unique.append(b)
        frame_index.append(seen[b])
        groups_per_frame.append(groups)

    with open(os.path.join(out_dir, 'show-first-demo.bin'), 'wb') as fh:
        for b in unique:
            fh.write(b)
    header = {'name': "Spring '25 demo show", 'fps': SHOW_FPS, 'ledCount': len(raw_leds),
              'uniqueFrames': len(unique), 'frames': frame_index, 'groups': groups_per_frame,
              'twinklePalette': ['#001733', '#bf4f00', '#ffffff']}
    json.dump(header, open(os.path.join(out_dir, 'show-first-demo.json'), 'w'), separators=(',', ':'))
    print('  show: %d frames (%d unique), %d stale positions not in the scene (ignored)' % (len(files), len(unique), len(missing)))


def build_glb(raw, unity, out_dir):
    src_tex = os.path.join(unity, TEXTURE_REL)
    tex = os.path.join(raw, 'stadium_diffuse.jpg')   # stadium.glb references it by this URI
    subprocess.run(['sips', '-Z', '2048', '-s', 'formatOptions', '80', src_tex, '--out', tex],
                   check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['npx', '-y', 'gltfpack@0.21', '-i', os.path.join(raw, 'stadium.glb'),
                    '-o', os.path.join(out_dir, 'stadium.glb'), '-cc', '-kn', '-km'], check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--raw', required=True, help='folder written by StadiumWebExporter')
    ap.add_argument('--unity', required=True, help='Unity project root (the "stadium copy" folder)')
    ap.add_argument('--out', default=os.path.join(ROOT, 'assets', 'jordan-hare'))
    ap.add_argument('--skip-glb', action='store_true', help='skip texture resize + gltfpack')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    raw_leds = json.load(open(os.path.join(args.raw, 'leds_raw.json')))['leds']
    zone_map = json.load(open(os.path.join(HERE, 'zone_map.json')))

    leds = build_leds(raw_leds, zone_map)
    json.dump(leds, open(os.path.join(args.out, 'leds.json'), 'w'), separators=(',', ':'))
    print('leds.json: %d LEDs, %d sections' % (leds['count'], len(leds['sections'])))
    for z in leds['zones']:
        print('  %-30s %5d LEDs  %3d cols x %2d rows' % (z['name'], z['count'], z['cols'], z['rows']))

    json.dump(build_cameras(args.unity, leds['center']), open(os.path.join(args.out, 'cameras.json'), 'w'), indent=1)
    print('cameras.json written')

    build_show(args.unity, raw_leds, args.out)

    if not args.skip_glb:
        if not shutil.which('npx'):
            sys.exit('npx (Node.js) is required for gltfpack; or pass --skip-glb')
        build_glb(args.raw, args.unity, args.out)
        print('stadium.glb: %.1f MB' % (os.path.getsize(os.path.join(args.out, 'stadium.glb')) / 1e6))


if __name__ == '__main__':
    main()
