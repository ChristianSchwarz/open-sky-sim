"""Pack flyable aircraft mods into single .aircraft.pack files for dist."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = PROJECT_ROOT / 'assets'
IMPORTS_DIR = PROJECT_ROOT / 'tools' / 'mods' / 'imports'
DIST_ASSETS = PROJECT_ROOT / 'dist' / 'assets'


def pack_relative(path: str) -> str:
    p = path.replace('\\', '/')
    if p.startswith('assets/'):
        return p[len('assets/'):]
    if p.startswith('tools/mods/imports/'):
        return p[len('tools/mods/imports/'):]
    return os.path.basename(p)


def resolve_gltf_uri(gltf_rel: str, uri: str) -> str | None:
    if uri.startswith('data:'):
        return None
    base_dir = os.path.dirname(gltf_rel)
    if base_dir:
        return os.path.normpath(os.path.join(base_dir, uri)).replace('\\', '/')
    return uri


def gltf_buffer_uris(gltf_rel: str, gltf_path: Path) -> list[str]:
    with open(gltf_path, encoding='utf-8') as f:
        gltf = json.load(f)
    uris: list[str] = []
    for buf in gltf.get('buffers', []):
        uri = buf.get('uri')
        if uri:
            resolved = resolve_gltf_uri(gltf_rel, uri)
            if resolved:
                uris.append(resolved)
    return uris


def collect_manifest_paths(manifest: dict) -> tuple[list[str], set[str]]:
    """Return (required_or_listed paths, optional paths that may be absent).

    Ramp `static` models are optional: some imports write a manifest before the
    static glTF is emitted, or the static emit can be empty. Packing must not
    fail the whole build over a missing static.
    """
    paths: list[str] = [manifest['body']]
    optional: set[str] = set()
    if manifest.get('shadow'):
        paths.append(manifest['shadow'])
    if manifest.get('gear'):
        paths.append(manifest['gear'])
    if manifest.get('collision'):
        paths.append(manifest['collision'])
    if manifest.get('static'):
        paths.append(manifest['static'])
        optional.add(pack_relative(manifest['static']))
    for surface in manifest.get('surfaces', []):
        paths.append(surface['path'])
    return paths, optional


def collect_files(manifest_path: Path) -> tuple[set[str], dict, str]:
    base_dir = manifest_path.parent
    mod_id = manifest_path.name[:-len('.aircraft.json')]
    with open(manifest_path, encoding='utf-8') as f:
        manifest = json.load(f)

    files: set[str] = set()
    listed, optional = collect_manifest_paths(manifest)
    pending = [pack_relative(p) for p in listed]

    static_gltf = f'{mod_id}_static.gltf'
    if (base_dir / static_gltf).exists() and static_gltf not in pending:
        pending.append(static_gltf)
        optional.add(static_gltf)

    while pending:
        rel = pending.pop()
        if rel in files:
            continue
        asset_path = base_dir / rel
        if not asset_path.exists():
            if rel in optional or rel.endswith('_static.gltf'):
                print(f'WARNING: missing optional asset for {manifest_path.name}: {rel}; skipping')
                continue
            raise FileNotFoundError(f'Missing asset for {manifest_path.name}: {rel}')
        files.add(rel)
        if rel.endswith('.gltf'):
            for buf_rel in gltf_buffer_uris(rel, asset_path):
                if buf_rel not in files:
                    pending.append(buf_rel)

    return files, manifest, mod_id


def rewrite_manifest(manifest: dict, mod_id: str, files: set[str]) -> dict:
    out = dict(manifest)
    out['body'] = pack_relative(manifest['body'])
    out['shadow'] = pack_relative(manifest['shadow']) if manifest.get('shadow') else None
    if manifest.get('gear') and pack_relative(manifest['gear']) in files:
        out['gear'] = pack_relative(manifest['gear'])
    else:
        out['gear'] = None
    if manifest.get('collision') and pack_relative(manifest['collision']) in files:
        out['collision'] = pack_relative(manifest['collision'])
    else:
        out['collision'] = None
    static_rel = f'{mod_id}_static.gltf'
    if static_rel in files:
        out['static'] = static_rel
    elif manifest.get('static') and pack_relative(manifest['static']) in files:
        out['static'] = pack_relative(manifest['static'])
    else:
        out['static'] = None
    out['surfaces'] = [
        {**surface, 'path': pack_relative(surface['path'])}
        for surface in manifest.get('surfaces', [])
        if pack_relative(surface['path']) in files
    ]
    return out


def compute_input_hash(manifest_path: Path, files: set[str], base_dir: Path) -> str:
    """Compute a hash of all input files to detect changes."""
    hasher = hashlib.sha256()
    hasher.update(manifest_path.read_bytes())
    for rel in sorted(files):
        file_path = base_dir / rel
        if file_path.exists():
            hasher.update(file_path.read_bytes())
    return hasher.hexdigest()


def should_rebuild_pack(mod_id: str, manifest_path: Path, files: set[str], base_dir: Path) -> bool:
    """Check if the pack needs rebuilding by comparing input hash."""
    pack_path = DIST_ASSETS / f'{mod_id}.aircraft.pack'
    if not pack_path.exists():
        return True

    current_hash = compute_input_hash(manifest_path, files, base_dir)
    hash_file = DIST_ASSETS / f'{mod_id}.aircraft.pack.hash'

    if hash_file.exists():
        try:
            prev_hash = hash_file.read_text().strip()
            if prev_hash == current_hash:
                return False
        except Exception:
            pass

    return True


def save_input_hash(mod_id: str, manifest_path: Path, files: set[str], base_dir: Path) -> None:
    """Save the input hash for future comparison."""
    current_hash = compute_input_hash(manifest_path, files, base_dir)
    hash_file = DIST_ASSETS / f'{mod_id}.aircraft.pack.hash'
    hash_file.write_text(current_hash)


def cleanup_loose_mod_files(mod_id: str) -> None:
    if not DIST_ASSETS.exists():
        return
    for path in DIST_ASSETS.iterdir():
        name = path.name
        if not path.is_file():
            continue
        if name == f'{mod_id}.aircraft.pack':
            continue
        if name == f'{mod_id}.aircraft.pack.hash':
            continue
        if name == f'{mod_id}.aircraft.json' or name.startswith(f'{mod_id}_'):
            path.unlink()


def pack_mod(manifest_path: Path) -> bool:
    """Pack a mod and return True if rebuilt, False if skipped."""
    base_dir = manifest_path.parent
    files, manifest, mod_id = collect_files(manifest_path)

    if not should_rebuild_pack(mod_id, manifest_path, files, base_dir):
        print(f'Skipped {mod_id} (no changes)')
        return False

    pack_manifest = rewrite_manifest(manifest, mod_id, files)

    DIST_ASSETS.mkdir(parents=True, exist_ok=True)
    out_path = DIST_ASSETS / f'{mod_id}.aircraft.pack'

    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('manifest.json', json.dumps(pack_manifest, indent=2))
        for rel in sorted(files):
            zf.write(base_dir / rel, rel)

    size = out_path.stat().st_size
    cleanup_loose_mod_files(mod_id)
    save_input_hash(mod_id, manifest_path, files, base_dir)
    print(f'Wrote {out_path} ({len(files) + 1} entries, {size:,} bytes)')
    return True


def find_manifests() -> list[Path]:
    manifests: list[Path] = []
    if ASSETS_DIR.exists():
        manifests.extend(sorted(ASSETS_DIR.glob('*.aircraft.json')))
    if IMPORTS_DIR.exists():
        manifests.extend(sorted(IMPORTS_DIR.glob('*.aircraft.json')))
    return manifests


def main() -> int:
    ap = argparse.ArgumentParser(description='Pack flyable aircraft mods for dist.')
    ap.add_argument('--imports-only', action='store_true',
                    help='Only pack manifests under tools/mods/imports/.')
    ap.add_argument('--only', nargs='*', metavar='MOD_ID',
                    help='Only pack manifests with these mod ids.')
    args = ap.parse_args()

    if args.imports_only:
        manifests = sorted(IMPORTS_DIR.glob('*.aircraft.json')) if IMPORTS_DIR.exists() else []
    else:
        manifests = find_manifests()

    if args.only:
        only = set(args.only)
        manifests = [
            manifest_path for manifest_path in manifests
            if manifest_path.name[:-len('.aircraft.json')] in only
        ]

    if not manifests:
        print('No aircraft manifests found')
        return 0

    rebuilt = 0
    skipped = 0
    for manifest_path in manifests:
        if pack_mod(manifest_path):
            rebuilt += 1
        else:
            skipped += 1

    if rebuilt > 0 or skipped > 0:
        print(f'Summary: rebuilt {rebuilt}, skipped {skipped}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
