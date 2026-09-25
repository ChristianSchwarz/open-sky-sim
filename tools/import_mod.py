"""Import a Unity asset-bundle mod into a retroflightsim glTF.

Many low-poly Unity mods (e.g. Tiny Combat Arena aircraft) do not use detail
textures. Their whole livery -- paint, insignia, side numbers, trim -- is
authored as flat polygon "vector decals" whose colours come from a tiny
palette-swatch texture: every triangle's UVs point at one solid-colour cell.
Others simply rely on per-material flat `_Color` values.

This tool recovers those real per-polygon colours by, for each mesh face:
  1. an explicit per-material override colour (config `materialColors`), else
  2. an afterburner nozzle interior -> a dark literal '#rrggbb' (rest pose), else
  3. glass -> the configured glass colour (usually 'GLASS'), else
  4. an emissive "light" (bright emission over a dark base) -> its literal colour, else
  5. a palette-swatch sample at the face's UV centroid, else
  6. the material's flat `_Color`, else a neutral fallback.
Faces are grouped by colour and written to a glTF with one mesh/material per
distinct colour. Each material is named '#rrggbb' so the sim renders that
literal colour (see ModelManager.rawColorFor). A material name may also be a
PaletteCategory (e.g. 'GLASS' for glass). Afterburner *glow* is procedural at
fx.nozzles; nozzle-interior meshes export as dark metal, not FX_FIRE.

Transparent materials (low alpha) are auto-detected as glass; you can also
force parts to glass by name, and control the glass colour.

Tiny Combat Arena "shared materials" (Canopy, ColliderMat, NozzleInteriorMat,
ShadowDepthOffset/HeightOffset) are referenced by GUID and are usually NOT
bundled with a workshop mod, so their material *name* cannot be resolved. Glass,
nozzle, and collider/shadow classification therefore also fall back to mesh-name
conventions so those parts are still handled when the material is unresolved.

The --bundle input may be a mod .zip (e.g. a Tiny Combat Arena workshop
download), a raw Unity asset bundle file, or a folder; a .zip is unpacked and
the Unity bundle inside is located automatically.

Usage:
    # Inspect a mod (list GameObjects, materials, textures) before importing:
    python tools/import_mod.py --bundle "C:/Downloads/mod.zip" --list

    # Import using a JSON config (see tools/mods/_template.json for all fields):
    python tools/import_mod.py --config tools/mods/mod.json

    # Import straight from the CLI (zero-config: include everything, auto glass):
    python tools/import_mod.py --bundle "C:/Downloads/mod.zip" --out assets/foo.gltf

The importer only produces the glTF asset. To make it appear in the sim, add it
to src/script/state/staticModelViews.ts (static ramp models) or load it via
ModelManager.getModel(...) like any other model.
"""
from __future__ import annotations

import argparse
import atexit
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
import zipfile
import zlib
from collections import defaultdict

import numpy as np
import trimesh
import UnityPy
from PIL import Image

from tca_mapping import (
    animated_part_control,
    auto_gear_names,
    auto_surface_defs,
    classify_material,
    is_attachment_empty,
    is_cockpit_part,
    is_collision_mesh,
    is_discover_skip_part,
    is_engine_part,
    is_fuselage_part,
    is_glass_part,
    is_livery_material,
    is_nozzle_mesh,
    is_nozzle_part,
    is_body_hint_part,
    is_wingtip_part,
    merge_config_overrides,
    point_in_expanded_bounds,
    should_skip_gear_clip_part,
    skip_part_substrings,
)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GLASS_CATEGORY = 'GLASS'
DEFAULT_MATERIAL = '#909094'  # neutral grey fallback
# PaletteCategory used for a generated flyable-aircraft shadow silhouette.
SHADOW_MATERIAL = 'SCENERY_TREE_SHADOW'
# Reserved material token for invisible TCA hitbox / collider meshes.
COLLISION_MATERIAL = 'COLLISION'
# Dark metal for nozzle-interior mesh geometry (TCA rest pose is black).
DEFAULT_NOZZLE_COLOR = '#1a1a1a'
# Kept for material-name parsing in legacy glTF node names.
FX_FIRE_MATERIAL = 'FX_FIRE'

# Emissive "light" detection: a material is treated as a self-lit lamp only when
# its _EmissionColor is at least this bright AND its base _Color is darker than
# EMISSION_BASE_MAX (the F4EEmissiveMat pattern: black base + bright emission).
# This keeps ordinary lit surfaces on the palette/flat-colour path.
EMISSION_MIN = 0.35
EMISSION_BASE_MAX = 0.2

# UnityPy's mesh.export() negates X to convert Unity's left-handed coordinates
# to a right-handed OBJ/glTF system. Transforms read from the bundle are still
# in Unity's left-handed space, so a part's world matrix must be conjugated by
# this flip (S @ M @ S) before it is applied to the exported (flipped) verts.
# Without this, only identity-rotation parts land correctly; rotated/offset
# parts (gear wheels, speedbrakes, control surfaces) get the wrong axis.
_FLIP_X = np.diag([-1.0, 1.0, 1.0, 1.0])

# A texture no larger than this (px) is treated as a flat palette-swatch atlas.
DEFAULT_SWATCH_MAX = 64
# Large bitmap liveries are downsampled to this max edge before per-face sampling.
DEFAULT_BITMAP_SAMPLE_MAX = 512


# --------------------------------------------------------------------------- #
# Unity math helpers
# --------------------------------------------------------------------------- #
def vec3(v) -> np.ndarray:
    return np.array([v.x, v.y, v.z], dtype=np.float64)


def quat(q) -> np.ndarray:
    return np.array([q.x, q.y, q.z, q.w], dtype=np.float64)


