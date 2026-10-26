"""Pack a Python runtime for the bake satellite (tools/build_satellite.ts).

The satellite runs the bake's Python stages, so it carries an interpreter
and the packages they import. The interpreter is a python.org install (a
relocatable directory: python.exe finds its Lib beside it); the packages
come from whichever site-packages has them, chosen by distribution and
closed over their own Requires-Dist, so nothing else installed there rides
along. Binary wheels are cp312-win_amd64 either way, so a Store Python's
packages run on a python.org interpreter of the same minor version.

The archive is the satellite's own format (tools/satellite/pyRuntime.ts
reads it): 'RFSPY1', a little-endian u32 count, then per file a u16 path
length, the path (UTF-8, '/'), u32 raw size, u32 packed size, and the
raw-deflated bytes.

Run with the Python whose packages are to be packed::

    python tools/satellite/pack_python.py --base <python.org install> --out python.bin numpy rasterio ...
"""

from __future__ import annotations

import argparse
import importlib.metadata as md
import os
import re
import struct
import sys
import zlib

# Not part of a runtime the satellite needs.
BASE_SKIP = re.compile(r'(^|/)(__pycache__|test|tests|idlelib|tkinter|turtledemo|ensurepip|venv|lib2to3|pydoc_data)(/|$)'
                       r'|^(Doc|Tools|tcl|Scripts|include|libs|Lib/site-packages)(/|$)'
                       r'|\.(pyc|pdb|chm)$|^(pythonw|python3)\.exe$')
PKG_SKIP = re.compile(r'(^|/)__pycache__(/|$)|\.pyc$')


def closure(names: list[str]) -> list[md.Distribution]:
    """The distributions named and everything they require, unconditionally or for win32."""
    seen: dict[str, md.Distribution] = {}
    todo = list(names)
    while todo:
        name = todo.pop()
        key = re.sub(r'[-_.]+', '-', name).lower()
        if key in seen:
            continue
        try:
            dist = md.distribution(name)
        except md.PackageNotFoundError:
            print(f'  (not installed, skipped: {name})', file=sys.stderr)
            continue
        seen[key] = dist
        for req in dist.requires or []:
            spec, _, marker = req.partition(';')
            if 'extra' in marker:
                continue
            if marker and ('sys_platform' in marker and 'win32' not in marker or 'platform_system' in marker and 'Windows' not in marker):
                continue
            todo.append(re.split(r'[\s<>=!~\[(]', spec.strip(), maxsplit=1)[0])
    return list(seen.values())


def package_files(dist: md.Distribution) -> list[tuple[str, str]]:
    """(absolute path, path under Lib/site-packages) of every file the distribution installed."""
    out = []
    root = dist.locate_file('')
    for f in dist.files or []:
        rel = str(f).replace('\\', '/')
        if rel.startswith('..') or PKG_SKIP.search(rel):
            continue
        p = os.path.join(str(root), str(f))
        if os.path.isfile(p):
            out.append((p, 'Lib/site-packages/' + rel))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True, help='a python.org install of this minor version')
    ap.add_argument('--out', required=True)
    ap.add_argument('dists', nargs='+')
    args = ap.parse_args()

    files: list[tuple[str, str]] = []
    for root, _dirs, names in os.walk(args.base):
        for n in names:
            p = os.path.join(root, n)
            rel = os.path.relpath(p, args.base).replace('\\', '/')
            if not BASE_SKIP.search(rel):
                files.append((p, rel))
    base_count = len(files)
    dists = closure(args.dists)
    for d in dists:
        files.extend(package_files(d))
    print(f'pack_python: {base_count} runtime files, {len(dists)} distributions: '
          + ', '.join(sorted(f"{d.metadata['Name']} {d.version}" for d in dists)))

    raw_total = packed_total = 0
    with open(args.out + '.tmp', 'wb') as out:
        out.write(b'RFSPY1' + struct.pack('<I', len(files)))
        for p, rel in files:
            with open(p, 'rb') as fh:
                raw = fh.read()
            c = zlib.compressobj(6, zlib.DEFLATED, -15)
            packed = c.compress(raw) + c.flush()
            name = rel.encode('utf-8')
            out.write(struct.pack('<H', len(name)) + name + struct.pack('<II', len(raw), len(packed)) + packed)
            raw_total += len(raw)
            packed_total += len(packed)
    os.replace(args.out + '.tmp', args.out)
    print(f'pack_python: {len(files)} files, {raw_total / 1e6:.0f} MB -> {packed_total / 1e6:.0f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
