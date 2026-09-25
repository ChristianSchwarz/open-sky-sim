"""Subdivide the Kuznetsov bow ski-jump ramp for denser collision/rendering.

Processes assets/kuz.glb (or an explicit path): one midpoint subdivision pass
on hull + deck faces in the bow region (~3× ramp vertices). Writes back to
assets/kuz.glb and data/kuz.glb.

Run after tools/export_kuz.py, or standalone on an existing GLB:

    python tools/rebuild_kuz.py
    python tools/rebuild_kuz.py --input assets/kuz.glb --output assets/kuz.glb
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_IN = ROOT / 'assets' / 'kuz.glb'
DEFAULT_OUT_ASSETS = ROOT / 'assets' / 'kuz.glb'
DEFAULT_OUT_DATA = ROOT / 'data' / 'kuz.glb'

# Bow = −Z in the exported GLB (stern +Z). Two-pass subdivision on the hull
# targets ~3× bow-region vertices; deck overlay gets one pass.
CARRIER_BOW_PASS1_Z = -100.0
CARRIER_BOW_PASS2_Z = -177.0  # all face verts past this (tip wedge only)
DECK_BOW_Z = -90.0
BOW_REPORT_Z = -90.0
TARGET_BOW_MULTIPLIER = 3.0


def _bow_vertex_count(vertices: np.ndarray, z_cut: float) -> int:
    return int(np.sum(vertices[:, 2] < z_cut))


def _subdivide_bow_faces(mesh: trimesh.Trimesh, z_cut: float, *, all_verts: bool = False) -> tuple[trimesh.Trimesh, int]:
    """One midpoint subdivision on faces in the bow half-space."""
    verts = mesh.vertices
    faces = mesh.faces
    tri = verts[faces]
    if all_verts:
        mask = np.all(tri[:, :, 2] < z_cut, axis=1)
    else:
        mask = np.any(tri[:, :, 2] < z_cut, axis=1)
    face_idx = np.where(mask)[0]
    if len(face_idx) == 0:
        return mesh, 0
    return mesh.subdivide(face_index=face_idx), len(face_idx)


def _subdivide_carrier_bow(mesh: trimesh.Trimesh) -> tuple[trimesh.Trimesh, list[int]]:
    """Two-pass hull subdivision: broad bow band, then ski-jump tip wedge."""
    counts: list[int] = []
    out, n = _subdivide_bow_faces(mesh.copy(), CARRIER_BOW_PASS1_Z)
    counts.append(n)
    out, n = _subdivide_bow_faces(out, CARRIER_BOW_PASS2_Z, all_verts=True)
    counts.append(n)
    return out, counts


def rebuild_kuz_scene(scene: trimesh.Scene) -> dict[str, int]:
    """Subdivide bow ramp geometry in-place; return before/after bow vertex stats."""
    stats: dict[str, int] = {}

    if 'carrier' in scene.geometry:
        hull = scene.geometry['carrier']
        before = _bow_vertex_count(hull.vertices, BOW_REPORT_Z)
        hull_out, pass_counts = _subdivide_carrier_bow(hull)
        after = _bow_vertex_count(hull_out.vertices, BOW_REPORT_Z)
        scene.geometry['carrier'] = hull_out
        stats['carrier_bow_before'] = before
        stats['carrier_bow_after'] = after
        stats['carrier_faces_subdivided'] = sum(pass_counts)
        stats['carrier_verts'] = len(hull_out.vertices)
        stats['carrier_bow_multiplier'] = after / before if before else 0.0

    deck_key = 'carrier_3'
    if deck_key in scene.geometry:
        deck = scene.geometry[deck_key]
        before = _bow_vertex_count(deck.vertices, DECK_BOW_Z)
        deck_out, n_faces = _subdivide_bow_faces(deck.copy(), DECK_BOW_Z)
        after = _bow_vertex_count(deck_out.vertices, DECK_BOW_Z)
        scene.geometry[deck_key] = deck_out
        stats['deck_bow_before'] = before
        stats['deck_bow_after'] = after
        stats['deck_faces_subdivided'] = n_faces
        stats['deck_verts'] = len(deck_out.vertices)

    return stats


def rebuild_glb(input_path: Path, output_paths: list[Path]) -> dict[str, int]:
    scene = trimesh.load(input_path, force='scene')
    if not isinstance(scene, trimesh.Scene):
        raise SystemExit(f'expected a GLB scene, got {type(scene)}')

    stats = rebuild_kuz_scene(scene)
    for out in output_paths:
        out.parent.mkdir(parents=True, exist_ok=True)
        scene.export(out)
        print(f'Wrote {out} ({out.stat().st_size} bytes)')

    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=DEFAULT_IN)
    parser.add_argument(
        '--output',
        type=Path,
        action='append',
        dest='outputs',
        help='Output GLB (default: assets/kuz.glb and data/kuz.glb)',
    )
    args = parser.parse_args(argv)

    outputs = args.outputs or [DEFAULT_OUT_ASSETS, DEFAULT_OUT_DATA]
    if not args.input.is_file():
        raise SystemExit(f'input not found: {args.input}')

    stats = rebuild_glb(args.input, outputs)

    if 'carrier_bow_before' in stats:
        b, a = stats['carrier_bow_before'], stats['carrier_bow_after']
        ratio = stats.get('carrier_bow_multiplier', a / b if b else 0.0)
        print(
            f"Hull bow (Z<{BOW_REPORT_Z}): {b} -> {a} verts ({ratio:.2f}x), "
            f"{stats['carrier_faces_subdivided']} faces subdivided, "
            f"{stats['carrier_verts']} hull verts total",
        )
    if 'deck_bow_before' in stats:
        b, a = stats['deck_bow_before'], stats['deck_bow_after']
        ratio = a / b if b else 0.0
        print(
            f"Deck bow (Z<{DECK_BOW_Z}): {b} -> {a} verts ({ratio:.2f}x), "
            f"{stats['deck_faces_subdivided']} faces subdivided, "
            f"{stats['deck_verts']} deck verts total",
        )

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
