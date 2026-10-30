#!/usr/bin/env python3
"""Check the ``airfields`` block against the pyramid it was baked from.

The bake reports as it goes, but it reports what it computed. This re-derives
the same numbers from what is actually on disk now, with no network, so it also
catches the case the bake cannot: a manifest baked against a DEM that has since
been re-imported, which leaves every runway sitting somewhere the ground is not.

Answers the question the airfields exist for - do the runways match the real
ones - in the only terms available offline: OSM's own declared length and
elevation against the geometry that was extracted, each graded runway, apron
and taxiway against the heights on disk, and their slopes against what an
aeroplane can use.

Usage::

    python tools/verify_airports.py
    python tools/verify_airports.py --icao GCLP --verbose

Exits non-zero when a hard check fails, so it can gate a bake in CI.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from typing import Iterable, List, Optional, Tuple

import numpy as np

from bake_osm_airports import (
    LandMask,
    LocalFrame,
    MAX_REF_DELTA_DEG,
    MAX_RESIDUAL_M,
    MAX_WATER_FRACTION,
    SAMPLE_STEP_M,
    designator_bearing,
    make_console_printable,
    parse_ref,
)
from osm_common import DemSampler, load_manifest

# A way that stops this far short of its own `length` tag is worth naming. Not
# an error: the tag is a declared distance and the way is often drawn between
# the displaced thresholds, so the two legitimately differ by a few percent.
LENGTH_TAG_TOLERANCE = 0.05
LENGTH_TAG_FLOOR_M = 40.0

# OSM's `ele` on an aerodrome is a spot height at the reference point and the
# runway's graded centre height is somewhere else, so they never agree
# exactly. Past this they disagree about which hill the airport is on.
ELE_TOLERANCE_M = 30.0

# The steepest a graded surface may be at all: a short grass strip kept at its
# ground's slope (airfield_grade.RUNWAY_CODE_12.steep_cap). Past it the
# profile on disk is not one the bake could have written.
MAX_PAVED_SLOPE = 0.205


def pad_surface(pad: dict, u: float, v: float) -> float:
    """A pad's stored surface at (u along, v across) metres from its centre:
    its profile where it has one, else its plane."""
    prof = pad.get('profile')
    if prof and len(prof) >= 2:
        f = min(len(prof) - 1.0, max(0.0, (u + pad['halfD']) / (2 * pad['halfD']) * (len(prof) - 1)))
        i = min(len(prof) - 2, int(f))
        return prof[i] + (prof[i + 1] - prof[i]) * (f - i)
    g = pad.get('gradient') or 0.0
    if g == 0.0:
        return pad['heightMsl']
    rel = math.radians((pad.get('gradientHeadingDeg', pad.get('headingDeg', 0.0)) - pad.get('headingDeg', 0.0)))
    return pad['heightMsl'] + g * (u * math.cos(rel) - v * math.sin(rel))


def resample(airfield: dict, dem: DemSampler, mask: Optional[LandMask]) -> Tuple[List[float], int, int]:
    """Residuals of every pad's stored surface, inside its core, against the
    heights on disk."""
    if not airfield.get('pads'):
        return [], 0, 0
    primary = max(airfield['runways'], key=lambda r: r['lengthM'])
    frame = LocalFrame(primary['lat'], primary['lon'])

    residuals: List[float] = []
    asked = water = 0
    for pad in airfield['pads']:
        pe, pn = frame.to_m(pad['lon'], pad['lat'])
        px = math.sin(math.radians(pad['headingDeg']))
        py = math.cos(math.radians(pad['headingDeg']))
        core_d = max(1.0, pad['halfD'] - pad['featherM'])
        core_w = max(1.0, pad['halfW'] - pad['featherM'])
        steps_l = max(1, int(core_d * 2 / SAMPLE_STEP_M))
        steps_w = max(1, int(core_w * 2 / SAMPLE_STEP_M))
        for i in range(steps_l + 1):
            u = -core_d + i * (2 * core_d / steps_l)
            for j in range(steps_w + 1):
                v = -core_w + j * (2 * core_w / steps_w)
                e = pe + px * u - py * v
                n = pn + py * u + px * v
                lon, lat = frame.to_lonlat(e, n)
                asked += 1
                if mask is not None and mask.is_land(lon, lat) is False:
                    water += 1
                h = dem.sample_bilinear(lon, lat)
                if math.isfinite(h):
                    residuals.append(h - pad_surface(pad, u, v))
    return residuals, asked, water


def check(
    airfield: dict, dem: DemSampler, mask: Optional[LandMask], verbose: bool,
) -> Tuple[List[str], List[str]]:
    """(problems, notes) for one airfield; both empty when it is sound.

    Split because the two have different consequences. A problem means the
    manifest cannot be trusted to place this airfield - the heights are gone,
    the graded surfaces no longer match them, or a paved runway is steeper
    than any aeroplane could use - and should stop a build. A note means
    OSM disagrees with itself, which it does constantly on small fields and
    which nothing downstream can or should fix.
    """
    problems: List[str] = []
    notes: List[str] = []
    name = f'{airfield.get("icao") or "----"} {airfield.get("name", "?")}'

    for r in airfield.get('runways', []):
        tag = r.get('lengthTagM')
        if tag:
            gap = r['lengthM'] - tag
            if abs(gap) > max(LENGTH_TAG_FLOOR_M, LENGTH_TAG_TOLERANCE * tag):
                notes.append(
                    f'{name}: runway {r["ref"]} measures {r["lengthM"]:.0f} m '
                    f'against an OSM length tag of {tag:.0f} m ({gap:+.0f} m)')
        if r.get('widthImplausible'):
            notes.append(f'{name}: runway {r["ref"]} had a width tag too narrow '
                         f'to believe; using {r["widthM"]:.0f} m')
        delta = r.get('refDeltaDeg')
        if delta is not None and abs(delta) > MAX_REF_DELTA_DEG:
            refs = parse_ref(r['ref'])
            want = designator_bearing(refs[0]) if refs else None
            problems.append(
                f'{name}: runway {r["ref"]} implies {want:.0f} deg magnetic but '
                f'runs {r["headingDeg"]:.1f} deg true')

    ele = airfield.get('eleTagM')
    plane = airfield.get('plane') or {}
    if ele is not None and plane:
        drift = plane['heightMsl'] - ele
        if abs(drift) > ELE_TOLERANCE_M:
            problems.append(f'{name}: the primary runway is {drift:+.0f} m off the OSM '
                            f'ele tag of {ele:.0f} m')

    # Slopes, as the bake graded them and re-read off the stored profiles.
    by_ref = {r['ref']: r for r in airfield.get('runways', [])}
    for report in (airfield.get('fit') or {}).get('runways', []):
        ref = report.get('ref', '?')
        status = report.get('status')
        if status == 'suspect':
            notes.append(f'{name}: runway {ref} needed {report["earthworkM"]:.1f} m of cut/fill '
                         f'(ground {report["naturalLocal"] * 100:.1f}% local) - the DEM and OSM may disagree')
        elif status == 'steep':
            notes.append(f'{name}: runway {ref} keeps the {report["local"] * 100:.1f}% of its ground '
                         f'({by_ref.get(ref, {}).get("surface", "?")} strip)')
    for pad in airfield.get('pads', []):
        prof = pad.get('profile')
        if not prof or len(prof) < 2:
            continue
        step = 2 * pad['halfD'] / (len(prof) - 1)
        worst = max(abs(b - a) for a, b in zip(prof, prof[1:])) / step
        if worst > MAX_PAVED_SLOPE:
            problems.append(f'{name}: a graded surface rises {worst * 100:.1f}% - no aeroplane uses that')
            break

    residuals, asked, water = resample(airfield, dem, mask)
    if not residuals:
        problems.append(f'{name}: the pyramid has no heights under this platform')
        return problems, notes

    arr = np.array(residuals)
    # The high tail is the buildings the bake weighted down; the surfaces are
    # only claimed to describe the ground, so this reads the same quantile back.
    kept = arr[arr <= np.quantile(arr, 0.90)]
    rms = float(np.sqrt(np.mean(kept ** 2)))
    worst = float(np.max(np.abs(kept)))
    if worst > MAX_RESIDUAL_M:
        problems.append(f'{name}: {worst:.0f} m between the stored surfaces and the '
                        f'heights on disk - was the DEM re-baked?')
    if asked and water / asked > MAX_WATER_FRACTION:
        problems.append(f'{name}: {100.0 * water / asked:.0f}% of the platform is '
                        f'water in the coast mask')

    if verbose:
        runways = ', '.join(f'{r["ref"]} {r["lengthM"]:.0f}x{r["widthM"]:.0f}'
                            for r in airfield.get('runways', []))
        print(f'  {name}  [{airfield.get("kind")}] {runways}')
        print(f'      primary {plane.get("heightMsl", 0):.1f} m MSL '
              f'{plane.get("gradient", 0) * 100:+.2f}% end to end  '
              f'rms {rms:.1f} m, max {worst:.1f} m over {len(residuals)} samples, '
              f'{100.0 * water / max(1, asked):.0f}% water')
        for report in (airfield.get('fit') or {}).get('runways', []):
            print(f'      {report.get("ref", "?"):9s} {report["status"]:7s} '
                  f'{report["naturalLocal"] * 100:.2f}% ground -> {report["local"] * 100:.2f}%, '
                  f'cut/fill {report["earthworkM"]:.1f} m')
    return problems, notes


def main(argv: Optional[Iterable[str]] = None) -> int:
    make_console_printable()
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', help='planet manifest.json (default: {out}/manifest.json)')
    parser.add_argument('--out', default='assets/planet', help='planet asset directory')
    parser.add_argument('--icao', help='check just this one')
    parser.add_argument('--verbose', action='store_true', help='print every airfield')
    args = parser.parse_args(list(argv) if argv is not None else sys.argv[1:])

    manifest_path = args.manifest or os.path.join(args.out, 'manifest.json')
    if not os.path.isfile(manifest_path):
        print(f'error: manifest not found: {manifest_path}', file=sys.stderr)
        return 2
    manifest = load_manifest(manifest_path)
    block = manifest.get('airfields') or {}
    items = block.get('items') or []
    if not items:
        print('no airfields baked - run tools/bake_osm_airports.py', file=sys.stderr)
        return 2
    if args.icao:
        items = [i for i in items if i.get('icao', '').upper() == args.icao.upper()]
        if not items:
            print(f'no airfield with ICAO {args.icao}', file=sys.stderr)
            return 2

    dem = DemSampler(args.out, manifest.get('maxZoom', 12), manifest.get('tileSize', 257))
    mask = (LandMask(args.out, manifest.get('maxZoom', 12), manifest.get('tileSize', 257))
            if manifest.get('coastMask', {}).get('enabled') else None)

    print(f'{len(items)} airfields, '
          f'{sum(len(i.get("runways", [])) for i in items)} runways')
    problems: List[str] = []
    notes: List[str] = []
    for airfield in items:
        found, said = check(airfield, dem, mask, args.verbose)
        problems.extend(found)
        notes.extend(said)

    if notes:
        print(f'\n{len(notes)} notes (OSM disagreeing with itself, not errors):')
        for n in notes:
            print(f'  {n}')
    if problems:
        print(f'\n{len(problems)} problems:')
        for p in problems:
            print(f'  {p}')
        return 1
    print('\nall sound')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
