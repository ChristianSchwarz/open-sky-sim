/**
 * The four drawn airframes the webbing solver is tested against, baked from
 * the running game with `PlayerEntity.bakeDrawnAirframe()` (on the deck,
 * gear down, the F-14's wings forward) and stored as gzipped little-endian
 * float32 triangle soups in the body frame (+Z forward). Node-only, so it is
 * named as a test file (outside the app's typecheck); it holds no tests itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { buildTriangleBvh, TriangleBvh } from '../collision/triangleBvh';
import { buildWebCollider, closeGearGaps, WebCollider } from './webCollider';
import { decimateSoup } from './webDecimate';

export const WEB_FIXTURES = ['f22', 'f16a', 'f16xl', 'f14a'] as const;
export type WebFixture = typeof WEB_FIXTURES[number];

export interface WebAirframe {
    readonly name: WebFixture;
    readonly triangles: Float32Array;
    readonly bvh: TriangleBvh;
    /** Body-frame bounds [minX, minY, minZ, maxX, maxY, maxZ]. */
    readonly bounds: Float32Array;
    /** What the webbing collides with. */
    readonly collider: WebCollider;
    /** The collision mesh it was built from: the drawn soup decimated to {@link COLLIDER_TRIS}. */
    readonly collisionTriangles: Float32Array;
}

/**
 * Triangles in each collision mesh. The F-22 is drawn with fewer and is used
 * as is. The F-14 is drawn in more separate parts than the others, and at
 * 3k its decimated skin lay up to 19 cm (p99 7 cm) inside the drawn one, far
 * enough that straps held off it cut the drawn wings; at 6k it is within
 * 8 cm (p99 2.6 cm), as the F-16s are at 3k.
 */
export const COLLIDER_TRIS: Record<WebFixture, number> = { f22: 3000, f16a: 3000, f16xl: 3000, f14a: 6000 };

const cache = new Map<WebFixture, WebAirframe>();

export function loadWebAirframe(name: WebFixture): WebAirframe {
    const hit = cache.get(name);
    if (hit) return hit;
    // Relative to the repo root, where the tests run (as the other fixture-reading tests do).
    const file = path.join('src', 'script', 'physics', 'barricade', 'fixtures', `${name}.f32.gz`);
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    // Copied out: a view straight onto the buffer need not be 4-byte aligned.
    const triangles = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const bvh = buildTriangleBvh(triangles);
    const collisionTriangles = decimateSoup(closeGearGaps(triangles), COLLIDER_TRIS[name]);
    const out = { name, triangles, bvh, bounds: bvh.bounds, collider: buildWebCollider(collisionTriangles), collisionTriangles };
    cache.set(name, out);
    return out;
}
