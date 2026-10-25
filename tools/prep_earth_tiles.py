#!/usr/bin/env python3
"""Cut NASA Blue Marble into the colour map the planet is drawn with from orbit.

Input is the 500 m Blue Marble Next Generation set (June 2004, public domain):
eight 21600x21600 JPEGs, world.200406.3x21600x21600.{A1,B1,C1,D1,A2,B2,C2,D2}.jpg,
each 90 degrees a side - A to D west to east from 180 W, 1 north of the
equator, 2 south - from
https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/june/

Output, in assets/earth/:
  base.jpg              the whole planet at 4096x2048, always resident
  1/r{row}c{col}.jpg    1.85 km level: 32 x 16 tiles of 675 px, 11.25 degrees
  2/r{row}c{col}.jpg    463 m level: 128 x 64 tiles of 675 px, 2.8125 degrees
Row 0 is the north edge, column 0 starts at 180 W.

The runtime keeps a block of each level's tiles round the camera and the base
everywhere else (see src/script/scene/earthMap.ts, whose grid constants must
match these).
"""
import argparse
import os

from PIL import Image

SOURCE_PX = 21600
TILE_PX = 675
LEVEL1_SCALE = 4             # 463 m -> 1.85 km
BASE_SIZE = (4096, 2048)
QUADS = ['A', 'B', 'C', 'D']


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('source_dir', help='folder holding the eight A1..D2 JPEGs')
    ap.add_argument('--out', default=os.path.join('assets', 'earth'))
    ap.add_argument('--quality', type=int, default=85)
    args = ap.parse_args()

    Image.MAX_IMAGE_PIXELS = None
    per_quad = SOURCE_PX // TILE_PX
    l1_quad = SOURCE_PX // LEVEL1_SCALE
    level1 = Image.new('RGB', (l1_quad * 4, l1_quad * 2))
    for level in ('1', '2'):
        os.makedirs(os.path.join(args.out, level), exist_ok=True)

    total = 0
    count = 0
    for qy, half in enumerate(('1', '2')):
        for qx, letter in enumerate(QUADS):
            path = os.path.join(args.source_dir, f'world.200406.3x21600x21600.{letter}{half}.jpg')
            if not os.path.exists(path):
                path = os.path.join(args.source_dir, f'{letter}{half}.jpg')
            quad = Image.open(path).convert('RGB')
            if quad.size != (SOURCE_PX, SOURCE_PX):
                raise SystemExit(f'{path}: expected {SOURCE_PX}x{SOURCE_PX}, got {quad.size}')
            for j in range(per_quad):
                for i in range(per_quad):
                    box = (i * TILE_PX, j * TILE_PX, (i + 1) * TILE_PX, (j + 1) * TILE_PX)
                    row = qy * per_quad + j
                    col = qx * per_quad + i
                    out = os.path.join(args.out, '2', f'r{row}c{col}.jpg')
                    quad.crop(box).save(out, quality=args.quality, optimize=True)
                    total += os.path.getsize(out)
                    count += 1
            level1.paste(quad.resize((l1_quad, l1_quad), Image.LANCZOS), (qx * l1_quad, qy * l1_quad))
            quad.close()
            print(f'{letter}{half} done')

    rows1 = level1.size[1] // TILE_PX
    cols1 = level1.size[0] // TILE_PX
    for row in range(rows1):
        for col in range(cols1):
            box = (col * TILE_PX, row * TILE_PX, (col + 1) * TILE_PX, (row + 1) * TILE_PX)
            out = os.path.join(args.out, '1', f'r{row}c{col}.jpg')
            level1.crop(box).save(out, quality=args.quality, optimize=True)
            total += os.path.getsize(out)
            count += 1
    level1.resize(BASE_SIZE, Image.LANCZOS).save(
        os.path.join(args.out, 'base.jpg'), quality=88, optimize=True)
    print(f'{count} tiles, {total / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
