"""Export data/kuz.blend → assets/kuz.glb for the flight sim.

- Assigns palette materials on empty/textured carrier slots
- Applies object transforms
- Exports a single glTF scene (all mesh layers) as binary GLB

Collision triangles are baked at runtime from the loaded GLB (no sidecar JSON).
"""
from __future__ import annotations

from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]
BLEND = ROOT / 'data' / 'kuz.blend'
OUT = ROOT / 'assets' / 'kuz.glb'
OUT_DATA = ROOT / 'data' / 'kuz.glb'

# Hull / island faces with missing or texture-only materials.
# Darker navy charcoal at runtime (ModelManager remaps legacy METAL too).
HULL_MATERIAL = 'VEHICLE_PLANE_ENGINE'


def ensure_material(name: str) -> bpy.types.Material:
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    return mat


def prepare_carrier() -> None:
    hull = ensure_material(HULL_MATERIAL)
    carrier = bpy.data.objects.get('carrier')
    if carrier is None or carrier.type != 'MESH':
        raise SystemExit('carrier mesh not found in kuz.blend')

    # Fill empty slots and replace texture-named materials with palette metal.
    for i, slot in enumerate(carrier.material_slots):
        mat = slot.material
        if mat is None or mat.name.endswith('_dds') or mat.name.startswith('#'):
            slot.material = hull
            if carrier.data.materials:
                # Keep mesh material list in sync with slots.
                while len(carrier.data.materials) <= i:
                    carrier.data.materials.append(None)
                carrier.data.materials[i] = hull


def apply_transforms() -> None:
    """Bake rotation/scale into mesh data without relying on view-layer selection."""
    import mathutils

    identity = mathutils.Matrix.Identity(4)
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mw = obj.matrix_world.copy()
        is_identity = True
        for r in range(4):
            for c in range(4):
                if abs(mw[r][c] - identity[r][c]) > 1e-8:
                    is_identity = False
                    break
            if not is_identity:
                break
        if is_identity:
            continue
        mesh = obj.data
        mesh.transform(mw)
        mesh.update()
        obj.matrix_world = identity


def merge_into_single_scene() -> None:
    """Put every mesh into the first scene so export is one LOD level."""
    if not bpy.data.scenes:
        return
    main = bpy.data.scenes[0]
    bpy.context.window.scene = main
    for obj in list(bpy.data.objects):
        if obj.type != 'MESH':
            continue
        if obj.name not in main.objects:
            try:
                main.collection.objects.link(obj)
            except RuntimeError:
                pass

    for sc in list(bpy.data.scenes):
        if sc != main:
            bpy.data.scenes.remove(sc)


def export_glb(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format='GLB',
        use_selection=False,
        export_apply=True,
        export_texcoords=False,
        export_normals=True,
        export_materials='EXPORT',
        export_animations=False,
        export_extras=False,
        export_yup=True,
    )
    print(f'Wrote {path} ({path.stat().st_size} bytes)')


def main() -> int:
    bpy.ops.wm.open_mainfile(filepath=str(BLEND))
    prepare_carrier()
    apply_transforms()
    merge_into_single_scene()
    export_glb(OUT)
    export_glb(OUT_DATA)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
