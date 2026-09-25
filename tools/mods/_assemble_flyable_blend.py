"""Reassemble a flyable-mode import_mod.py manifest (body + gear + per-surface
gltf files) into one rigged .blend: each control surface gets an Empty ("hinge
bone") placed at its pivot and oriented so local +X is the hinge axis, with the
surface mesh parented to it -- matching how the sim itself rotates these parts
at runtime (see ControlSurfaceConfig/pivot/axis in aircraftRegistry.ts)."""
import json
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
manifest_path, blend_path = argv[0], argv[1]

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(manifest_path)))


def to_blender(v):
    """glTF (Y-up) -> Blender (Z-up), consistent with what the glTF importer
    bakes into every object it creates."""
    return Vector((v[0], -v[2], v[1]))


def import_gltf(rel_path):
    path = os.path.join(PROJECT_ROOT, rel_path)
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=path)
    return [bpy.data.objects[n] for n in set(bpy.data.objects.keys()) - before]


def make_collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll


def move_to_collection(objs, coll):
    for o in objs:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)


def rename_parts(objs, prefix):
    for o in objs:
        o.name = f'{prefix}_{o.name}'
        if o.data:
            o.data.name = o.name


bpy.ops.wm.read_factory_settings(use_empty=True)

with open(manifest_path, encoding='utf-8') as f:
    manifest = json.load(f)

root = bpy.data.objects.new(manifest.get('id', 'aircraft'), None)
bpy.context.scene.collection.objects.link(root)

# Body / gear / shadow already share the body's frame -- no repositioning.
for key, label in (('body', 'Body'), ('gear', 'Gear'), ('shadow', 'Shadow')):
    rel = manifest.get(key)
    if not rel:
        continue
    coll = make_collection(label)
    objs = import_gltf(rel)
    rename_parts(objs, label)
    move_to_collection(objs, coll)
    for o in objs:
        if o.parent is None:
            o.parent = root

# Each control surface ships in its own hinge-centered frame (pivot -> origin).
# Recreate the hinge as an Empty at the pivot, X axis aligned to the rotation
# axis, and parent the surface mesh to it so posing the Empty poses the part.
for sd in manifest.get('surfaces', []):
    role = sd['role']
    rel = sd.get('path')
    if not rel:
        continue
    coll = make_collection(role[0].upper() + role[1:])
    objs = import_gltf(rel)
    rename_parts(objs, role)
    move_to_collection(objs, coll)

    pivot = to_blender(sd['pivot'])
    axis = to_blender(sd['axis']).normalized()

    quat = Vector((1.0, 0.0, 0.0)).rotation_difference(axis)

    hinge = bpy.data.objects.new(f'Hinge_{role}', None)
    hinge.empty_display_type = 'SINGLE_ARROW'
    hinge.empty_display_size = 0.6
    hinge.location = pivot
    hinge.rotation_mode = 'QUATERNION'
    hinge.rotation_quaternion = quat
    hinge['control'] = sd.get('control', '')
    hinge['sign'] = sd.get('sign', 1)
    hinge['rangeRad'] = sd.get('rangeRad', 0.0)
    bpy.context.scene.collection.objects.link(hinge)
    hinge.parent = root

    # Cancel just the hinge's rest rotation (not its translation) so, at rest,
    # the mesh sits at pure pivot + local-vertex (matching the sim's own rest
    # pose); rotating the Empty about its local +X then poses the surface
    # around the real world-space hinge axis through that pivot.
    parent_inverse = quat.inverted().to_matrix().to_4x4()
    for o in objs:
        if o.parent is None:
            o.parent = hinge
            o.matrix_parent_inverse = parent_inverse

# Each gltf import creates its own (now-empty) numbered scene collection --
# drop those so the outliner only shows the named per-part collections.
for c in list(bpy.data.collections):
    if len(c.objects) == 0 and len(c.children) == 0:
        bpy.data.collections.remove(c)

bpy.ops.wm.save_as_mainfile(filepath=blend_path)
print(f'Saved {blend_path}')
