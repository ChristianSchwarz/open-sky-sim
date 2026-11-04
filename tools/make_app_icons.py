"""Draws the home-screen icons the web manifest names (src/manifest.webmanifest).

A delta-wing jet seen from above, white on the night-sky blue of the boot
screen; drawn at 4x and scaled down for smooth edges. Run once:

    python tools/make_app_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

BACKGROUND = (12, 20, 48, 255)
JET = (240, 240, 240, 255)
# Nose up, in a unit square: fuselage, delta wings, tail fins.
OUTLINE = [
    (0.50, 0.12), (0.55, 0.30), (0.56, 0.44), (0.84, 0.66), (0.84, 0.72),
    (0.56, 0.64), (0.55, 0.76), (0.66, 0.86), (0.66, 0.90), (0.50, 0.86),
    (0.34, 0.90), (0.34, 0.86), (0.45, 0.76), (0.44, 0.64), (0.16, 0.72),
    (0.16, 0.66), (0.44, 0.44), (0.45, 0.30),
]


def draw(size: int) -> Image.Image:
    big = size * 4
    image = Image.new('RGBA', (big, big), BACKGROUND)
    ImageDraw.Draw(image).polygon([(x * big, y * big) for x, y in OUTLINE], fill=JET)
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = Path(__file__).resolve().parent.parent / 'assets'
    for size in (192, 512):
        draw(size).save(out / f'icon-{size}.png', optimize=True)


if __name__ == '__main__':
    main()