def local_matrix(transform) -> np.ndarray:
    pos = vec3(transform.m_LocalPosition)
    rot = quat(transform.m_LocalRotation)
    scale = vec3(transform.m_LocalScale)

    x, y, z, w = rot
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z

    rot_mat = np.array([
        [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
        [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
        [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
    ], dtype=np.float64)

    mat = np.eye(4, dtype=np.float64)
    mat[:3, :3] = rot_mat * scale
    mat[:3, 3] = pos
    return mat


def world_matrix(path_id: int, transforms, cache) -> np.ndarray:
    if path_id in cache:
        return cache[path_id]
    transform = transforms[path_id]
    mat = local_matrix(transform)
    parent = transform.m_Father
    if parent.path_id != 0 and parent.path_id in transforms:
        mat = world_matrix(parent.path_id, transforms, cache) @ mat
    cache[path_id] = mat
    return mat


def euler_matrix(degrees) -> np.ndarray:
    """3x3 rotation matrix from XYZ Euler angles (degrees), applied X then Y then Z."""
    rx, ry, rz = (np.radians(float(a)) for a in degrees)
    cx, sx = np.cos(rx), np.sin(rx)
    cy, sy = np.cos(ry), np.sin(ry)
    cz, sz = np.cos(rz), np.sin(rz)
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float64)
    mz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=np.float64)
    return mz @ my @ mx


def unity_hash(s: str) -> int:
    """CRC32 path hash used by Unity animation bindings."""
    return zlib.crc32(s.encode('utf-8')) & 0xFFFFFFFF


def unity_euler_quat(x_deg: float, y_deg: float, z_deg: float) -> np.ndarray:
    """Quaternion (x,y,z,w) matching Unity Quaternion.Euler(x,y,z)."""
    # Unity applies Y, then X, then Z (world axes) == intrinsic ZXY.
    rx, ry, rz = np.radians([x_deg, y_deg, z_deg])
    cx, sx = np.cos(rx * 0.5), np.sin(rx * 0.5)
    cy, sy = np.cos(ry * 0.5), np.sin(ry * 0.5)
    cz, sz = np.cos(rz * 0.5), np.sin(rz * 0.5)
    # q = qy * qx * qz
    qx = np.array([sx, 0.0, 0.0, cx])
    qy = np.array([0.0, sy, 0.0, cy])
    qz = np.array([0.0, 0.0, sz, cz])

    def qmul(a, b):
        ax, ay, az, aw = a
        bx, by, bz, bw = b
        return np.array([
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ], dtype=np.float64)

    return qmul(qy, qmul(qx, qz))


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    x, y, z, w = q
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    return np.array([
        [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
        [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
        [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
    ], dtype=np.float64)


def matrix_to_trs(mat: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Decompose a 4x4 (no shear) into translation, quaternion (xyzw), scale."""
    t = mat[:3, 3].copy()
    sx = float(np.linalg.norm(mat[:3, 0]))
    sy = float(np.linalg.norm(mat[:3, 1]))
    sz = float(np.linalg.norm(mat[:3, 2]))
    # Preserve orientation when a scale axis collapses (m_IsActive hide).
    if sx < 1e-8:
        sx = 1e-8
    if sy < 1e-8:
        sy = 1e-8
    if sz < 1e-8:
        sz = 1e-8
    r = mat[:3, :3].copy()
    r[:, 0] /= sx
    r[:, 1] /= sy
    r[:, 2] /= sz
    # Orthonormalise in case of tiny numeric drift.
    r[:, 0] /= max(np.linalg.norm(r[:, 0]), 1e-12)
    r[:, 1] = np.cross(r[:, 2], r[:, 0])
    r[:, 1] /= max(np.linalg.norm(r[:, 1]), 1e-12)
    r[:, 2] = np.cross(r[:, 0], r[:, 1])
    r[:, 2] /= max(np.linalg.norm(r[:, 2]), 1e-12)
    # Rotation matrix -> quaternion (xyzw).
    tr = float(r[0, 0] + r[1, 1] + r[2, 2])
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2.0
        qw = 0.25 * s
        qx = (r[2, 1] - r[1, 2]) / s
        qy = (r[0, 2] - r[2, 0]) / s
        qz = (r[1, 0] - r[0, 1]) / s
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2.0
        qw = (r[2, 1] - r[1, 2]) / s
        qx = 0.25 * s
        qy = (r[0, 1] + r[1, 0]) / s
        qz = (r[0, 2] + r[2, 0]) / s
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2.0
        qw = (r[0, 2] - r[2, 0]) / s
        qx = (r[0, 1] + r[1, 0]) / s
        qy = 0.25 * s
        qz = (r[1, 2] + r[2, 1]) / s
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2.0
        qw = (r[1, 0] - r[0, 1]) / s
        qx = (r[0, 2] + r[2, 0]) / s
        qy = (r[1, 2] + r[2, 1]) / s
        qz = 0.25 * s
    q = np.array([qx, qy, qz, qw], dtype=np.float64)
    q /= max(np.linalg.norm(q), 1e-12)
    return t, q, np.array([sx, sy, sz], dtype=np.float64)


# Unity generic-binding attribute IDs used by TCA GearUp clips.
_ATTR_POSITION = 1
_ATTR_ROTATION = 2
_ATTR_SCALE = 3
_ATTR_EULER = 4
_ATTR_IS_ACTIVE = 2086281974  # CRC of "m_IsActive"


def _u32_to_f32(u: int) -> float:
    return struct.unpack('<f', struct.pack('<I', int(u) & 0xFFFFFFFF))[0]


def _decode_streamed_clip(data: list[int], curve_count: int) -> list[dict]:
    """Decode Unity StreamedClip frames (AssetStudio layout).

    Each key is index + 4 float coeffs; value = coeff[3].
    """
    frames: list[dict] = []
    i = 0
    n = len(data)
    while i + 2 <= n:
        time = _u32_to_f32(data[i])
        i += 1
        num = int(data[i])
        i += 1
        if num < 0 or num > curve_count + 8 or i + num * 5 > n:
            break
        keys = []
        for _ in range(num):
            index = int(data[i])
            value = _u32_to_f32(data[i + 4])
            keys.append({'index': index, 'value': value})
            i += 5
        frames.append({'time': time, 'keys': keys})
        if not math.isfinite(time) and time > 0:
            break
    return frames


def _lerp_keyframes(keys: list[tuple[float, float]], t: float) -> float:
    if not keys:
        return 0.0
    if t <= keys[0][0]:
        return keys[0][1]
    if t >= keys[-1][0]:
        return keys[-1][1]
    for i in range(1, len(keys)):
        t0, v0 = keys[i - 1]
        t1, v1 = keys[i]
        if t <= t1:
            if t1 <= t0:
                return v1
            u = (t - t0) / (t1 - t0)
            return v0 + (v1 - v0) * u
    return keys[-1][1]


def build_transform_path_index(bundle: 'Bundle') -> tuple[dict, dict, dict]:
    """Return (t_info, path_hash->[(rel_path, tpid)], tpid->full_path)."""
    go_names: dict[int, str] = {}
    for o in bundle.env.objects:
        if o.type.name != 'GameObject':
            continue
        go_names[o.path_id] = o.read().m_Name

    t_info: dict[int, dict] = {}
    for pid, transform in bundle.transforms.items():
        go_pid = transform.m_GameObject.path_id
        father = transform.m_Father.path_id if transform.m_Father else 0
        t_info[pid] = {
            'name': go_names.get(go_pid, '?'),
            'father': father if father in bundle.transforms else 0,
            'go': go_pid,
            'transform': transform,
        }

    def full_path(tpid: int) -> str:
        parts = []
        cur = tpid
        seen: set[int] = set()
        while cur and cur in t_info and cur not in seen:
            seen.add(cur)
            parts.append(t_info[cur]['name'])
            cur = t_info[cur]['father']
        return '/'.join(reversed(parts))

    full_paths = {tid: full_path(tid) for tid in t_info}
    path_index: dict[int, list[tuple[str, int]]] = defaultdict(list)
    for tid, path in full_paths.items():
        parts = path.split('/') if path else []
        for i in range(len(parts)):
            rel = '/'.join(parts[i:])
            path_index[unity_hash(rel)].append((rel, tid))
        path_index[unity_hash(t_info[tid]['name'])].append((t_info[tid]['name'], tid))
    return t_info, path_index, full_paths


def _normalize_aircraft_token(s: str) -> str:
    """Alphanumeric lowercase token for matching clip names to aircraft ids."""
    return re.sub(r'[^a-z0-9]+', '', (s or '').lower())


def _gear_clip_name_affinity(clip_name: str, hints: list[str] | None) -> int:
    """Longest common prefix between clip stem (sans GearUp) and aircraft hints.

    Multi-plane packs share leaf names like GearDoorL across airframes, so leaf
    overlap alone often picks the wrong GearUp clip (e.g. MiggerGearUp for an
    F-16). Clip names usually embed the airframe (F-16CGearUp); F-16A still
    matches F-16CGearUp via the shared ``f16`` prefix.
    """
    if not hints:
        return 0
    stem = re.sub(r'gearup$', '', _normalize_aircraft_token(clip_name), flags=re.I)
    if not stem:
        return 0
    best = 0
    for hint in hints:
        h = _normalize_aircraft_token(hint)
        if not h:
            continue
        n = 0
        for a, b in zip(stem, h):
            if a != b:
                break
            n += 1
        # Also allow hint shorter than stem (``f16c`` vs ``f16c50oadf``).
        if stem.startswith(h) or h.startswith(stem):
            n = max(n, min(len(stem), len(h)))
        best = max(best, n)
    return best if best >= 3 else 0


def discover_gear_up_clip(
        bundle: 'Bundle',
        available_names: set[str] | None = None,
        name_hints: list[str] | None = None,
        aircraft_roots: set[str] | None = None,
) -> dict | None:
    """Find and decode a TCA GearUp AnimationClip from the bundle.

    When several clips exist (multi-plane packs), prefer (1) clip-name affinity
    to the aircraft being imported, then (2) animated leaf overlap with the
    meshes (and their transform ancestors) under that aircraft.
    """
    clip_objs = []
    for o in bundle.env.objects:
        if o.type.name != 'AnimationClip':
            continue
        name = o.read_typetree().get('m_Name', '') or ''
        clip_objs.append((name, o))
    if not clip_objs:
        return None

    def score_name(name: str) -> int:
        n = name.lower()
        if 'gearup' in n:
            return 2
        if 'gear' in n:
            return 1
        return 0

    clip_objs.sort(key=lambda x: -score_name(x[0]))

    t_info, path_index, full_paths = build_transform_path_index(bundle)

    # Mesh leaf names miss hinge empties (BGearDoorL). Expand with ancestors of
    # every available leaf so door-parent bindings count toward overlap.
    expanded_names = set(available_names or [])
    for path in full_paths.values():
        parts = path.split('/') if path else []
        if not parts:
            continue
        if aircraft_roots and parts[0] not in aircraft_roots:
            continue
        if parts[-1] in (available_names or ()):
            expanded_names.update(parts)

    def decode_one(clip_obj) -> dict | None:
        tt = clip_obj.read_typetree()
        clip = clip_obj.read()
        muscle = tt.get('m_MuscleClip') or {}
        duration = float(muscle.get('m_StopTime') or 0.0)
        if duration <= 1e-6:
            settings = tt.get('m_AnimationClipSettings') or {}
            duration = float(settings.get('m_StopTime') or 0.0)
        clip_data = ((muscle.get('m_Clip') or {}).get('data')) or {}
        streamed = clip_data.get('m_StreamedClip') or {}
        dense = clip_data.get('m_DenseClip') or {}
        constant = clip_data.get('m_ConstantClip') or {}
        data = streamed.get('data') or []
        streamed_count = int(streamed.get('curveCount') or 0)
        dense_count = int(dense.get('m_CurveCount') or 0)
        constant_data = list(constant.get('data') or [])
        constant_count = len(constant_data)
        # Binding curve indices span streamed, then dense, then constant
        # (AssetStudio / Unity ClipMuscleConstant layout).
        total_count = streamed_count + dense_count + constant_count
        if total_count <= 0:
            return None
        if streamed_count > 0 and not data:
            return None

        finite: list[dict] = []
        if streamed_count > 0:
            frames = _decode_streamed_clip(data, streamed_count)
            finite = [f for f in frames if math.isfinite(f['time']) and f['time'] >= 0.0]
            if not finite and dense_count <= 0 and constant_count <= 0:
                return None
        if duration <= 1e-6 and finite:
            duration = max(f['time'] for f in finite)

        deltas = muscle.get('m_ValueArrayDelta') or []

        def _delta_start(i: int, fallback: float = 0.0) -> float:
            return float((deltas[i] if i < len(deltas) else {}).get('m_Start', fallback))

        def _delta_stop(i: int, fallback: float) -> float:
            return float((deltas[i] if i < len(deltas) else {}).get('m_Stop', fallback))

        def _append_key(series: list[tuple[float, float]], t: float, val: float) -> None:
            if series and abs(series[-1][0] - t) < 1e-6:
                series[-1] = (t, val)
            else:
                series.append((t, val))

        curves: dict[int, list[tuple[float, float]]] = {
            i: [(0.0, _delta_start(i))]
            for i in range(streamed_count)
        }
        for fr in finite:
            t = float(fr['time'])
            if t > duration + 1e-4:
                continue
            for k in fr['keys']:
                idx = int(k['index'])
                if idx < 0 or idx >= streamed_count:
                    continue
                _append_key(curves[idx], t, float(k['value']))

        for idx in range(streamed_count):
            series = curves[idx]
            if series and series[-1][0] < duration - 1e-6:
                series.append((duration, _delta_stop(idx, series[-1][1])))

        # Dense curves: regularly sampled block after streamed indices.
        sample_rate = float(dense.get('m_SampleRate') or 0.0)
        begin_time = float(dense.get('m_BeginTime') or 0.0)
        frame_count = int(dense.get('m_FrameCount') or 0)
        samples = dense.get('m_SampleArray') or []
        if dense_count > 0 and frame_count > 0 and sample_rate > 1e-6:
            for c in range(dense_count):
                idx = streamed_count + c
                curves[idx] = [(0.0, _delta_start(idx))]
            need = frame_count * dense_count
            if len(samples) >= need:
                for frame_i in range(frame_count):
                    t = begin_time + frame_i / sample_rate
                    if t > duration + 1e-4:
                        continue
                    base = frame_i * dense_count
                    for c in range(dense_count):
                        idx = streamed_count + c
                        _append_key(curves[idx], t, float(samples[base + c]))
            for c in range(dense_count):
                idx = streamed_count + c
                series = curves[idx]
                if series and series[-1][0] < duration - 1e-6:
                    series.append((duration, _delta_stop(idx, series[-1][1])))

        # Constant curves: single value for the whole clip, after dense.
        for c, raw in enumerate(constant_data):
            idx = streamed_count + dense_count + c
            val = float(raw)
            start = _delta_start(idx, val)
            stop = _delta_stop(idx, val)
            curves[idx] = [(0.0, start)]
            if duration > 1e-6:
                curves[idx].append((duration, stop))

        def resolve_path(path_hash: int) -> str | None:
            hits = path_index.get(path_hash) or []
            if not hits:
                return None
            if aircraft_roots:
                preferred = [h for h in hits if h[0].split('/')[0] in aircraft_roots]
                if preferred:
                    hits = preferred
            hits_sorted = sorted(hits, key=lambda h: (-h[0].count('/'), -len(h[0])))
            return hits_sorted[0][0]

        bindings_raw = list(clip.m_ClipBindingConstant.genericBindings)
        bindings = []
        curve_idx = 0
        animated_paths: set[str] = set()
        animated_leaves: set[str] = set()
        for b in bindings_raw:
            attr = int(b.attribute)
            if attr in (_ATTR_POSITION, _ATTR_SCALE, _ATTR_EULER):
                dim = 3
            elif attr == _ATTR_ROTATION:
                dim = 4
            else:
                dim = 1
            rel = resolve_path(int(b.path))
            if rel:
                animated_paths.add(rel)
                parts = rel.split('/')
                animated_leaves.add(parts[-1])
                for i in range(len(parts)):
                    animated_paths.add('/'.join(parts[i:]))
            bindings.append({
                'path': rel,
                'path_hash': int(b.path),
                'attribute': attr,
                'curve_index': curve_idx,
                'dim': dim,
            })
            curve_idx += dim

        overlap = 0
        if expanded_names:
            overlap = len(animated_leaves & expanded_names)

        return {
            'name': tt.get('m_Name', 'GearUp'),
            'duration': duration,
            'curves': curves,
            'bindings': bindings,
            'animated_paths': animated_paths,
            'animated_leaves': animated_leaves,
            'overlap': overlap,
            'name_affinity': _gear_clip_name_affinity(
                tt.get('m_Name', 'GearUp'), name_hints),
            't_info': t_info,
            'path_index': path_index,
        }

    best = None
    for name, obj in clip_objs:
        if score_name(name) == 0 and best is not None:
            continue
        decoded = decode_one(obj)
        if decoded is None:
            continue
        if best is None:
            best = decoded
            continue
        # Name affinity beats raw leaf overlap in multi-plane packs.
        key = (
            decoded.get('name_affinity', 0),
            decoded['overlap'],
            score_name(decoded['name']),
        )
        best_key = (
            best.get('name_affinity', 0),
            best['overlap'],
            score_name(best['name']),
        )
        if key > best_key:
            best = decoded
    return best


def sample_gear_clip(clip: dict, t: float) -> dict[str, dict]:
    """Sample local TRS + active overrides keyed by relative binding path."""
    curves = clip['curves']
    out: dict[str, dict] = {}
    for b in clip['bindings']:
        path = b['path']
        if not path:
            continue
        slot = out.setdefault(path, {})
        base = b['curve_index']
        attr = b['attribute']
        dim = int(b.get('dim') or 1)
        if any((base + i) not in curves for i in range(dim)):
            continue
        if attr == _ATTR_POSITION:
            slot['position'] = np.array([
                _lerp_keyframes(curves[base], t),
                _lerp_keyframes(curves[base + 1], t),
                _lerp_keyframes(curves[base + 2], t),
            ], dtype=np.float64)
        elif attr == _ATTR_SCALE:
            slot['scale'] = np.array([
                _lerp_keyframes(curves[base], t),
                _lerp_keyframes(curves[base + 1], t),
                _lerp_keyframes(curves[base + 2], t),
            ], dtype=np.float64)
        elif attr == _ATTR_EULER:
            slot['euler'] = np.array([
                _lerp_keyframes(curves[base], t),
                _lerp_keyframes(curves[base + 1], t),
                _lerp_keyframes(curves[base + 2], t),
            ], dtype=np.float64)
        elif attr == _ATTR_ROTATION:
            slot['rotation'] = np.array([
                _lerp_keyframes(curves[base], t),
                _lerp_keyframes(curves[base + 1], t),
                _lerp_keyframes(curves[base + 2], t),
                _lerp_keyframes(curves[base + 3], t),
            ], dtype=np.float64)
        elif attr == _ATTR_IS_ACTIVE:
            slot['active'] = _lerp_keyframes(curves[base], t) >= 0.5
    return out


def animated_local_matrix(transform, overrides: dict | None) -> np.ndarray:
    """Local 4x4 for a Transform, with optional animation overrides."""
    overrides = overrides or {}
    if 'position' in overrides:
        pos = overrides['position']
    else:
        pos = vec3(transform.m_LocalPosition)
    if 'scale' in overrides:
        scale = overrides['scale']
    else:
        scale = vec3(transform.m_LocalScale)
    if 'euler' in overrides:
        rot_m = quat_to_matrix(unity_euler_quat(*overrides['euler']))
    elif 'rotation' in overrides:
        q = overrides['rotation']
        n = float(np.linalg.norm(q))
        rot_m = quat_to_matrix(q / n if n > 1e-12 else np.array([0.0, 0.0, 0.0, 1.0]))
    else:
        rot_m = quat_to_matrix(quat(transform.m_LocalRotation))
    mat = np.eye(4, dtype=np.float64)
    mat[:3, :3] = rot_m * scale
    mat[:3, 3] = pos
    return mat


def world_matrix_animated(tpid: int, t_info: dict, sample: dict[str, dict],
                          full_paths: dict[int, str], cache: dict) -> tuple[np.ndarray, bool]:
    """World matrix + hierarchy-active flag at a sampled animation pose."""
    if tpid in cache:
        return cache[tpid]
    info = t_info[tpid]
    # Resolve overrides: bindings use paths relative to the animated root, so
    # try every suffix of the full path.
    full = full_paths.get(tpid, info['name'])
    parts = full.split('/') if full else [info['name']]
    overrides = None
    for i in range(len(parts)):
        rel = '/'.join(parts[i:])
        if rel in sample:
            overrides = sample[rel]
            break
        if info['name'] in sample:
            overrides = sample[info['name']]
    active = True if not overrides or 'active' not in overrides else bool(overrides['active'])
    local = animated_local_matrix(info['transform'], overrides)
    parent = info['father']
    if parent and parent in t_info:
        pw, p_active = world_matrix_animated(parent, t_info, sample, full_paths, cache)
        mat = pw @ local
        active = active and p_active
    else:
        mat = local
    cache[tpid] = (mat, active)
    return cache[tpid]


def gear_clip_sample_times(clip: dict, max_samples: int = 96) -> np.ndarray:
    """Uniform sample times across the clip for stable TRS baking.

    glTF LINEAR interpolates translation/rotation/scale independently. Sampling
    only at sparse Unity key times makes hinged doors leave their arc (looks
    like the door rotates on the wrong axis). A dense uniform grid keeps the
    baked world deltas close to rigid hinge motion.
    """
    duration = float(clip['duration'])
    if duration <= 1e-8:
        return np.array([0.0], dtype=np.float64)
    # Prefer ~30 Hz; clamp to max_samples for long clips.
    n = int(math.ceil(duration * 30.0)) + 1
    n = max(2, min(n, max_samples))
    return np.linspace(0.0, duration, n, dtype=np.float64)


# --------------------------------------------------------------------------- #
# Mesh / material parsing
# --------------------------------------------------------------------------- #
def mesh_geometry(mesh, mat_pids: list) -> tuple[np.ndarray, np.ndarray | None, list[np.ndarray], list[np.ndarray]]:
    """Return verts, uvs, per-submesh face indices, and per-submesh UV indices.

    Submesh order matches Unity material slots on the MeshRenderer. UnityPy's
    OBJ export emits ``g MeshName_N`` groups — one per submesh — which we keep
    separate so frame/livery slots are not collapsed into material 0 (glass).
    """
    # UnityPy's Mesh.export() returns False for meshes it cannot decode (e.g.
    # certain compressed/skinned meshes). Skip those parts instead of crashing.
    obj_text = mesh.export()
    if not isinstance(obj_text, str):
        return np.empty((0, 3)), None, [], []
    verts, uvs, sub_faces, sub_face_t = parse_obj(obj_text)
    if len(verts) == 0 or not sub_faces:
        return np.empty((0, 3)), None, [], []
    # Drop trailing empty slots; keep holes so material index still aligns.
    while sub_faces and len(sub_faces[-1]) == 0:
        sub_faces.pop()
        sub_face_t.pop()
    if not sub_faces:
        return np.empty((0, 3)), None, [], []
    return verts, uvs, sub_faces, sub_face_t


def parse_obj(obj_text: str):
    """Return (vertices Nx3, uvs Mx2 or None, sub_faces[], sub_face_t[]).

    Faces are grouped by UnityPy's ``g Name_N`` submesh markers. A bare
    ``g Name`` group (no faces) is ignored. If no numbered groups appear, all
    faces go to submesh 0.
    """
    verts, uvs = [], []
    sub_fv: dict[int, list] = defaultdict(list)
    sub_ft: dict[int, list] = defaultdict(list)
    current_sub: int | None = None

    for line in obj_text.splitlines():
        if line.startswith('v '):
            verts.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('vt '):
            uvs.append([float(x) for x in line.split()[1:3]])
        elif line.startswith('g '):
            name = line[2:].strip()
            m = re.search(r'_(\d+)$', name)
            current_sub = int(m.group(1)) if m else None
        elif line.startswith('f '):
            corners = line.split()[1:]
            if len(corners) < 3:
                continue
            vi, ti = [], []
            for c in corners[:3]:
                p = c.split('/')
                vi.append(int(p[0]) - 1)
                ti.append(int(p[1]) - 1 if len(p) > 1 and p[1] else -1)
            slot = 0 if current_sub is None else current_sub
            sub_fv[slot].append(vi)
            sub_ft[slot].append(ti)

    verts_a = np.array(verts, dtype=np.float64) if verts else np.empty((0, 3))
    uvs_a = np.array(uvs, dtype=np.float64) if uvs else None
    if not sub_fv:
        return verts_a, uvs_a, [], []
    n = max(sub_fv.keys()) + 1
    face_v_list: list[np.ndarray] = []
    face_t_list: list[np.ndarray] = []
    for i in range(n):
        fv = sub_fv.get(i) or []
        ft = sub_ft.get(i) or []
        face_v_list.append(
            np.array(fv, dtype=np.int64) if fv else np.empty((0, 3), dtype=np.int64)
        )
        face_t_list.append(
            np.array(ft, dtype=np.int64) if ft else np.empty((0, 3), dtype=np.int64)
        )
    return verts_a, uvs_a, face_v_list, face_t_list


def sample_hex(pal: np.ndarray, uv_centroids: np.ndarray) -> np.ndarray:
    """Sample sRGB hex colours from a palette texture at (u, v) coordinates.

    Unity UV origin is bottom-left, so V is flipped."""
    h, w, _ = pal.shape
    xs = np.clip((uv_centroids[:, 0] * w).astype(int), 0, w - 1)
    ys = np.clip(((1.0 - uv_centroids[:, 1]) * h).astype(int), 0, h - 1)
    cols = pal[ys, xs]
    return np.array(['#%02x%02x%02x' % (int(c[0]), int(c[1]), int(c[2])) for c in cols])


def rgba01_to_hex(c) -> str:
    r = int(round(max(0.0, min(1.0, c.get('r', 1.0))) * 255))
    g = int(round(max(0.0, min(1.0, c.get('g', 1.0))) * 255))
    b = int(round(max(0.0, min(1.0, c.get('b', 1.0))) * 255))
    return '#%02x%02x%02x' % (r, g, b)


def decode_texture_array(tex: dict) -> np.ndarray | None:
    """Decode a lazy Texture2D entry on first use; cache in ``tex['array']``."""
    cached = tex.get('array')
    if cached is not None:
        return cached
    src = tex.get('_src')
    if src is None:
        return None
    try:
        decoded = np.array(src.read().image.convert('RGB'))
    except Exception:
        decoded = None
    tex['array'] = decoded
    tex.pop('_src', None)
    return decoded


def texture_sample_array(
        tex: dict,
        swatch_max: int,
        bitmap_livery: bool = False,
        bitmap_sample_max: int = DEFAULT_BITMAP_SAMPLE_MAX,
) -> np.ndarray | None:
    """Return an RGB array suitable for palette sampling, or None."""
    arr = decode_texture_array(tex)
    if arr is None:
        return None
    w, h = int(tex['w']), int(tex['h'])
    if w <= swatch_max and h <= swatch_max:
        return arr
    if not bitmap_livery:
        return None
    edge = max(w, h)
    if edge <= bitmap_sample_max:
        return arr
    scale = bitmap_sample_max / edge
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    img = Image.fromarray(arr.astype(np.uint8))
    img = img.resize((nw, nh), Image.Resampling.BILINEAR)
    return np.array(img)


_BUNDLE_PATH_CACHE: dict[str, str] = {}


def resolve_bundle_path(path: str) -> str:
    """Accept a raw Unity asset bundle, a folder, or a mod .zip.

    Mods are usually distributed as a .zip (e.g. a Tiny Combat Arena workshop
    download) with the Unity asset bundle inside alongside config files. This
    extracts the largest file whose header is the Unity bundle magic 'UnityFS'
    into a temp dir (cleaned up on exit) and returns its path."""
    if not path.lower().endswith('.zip'):
        return path

    abs_path = os.path.abspath(path)
    cache_key = f'{abs_path}:{os.path.getmtime(abs_path)}:{os.path.getsize(abs_path)}'
    cached = _BUNDLE_PATH_CACHE.get(cache_key)
    if cached is not None and os.path.isfile(cached):
        return cached

    tmp = tempfile.mkdtemp(prefix='rfs_mod_')
    atexit.register(shutil.rmtree, tmp, ignore_errors=True)

    with zipfile.ZipFile(path) as z:
        candidates = []
        for info in z.infolist():
            if info.is_dir():
                continue
            with z.open(info) as f:
                if f.read(8).startswith(b'UnityFS'):
                    candidates.append(info)
        if not candidates:
            raise SystemExit(f'No Unity asset bundle (UnityFS) found in {path}')
        candidates.sort(key=lambda i: i.file_size, reverse=True)
        chosen = candidates[0]
        out = os.path.join(tmp, os.path.basename(chosen.filename))
        with z.open(chosen) as src, open(out, 'wb') as dst:
            shutil.copyfileobj(src, dst)
        print(f'Extracted asset bundle "{chosen.filename}" from {os.path.basename(path)}',
              file=sys.stderr)
        _BUNDLE_PATH_CACHE[cache_key] = out
        return out


class Bundle:
    """Parsed view over a Unity asset bundle."""

    def __init__(self, path: str):
        self.source_path = path
        self.resolved_path = resolve_bundle_path(path)
        self.env = UnityPy.load(self.resolved_path)
        self.by_path = {o.path_id: o for o in self.env.objects}
        self.transforms = {}
        self.mesh_filters = {}
        self.meshes = {}
        self.materials = {}   # path_id -> dict(name, main_tex, color, alpha)
        self.textures = {}    # path_id -> dict(name, w, h, array or None)
        for o in self.env.objects:
            t = o.type.name
            if t == 'Transform':
                self.transforms[o.path_id] = o.read()
            elif t == 'MeshFilter':
                self.mesh_filters[o.path_id] = o.read()
            elif t == 'Mesh':
                self.meshes[o.path_id] = o.read()
            elif t == 'Material':
                self.materials[o.path_id] = self._read_material(o)
            elif t == 'Texture2D':
                self.textures[o.path_id] = self._read_texture(o)

    @staticmethod
    def _read_material(o) -> dict:
        tt = o.read_typetree()
        sp = tt.get('m_SavedProperties', {})
        colors = {c[0]: c[1] for c in sp.get('m_Colors', [])}
        texs = sp.get('m_TexEnvs', [])
        main_tex = None
        for key, env in texs:
            if isinstance(env, dict):
                pid = env.get('m_Texture', {}).get('m_PathID', 0)
                if pid and (key == '_MainTex' or main_tex is None):
                    main_tex = pid
                    if key == '_MainTex':
                        break
        color = colors.get('_Color') or colors.get('_BaseColor') or {}
        # TinyDiffuse exposes emission via _EmissionColor (bright for lights,
        # black otherwise). NozzleInteriorMat instead uses _Emissive; that mesh
        # is handled by nozzle detection, so lights only look at _EmissionColor.
        emission = colors.get('_EmissionColor') or colors.get('_Emissive') or {}
        return {
            'name': tt.get('m_Name', ''),
            'main_tex': main_tex,
            'color': color,
            'alpha': float(color.get('a', 1.0)) if color else 1.0,
            'emission': emission,
        }

    @staticmethod
    def _read_texture(o) -> dict:
        # Keep metadata only; decode RGB on first palette/livery sample.
        tt = o.read_typetree()
        return {
            'name': tt.get('m_Name', ''),
            'w': int(tt.get('m_Width', 0)),
            'h': int(tt.get('m_Height', 0)),
            'array': None,
            '_src': o,
        }


# --------------------------------------------------------------------------- #
# Inspection
# --------------------------------------------------------------------------- #
def list_bundle(bundle: Bundle):
    print('== Textures ==')
    for pid, tex in bundle.textures.items():
        tag = ' (palette-swatch?)' if tex['w'] <= DEFAULT_SWATCH_MAX and tex['h'] <= DEFAULT_SWATCH_MAX else ''
        print(f'  {tex["name"]:24s} {tex["w"]}x{tex["h"]}{tag}')
    print('== Materials ==')
    for pid, m in bundle.materials.items():
        tex = bundle.textures.get(m['main_tex'], {}) if m['main_tex'] else {}
        texname = tex.get('name', '-')
        col = rgba01_to_hex(m['color']) if m['color'] else '-'
        glass = ' (transparent -> glass)' if m['alpha'] < 0.9 else ''
        print(f'  {m["name"]:24s} tex={texname:20s} color={col} alpha={m["alpha"]:.2f}{glass}')
    print('== GameObjects with meshes ==')
    for o in bundle.env.objects:
        if o.type.name != 'GameObject':
            continue
        go = o.read()
        mats = _renderer_material_names(bundle, go)
        if mats is None:
            continue
        print(f'  {go.m_Name:24s} materials={mats}')


def _renderer_material_names(bundle: Bundle, go):
    has_mesh = False
    names = []
    for comp in go.m_Component:
        co = bundle.by_path.get(comp.component.path_id)
        if co is None:
            continue
        if co.type.name == 'MeshFilter':
            has_mesh = True
        elif co.type.name == 'MeshRenderer':
            tt = co.read_typetree()
            names = [bundle.materials.get(m['m_PathID'], {}).get('name', '?')
                     for m in tt.get('m_Materials', [])]
    return names if has_mesh else None


# Substrings that identify exterior airframe meshes when discovering liveries.
# (Defined in tools/tca_mapping.json partCategories.bodyHint.)


def discover_livery_materials(bundle_path: str, bundle: Bundle | None = None) -> list[dict]:
    """Find distinct flyable aircraft liveries in a multi-plane Unity bundle.

    Multi-plane packs reuse part names across aircraft; the Unity *material*
    usually separates them. When one material is stamped onto multiple
    unrelated airframe roots (different sizes), each span-cluster becomes its
    own discover entry with ``transformRoot`` so imports stay unmerged.
    """
    if bundle is None:
        bundle = Bundle(bundle_path)
    tca = merge_config_overrides({})
    # mat -> root -> stats
    root_body: dict[str, dict[int, set[str]]] = defaultdict(lambda: defaultdict(set))
    root_hits: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    root_mins: dict[str, dict[int, np.ndarray]] = defaultdict(dict)
    root_maxs: dict[str, dict[int, np.ndarray]] = defaultdict(dict)
    root_all_mats: dict[int, set[str]] = defaultdict(set)
    fuselage_mats: set[str] = set()
    world_cache: dict[int, np.ndarray] = {}

    for o in bundle.env.objects:
        if o.type.name != 'GameObject':
            continue
        go = o.read()
        name = go.m_Name
        if is_discover_skip_part(name, tca):
            continue
        mat_pids: list[int] = []
        has_mesh = False
        tpid = None
        mesh_filter = None
        for comp in go.m_Component:
            co = bundle.by_path.get(comp.component.path_id)
            if co is None:
                continue
            if co.type.name == 'Transform':
                tpid = comp.component.path_id
            elif co.type.name == 'MeshFilter':
                has_mesh = True
                mesh_filter = bundle.mesh_filters.get(comp.component.path_id)
            elif co.type.name == 'MeshRenderer':
                tt = co.read_typetree()
                mat_pids = [m['m_PathID'] for m in tt.get('m_Materials', [])]
        if not has_mesh or not mat_pids or tpid is None:
            continue

        root = transform_root(tpid, bundle.transforms)
        mat_names = [
            bundle.materials.get(pid, {}).get('name', '') for pid in mat_pids
        ]
        for other in mat_names:
            if (other
                    and not any(s in other for s in tca.skip_material_substrings)
                    and other not in ('Canopy', 'Glass', 'Glass HUD', 'NozzleInteriorMat')):
                root_all_mats[root].add(other)

        livery_on_mesh = [
            m for m, pid in zip(mat_names, mat_pids)
            if m and is_livery_material(m, tca)
            and bundle.materials.get(pid, {}).get('alpha', 1.0) >= 0.9
        ]
        if not livery_on_mesh:
            continue

        mesh_pts = None
        if mesh_filter is not None:
            mesh = bundle.meshes.get(mesh_filter.m_Mesh.path_id)
            if mesh is not None:
                verts, _uvs, sub_faces, _sft = mesh_geometry(mesh, mat_pids)
                if len(verts) and sub_faces:
                    wm = world_matrix(tpid, bundle.transforms, world_cache)
                    wm = _FLIP_X @ wm @ _FLIP_X
                    mesh_pts = (wm @ np.c_[verts, np.ones(len(verts))].T).T[:, :3]

        for mat_name in livery_on_mesh:
            root_hits[mat_name][root] += 1
            if is_body_hint_part(name, tca):
                root_body[mat_name][root].add(name)
            if is_fuselage_part(name, tca):
                fuselage_mats.add(mat_name)
            if mesh_pts is not None and len(mesh_pts):
                pmin = mesh_pts.min(axis=0)
                pmax = mesh_pts.max(axis=0)
                if root not in root_mins[mat_name]:
                    root_mins[mat_name][root] = pmin.copy()
                    root_maxs[mat_name][root] = pmax.copy()
                else:
                    root_mins[mat_name][root] = np.minimum(
                        root_mins[mat_name][root], pmin)
                    root_maxs[mat_name][root] = np.maximum(
                        root_maxs[mat_name][root], pmax)

    # Materials that look like complete airframes.
    candidates = sorted(fuselage_mats) if fuselage_mats else sorted(
        m for m, roots in root_body.items()
        if any(len(parts) >= 3 for parts in roots.values()))
    if not candidates and root_body:
        candidates = sorted(
            m for m, roots in root_body.items()
            if any(len(parts) >= 2 for parts in roots.values()))
    candidates = [
        m for m in candidates
        if m in fuselage_mats
        or any(len(parts) >= 5 for parts in root_body.get(m, {}).values())
    ]

    out: list[dict] = []
    for mat_name in candidates:
        roots = set(root_hits[mat_name]) | set(root_body.get(mat_name, {}))
        if not roots:
            continue
        spans = {
            r: float(np.max(root_maxs[mat_name][r] - root_mins[mat_name][r]))
            for r in roots
            if r in root_mins.get(mat_name, {})
        }
        # Group duplicate copies (same span) vs unrelated airframes.
        remaining = set(spans) if spans else set(roots)
        clusters: list[set[int]] = []
        while remaining:
            seed = max(remaining, key=lambda r: (
                len(root_body[mat_name].get(r, ())),
                root_hits[mat_name].get(r, 0),
            ))
            if seed not in spans:
                clusters.append({seed})
                remaining.remove(seed)
                continue
            selected = select_primary_livery_roots(
                {r: spans[r] for r in remaining if r in spans},
                {r: len(root_body[mat_name].get(r, ())) for r in remaining},
                single_root=False,
            )
            # One cluster = selected (same-size copies). Peel off; leftover
            # outliers become further clusters.
            cluster = set(selected) & remaining
            if not cluster:
                cluster = {seed}
            clusters.append(cluster)
            remaining -= cluster

        clusters.sort(
            key=lambda c: -sum(len(root_body[mat_name].get(r, ())) for r in c))

        for i, cluster in enumerate(clusters):
            root = max(
                cluster,
                key=lambda r: (
                    len(root_body[mat_name].get(r, ())),
                    root_hits[mat_name].get(r, 0),
                ),
            )
            body = set()
            hits = 0
            companions: set[str] = set()
            for r in cluster:
                body |= root_body[mat_name].get(r, set())
                hits += root_hits[mat_name].get(r, 0)
                # Props / secondary mats often live on sibling meshes under the
                # same root that do not use the borrowed livery material.
                companions |= (root_all_mats.get(r, set()) - {mat_name})
            # Only keep companions that identify this airframe (Prop mats or
            # mats naming the companion label). Shared cockpit/weapon mats must
            # not widen includeMaterials across the whole collection pack.
            if i == 0:
                label = mat_name
            else:
                label = _label_from_companions(companions) or f'{mat_name} (alt {i})'
            companions = _airframe_companions(companions, label)
            entry: dict = {
                'material': mat_name,
                'name': label,
                'partCount': hits,
                'bodyParts': len(body),
                # Stringify 64-bit Unity path IDs: JS JSON.parse cannot round-trip
                # integers beyond Number.MAX_SAFE_INTEGER, which would corrupt
                # includeRoots and make multi-plane imports miss every mesh.
                'transformRoot': str(root),
                # One root per import so duplicate packed copies / foreign
                # hulls sharing this material are never merged.
                'includeRoots': [str(root)],
            }
            if companions:
                entry['companionMaterials'] = sorted(companions)
            out.append(entry)
    return out


def _label_from_companions(companions: set[str]) -> str | None:
    """Best-effort airframe name from non-livery mats on the same root."""
    for c in sorted(companions):
        if 'Prop' not in c:
            continue
        label = re.sub(r'\s+Prop\s+Mat\s*$', '', c, flags=re.I).strip()
        label = re.sub(r'\s+Mat\s*$', '', label, flags=re.I).strip()
        if label:
            return label
    return None


def _airframe_companions(companions: set[str], label: str) -> set[str]:
    """Filter co-root materials down to ones safe for includeMaterials."""
    keep: set[str] = set()
    label_norm = re.sub(r'[^a-z0-9]+', '', (label or '').lower())
    for c in companions:
        if 'Prop' in c:
            keep.add(c)
            continue
        if not label_norm:
            continue
        c_norm = re.sub(r'[^a-z0-9]+', '', c.lower())
        if label_norm in c_norm:
            keep.add(c)
    return keep


def count_livery_materials(bundle: Bundle, tca=None) -> int:
    """Distinct opaque livery material names in a bundle (collection detection)."""
    tca = tca or merge_config_overrides({})
    mats: set[str] = set()
    for mat in bundle.materials.values():
        name = mat.get('name', '')
        if is_livery_material(name, tca) and mat.get('alpha', 1.0) >= 0.9:
            mats.add(name)
    return len(mats)


# Bundles with more than this many liveries are treated as multi-aircraft
# collection packs (e.g. Global Skies). Global spatial rescue would otherwise
# re-admit every co-located aircraft's glass/cockpit/nozzle meshes.
COLLECTION_LIVERY_THRESHOLD = 5


def _set_flat_normals(mesh: trimesh.Trimesh) -> None:
    """Flat-shaded export: skip trimesh/scipy weighted normal computation."""
    mesh.vertex_normals = np.tile([0.0, 1.0, 0.0], (len(mesh.vertices), 1))


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #
def _should_include(name: str, include_exact, skip_parts, skip_exact) -> bool:
    if name in skip_exact:
        return False
    if name in include_exact:
        return True
    return not any(part in name for part in skip_parts)


def _strip_json_trailing_commas(text: str) -> str:
    return re.sub(r',(\s*[}\]])', r'\1', text)


def _parse_aircraft2_animated_parts(text: str) -> list[dict]:
    """Best-effort AnimatedParts array from a TCA Aircraft2 JSON file."""
    cleaned = _strip_json_trailing_commas(text)
    try:
        data = json.loads(cleaned)
        ap = data.get('AnimatedParts') or data.get('Animated Parts') or []
        if isinstance(ap, list):
            return [e for e in ap if isinstance(e, dict)]
    except json.JSONDecodeError:
        pass
    m = re.search(r'"AnimatedParts"\s*:\s*(\[.*?\])\s*,\s*\n', text, re.S)
    if not m:
        return []
    try:
        ap = json.loads(_strip_json_trailing_commas(m.group(1)))
    except json.JSONDecodeError:
        return []
    return [e for e in ap if isinstance(e, dict)] if isinstance(ap, list) else []


_AIRCRAFT2_PARTS_CACHE: dict[str, list[tuple[str, list[str], list[dict]]]] = {}


def load_aircraft2_animated_parts(bundle_path: str, hints: list[str]) -> list[dict]:
    """Read AnimatedParts for this aircraft from a TCA mod zip's Aircraft2 JSON.

    TCA maps procedural surfaces (including airbrakes) here — e.g.
    ``AngleByBrake`` on ``Part: BAirbrakeL``. Name heuristics alone miss the
    workshop naming (SpeedbrakeT / SpeedbrakeLL / …).
    """
    if not bundle_path or not str(bundle_path).lower().endswith('.zip'):
        return []
    if not os.path.isfile(bundle_path):
        return []
    cache_key = f'{os.path.abspath(bundle_path)}:{os.path.getmtime(bundle_path)}'
    if cache_key not in _AIRCRAFT2_PARTS_CACHE:
        _AIRCRAFT2_PARTS_CACHE[cache_key] = _scan_aircraft2_animated_parts(bundle_path)
    hint_tokens = {_normalize_aircraft_token(h) for h in hints if h}
    hint_tokens = {t for t in hint_tokens if len(t) >= 3}
    best: list[dict] | None = None
    best_score = -1
    for norm, candidates, parts in _AIRCRAFT2_PARTS_CACHE[cache_key]:
        score = _aircraft2_hint_score(candidates, hint_tokens)
        if score < 3 and hint_tokens:
            continue
        if score > best_score:
            best_score = score
            best = parts
            print(f'Aircraft2 AnimatedParts from "{norm}" '
                  f'(score={score}, n={len(parts)})')
    return best or []


def _aircraft2_hint_score(candidates: list[str], hint_tokens: set[str]) -> int:
    score = 0
    for c in candidates:
        tok = _normalize_aircraft_token(c)
        if not tok:
            continue
        for h in hint_tokens:
            n = 0
            for a, b in zip(tok, h):
                if a != b:
                    break
                n += 1
            if tok.startswith(h) or h.startswith(tok):
                n = max(n, min(len(tok), len(h)))
            score = max(score, n)
    return score


def _scan_aircraft2_animated_parts(bundle_path: str) -> list[tuple[str, list[str], list[dict]]]:
    """Return [(zipEntry, nameCandidates, AnimatedParts), ...] for Aircraft2 JSON."""
    out: list[tuple[str, list[str], list[dict]]] = []
    try:
        with zipfile.ZipFile(bundle_path) as z:
            for name in z.namelist():
                norm = name.replace('\\', '/')
                if '/Aircraft2/' not in norm or not norm.lower().endswith('.json'):
                    continue
                if '/campaign/' in norm.lower():
                    continue
                try:
                    text = z.read(name).decode('utf-8', errors='ignore')
                except Exception:
                    continue
                nm = re.search(r'"Name"\s*:\s*"([^"]+)"', text)
                dn = re.search(r'"DisplayName"\s*:\s*"([^"]+)"', text)
                candidates = [
                    nm.group(1) if nm else '',
                    dn.group(1) if dn else '',
                    os.path.splitext(os.path.basename(norm))[0],
                ]
                parts = _parse_aircraft2_animated_parts(text)
                if parts:
                    out.append((norm, candidates, parts))
    except zipfile.BadZipFile:
        return []
    except Exception:
        return []
    return out


_AIRCRAFT2_BLOCKS_CACHE: dict[str, list[tuple[str, list[str], dict]]] = {}


def _scan_aircraft2_blocks(bundle_path: str) -> list[tuple[str, list[str], dict]]:
    """Return [(zipEntry, nameCandidates, {SwingWings, WingTrails}), ...] per Aircraft2 JSON."""
    out: list[tuple[str, list[str], dict]] = []
    try:
        with zipfile.ZipFile(bundle_path) as z:
            for name in z.namelist():
                norm = name.replace(chr(92), '/')
                if '/Aircraft2/' not in norm or not norm.lower().endswith('.json'):
                    continue
                if '/campaign/' in norm.lower():
                    continue
                try:
                    text = z.read(name).decode('utf-8', errors='ignore')
                    data = json.loads(_strip_json_trailing_commas(text))
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                blocks = {'SwingWings': data.get('SwingWings'), 'WingTrails': data.get('WingTrails')}
                candidates = [
                    str(data.get('Name') or ''),
                    str(data.get('DisplayName') or ''),
                    os.path.splitext(os.path.basename(norm))[0],
                ]
                out.append((norm, candidates, blocks))
    except Exception:
        return []
    return out


def _load_aircraft2_block(bundle_path: str, hints: list[str], key: str):
    """One block (`key`) of the Aircraft2 JSON that best matches this aircraft."""
    if not bundle_path or not str(bundle_path).lower().endswith('.zip'):
        return None
    if not os.path.isfile(bundle_path):
        return None
    cache_key = f'{os.path.abspath(bundle_path)}:{os.path.getmtime(bundle_path)}'
    if cache_key not in _AIRCRAFT2_BLOCKS_CACHE:
        _AIRCRAFT2_BLOCKS_CACHE[cache_key] = _scan_aircraft2_blocks(bundle_path)
    hint_tokens = {_normalize_aircraft_token(h) for h in hints if h}
    hint_tokens = {t for t in hint_tokens if len(t) >= 3}
    # Score against EVERY Aircraft2 file, not just those carrying the block, so a
    # fixed-wing sibling never inherits another plane's swing wings.
    best, best_score = None, -1
    for _norm, candidates, blocks in _AIRCRAFT2_BLOCKS_CACHE[cache_key]:
        score = _aircraft2_hint_score(candidates, hint_tokens)
        if score < 3 and hint_tokens:
            continue
        if score > best_score:
            best, best_score = blocks.get(key), score
    return best


def load_aircraft2_swing_wings(bundle_path: str, hints: list[str]) -> dict | None:
    """The `SwingWings` block (variable-geometry wings) of this aircraft's Aircraft2 JSON."""
    block = _load_aircraft2_block(bundle_path, hints, 'SwingWings')
    return block if isinstance(block, dict) and block.get('Parts') else None


def load_aircraft2_wing_trails(bundle_path: str, hints: list[str]) -> list[str]:
    """Names of the mod's wingtip-trail nodes (`WingTrails`), e.g. TrailL / TrailR."""
    block = _load_aircraft2_block(bundle_path, hints, 'WingTrails')
    return [str(n) for n in block] if isinstance(block, list) else []


def _curve_range_sign(curve) -> tuple[float, int]:
    """Max |degrees| → (rangeRad, sign) from a TCA AngleBy* keyframe list."""
    if not isinstance(curve, list) or not curve:
        return 0.45, 1
    best_deg = 0.0
    for key in curve:
        try:
            deg = float(key.get('Degrees', 0))
        except (TypeError, ValueError):
            continue
        if abs(deg) >= abs(best_deg):
            best_deg = deg
    if abs(best_deg) < 1e-6:
        return 0.45, 1
    return abs(math.radians(best_deg)), (1 if best_deg >= 0 else -1)


def _rotation_axis_hint(entry: dict) -> tuple[str | None, int]:
    """TCA ``RotationAxis`` → (hingeAxis letter, sign) for our hinge convention.

    ``hinge_frame_from_part`` forces the chosen bone axis so its dominant world
    component is positive (+X / +Y). TCA often uses the opposite sense on the
    mirrored side (e.g. SpeedbrakeLL ``[-1,0,0]`` vs TL ``[1,0,0]``). Fold that
    into ``sign`` so left/right petals open symmetrically instead of twisting
    the tail (which reads as the airframe rolling).
    """
    axis = entry.get('RotationAxis')
    if not isinstance(axis, (list, tuple)) or len(axis) < 3:
        return None, 1
    try:
        comps = [float(axis[0]), float(axis[1]), float(axis[2])]
    except (TypeError, ValueError):
        return None, 1
    idx = max(range(3), key=lambda i: abs(comps[i]))
    if abs(comps[idx]) < 1e-6:
        return None, 1
    return 'xyz'[idx], (1 if comps[idx] >= 0.0 else -1)


def _mesh_name_for_animated_part(entry: dict, available: set[str]) -> str | None:
    """Resolve the exported mesh name for an AnimatedParts entry."""
    name = str(entry.get('Name') or '')
    part = str(entry.get('Part') or '')
    for candidate in (name, part):
        if candidate in available:
            return candidate
    if part.startswith('B') and part[1:] in available:
        return part[1:]
    if name.startswith('B') and name[1:] in available:
        return name[1:]
    return None


def surface_defs_from_animated_parts(
        animated: list[dict], available: set[str],
        tca=None) -> list[dict]:
    """Build flyable surface entries from TCA Aircraft2 AnimatedParts."""
    surfaces: list[dict] = []
    used_parts: set[str] = set()
    used_roles: set[str] = set()
    for entry in animated:
        control = animated_part_control(entry, tca)
        if control is None:
            continue
        mesh = _mesh_name_for_animated_part(entry, available)
        if mesh is None or mesh in used_parts:
            continue
        hinge = str(entry.get('Part') or '') or None
        role_base = str(entry.get('Name') or mesh)
        role = ''.join(c if c.isalnum() or c in '-_' else '_' for c in role_base)
        role = role[:40] or f'{control}_{len(surfaces)}'
        if role in used_roles:
            role = f'{role}_{len(surfaces)}'
        # Prefer AngleByBrake / AngleBy* curve for range; FlapInfluence falls back.
        curve = (entry.get('AngleByBrake') or entry.get('AngleByPitch')
                 or entry.get('AngleByRoll') or entry.get('AngleByYaw')
                 or entry.get('AngleBySlats'))
        hinge_axis, axis_sign = _rotation_axis_hint(entry)
        if curve:
            range_rad, curve_sign = _curve_range_sign(curve)
        else:
            range_rad, curve_sign = (0.5 if control == 'flaps' else 0.45), 1
        sd: dict = {
            'role': role,
            'parts': [mesh],
            'control': control,
            'sign': axis_sign * curve_sign,
            'rangeRad': range_rad,
        }
        if hinge:
            sd['hingePart'] = hinge
        if hinge_axis:
            sd['hingeAxis'] = hinge_axis
        surfaces.append(sd)
        used_parts.add(mesh)
        used_roles.add(role)
    return surfaces


def merge_surface_defs(primary: list[dict], fallback: list[dict]) -> list[dict]:
    """Prefer Aircraft2-derived surfaces; fill missing roles/parts from name rules."""
    out = list(primary)
    used_parts = {pn for sd in out for pn in sd.get('parts', [])}
    used_roles = {sd.get('role') for sd in out}
    for sd in fallback:
        parts = [p for p in sd.get('parts', []) if p not in used_parts]
        if not parts:
            continue
        role = sd.get('role')
        if role in used_roles:
            continue
        merged = dict(sd)
        merged['parts'] = parts
        out.append(merged)
        used_parts.update(parts)
        used_roles.add(role)
    return out


def auto_gear_names_from_clip(available: set[str], clip: dict | None,
                              processed: list[dict], full_paths: dict[int, str],
                              tca=None) -> set[str]:
    """Gear/door mesh names driven by the GearUp clip (legs + bay doors)."""
    names = set(auto_gear_names(available, tca))
    if not clip:
        return {n for n in names if not should_skip_gear_clip_part(n, tca)}

    animated = clip['animated_paths']
    for p in processed:
        name = p['name']
        if should_skip_gear_clip_part(name, tca):
            continue
        tpid = p.get('tpid')
        if tpid is None:
            continue
        full = full_paths.get(tpid, name)
        parts = full.split('/')
        # Include if this mesh or any ancestor is animated by the clip.
        matched = False
        for i in range(len(parts)):
            rel = '/'.join(parts[i:])
            if rel in animated or parts[i] in animated:
                matched = True
                break
        if matched:
            names.add(name)
    return {n for n in names if not should_skip_gear_clip_part(n, tca)}


def transform_root(tpid: int, transforms) -> int:
    """Walk the Unity Transform parent chain to the top-most ancestor path_id."""
    seen: set[int] = set()
    cur = tpid
    while True:
        t = transforms.get(cur)
        if t is None:
            return cur
        father = t.m_Father.path_id
        if not father or father not in transforms or father in seen:
            return cur
        seen.add(cur)
        cur = father


def select_primary_livery_roots(
    root_spans: dict[int, float],
    root_part_counts: dict[int, int],
    *,
    single_root: bool = True,
    span_ratio: float = 1.6,
) -> set[int]:
    """Pick transform root(s) when several airframes share one livery material.

    Collection packs sometimes stamp the same Unity material name onto unrelated
    models (e.g. a fighter livery also on a bomber-sized hull). Span-cluster the
    roots and optionally keep a single copy so the export is one coherent plane.
    """
    if not root_spans:
        return set()
    if len(root_spans) == 1:
        return set(root_spans.keys())

    spans = sorted(root_spans.values())
    median = spans[len(spans) // 2]
    if median < 1e-3:
        best = max(root_part_counts, key=lambda r: root_part_counts.get(r, 0))
        return {best}

    lo, hi = median / span_ratio, median * span_ratio
    cluster = [r for r, s in root_spans.items() if lo <= s <= hi]
    if not cluster:
        cluster = [min(root_spans, key=lambda r: abs(root_spans[r] - median))]

    if single_root:
        return {max(
            cluster,
            key=lambda r: (
                root_part_counts.get(r, 0),
                -abs(root_spans[r] - median),
            ),
        )}
    return set(cluster)


def _transform_pid_of(go, bundle: Bundle) -> int | None:
    for comp in go.m_Component:
        co = bundle.by_path.get(comp.component.path_id)
        if co is not None and co.type.name == 'Transform':
            return comp.component.path_id
    return None


def find_node_pid(bundle: Bundle, part_name: str, root_pid: int | None = None) -> int | None:
    """Transform path_id of the GameObject called `part_name`.

    A bundle can pack several aircraft sharing node names, so with `root_pid` the
    node under that aircraft's transform root wins; otherwise the first match.
    """
    matches: list[int] = []
    for o in bundle.env.objects:
        if o.type.name != 'GameObject':
            continue
        go = o.read()
        if go.m_Name != part_name:
            continue
        tp = _transform_pid_of(go, bundle)
        if tp is not None:
            matches.append(tp)
    if not matches:
        return None
    if root_pid is not None:
        for tp in matches:
            if transform_root(tp, bundle.transforms) == root_pid:
                return tp
    return matches[0]


def transform_is_under(bundle: Bundle, tpid: int, ancestor: int) -> bool:
    """True when `tpid` is `ancestor` or one of its descendants."""
    seen: set[int] = set()
    cur = tpid
    while cur and cur in bundle.transforms and cur not in seen:
        if cur == ancestor:
            return True
        seen.add(cur)
        cur = bundle.transforms[cur].m_Father.path_id
    return False


def hinge_frame_from_part(
    bundle: Bundle,
    part_name: str,
    world_cache: dict[int, np.ndarray],
    scale: float,
    ground_offset_y: float,
    control: str = 'pitch',
    hinge_axis: str | None = None,
    root_pid: int | None = None,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Pivot + hinge axis from a Unity bone/empty (e.g. BSlatL) in the sim body frame.

    The hinge axis is one of the bone's three local axes, but which column the
    artist aligned to the hinge line varies between mods (e.g. one mod's rudder
    hinge is the bone's local Y, another's is its local Z). Rather
    than assume a fixed column, pick the local axis whose world direction best
    matches the expected hinge orientation: vertical (world +Y) for a yaw
    surface (rudder), spanwise (world +X) for everything else. An explicit
    `hinge_axis` ('x'/'y'/'z') forces a specific column when needed.

    A single Unity bundle may pack several aircraft that share bone names (e.g.
    12 different planes each with a `BAileronL`). When `root_pid` is given, the
    bone under that aircraft's transform root is preferred so the surface always
    gets *its own* plane's hinge, not the first identically-named bone in the
    bundle. Falls back to the first name match if none share the root.
    """
    transform_pid = find_node_pid(bundle, part_name, root_pid)
    if transform_pid is None:
        return None

    wm = _FLIP_X @ world_matrix(transform_pid, bundle.transforms, world_cache) @ _FLIP_X
    hinge_world = wm[:3, 3] * scale
    pivot_local = hinge_world + np.array([0.0, ground_offset_y, 0.0])

    def _norm(v: np.ndarray) -> np.ndarray:
        n = float(np.linalg.norm(v))
        return v / n if n > 1e-9 else np.array([1.0, 0.0, 0.0])

    cols = [_norm(wm[:3, i].copy()) for i in range(3)]
    ref = np.array([0.0, 1.0, 0.0]) if control == 'yaw' else np.array([1.0, 0.0, 0.0])
    if hinge_axis is not None:
        axis = cols[{'x': 0, 'y': 1, 'z': 2}.get(hinge_axis.lower(), 0)]
    else:
        axis = max(cols, key=lambda c: abs(float(c @ ref)))
    # Orient the sign so the dominant component is positive (+Y for yaw,
    # +X otherwise); the per-surface `sign` in the manifest is tuned against
    # this convention.
    if float(axis @ ref) < 0.0:
        axis = -axis
    return pivot_local, axis


def derive_gear_points(
    processed: list[dict],
    ground_part_names: list[str],
    translate: np.ndarray,
    bottom_percentile: float = 10.0,
) -> list[list[float]]:
    """FM2 spring contact points from each wheel mesh's lowest vertices."""
    part_by_name = {p['name']: p for p in processed}
    translate = np.asarray(translate, dtype=np.float64)
    points: list[list[float]] = []
    for name in ground_part_names:
        part = part_by_name.get(name)
        if part is None:
            print(f'WARNING: ground part "{name}" not found; skipping gear point.')
            continue
        v = part['world_v'] + translate
        y_contact = float(v[:, 1].min())
        y_thresh = float(np.percentile(v[:, 1], bottom_percentile))
        bottom = v[v[:, 1] <= y_thresh]
        if len(bottom) == 0:
            bottom = v
        x = float(bottom[:, 0].mean())
        z = float(bottom[:, 2].mean())
        points.append([round(x, 4), round(y_contact, 4), round(z, 4)])
    return points


def import_mod(cfg: dict, bundle: Bundle | None = None) -> int:
    bundle_path = cfg['bundle']
    out = cfg['out']
    if not os.path.isabs(out):
        out = os.path.join(PROJECT_ROOT, out)
    tca = merge_config_overrides(cfg)
    buffer_prefix = cfg.get('bufferPrefix') or (
        os.path.splitext(os.path.basename(out))[0] + '_buffer_')
    ground_distance = float(cfg.get('groundDistance', 2.0))
    ground_contact_percentile = float(cfg.get('groundContactPercentile', 10.0))
    ground_contact_inset_m = float(cfg.get('groundContactInsetM', 0.0))
    scale = float(cfg.get('scale', 1.0))
    rotation_euler = cfg.get('rotationEuler')  # [x, y, z] degrees, or None
    swatch_max = int(cfg.get('swatchMax', DEFAULT_SWATCH_MAX))
    bitmap_livery = bool(cfg.get('bitmapLivery', True))
    bitmap_sample_max = int(cfg.get('bitmapSampleMax', DEFAULT_BITMAP_SAMPLE_MAX))
    glass_color = cfg.get('glassColor', '#d1f7ff')
    glass_auto_alpha = bool(cfg.get('glassAutoAlpha', True))
    glass_alpha_max = float(cfg.get('glassAlphaMax', 0.9))
    # Afterburner nozzle interiors: export as dark metal, not FX_FIRE (the sim
    # renders FX_FIRE with orange/yellow ordered dither for plume FX).
    nozzle_auto = bool(cfg.get('nozzleAuto', True))
    nozzle_color = str(cfg.get('nozzleColor', DEFAULT_NOZZLE_COLOR))
    # Emissive "lights": a bright _EmissionColor over a dark base colour is
    # exported as its literal bright colour. An optional allow-list restricts
    # which material names may glow (empty = any qualifying material).
    emissive_lights = bool(cfg.get('emissiveLights', True))
    emissive_materials = set(cfg.get('emissiveMaterials', []))
    # Explicit per-material colour overrides: Unity material name -> '#rrggbb'
    # or a PaletteCategory name (e.g. 'GLASS'). Supersedes palette sampling.
    material_colors = dict(cfg.get('materialColors', {}))
    # groundParts is the general name; gearWheelParts kept as a back-compat alias.
    ground_part_names = list(cfg.get('groundParts', cfg.get('gearWheelParts', [])))
    ground_parts = set(ground_part_names)
    include_exact = set(cfg.get('includeExact', []))
    # Always apply shadow/clutter name fallbacks so unbundled shared materials
    # cannot let those meshes leak into the visible body; includeExact still
    # rescues any legitimate part that happens to match. Colliders are kept
    # separately (see collision_parts) rather than skipped.
    skip_parts = skip_part_substrings(tca)
    skip_exact = set(cfg.get('skipExact', []))
    skip_materials = tuple(cfg.get('skipMaterials', tca.skip_material_substrings))
    # A single Unity bundle may pack several aircraft that share part names
    # (e.g. many 'WingR'/'Cockpit'); they are separable only by material. When
    # set, only meshes whose renderer uses one of these materials are exported,
    # carving one plane out of a multi-plane bundle. Empty = include all.
    include_materials = set(cfg.get('includeMaterials', []))
    # Extra mats on the same transform root (e.g. "AC-208 Prop Mat" when the
    # hull wrongly shares another plane's livery material).
    for companion in cfg.get('companionMaterials', []) or []:
        if companion:
            include_materials.add(companion)
    # Explicit transform roots: carve one airframe when several share a material.
    include_roots_cfg = {
        int(r) for r in (cfg.get('includeRoots') or [])
    }
    # Some bundles pack two overlapping copies of the same plane (e.g. a
    # flyable + a scenery prefab, or two liveries sharing one material). Left
    # in, they z-fight and the model looks broken. When true, only the first
    # mesh per unique GameObject name is kept, yielding one clean copy.
    dedupe_parts = bool(cfg.get('dedupeParts', False))
    seen_names: set[tuple[str, int]] = set()
    # Optional greyscale remap. Some liveries bake heavy panel/camo shading into
    # their swatch texture, so sampling yields a high-contrast mix of near-black
    # and white faces. In a flat-shaded renderer the near-black regions read as
    # voids ("missing" fuselage/wings), and the plane is not the uniform grey a
    # jet should be. When enabled, every sampled colour is desaturated to its
    # luminance and remapped into a [lo, hi] grey band (lifting blacks, taming
    # whites), yielding a clean, fully-visible grey aircraft. Value: true (uses
    # the defaults) or {"lo": <0-255>, "hi": <0-255>}.
    grayscale_cfg = cfg.get('grayscale')
    if grayscale_cfg is True:
        gray_lo, gray_hi = 90, 205
    elif isinstance(grayscale_cfg, dict):
        gray_lo = int(grayscale_cfg.get('lo', 90))
        gray_hi = int(grayscale_cfg.get('hi', 205))
    else:
        grayscale_cfg = None
        gray_lo = gray_hi = 0

    def grayify(hexes: np.ndarray) -> np.ndarray:
        """Map an array of '#rrggbb' colours to greys in the [lo, hi] band.
        Non-hex entries (PaletteCategory names, e.g. 'GLASS') pass through."""
        if not grayscale_cfg:
            return hexes
        out = hexes.copy()
        for h in np.unique(hexes):
            s = str(h)
            if len(s) != 7 or s[0] != '#':
                continue
            try:
                r, g, b = int(s[1:3], 16), int(s[3:5], 16), int(s[5:7], 16)
            except ValueError:
                continue
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            v = int(round(gray_lo + (gray_hi - gray_lo) * (lum / 255.0)))
            v = max(0, min(255, v))
            out[hexes == h] = f'#{v:02x}{v:02x}{v:02x}'
        return out

    rotation_matrix = euler_matrix(rotation_euler) if rotation_euler else None

    if bundle is None:
        bundle = Bundle(bundle_path)
    elif os.path.abspath(bundle.source_path) != os.path.abspath(bundle_path):
        bundle = Bundle(bundle_path)

    if 'collectionPack' in cfg:
        collection_bundle = bool(cfg['collectionPack'])
    else:
        collection_bundle = count_livery_materials(bundle, tca) > COLLECTION_LIVERY_THRESHOLD
    if collection_bundle and include_materials:
        print('Multi-aircraft collection bundle: global spatial part rescue disabled.',
              file=sys.stderr)

    def material_is_true_glass(mat: dict | None) -> bool:
        """Shared Canopy/Glass material or low-alpha transparency — not livery paint."""
        if mat is None:
            return False
        cls = classify_material(mat.get('name', ''), tca)
        if cls is not None and cls.palette_category == GLASS_CATEGORY:
            return True
        return bool(glass_auto_alpha and mat.get('alpha', 1.0) < glass_alpha_max)

    def is_glass(
        name: str,
        mat: dict | None,
        *,
        sibling_has_true_glass: bool = False,
    ) -> bool:
        """True for see-through canopy glass faces.

        Rules (same for every mod):
        1. Shared Canopy/Glass material, or low alpha → glass.
        2. On a canopy-named mesh that also has true glass, opaque materials are
           frames/seals/interior and stay solid.
        3. On a canopy-named mesh with no true-glass submesh, opaque materials
           still count as glass (livery-painted canopy bubble).
        """
        if material_is_true_glass(mat):
            return True
        if not is_glass_part(name, tca):
            return False
        if (
            sibling_has_true_glass
            and mat is not None
            and mat.get('alpha', 1.0) >= glass_alpha_max
        ):
            return False
        return True

    def is_nozzle(name: str, mat: dict | None) -> bool:
        """True for an afterburner nozzle-interior mesh (shared NozzleInteriorMat
        or a matching mesh name when that material is an unbundled GUID ref)."""
        if not nozzle_auto:
            return False
        if is_nozzle_part(name, tca):
            return True
        if mat is None:
            return False
        cls = classify_material(mat.get('name', ''), tca)
        return cls is not None and cls.palette_category == FX_FIRE_MATERIAL

    def nozzle_hex(mat: dict | None) -> str:
        """Rest-pose nozzle colour: dark material _Color when present, else config."""
        if mat is not None and mat.get('color'):
            c = mat['color']
            if max(c.get('r', 0.0), c.get('g', 0.0), c.get('b', 0.0)) <= EMISSION_BASE_MAX:
                return rgba01_to_hex(c)
        return nozzle_color

    def emissive_hex(mat: dict | None) -> str | None:
        """Bright emissive 'light' colour ('#rrggbb') for a material, else None.

        Targets true lamps (dark base colour + bright _EmissionColor, e.g.
        F4EEmissiveMat); ordinary lit surfaces fall through to palette/flat
        colouring. An optional emissiveMaterials allow-list narrows this."""
        if not emissive_lights or mat is None:
            return None
        if emissive_materials and mat.get('name', '') not in emissive_materials:
            return None
        em = mat.get('emission') or {}
        if not em:
            return None
        er, eg, eb = em.get('r', 0.0), em.get('g', 0.0), em.get('b', 0.0)
        if max(er, eg, eb) < EMISSION_MIN:
            return None
        base = mat.get('color') or {}
        if base and max(base.get('r', 0.0), base.get('g', 0.0),
                        base.get('b', 0.0)) > EMISSION_BASE_MAX:
            return None
        return rgba01_to_hex(em)

    def face_colors(name: str, mat: dict | None, face_t: np.ndarray,
                    uvs: np.ndarray | None, pal: np.ndarray | None,
                    *, sibling_has_true_glass: bool = False) -> np.ndarray:
        # 1. Explicit per-material override wins.
        if mat is not None and mat['name'] in material_colors:
            res = np.full(len(face_t), material_colors[mat['name']])
        # 2. Afterburner nozzle interior -> dark metal (not FX_FIRE: that category
        # is ordered-dither orange/yellow plume FX in the sim renderer).
        elif is_nozzle(name, mat):
            return np.full(len(face_t), nozzle_hex(mat))
        # 3. Glass: a PaletteCategory glass colour (e.g. 'GLASS') always renders
        # as one uniform material so the sim can tint/dither it; a literal
        # '#rrggbb' still samples per-poly tint when the glass has a swatch.
        elif is_glass(name, mat, sibling_has_true_glass=sibling_has_true_glass):
            # Always tag glass faces with the configured glass colour (usually the
            # PaletteCategory 'GLASS'). Do not palette-sample glass: livery swatches
            # on canopy parts would export as opaque hex colours the renderer cannot
            # treat as see-through glass.
            return np.full(len(face_t), glass_color)
        # 4. Emissive light (bright emission over a dark base). Exported as its
        # literal colour and never desaturated by the livery grayscale remap.
        elif (light := emissive_hex(mat)) is not None:
            return np.full(len(face_t), light)
        # 5. Palette-swatch sampled per face.
        elif pal is not None and uvs is not None:
            res = sample_hex(pal, uvs[face_t].mean(axis=1))
        # 6. Flat material colour, else neutral fallback.
        elif mat is not None and mat['color']:
            res = np.full(len(face_t), rgba01_to_hex(mat['color']))
        else:
            res = np.full(len(face_t), DEFAULT_MATERIAL)
        if is_nozzle(name, mat):
            return res
        return grayify(res)

    def palette_array(mat: dict):
        if mat is None or not mat['main_tex']:
            return None
        tex = bundle.textures.get(mat['main_tex'])
        if tex is None:
            return None
        return texture_sample_array(
            tex, swatch_max, bitmap_livery, bitmap_sample_max)

    world_cache: dict[int, np.ndarray] = {}

    # A flyable mod additionally routes movable parts into per-surface + gear
    # sub-models and emits an aircraft manifest; absent, the classic single
    # static glTF is produced.
    flyable = cfg.get('flyable')
    surface_defs = flyable.get('surfaces', []) if flyable else []
    gear_names = set(flyable.get('gear', [])) if flyable else set()

    def colourable(name: str, sub_mat: dict | None, pal,
                   *, sibling_has_true_glass: bool = False) -> bool:
        has_override = sub_mat is not None and sub_mat['name'] in material_colors
        return bool(has_override or is_nozzle(name, sub_mat)
                    or is_glass(name, sub_mat, sibling_has_true_glass=sibling_has_true_glass)
                    or emissive_hex(sub_mat) is not None
                    or pal is not None or (sub_mat is not None and sub_mat['color']))

    # A multi-plane bundle can have per-plane companion materials that are not
    # the selected livery (e.g. glass or nozzle interiors). Without a rescue
    # path those parts are dropped by includeMaterials. We first find the
    # transform-hierarchy root(s) of the livery-matched parts, then optionally
    # re-admit same-root parts:
    #   - glass/canopy (rescueGlassUnderRoot / rescueGlassGlobal), or
    #   - cockpit interior (rescueCockpit), or
    #   - nozzle interiors (rescueNozzleUnderRoot / rescueNozzleGlobal), or
    #   - any non-skipped material (rescueMaterialsUnderRoot).
    # rescueNozzleGlobal / rescueGlassGlobal re-admit off-root pooled meshes when
    # they lie near the livery-matched hull bounds (common in multi-plane bundles).
    # Disabled for collection packs where every aircraft shares the same origin.
    global_rescue_default = bool(include_materials) and not collection_bundle
    rescue_glass = bool(cfg.get('rescueGlassUnderRoot', False)) and bool(include_materials)
    rescue_glass_global = bool(cfg.get(
        'rescueGlassGlobal',
        global_rescue_default,
    )) and bool(include_materials)
    rescue_cockpit = bool(cfg.get(
        'rescueCockpit',
        bool(include_materials),
    )) and bool(include_materials)
    rescue_cockpit_global = bool(cfg.get(
        'rescueCockpitGlobal',
        global_rescue_default,
    )) and bool(include_materials)
    rescue_nozzle = bool(cfg.get(
        'rescueNozzleUnderRoot',
        bool(include_materials),
    )) and bool(include_materials)
    rescue_nozzle_global = bool(cfg.get(
        'rescueNozzleGlobal',
        global_rescue_default,
    )) and bool(include_materials)
    rescue_collision = bool(cfg.get(
        'rescueCollisionUnderRoot',
        bool(include_materials),
    )) and bool(include_materials)
    rescue_collision_global = bool(cfg.get(
        'rescueCollisionGlobal',
        global_rescue_default,
    )) and bool(include_materials)
    rescue_materials = bool(cfg.get('rescueMaterialsUnderRoot', False)) and bool(include_materials)

    def _root_of(tpid: int) -> int:
        return transform_root(tpid, bundle.transforms)

    def _transform_origin(tpid: int) -> np.ndarray:
        wm = world_matrix(tpid, bundle.transforms, world_cache)
        wm = _FLIP_X @ wm @ _FLIP_X
        origin = (wm @ np.array([0.0, 0.0, 0.0, 1.0]))[:3] * scale
        if rotation_matrix is not None:
            origin = origin @ rotation_matrix.T
        return origin

    def _transform_forward(tpid: int) -> np.ndarray:
        wm = world_matrix(tpid, bundle.transforms, world_cache)
        wm = _FLIP_X @ wm @ _FLIP_X
        forward = (wm @ np.array([0.0, 0.0, 1.0, 0.0]))[:3]
        n = float(np.linalg.norm(forward))
        if n < 1e-9:
            forward = np.array([0.0, 0.0, 1.0], dtype=np.float64)
        else:
            forward = forward / n
        if rotation_matrix is not None:
            forward = forward @ rotation_matrix.T
        return forward

    def _has_glass_mat(pids) -> bool:
        return any(bundle.materials.get(pid, {}).get('alpha', 1.0) < glass_alpha_max
                   for pid in pids)

    def _mat_names_for_pids(pids) -> tuple[str, ...]:
        return tuple(bundle.materials.get(pid, {}).get('name', '') for pid in pids)

    def _is_nozzle_mesh(name: str, pids) -> bool:
        return is_nozzle_mesh(name, _mat_names_for_pids(pids), tca)

    def _is_glass_mesh(name: str, pids) -> bool:
        if is_glass_part(name, tca):
            return True
        if _has_glass_mat(pids):
            return True
        for pid in pids:
            cls = classify_material(
                bundle.materials.get(pid, {}).get('name', ''), tca)
            if cls is not None and cls.palette_category == GLASS_CATEGORY:
                return True
        return False

    def _is_cockpit_mesh(name: str) -> bool:
        return is_cockpit_part(name, tca)

    def _is_collision_mesh(name: str, pids) -> bool:
        return is_collision_mesh(name, _mat_names_for_pids(pids), tca)

    matched_roots: set[int] = set()
    plane_bounds: tuple[np.ndarray, np.ndarray] | None = None
    if include_materials:
        # Build livery-root stats when includeMaterials is set so we can drop
        # foreign airframes that reuse the same material name.
        livery_mins = None
        livery_maxs = None
        root_mins: dict[int, np.ndarray] = {}
        root_maxs: dict[int, np.ndarray] = {}
        root_part_counts: dict[int, int] = defaultdict(int)
        for o in bundle.env.objects:
            if o.type.name != 'GameObject':
                continue
            go = o.read()
            tpid = None
            mat_pids = []
            mesh_filter = None
            for comp in go.m_Component:
                co = bundle.by_path.get(comp.component.path_id)
                if co is None:
                    continue
                if co.type.name == 'Transform':
                    tpid = comp.component.path_id
                elif co.type.name == 'MeshFilter':
                    mesh_filter = bundle.mesh_filters.get(comp.component.path_id)
                elif co.type.name == 'MeshRenderer':
                    tt = co.read_typetree()
                    mat_pids = [m['m_PathID'] for m in tt.get('m_Materials', [])]
            if tpid is None:
                continue
            if not any(
                    bundle.materials.get(pid, {}).get('name', '') in include_materials
                    for pid in mat_pids):
                continue
            root = _root_of(tpid)
            matched_roots.add(root)
            root_part_counts[root] += 1
            origin = _transform_origin(tpid)
            if livery_mins is None:
                livery_mins = origin.copy()
                livery_maxs = origin.copy()
            else:
                livery_mins = np.minimum(livery_mins, origin)
                livery_maxs = np.maximum(livery_maxs, origin)

            # Prefer mesh AABB for span (collection packs share one origin).
            mesh_pts = None
            if mesh_filter is not None:
                mesh = bundle.meshes.get(mesh_filter.m_Mesh.path_id)
                if mesh is not None:
                    verts, _uvs, sub_faces, _sft = mesh_geometry(mesh, mat_pids)
                    if len(verts) and sub_faces:
                        wm = world_matrix(tpid, bundle.transforms, world_cache)
                        wm = _FLIP_X @ wm @ _FLIP_X
                        mesh_pts = (wm @ np.c_[verts, np.ones(len(verts))].T).T[:, :3] * scale
                        if rotation_matrix is not None:
                            mesh_pts = mesh_pts @ rotation_matrix.T
            if mesh_pts is not None and len(mesh_pts):
                pmin = mesh_pts.min(axis=0)
                pmax = mesh_pts.max(axis=0)
            else:
                pmin = pmax = origin
            if root not in root_mins:
                root_mins[root] = pmin.copy()
                root_maxs[root] = pmax.copy()
            else:
                root_mins[root] = np.minimum(root_mins[root], pmin)
                root_maxs[root] = np.maximum(root_maxs[root], pmax)

        if include_roots_cfg:
            selected = include_roots_cfg & matched_roots if matched_roots else set(include_roots_cfg)
            if not selected:
                selected = set(include_roots_cfg)
            dropped = matched_roots - selected
            if dropped:
                print(
                    f'includeRoots pinned {sorted(selected)}; '
                    f'dropping {len(dropped)} other material-matched roots.',
                    file=sys.stderr,
                )
            matched_roots = selected
        elif len(matched_roots) > 1:
            root_spans = {
                r: float(np.max(root_maxs[r] - root_mins[r]))
                for r in matched_roots
                if r in root_mins
            }
            selected = select_primary_livery_roots(
                root_spans,
                dict(root_part_counts),
                single_root=dedupe_parts or collection_bundle,
            )
            dropped = matched_roots - selected
            if dropped:
                print(
                    f'Livery material shared by {len(matched_roots)} airframe roots; '
                    f'keeping {len(selected)} (span-clustered), dropping {len(dropped)}.',
                    file=sys.stderr,
                )
                for r in sorted(dropped, key=lambda x: -root_spans.get(x, 0)):
                    span = root_spans.get(r, 0.0)
                    print(
                        f'  drop root parts={root_part_counts.get(r, 0)} '
                        f'span={span:.1f}m',
                        file=sys.stderr,
                    )
            matched_roots = selected

        # Rebuild plane bounds from the kept root(s) only.
        if matched_roots and root_mins:
            livery_mins = None
            livery_maxs = None
            for r in matched_roots:
                if r not in root_mins:
                    continue
                if livery_mins is None:
                    livery_mins = root_mins[r].copy()
                    livery_maxs = root_maxs[r].copy()
                else:
                    livery_mins = np.minimum(livery_mins, root_mins[r])
                    livery_maxs = np.maximum(livery_maxs, root_maxs[r])

        if livery_mins is not None:
            plane_bounds = (livery_mins, livery_maxs)

    def _near_plane_bounds(transform_pid: int) -> bool:
        if plane_bounds is None:
            return False
        lo, hi = plane_bounds
        return point_in_expanded_bounds(_transform_origin(transform_pid), lo, hi)

    def _nozzle_rescued(name: str, pids, transform_pid: int) -> bool:
        if not rescue_nozzle or not _is_nozzle_mesh(name, pids):
            return False
        if _root_of(transform_pid) in matched_roots:
            return True
        return rescue_nozzle_global and _near_plane_bounds(transform_pid)

    def _glass_rescued(name: str, pids, transform_pid: int) -> bool:
        if not rescue_glass or not _is_glass_mesh(name, pids):
            return False
        if _root_of(transform_pid) in matched_roots:
            return True
        return rescue_glass_global and _near_plane_bounds(transform_pid)

    def _cockpit_rescued(name: str, transform_pid: int) -> bool:
        if not rescue_cockpit or not _is_cockpit_mesh(name):
            return False
        if _root_of(transform_pid) in matched_roots:
            return True
        return rescue_cockpit_global and _near_plane_bounds(transform_pid)

    def _collision_rescued(name: str, pids, transform_pid: int) -> bool:
        if not rescue_collision or not _is_collision_mesh(name, pids):
            return False
        if _root_of(transform_pid) in matched_roots:
            return True
        return rescue_collision_global and _near_plane_bounds(transform_pid)

    processed: list[dict] = []
    ground_contact_y = None

    for o in bundle.env.objects:
        if o.type.name != 'GameObject':
            continue
        go = o.read()
        name = go.m_Name
        # Collider-named parts are collected even when "Collider" appears in an
        # overridden skipNameParts list — they route to collision_parts, not body.
        is_collider_name = is_collision_mesh(name, (), tca)
        if not is_collider_name and not _should_include(name, include_exact, skip_parts, skip_exact):
            continue

        transform_pid = None
        mesh_filter = None
        mat_pids = []
        for comp in go.m_Component:
            co = bundle.by_path.get(comp.component.path_id)
            if co is None:
                continue
            tn = co.type.name
            if tn == 'Transform':
                transform_pid = comp.component.path_id
            elif tn == 'MeshFilter':
                mesh_filter = bundle.mesh_filters[comp.component.path_id]
            elif tn == 'MeshRenderer':
                tt = co.read_typetree()
                mat_pids = [m['m_PathID'] for m in tt.get('m_Materials', [])]

        if transform_pid is None or mesh_filter is None:
            continue
        mesh = bundle.meshes.get(mesh_filter.m_Mesh.path_id)
        if mesh is None:
            continue

        if not mat_pids:
            continue
        has_livery = (not include_materials) or any(
            bundle.materials.get(pid, {}).get('name', '') in include_materials
            for pid in mat_pids)
        same_root = _root_of(transform_pid) in matched_roots
        # When includeMaterials matched several airframes, matched_roots was
        # span-clustered to one primary copy — reject other roots' livery meshes.
        if include_materials and has_livery and matched_roots and not same_root:
            continue
        rescued = (
            not has_livery
            and (
                _nozzle_rescued(name, mat_pids, transform_pid)
                or _glass_rescued(name, mat_pids, transform_pid)
                or _cockpit_rescued(name, transform_pid)
                or _collision_rescued(name, mat_pids, transform_pid)
                or (
                    same_root
                    and (
                        (rescue_glass and _is_glass_mesh(name, mat_pids))
                        or rescue_materials
                    )
                )
            )
        )
        if include_materials and not has_livery and not rescued:
            continue
        mat_names = _mat_names_for_pids(mat_pids)
        part_is_collision = is_collision_mesh(name, mat_names, tca)
        # Skip shadow materials always; collider materials are kept as collision.
        if not part_is_collision and any(
            any(s in bundle.materials.get(pid, {}).get('name', '')
                for s in skip_materials)
            for pid in mat_pids
        ):
            continue
        if dedupe_parts:
            dedupe_key = (name, _root_of(transform_pid))
            if dedupe_key in seen_names:
                continue
            seen_names.add(dedupe_key)

        verts, uvs, sub_faces, sub_face_t = mesh_geometry(mesh, mat_pids)
        if len(verts) == 0 or not sub_faces:
            continue

        wm = world_matrix(transform_pid, bundle.transforms, world_cache)
        wm = _FLIP_X @ wm @ _FLIP_X  # match the X-flip in mesh.export()
        world_v = (wm @ np.c_[verts, np.ones(len(verts))].T).T[:, :3] * scale
        if rotation_matrix is not None:
            world_v = world_v @ rotation_matrix.T

        if name in ground_parts:
            ys = world_v[:, 1]
            contact = float(np.percentile(ys, ground_contact_percentile))
            contact -= ground_contact_inset_m
            ground_contact_y = (contact if ground_contact_y is None
                                else max(ground_contact_y, contact))

        sub_mats = [bundle.materials.get(mat_pids[si if si < len(mat_pids) else 0])
                    for si in range(len(sub_faces))]
        processed.append({
            'name': name, 'world_v': world_v, 'uvs': uvs,
            'sub_faces': sub_faces, 'sub_face_t': sub_face_t, 'sub_mats': sub_mats,
            'tpid': transform_pid,
            'is_collision': part_is_collision,
        })

    if not processed:
        raise SystemExit('No colourable meshes found. Try --list to inspect the bundle.')

    collision_parts = [p for p in processed if p.get('is_collision')]
    visual_parts = [p for p in processed if not p.get('is_collision')]
    if not visual_parts:
        raise SystemExit('No visual meshes found (only colliders). Try --list to inspect the bundle.')

    if ground_contact_y is None:
        ground_contact_y = min(float(p['world_v'][:, 1].min()) for p in visual_parts)
    ground_min_y = ground_contact_y
    ground_offset_y = -ground_distance - ground_min_y

    def build_buckets(parts, translate) -> dict[str, list[np.ndarray]]:
        buckets: dict[str, list[np.ndarray]] = defaultdict(list)
        for p in parts:
            sibling_glass = any(material_is_true_glass(m) for m in p['sub_mats'])
            for si, face_v in enumerate(p['sub_faces']):
                if len(face_v) == 0:
                    continue
                sub_mat = p['sub_mats'][si]
                if sub_mat and any(s in sub_mat['name'] for s in skip_materials):
                    continue
                pal = palette_array(sub_mat)
                if not colourable(
                    p['name'], sub_mat, pal, sibling_has_true_glass=sibling_glass,
                ):
                    continue
                face_t = p['sub_face_t'][si]
                tri_corners = p['world_v'][face_v] + translate
                keys = face_colors(
                    p['name'], sub_mat, face_t, p['uvs'], pal,
                    sibling_has_true_glass=sibling_glass,
                )
                for key in np.unique(keys):
                    buckets[str(key)].append(tri_corners[keys == key].reshape(-1, 3))
        return buckets

    def emit(parts, translate, out_path, buffer_prefix, animations=None) -> list[str]:
        buckets = build_buckets(parts, np.asarray(translate, dtype=np.float64))
        if not buckets:
            return []
        scene = trimesh.Scene()
        for idx, (key, tris) in enumerate(buckets.items()):
            v = np.vstack(tris)
            f = np.arange(len(v), dtype=np.int64).reshape(-1, 3)
            m = trimesh.Trimesh(vertices=v, faces=f, process=False)
            _set_flat_normals(m)
            m.visual = trimesh.visual.TextureVisuals(
                material=trimesh.visual.material.PBRMaterial(name=key))
            scene.add_geometry(m, node_name=f'0_{idx}_{key}', geom_name=f'{idx}_{key}')
        _write_gltf(scene, out_path, buffer_prefix, animations=animations)
        return sorted(buckets)

    def emit_collision(parts, translate, out_path, buffer_prefix) -> bool:
        """Emit collider meshes under the reserved COLLISION material (invisible)."""
        translate = np.asarray(translate, dtype=np.float64)
        tris: list[np.ndarray] = []
        for p in parts:
            for face_v in p['sub_faces']:
                if len(face_v) == 0:
                    continue
                tris.append((p['world_v'][face_v] + translate).reshape(-1, 3))
        if not tris:
            return False
        v = np.vstack(tris)
        f = np.arange(len(v), dtype=np.int64).reshape(-1, 3)
        m = trimesh.Trimesh(vertices=v, faces=f, process=False)
        _set_flat_normals(m)
        m.visual = trimesh.visual.TextureVisuals(
            material=trimesh.visual.material.PBRMaterial(name=COLLISION_MATERIAL))
        scene = trimesh.Scene()
        scene.add_geometry(m, node_name=f'0_0_{COLLISION_MATERIAL}',
                           geom_name=f'0_{COLLISION_MATERIAL}')
        _write_gltf(scene, out_path, buffer_prefix)
        return True

    def bake_collision_mesh(parts, translate) -> dict | None:
        """Body-frame triangle soup + AABB for runtime bullet/ground tests."""
        translate = np.asarray(translate, dtype=np.float64)
        flat: list[float] = []
        for p in parts:
            for face_v in p['sub_faces']:
                if len(face_v) == 0:
                    continue
                corners = (p['world_v'][face_v] + translate).reshape(-1, 3)
                for row in corners:
                    flat.extend((float(row[0]), float(row[1]), float(row[2])))
        if not flat:
            return None
        arr = np.asarray(flat, dtype=np.float64).reshape(-1, 3)
        mn = arr.min(axis=0)
        mx = arr.max(axis=0)
        return {
            'triangles': [round(float(x), 5) for x in flat],
            'aabb': {
                'min': [round(float(x), 5) for x in mn],
                'max': [round(float(x), 5) for x in mx],
            },
        }

    def emit_gear_animated(parts, translate, out_path, buffer_prefix, clip) -> tuple[list[str], bool]:
        """Emit per-part gear meshes with baked GearUp clips (doors close late).

        Rest pose = TCA clip t=0 (gear down). Clips are time-reversed so the sim's
        F-22 convention holds: playback position 1 = extended, 0 = retracted.
        """
        translate = np.asarray(translate, dtype=np.float64)
        t_info = clip['t_info']
        _, _, full_paths = build_transform_path_index(bundle)
        # Reuse clip's t_info paths when available.
        full_paths = {tid: full_paths.get(tid, t_info[tid]['name']) for tid in t_info}

        sample_times_u = gear_clip_sample_times(clip)
        duration = float(clip['duration'])
        # Precompute rest + animated world matrices (Unity space) per part.
        rest_sample = sample_gear_clip(clip, 0.0)
        rest_cache: dict = {}
        rest_world: dict[int, tuple[np.ndarray, bool]] = {}
        for p in parts:
            tpid = p.get('tpid')
            if tpid is None:
                continue
            rest_world[tpid] = world_matrix_animated(
                tpid, t_info, rest_sample, full_paths, rest_cache)

        anim_worlds: list[dict[int, tuple[np.ndarray, bool]]] = []
        for tu in sample_times_u:
            cache: dict = {}
            sample = sample_gear_clip(clip, float(tu))
            pose = {}
            for p in parts:
                tpid = p.get('tpid')
                if tpid is None:
                    continue
                pose[tpid] = world_matrix_animated(
                    tpid, t_info, sample, full_paths, cache)
            anim_worlds.append(pose)

        scene = trimesh.Scene()
        animations = []
        keys_out: list[str] = []
        node_i = 0

        def to_gltf_world(wu: np.ndarray) -> np.ndarray:
            wg = _FLIP_X @ wu @ _FLIP_X
            # Match mesh path: apply uniform scale on the transformed point, then
            # ground translate. Encode as S @ wg with translation scaled.
            out = np.eye(4, dtype=np.float64)
            out[:3, :3] = wg[:3, :3] * scale
            out[:3, 3] = wg[:3, 3] * scale
            if rotation_matrix is not None:
                r4 = np.eye(4, dtype=np.float64)
                r4[:3, :3] = rotation_matrix
                out = r4 @ out
            out[:3, 3] = out[:3, 3] + translate
            return out

        for p in parts:
            tpid = p.get('tpid')
            # Build per-colour buckets for THIS part only (keep part identity).
            part_buckets: dict[str, list[np.ndarray]] = defaultdict(list)
            sibling_glass = any(material_is_true_glass(m) for m in p['sub_mats'])
            for si, face_v in enumerate(p['sub_faces']):
                if len(face_v) == 0:
                    continue
                sub_mat = p['sub_mats'][si]
                if sub_mat and any(s in sub_mat['name'] for s in skip_materials):
                    continue
                pal = palette_array(sub_mat)
                if not colourable(
                    p['name'], sub_mat, pal, sibling_has_true_glass=sibling_glass,
                ):
                    continue
                face_t = p['sub_face_t'][si]
                tri_corners = p['world_v'][face_v] + translate
                face_keys = face_colors(
                    p['name'], sub_mat, face_t, p['uvs'], pal,
                    sibling_has_true_glass=sibling_glass,
                )
                for key in np.unique(face_keys):
                    part_buckets[str(key)].append(tri_corners[face_keys == key].reshape(-1, 3))
            if not part_buckets:
                continue

            # Delta matrices over time (F-22 order: t=0 retracted / TCA end).
            times_gltf = []
            trs_list = []  # (t, q, s) per sample
            if tpid is not None and tpid in rest_world:
                r0_u, _ = rest_world[tpid]
                r0 = to_gltf_world(r0_u)
                try:
                    r0_inv = np.linalg.inv(r0)
                except np.linalg.LinAlgError:
                    r0_inv = np.eye(4, dtype=np.float64)
                for tu, pose in zip(sample_times_u, anim_worlds):
                    rt_u, active = pose.get(tpid, (r0_u, True))
                    rt = to_gltf_world(rt_u)
                    # M maps rest mesh (already at r0) -> animated pose.
                    m = rt @ r0_inv
                    # Legs/struts use m_IsActive to disappear when stowed; bay doors
                    # must stay visible in the closed pose (body usually has no
                    # closed-door panels of its own in these flat imports).
                    is_door = 'door' in p['name'].lower()
                    if not active and not is_door:
                        m = m.copy()
                        m[:3, :3] *= 1e-4
                    tvec, quat, scl = matrix_to_trs(m)
                    # Reverse time: TCA gear-down (tu=0) -> glTF t=duration (extended).
                    tg = duration - float(tu)
                    times_gltf.append(tg)
                    trs_list.append((tvec, quat, scl))
                # Sort by ascending glTF time.
                order = sorted(range(len(times_gltf)), key=lambda i: times_gltf[i])
                times_gltf = [times_gltf[i] for i in order]
                trs_list = [trs_list[i] for i in order]
                # Quaternion continuity (avoid flips).
                for i in range(1, len(trs_list)):
                    if np.dot(trs_list[i][1], trs_list[i - 1][1]) < 0:
                        trs_list[i] = (trs_list[i][0], -trs_list[i][1], trs_list[i][2])
                # Renormalise after continuity fix.
                trs_list = [
                    (tvec, (q / max(np.linalg.norm(q), 1e-12)), scl)
                    for tvec, q, scl in trs_list
                ]
            else:
                times_gltf = [0.0, duration]
                trs_list = [
                    (np.zeros(3), np.array([0.0, 0.0, 0.0, 1.0]), np.ones(3)),
                    (np.zeros(3), np.array([0.0, 0.0, 0.0, 1.0]), np.ones(3)),
                ]

            safe = ''.join(c if c.isalnum() or c in '-_' else '_' for c in p['name'])
            for bi, (key, tris) in enumerate(part_buckets.items()):
                v = np.vstack(tris)
                f = np.arange(len(v), dtype=np.int64).reshape(-1, 3)
                mesh = trimesh.Trimesh(vertices=v, faces=f, process=False)
                _set_flat_normals(mesh)
                mesh.visual = trimesh.visual.TextureVisuals(
                    material=trimesh.visual.material.PBRMaterial(name=key))
                # Keep the colour token in the node name so _write_gltf can bind
                # the literal '#rrggbb' / PaletteCategory material (F-22-style
                # "{name}Action" clips still match via replace('Action','')).
                node_name = f'0_{safe}_{key}' if len(part_buckets) == 1 else f'0_{safe}_{bi}_{key}'
                scene.add_geometry(mesh, node_name=node_name, geom_name=f'{node_i}_{key}')
                animations.append({
                    'name': f'{node_name}Action',
                    'node': node_name,
                    'times': times_gltf,
                    'translations': [trs[0] for trs in trs_list],
                    'rotations': [trs[1] for trs in trs_list],
                    'scales': [trs[2] for trs in trs_list],
                })
                keys_out.append(key)
                node_i += 1

        if not keys_out:
            return [], False
        _write_gltf(scene, out_path, buffer_prefix, animations=animations)
        return sorted(set(keys_out)), True

    def emit_shadow(parts, translate, out_path, buffer_prefix) -> bool:
        """Flattened planform silhouette (aircraft-local y=0) as a black-dithered shadow mesh."""
        tris = []
        translate = np.asarray(translate, dtype=np.float64)
        for p in parts:
            for si, face_v in enumerate(p['sub_faces']):
                sub_mat = p['sub_mats'][si]
                if sub_mat and any(s in sub_mat['name'] for s in skip_materials):
                    continue
                v = p['world_v'][face_v].reshape(-1, 3).copy() + translate
                v[:, 1] = 0.0
                tris.append(v)
        if not tris:
            return False
        v = np.vstack(tris)
        f = np.arange(len(v), dtype=np.int64).reshape(-1, 3)
        m = trimesh.Trimesh(vertices=v, faces=f, process=False)
        _set_flat_normals(m)
        m.visual = trimesh.visual.TextureVisuals(
            material=trimesh.visual.material.PBRMaterial(name=SHADOW_MATERIAL))
        scene = trimesh.Scene()
        scene.add_geometry(m, node_name=f'0_0_{SHADOW_MATERIAL}',
                           geom_name=f'0_{SHADOW_MATERIAL}')
        _write_gltf(scene, out_path, buffer_prefix)
        return True

    def bp(path: str) -> str:
        return os.path.splitext(os.path.basename(path))[0] + '_buffer_'

    def rel(path: str) -> str:
        return os.path.relpath(path, PROJECT_ROOT).replace('\\', '/')

    ground_translate = [0.0, ground_offset_y, 0.0]

    if not flyable:
        keys = emit(visual_parts, ground_translate, out, buffer_prefix)
        print(f'Wrote {out}')
        print(f'Parts: {len(visual_parts)}, colours/materials: {len(keys)}')
        print('  ' + ', '.join(keys))
        print(f'ground_min_y: {ground_min_y:.3f}, ground_offset_y: {ground_offset_y:.3f}')
        return 0

    available = {p['name'] for p in visual_parts}
    _, _, full_paths_for_roots = build_transform_path_index(bundle)
    aircraft_roots: set[str] = set()
    for p in visual_parts:
        tpid = p.get('tpid')
        if not tpid or tpid not in full_paths_for_roots:
            continue
        root = full_paths_for_roots[tpid].split('/')[0]
        if root:
            aircraft_roots.add(root)
    name_hints = [
        h for h in (
            cfg.get('canonicalName'),
            cfg.get('displayName'),
            cfg.get('name'),
            cfg.get('id'),
            *sorted(aircraft_roots),
        ) if h
    ]
    gear_clip = discover_gear_up_clip(
        bundle,
        available,
        name_hints=name_hints,
        aircraft_roots=aircraft_roots or None,
    ) if flyable else None
    if gear_clip:
        print(f'Found gear clip "{gear_clip["name"]}" '
              f'({gear_clip["duration"]:.2f}s, {len(gear_clip["bindings"])} bindings, '
              f'overlap={gear_clip.get("overlap", 0)}, '
              f'affinity={gear_clip.get("name_affinity", 0)})')
    if not surface_defs and flyable.get('autoSurfaces', True) is not False:
        animated_parts = load_aircraft2_animated_parts(
            bundle_path,
            [
                cfg.get('canonicalName'),
                cfg.get('displayName'),
                cfg.get('name'),
                cfg.get('id'),
                *sorted(aircraft_roots),
            ],
        )
        from_json = surface_defs_from_animated_parts(animated_parts, available, tca)
        from_names = auto_surface_defs(available, tca)
        surface_defs = merge_surface_defs(from_json, from_names)
        if surface_defs:
            brakes = sum(1 for s in surface_defs if s.get('control') == 'airbrake')
            print(f'Auto-detected {len(surface_defs)} control surface(s)'
                  + (f' ({brakes} airbrake)' if brakes else '')
                  + ': ' + ', '.join(sd['role'] for sd in surface_defs))
    if not gear_names and flyable.get('autoGear', True) is not False:
        _, _, full_paths_for_gear = build_transform_path_index(bundle)
        detected_gear = auto_gear_names_from_clip(
            available, gear_clip, visual_parts, full_paths_for_gear, tca)
        if detected_gear:
            gear_names = detected_gear
            print(f'Auto-detected {len(gear_names)} gear/door part(s)')

    # ---- Variable-geometry wings: the mod's `SwingWings` block names transform
    # nodes (WingLRoot/WingRRoot, gloves) that the game rotates about a local
    # axis by up to MaxAngle. Everything parented under such a node sweeps with
    # it, so each node becomes one `sweep` surface; surfaces already split out of
    # its subtree (flaps, spoilers) stay separate but record it as `sweepParent`.
    swing_manifest = None
    swing = None
    aircraft2_hints = [
        cfg.get('canonicalName'),
        cfg.get('displayName'),
        cfg.get('name'),
        cfg.get('id'),
        *sorted(aircraft_roots),
    ]
    if flyable.get('autoSwingWings', True) is not False:
        swing = load_aircraft2_swing_wings(bundle_path, aircraft2_hints)
    if swing:
        max_deg = float(swing.get('MaxAngle', 0.0))
        plane_roots = {_root_of(p['tpid']) for p in visual_parts if p.get('tpid') is not None}
        wing_entries: list[dict] = []
        for entry in swing.get('Parts', []):
            mesh = str(entry.get('Mesh') or '')
            try:
                local_axis = np.asarray(entry.get('Axis'), dtype=np.float64)
            except (TypeError, ValueError):
                continue
            mag = float(np.linalg.norm(local_axis)) if local_axis.shape == (3,) else 0.0
            node = None
            for root_pid in plane_roots or {None}:
                node = find_node_pid(bundle, mesh, root_pid)
                if node is not None and (root_pid is None
                                         or transform_root(node, bundle.transforms) == root_pid):
                    break
                node = None
            if node is None or mag < 1e-6 or abs(max_deg) < 1e-3:
                print(f'  swing wing node "{mesh}" not found on this aircraft; skipping.')
                continue
            wm = _FLIP_X @ world_matrix(node, bundle.transforms, world_cache) @ _FLIP_X
            world_axis = wm[:3, :3] @ (local_axis / mag)
            world_axis = world_axis / max(float(np.linalg.norm(world_axis)), 1e-9)
            if abs(world_axis[1]) < 0.7:
                # Only vertical-axis (planform) sweep is rendered; e.g. F-15 intake
                # ramps rotate about a spanwise axis and are left in the body.
                print(f'  swing part "{mesh}" is not a vertical-axis sweep; skipping.')
                continue
            members = [p for p in visual_parts
                       if p.get('tpid') is not None and p['name'] not in gear_names
                       and transform_is_under(bundle, p['tpid'], node)]
            if not members:
                print(f'  swing wing node "{mesh}" has no meshes under it; skipping.')
                continue
            wing_entries.append({
                'mesh': mesh, 'node': node, 'mag': mag, 'members': members,
                'pivot': wm[:3, 3] * scale, 'world_axis': world_axis,
            })

        # Handedness: Unity's rotation convention vs ours is fixed per aircraft, so
        # calibrate it on the full-strength wing nodes -- the tip must move aft (-Z).
        handedness = None
        for w in wing_entries:
            if w['mag'] < 0.9:
                continue
            v = np.vstack([p['world_v'] for p in w['members']]) - w['pivot']
            tip = v[int(np.argmax(v[:, 0] ** 2 + v[:, 2] ** 2))]
            up = w['world_axis'] * (1.0 if w['world_axis'][1] > 0 else -1.0)
            aft_sign = 1 if float(np.cross(up, tip)[2]) < 0.0 else -1
            handedness = aft_sign * (1 if w['world_axis'][1] > 0 else -1)
            break

        swing_defs: list[dict] = []
        for w in wing_entries:
            if handedness is None:
                print('  swing wings: no full-strength wing node to calibrate on; skipping.')
                break
            up_sign = 1 if w['world_axis'][1] > 0 else -1
            role = f'{w["mesh"]}_sweep'
            names = []
            for p in w['members']:
                if p['name'] not in names:
                    names.append(p['name'])
            claimed: set[str] = set()
            for sd in surface_defs:
                if any(pn in names for pn in sd.get('parts', [])):
                    sd['sweepParent'] = role
                    claimed.update(sd.get('parts', []))
            own = [n for n in names if n not in claimed]
            if not own:
                continue
            up = w['world_axis'] * up_sign
            swing_defs.append({
                'role': role,
                'parts': own,
                'control': 'sweep',
                'hingePart': w['mesh'],
                'axis': [float(x) for x in up],
                'sign': handedness * up_sign,
                'rangeRad': float(np.radians(abs(max_deg))) * w['mag'],
            })
        if swing_defs:
            surface_defs = list(surface_defs) + swing_defs
            swing_manifest = {
                'minKias': float(swing.get('MinKIAS', 0.0)),
                'maxKias': float(swing.get('MaxKIAS', 0.0)),
                'travelSeconds': round(abs(max_deg) / max(float(swing.get('SweepSpeed', 1.0)), 1e-3), 3),
            }
            print(f'Swing wings: {len(swing_defs)} sweep surface(s) '
                  f'({", ".join(sd["role"] for sd in swing_defs)}), '
                  f'{swing_manifest["minKias"]:.0f}-{swing_manifest["maxKias"]:.0f} KIAS')

    surface_of_part: dict[str, int] = {}
    for si, sd in enumerate(surface_defs):
        for pn in sd.get('parts', []):
            surface_of_part[pn] = si

    # ---- Flyable: split into body / per-surface / gear sub-models + manifest.
    out_dir = os.path.dirname(out)
    stem = os.path.splitext(os.path.basename(out))[0]
    if stem.endswith('_static'):
        stem = stem[:-len('_static')]
    prefix = flyable.get('outPrefix') or os.path.join(out_dir, stem)
    if not os.path.isabs(prefix):
        prefix = os.path.join(PROJECT_ROOT, prefix)

    surface_parts = set(surface_of_part.keys())
    body_parts = [p for p in visual_parts
                  if p['name'] not in surface_parts and p['name'] not in gear_names]
    gear_parts = [p for p in visual_parts if p['name'] in gear_names]

    body_path = f'{prefix}_body.gltf'
    body_keys = emit(body_parts, ground_translate, body_path, bp(body_path))
    print(f'Wrote {body_path} ({len(body_keys)} colours)')

    gear_manifest = None
    gear_animated = False
    if gear_parts:
        gear_path = f'{prefix}_gear.gltf'
        if gear_clip:
            gear_keys, gear_animated = emit_gear_animated(
                gear_parts, ground_translate, gear_path, bp(gear_path), gear_clip)
            if gear_keys:
                gear_manifest = rel(gear_path)
                print(f'Wrote {gear_path} ({len(gear_keys)} colours, '
                      f'animated={gear_animated}, doors+legs from {gear_clip["name"]})')
        if not gear_manifest:
            gear_keys = emit(gear_parts, ground_translate, gear_path, bp(gear_path))
            if gear_keys:
                gear_manifest = rel(gear_path)
                gear_animated = False
                print(f'Wrote {gear_path} ({len(gear_keys)} colours, static)')

    def unit(v) -> np.ndarray:
        v = np.asarray(v, dtype=np.float64)
        n = float(np.linalg.norm(v))
        return v / n if n > 1e-9 else np.array([1.0, 0.0, 0.0])

    surfaces_manifest = []
    for si, sd in enumerate(surface_defs):
        members = [p for pn in sd.get('parts', []) for p in visual_parts if p['name'] == pn]
        if not members:
            print(f'WARNING: surface "{sd.get("role", si)}" matched no parts; skipping.')
            continue
        control = sd.get('control', 'pitch')
        role = sd.get('role', f'surf{si}')

        # A bundle may pack many planes sharing bone names, so resolve the hinge
        # bone within the same aircraft hierarchy (transform root) as this
        # surface's own mesh -- otherwise a left surface can grab another plane's
        # identically-named bone and hinge about the wrong axis/pivot.
        member_tpid = next((p.get('tpid') for p in members if p.get('tpid') is not None), None)
        surface_root = _root_of(member_tpid) if member_tpid is not None else None

        # Hinge frame: an explicit `hingePart` bone, else -- unless disabled via
        # `autoHinge: false` -- an auto-discovered bone following the mod's
        # `B`+partName convention (e.g. Rudder -> BRudder, SlatsL -> BSlatsL).
        # This lets any well-authored mod get its true (often tilted) hinge axis
        # and pivot with no per-surface config.
        hinge_part = sd.get('hingePart')
        hinge_frame = None
        if hinge_part:
            hinge_frame = hinge_frame_from_part(
                bundle, hinge_part, world_cache, scale, ground_offset_y,
                control, sd.get('hingeAxis'), surface_root,
            )
            if hinge_frame is None:
                print(f'WARNING: hingePart "{hinge_part}" for surface "{role}" not found; '
                      'falling back to geometry pivot.')
        elif sd.get('autoHinge', True) and sd.get('parts'):
            bone_prefix = cfg.get('hingeBonePrefix', tca.hinge_bone_prefix)
            hinge_part = bone_prefix + sd['parts'][0]
            hinge_frame = hinge_frame_from_part(
                bundle, hinge_part, world_cache, scale, ground_offset_y,
                control, sd.get('hingeAxis'), surface_root,
            )
            if hinge_frame is not None:
                print(f'  auto hinge bone "{hinge_part}" for surface "{role}"')

        # Hinge axis: explicit override, else bone local axis, else spanwise
        # flap surfaces and vertical (UP) for the rudder.
        if 'axis' in sd:
            axis = unit(sd['axis'])
        elif hinge_frame is not None:
            axis = unit(hinge_frame[1])
        else:
            axis = np.array([1.0, 0.0, 0.0]) if control != 'yaw' else np.array([0.0, 1.0, 0.0])

        # Hinge pivot (aircraft-local frame). Baked-geometry mods carry no useful
        # per-part transform, so derive it from the part geometry: the spanwise/
        # vertical centre at the hinge edge; trailing-edge controls (flaps,
        # ailerons, etc.) use max +Z; leading-edge slats use min +Z. `pivot` may
        # override it.
        if 'pivot' in sd:
            pivot_local = np.asarray(sd['pivot'], dtype=np.float64)
            translate = np.array([0.0, ground_offset_y, 0.0]) - pivot_local
        elif hinge_frame is not None:
            pivot_local = hinge_frame[0]
            translate = np.array([0.0, ground_offset_y, 0.0]) - pivot_local
        else:
            member_v = np.vstack([p['world_v'] for p in members])
            hinge_z = float(member_v[:, 2].min()) if control == 'slats' else float(member_v[:, 2].max())
            pivot_world = np.array([
                float(member_v[:, 0].mean()),
                float(member_v[:, 1].mean()),
                hinge_z,
            ])
            pivot_local = pivot_world + np.array([0.0, ground_offset_y, 0.0])
            translate = -pivot_world

        surf_path = f'{prefix}_surf_{role}.gltf'
        surf_keys = emit(members, translate, surf_path, bp(surf_path))
        if not surf_keys:
            print(f'WARNING: surface "{role}" produced no geometry; skipping.')
            continue
        surfaces_manifest.append({
            'role': role,
            'path': rel(surf_path),
            'pivot': [round(float(x), 4) for x in pivot_local],
            'axis': [round(float(x), 4) for x in axis],
            'control': control,
            'sign': sd.get('sign', 1),
            'rangeRad': sd.get('rangeRad', float(np.pi / 6)),
            **({'sweepParent': sd['sweepParent']} if sd.get('sweepParent') else {}),
        })
        print(f'Wrote {surf_path} (pivot={pivot_local.round(2).tolist()} axis={axis.round(2).tolist()})')

    # Flattened planform shadow in the same aircraft-local frame as the body.
    shadow_path = f'{prefix}_shadow.gltf'
    shadow_manifest = (rel(shadow_path)
                       if emit_shadow(visual_parts, ground_translate, shadow_path, bp(shadow_path))
                       else None)
    if shadow_manifest:
        print(f'Wrote {shadow_path}')

    def _points_from_groups(groups: dict) -> tuple[list, list]:
        """Reduce name->vertex-lists groups to (exit points, radii). Each group is
        one nozzle: lateral/vertical centre at the aft-most (exit) rim."""
        points, radii = [], []
        for verts_list in groups.values():
            v = np.vstack(verts_list)
            points.append([
                round(float(v[:, 0].mean()), 4),
                round(float(v[:, 1].mean()), 4),
                round(float(v[:, 2].min()), 4),  # aft-most rim = exhaust exit
            ])
            radii.append(0.5 * max(float(v[:, 0].max() - v[:, 0].min()),
                                   float(v[:, 1].max() - v[:, 1].min())))
        order = sorted(range(len(points)), key=lambda i: points[i][0])
        return [points[i] for i in order], [radii[i] for i in order]

    def _consolidate_nozzles(points: list, radii: list) -> tuple[list, list]:
        """Collapse spurious extra exhaust points into the real nozzle count.

        Twin-engine models often carry a center part between the two engines
        (e.g. 'EngineB', 'TailInner', a center 'NozzleInt' fairing). When exit
        points exist on BOTH sides of the centerline the plane is a twin, so any
        near-center point is that fairing -- not an engine -- and is dropped.
        Multiple points on the same side are averaged into one nozzle. Planes with
        only centered/one-sided points are left as single/asymmetric as found."""
        if len(points) <= 1:
            return points, radii
        tol = 0.35  # m: real twin nozzles sit well outside this; fairings within
        rad = list(radii) if radii else [None] * len(points)
        left = [(p, r) for p, r in zip(points, rad) if p[0] < -tol]
        right = [(p, r) for p, r in zip(points, rad) if p[0] > tol]
        center = [(p, r) for p, r in zip(points, rad) if abs(p[0]) <= tol]

        def _merge(group):
            ps = np.vstack([np.asarray(p, dtype=float) for p, _ in group])
            rs = [r for _, r in group if r is not None]
            pt = [round(float(x), 4) for x in ps.mean(axis=0)]
            return pt, (float(np.median(rs)) if rs else None)

        groups = ([left, right] if left and right
                  else [g for g in (left, center, right) if g])
        out_pts, out_rad = [], []
        for g in groups:
            pt, r = _merge(g)
            out_pts.append(pt)
            if r is not None:
                out_rad.append(r)
        return out_pts, out_rad

    def _derive_from_body(parts, translate) -> tuple[list, list]:
        """Fallback: estimate nozzle exits from the aft body slab when no engine
        part is named. Keeps the lower half by Y (drops the vertical fin) and
        splits into twin nozzles on a clear lateral gap."""
        if not parts:
            return [], []
        v = np.vstack([p['world_v'] for p in parts]) + translate
        zmin, zmax = float(v[:, 2].min()), float(v[:, 2].max())
        slab_depth = max(0.6, 0.08 * max(zmax - zmin, 1e-3))
        slab = v[v[:, 2] <= zmin + slab_depth]
        if len(slab) < 8:
            return [], []
        low = slab[slab[:, 1] <= float(np.median(slab[:, 1]))]
        if len(low) < 6:
            low = slab
        xs = np.sort(low[:, 0])
        xspan = float(xs[-1] - xs[0])
        clusters = [low]
        if len(xs) > 1 and xspan > 0.9:
            gaps = np.diff(xs)
            gi = int(np.argmax(gaps))
            gap = float(gaps[gi])
            split_x = 0.5 * (xs[gi] + xs[gi + 1])
            left, right = low[low[:, 0] <= split_x], low[low[:, 0] > split_x]
            if gap > 0.35 * xspan and gap > 0.4 and len(left) >= 4 and len(right) >= 4:
                clusters = [left, right]
        groups = {i: [c] for i, c in enumerate(clusters)}
        return _points_from_groups(groups)

    def _part_on_plane(p: dict) -> bool:
        if not include_materials or not matched_roots:
            return True
        tpid = p.get('tpid')
        if tpid is None:
            return True
        return _root_of(tpid) in matched_roots

    def _has_livery_submat(p: dict) -> bool:
        if not include_materials:
            return False
        for sm in p.get('sub_mats') or []:
            if sm and sm.get('name', '') in include_materials:
                return True
        return False

    def nozzle_exhaust_points(parts, translate) -> tuple[list, float | None, str | None]:
        """Afterburner exhaust-cone origins (+ representative radius) in the body's
        aircraft-local frame, so the sim can auto-place throttle-driven plumes.

        Priority: (1) real nozzle-interior meshes when reachable; (2) the plane's
        own engine/exhaust parts by name (robust for multi-plane bundles whose
        shared nozzle meshes are pooled under another root); (3) an aft-slab
        geometric estimate. Same frame as the emitted body (ground_translate)."""
        offset = [p.copy() for p in parts if _part_on_plane(p)]
        for p in offset:
            p['world_v'] = p['world_v'] + translate

        nozzle_groups: dict[str, list] = {}
        engine_livery: dict[str, list] = {}
        engine_other: dict[str, list] = {}
        for p in offset:
            sub_mats = p.get('sub_mats') or []
            if is_nozzle(p['name'], None) or any(is_nozzle(p['name'], sm) for sm in sub_mats):
                nozzle_groups.setdefault(p['name'], []).append(p['world_v'])
            elif is_engine_part(p['name'], tca):
                bucket = engine_livery if _has_livery_submat(p) else engine_other
                bucket.setdefault(p['name'], []).append(p['world_v'])

        for label, source in (
            ('nozzle-interior', nozzle_groups),
            ('engine-part', engine_livery),
            ('engine-part', engine_other),
        ):
            if source:
                points, radii = _points_from_groups(source)
                points, radii = _consolidate_nozzles(points, radii)
                if points:
                    radius = float(np.median(radii)) if radii else None
                    return points, radius, label

        scoped = [p for p in parts if _part_on_plane(p)]
        points, radii = _derive_from_body(scoped, translate)
        points, radii = _consolidate_nozzles(points, radii)
        radius = float(np.median(radii)) if radii else None
        if points:
            return points, radius, 'body-slab'
        return [], None, None

    def wingtip_trail_origins(parts, translate) -> tuple[list | None, str | None]:
        """Wingtip vortex trail origins: prefer named WingTip meshes, else hull extremes."""
        if not parts:
            return None, None
        offset = np.asarray(translate, dtype=np.float64)

        tip_parts = [p for p in parts if is_wingtip_part(p['name'], tca)]
        if tip_parts:
            left_cands: list[np.ndarray] = []
            right_cands: list[np.ndarray] = []
            for p in tip_parts:
                v = p['world_v'] + offset
                if len(v) == 0:
                    continue
                mean_x = float(v[:, 0].mean())
                if mean_x >= 0:
                    left_cands.append(v[int(np.argmax(v[:, 0]))])
                else:
                    right_cands.append(v[int(np.argmin(v[:, 0]))])
            if left_cands and right_cands:
                left = left_cands[int(np.argmax([c[0] for c in left_cands]))]
                right = right_cands[int(np.argmin([c[0] for c in right_cands]))]
                if float(left[0] - right[0]) >= 0.6:
                    return [
                        [round(float(left[0]), 4), round(float(left[1]), 4),
                         round(float(left[2]), 4)],
                        [round(float(right[0]), 4), round(float(right[1]), 4),
                         round(float(right[2]), 4)],
                    ], 'wingtip-part'

        v = np.vstack([p['world_v'] for p in parts]) + offset
        if len(v) < 8:
            return None, None
        zmin, zmax = float(v[:, 2].min()), float(v[:, 2].max())
        zrange = zmax - zmin
        if zrange >= 0.5:
            zlo = zmin + 0.05 * zrange
            zhi = zmin + 0.95 * zrange
            band = v[(v[:, 2] >= zlo) & (v[:, 2] <= zhi)]
            if len(band) >= 8:
                v = band
        ycut = float(np.percentile(v[:, 1], 75))
        low = v[v[:, 1] <= ycut]
        if len(low) >= 4:
            v = low
        li = int(np.argmax(v[:, 0]))
        ri = int(np.argmin(v[:, 0]))
        left = v[li]
        right = v[ri]
        if float(left[0] - right[0]) < 0.6:
            return None, None
        return [
            [round(float(left[0]), 4), round(float(left[1]), 4), round(float(left[2]), 4)],
            [round(float(right[0]), 4), round(float(right[1]), 4), round(float(right[2]), 4)],
        ], 'body-extreme'

    def trail_node_origins(translate) -> tuple[list | None, str | None]:
        """Wingtip trail origins from the mod's own `WingTrails` nodes (TrailL/TrailR).

        These sit on the real wingtips, unlike a hull-extreme guess -- which, on a
        swing-wing aircraft whose wings are split out of the body, would land on the
        fuselage. Spread-wing positions; the runtime carries them round the sweep.
        """
        names = load_aircraft2_wing_trails(bundle_path, aircraft2_hints)
        roots = {_root_of(p['tpid']) for p in visual_parts if p.get('tpid') is not None}
        tips: list[np.ndarray] = []
        for name in names:
            node = None
            for root_pid in roots or {None}:
                node = find_node_pid(bundle, name, root_pid)
                if node is not None and (root_pid is None
                                         or transform_root(node, bundle.transforms) == root_pid):
                    break
                node = None
            if node is not None:
                tips.append(_transform_origin(node) + np.asarray(translate, dtype=np.float64))
        if len(tips) < 2:
            return None, None
        left = max(tips, key=lambda t: float(t[0]))
        right = min(tips, key=lambda t: float(t[0]))
        if float(left[0] - right[0]) < 0.6:
            return None, None
        return [[round(float(c), 4) for c in left],
                [round(float(c), 4) for c in right]], 'wing-trail-nodes'

    attachments: list[dict] = []
    gt = np.asarray(ground_translate)
    for o in bundle.env.objects:
        if o.type.name != 'GameObject':
            continue
        go = o.read()
        name = go.m_Name
        if not is_attachment_empty(name, tca):
            continue
        tpid = None
        has_mesh = False
        for comp in go.m_Component:
            co = bundle.by_path.get(comp.component.path_id)
            if co is None:
                continue
            if co.type.name == 'Transform':
                tpid = comp.component.path_id
            elif co.type.name == 'MeshFilter':
                has_mesh = True
        if tpid is None or has_mesh:
            continue
        if include_materials and matched_roots and _root_of(tpid) not in matched_roots:
            if not _near_plane_bounds(tpid):
                continue
        pos = _transform_origin(tpid) + gt
        fwd = _transform_forward(tpid)
        attachments.append({
            'name': name,
            'position': [round(float(pos[i]), 4) for i in range(3)],
            'forward': [round(float(fwd[i]), 4) for i in range(3)],
        })
    if attachments:
        print(f'Attachment empties: {len(attachments)}')

    cockpit_offset = list(flyable.get('cockpitOffset', [0.0, 1.0, 4.0]))
    for att in attachments:
        ln = att['name'].lower()
        if any(tok in ln for tok in ('pilot', 'cockpitcam', 'cockpit_cam', 'viewpoint')):
            cockpit_offset = att['position']
            print(f'Cockpit offset from {att["name"]}: {cockpit_offset}')
            break

    fx = dict(flyable.get('fx') or {})
    if fx.get('nozzles') is None:
        auto_nozzles, auto_radius, nozzle_src = nozzle_exhaust_points(
            body_parts, np.asarray(ground_translate))
        if auto_nozzles:
            fx['nozzles'] = auto_nozzles
            if auto_radius is not None and fx.get('nozzleRadius') is None:
                fx['nozzleRadius'] = round(max(0.15, min(auto_radius, 1.5)), 4)
            print(f'Afterburner nozzles ({nozzle_src}): {auto_nozzles} '
                  f'(r={fx.get("nozzleRadius")})')
        else:
            fx.setdefault('nozzles', None)
    fx.setdefault('nozzles', None)
    fx.setdefault('nozzleRadius', None)
    if fx.get('wingtips') is None:
        auto_wingtips, wingtip_src = trail_node_origins(np.asarray(ground_translate))
        if not auto_wingtips:
            auto_wingtips, wingtip_src = wingtip_trail_origins(
                body_parts, np.asarray(ground_translate))
        if auto_wingtips:
            fx['wingtips'] = auto_wingtips
            print(f'Wingtip trails ({wingtip_src}): {auto_wingtips}')
        else:
            fx.setdefault('wingtips', None)

    flight = dict(cfg.get('flight') or {})
    ground_rest_height_m = ground_distance
    if ground_part_names and flight:
        gear_cfg = dict(flight.get('gear') or {})
        derived = derive_gear_points(
            visual_parts, ground_part_names, np.asarray(ground_translate),
            bottom_percentile=ground_contact_percentile,
        )
        if derived:
            gear_cfg['points'] = derived
            flight['gear'] = gear_cfg
            ground_rest_height_m = -min(p[1] for p in derived)
            print(f'Gear contact points: {derived}')

    # Emit the ramp static model before writing the manifest so a crashed or
    # empty static export cannot leave a dangling static path in the pack list.
    static_keys = emit(visual_parts, ground_translate, out, buffer_prefix)
    static_manifest = rel(out) if static_keys else None
    if static_keys:
        print(f'Wrote {out} ({len(static_keys)} colours)')

    collision_path = f'{prefix}_collision.gltf'
    collision_gltf = None
    collision_mesh = None
    if collision_parts:
        if emit_collision(collision_parts, ground_translate, collision_path, bp(collision_path)):
            collision_gltf = rel(collision_path)
            print(f'Wrote {collision_path} ({len(collision_parts)} collider part(s))')
        collision_mesh = bake_collision_mesh(collision_parts, ground_translate)
        if collision_mesh:
            n_tri = len(collision_mesh['triangles']) // 9
            print(f'Baked collision mesh: {n_tri} triangle(s)')

    manifest = {
        'id': cfg.get('id', stem),
        'name': cfg.get('displayName', cfg.get('name', stem)),
        'displayName': cfg.get('displayName', cfg.get('name', stem)),
        'canonicalName': cfg.get('canonicalName', cfg.get('name', stem)),
        'category': cfg.get('category'),
        'description': cfg.get('description'),
        'tags': cfg.get('tags', []),
        'sourceMod': cfg.get('sourceMod'),
        'sourceModId': cfg.get('sourceModId'),
        'sourceMaterial': cfg.get('sourceMaterial'),
        'importMeta': cfg.get('importMeta', {}),
        'body': rel(body_path),
        'shadow': shadow_manifest,
        'gear': gear_manifest,
        'gearAnimated': bool(gear_animated),
        'static': static_manifest,
        'collision': collision_gltf,
        'collisionMesh': collision_mesh,
        'surfaces': surfaces_manifest,
        'swingWings': swing_manifest,
        'fx': fx,
        'attachments': attachments or None,
        'cockpitOffset': cockpit_offset,
        'spawn': flyable.get('spawn', {}),
        'groundOffsetY': round(float(ground_offset_y), 4),
        'groundRestHeightM': round(float(ground_rest_height_m), 4),
        'flight': flight or None,
    }
    manifest_path = f'{prefix}.aircraft.json'
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
    print(f'Wrote {manifest_path}')

    print(f'Parts: {len(visual_parts)} visual + {len(collision_parts)} collision '
          f'(body {len(body_parts)}, gear {len(gear_parts)}, surfaces {len(surfaces_manifest)})')
    print(f'ground_min_y: {ground_min_y:.3f}, ground_offset_y: {ground_offset_y:.3f}')
    return 0


def _hex_to_factor(key: str):
    if key.startswith('#') and len(key) == 7:
        return [int(key[1:3], 16) / 255.0, int(key[3:5], 16) / 255.0,
                int(key[5:7], 16) / 255.0, 1.0]
    return [1.0, 1.0, 1.0, 1.0]


def _material_key_from_node_name(nm: str) -> str:
    """Recover the material token embedded in an exported node name.

    Node names are `0_{idx}_{key}` (body/surfaces/shadow) or
    `0_{part}_{key}` / `0_{part}_{i}_{key}` (animated gear). `key` may be a
    literal `#rrggbb` or a PaletteCategory that itself contains underscores
    (e.g. `VEHICLE_PLANE_GREY`, `FX_FIRE`) -- never take only the last `_`
    segment.
    """
    if not nm.startswith('0_'):
        return DEFAULT_MATERIAL
    # Literal colour wins when present.
    for seg in nm.split('_'):
        if len(seg) == 7 and seg[0] == '#':
            try:
                int(seg[1:], 16)
                return seg
            except ValueError:
                pass
    # Known PaletteCategory names (may contain underscores).
    for cat in (SHADOW_MATERIAL, FX_FIRE_MATERIAL, GLASS_CATEGORY, COLLISION_MATERIAL):
        if nm == cat or nm.endswith('_' + cat):
            return cat
    # Classic `0_{idx}_{key}` / `0_{part}_{key}`: everything after the second '_'.
    parts = nm.split('_', 2)
    if len(parts) >= 3 and parts[2]:
        return parts[2]
    return DEFAULT_MATERIAL


def _write_gltf(scene: trimesh.Scene, out: str, buffer_prefix: str, animations=None):
    export = scene.export(file_type='gltf')
    gltf = json.loads(export['model.gltf'].decode('utf-8'))

    mesh_key: dict[int, str] = {}
    for node in gltf.get('nodes', []):
        nm = node.get('name', '')
        if node.get('mesh') is not None and nm.startswith('0_'):
            mesh_key[node['mesh']] = _material_key_from_node_name(nm)

    material_index: dict[str, int] = {}
    mats: list[dict] = []
    for mi, mesh_def in enumerate(gltf.get('meshes', [])):
        key = mesh_key.get(mi, DEFAULT_MATERIAL)
        if key not in material_index:
            material_index[key] = len(mats)
            mats.append({'name': key,
                         'pbrMetallicRoughness': {'baseColorFactor': _hex_to_factor(key)}})
        for prim in mesh_def.get('primitives', []):
            prim['material'] = material_index[key]
    gltf['materials'] = mats

    # Flatten node hierarchy: every mesh is a direct scene root (like the F-22),
    # not wrapped under trimesh's 'world' parent node.
    flat_nodes = [{'name': n.get('name', ''), 'mesh': n['mesh']}
                  for n in gltf.get('nodes', []) if n.get('mesh') is not None]
    gltf['nodes'] = flat_nodes
    node_index = {n['name']: i for i, n in enumerate(flat_nodes)}

    # LOD scene 0 holds every mesh node; scenes 1..5 are empty LOD levels.
    gltf['scenes'][0]['name'] = '0'
    gltf['scenes'][0]['nodes'] = list(range(len(flat_nodes)))
    for lod in range(1, 6):
        gltf['scenes'].append({'name': str(lod), 'nodes': []})

    out_dir = os.path.dirname(out)
    os.makedirs(out_dir, exist_ok=True)

    # Pair each buffer with its own exporter key via the existing uri. Do NOT
    # sort keys lexicographically: trimesh emits gltf_buffer_10.bin etc, which
    # would sort before gltf_buffer_2.bin and scramble buffer contents.
    buffer_blobs: list[bytes] = []
    for i, buf in enumerate(gltf['buffers']):
        blob = export[buf['uri']]
        buffer_blobs.append(blob)
        buf['uri'] = f'{buffer_prefix}{i}.bin'

    # Bake per-node TRS clips (LODHelper expects "{nodeName}Action").
    if animations:
        anim_blob = bytearray()
        accessors = gltf.setdefault('accessors', [])
        buffer_views = gltf.setdefault('bufferViews', [])
        gltf_anims = []
        buf_index = len(buffer_blobs)

        def _append(arr: np.ndarray, type_name: str) -> int:
            data = np.asarray(arr, dtype=np.float32).reshape(-1)
            raw = data.tobytes()
            # Align to 4 bytes.
            while len(anim_blob) % 4:
                anim_blob.append(0)
            offset = len(anim_blob)
            anim_blob.extend(raw)
            bv_i = len(buffer_views)
            buffer_views.append({
                'buffer': buf_index,
                'byteOffset': offset,
                'byteLength': len(raw),
            })
            count = int(np.asarray(arr).reshape(-1, {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[type_name]).shape[0])
            shaped = np.asarray(arr, dtype=np.float32).reshape(count, -1)
            acc = {
                'bufferView': bv_i,
                'componentType': 5126,
                'count': count,
                'type': type_name,
                'min': [float(x) for x in shaped.min(axis=0)],
                'max': [float(x) for x in shaped.max(axis=0)],
            }
            accessors.append(acc)
            return len(accessors) - 1

        for anim in animations:
            node_i = node_index.get(anim['node'])
            if node_i is None:
                continue
            times = np.asarray(anim['times'], dtype=np.float32)
            # Ensure strictly increasing times for samplers.
            if len(times) >= 2:
                for i in range(1, len(times)):
                    if times[i] <= times[i - 1]:
                        times[i] = times[i - 1] + 1e-4
            t_acc = _append(times, 'SCALAR')
            channels = []
            samplers = []

            def _channel(path, values, type_name):
                o_acc = _append(np.asarray(values, dtype=np.float32), type_name)
                si = len(samplers)
                samplers.append({'input': t_acc, 'output': o_acc, 'interpolation': 'LINEAR'})
                channels.append({'sampler': si, 'target': {'node': node_i, 'path': path}})

            _channel('translation', anim['translations'], 'VEC3')
            _channel('rotation', anim['rotations'], 'VEC4')
            _channel('scale', anim['scales'], 'VEC3')
            gltf_anims.append({'name': anim['name'], 'channels': channels, 'samplers': samplers})

        if gltf_anims:
            gltf['animations'] = gltf_anims
            buffer_blobs.append(bytes(anim_blob))
            gltf.setdefault('buffers', []).append({
                'byteLength': len(anim_blob),
                'uri': f'{buffer_prefix}{buf_index}.bin',
            })

    for i, blob in enumerate(buffer_blobs):
        with open(os.path.join(out_dir, f'{buffer_prefix}{i}.bin'), 'wb') as f:
            f.write(blob)

    # Defensive guard: glTF is JSON, and browsers reject the non-standard `NaN`
    # /`Infinity` literals that Python's json.dump emits. Scrub any non-finite
    # accessor bounds (they are only hints) so a stray degenerate value can never
    # again produce a file that parses in Python but fails in the browser.
    for acc in gltf.get('accessors', []):
        for bound in ('min', 'max'):
            vals = acc.get(bound)
            if vals is not None and any(not math.isfinite(x) for x in vals):
                acc[bound] = [0.0 if not math.isfinite(x) else x for x in vals]

    with open(out, 'w', encoding='utf-8') as f:
        json.dump(gltf, f, indent=2, allow_nan=False)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def load_config(path: str) -> dict:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def import_batch(batch_path: str) -> int:
    """Import multiple aircraft configs in one process, loading each bundle once."""
    with open(batch_path, encoding='utf-8') as f:
        data = json.load(f)
    configs = data if isinstance(data, list) else data.get('configs', [])
    if not configs:
        raise SystemExit('batch file has no configs')

    bundles: dict[str, Bundle] = {}
    rc = 0
    for i, cfg in enumerate(configs):
        bundle_path = cfg.get('bundle')
        if not bundle_path:
            print(f'ERROR: config[{i}] missing bundle', file=sys.stderr)
            rc = 1
            continue
        label = cfg.get('displayName') or cfg.get('name') or cfg.get('id') or str(i + 1)
        print(f'Importing {i + 1}/{len(configs)}: {label}', file=sys.stderr, flush=True)
        key = os.path.abspath(bundle_path)
        if key not in bundles:
            print(f'Loading bundle ({len(bundles) + 1}) from {os.path.basename(bundle_path)}',
                  file=sys.stderr)
            bundles[key] = Bundle(bundle_path)
        try:
            import_mod(cfg, bundle=bundles[key])
        except SystemExit as exc:
            print(f'ERROR importing config[{i}]: {exc}', file=sys.stderr)
            rc = 1
    return rc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Import a Unity asset-bundle mod into a retroflightsim glTF.')
    ap.add_argument('--config', help='JSON config file (see tools/mods/mod.json).')
    ap.add_argument('--batch', help='JSON file with a "configs" array for multi-plane import.')
    ap.add_argument('--bundle', help='Path to a mod .zip, a Unity asset bundle file, or a folder.')
    ap.add_argument('--out', help='Output .gltf path (relative to project root).')
    ap.add_argument('--ground', type=float, help='Distance from origin to ground (default 2.0).')
    ap.add_argument('--scale', type=float, help='Uniform scale applied to geometry.')
    ap.add_argument('--rotate', help='XYZ Euler rotation in degrees, e.g. "0,180,0", to reorient the model.')
    ap.add_argument('--swatch-max', type=int, help='Max texture size (px) treated as a palette swatch.')
    ap.add_argument('--list', action='store_true', help='List textures/materials/objects and exit.')
    ap.add_argument('--discover', action='store_true',
                    help='List distinct aircraft liveries (JSON) and exit.')
    args = ap.parse_args(argv)

    if args.batch:
        return import_batch(args.batch)

    cfg: dict = load_config(args.config) if args.config else {}
    if args.bundle:
        cfg['bundle'] = args.bundle
    if args.out:
        cfg['out'] = args.out
    if args.ground is not None:
        cfg['groundDistance'] = args.ground
    if args.scale is not None:
        cfg['scale'] = args.scale
    if args.rotate is not None:
        cfg['rotationEuler'] = [float(x) for x in args.rotate.split(',')]
    if args.swatch_max is not None:
        cfg['swatchMax'] = args.swatch_max

    if 'bundle' not in cfg:
        ap.error('a bundle is required (via --bundle or --config)')

    if args.discover:
        print(json.dumps(discover_livery_materials(cfg['bundle']), indent=2))
        return 0

    if args.list:
        list_bundle(Bundle(cfg['bundle']))
        return 0

    if 'out' not in cfg:
        ap.error('an output path is required (via --out or --config)')

    return import_mod(cfg)


if __name__ == '__main__':
    raise SystemExit(main())
