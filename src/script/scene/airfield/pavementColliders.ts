/**
 * The aprons, taxiways and steel decks of an airfield as solid ground.
 *
 * They are drawn AIRFIELD_SURFACE_EPS_M above the ground they are draped on,
 * like the runways - but only the runways were solid, so an aircraft that
 * rolled off one sank 1.5 m into the pavement around it (Saki's NITKA deck
 * and the apron round it). These are the drawn triangles themselves, so the
 * solid surface is the one on screen.
 *
 * Two things the bare triangles lack. An edge: the pavement stands 1.5 m off
 * the ground, and a hull meeting that lip from the grass is an impact, so
 * every outer edge gets a skirt sloping down to the ground over
 * PAVEMENT_SKIRT_M, as the runway pads have. And an index: mesh colliders are
 * sampled triangle by triangle, and a field's taxiway network is thousands of
 * them, so they are split into PAVEMENT_CELL_M cells, each a collider whose
 * box is tested before any of its triangles.
 */
import { CarrierMeshCollider } from '../entities/carrierDeck';

/** Run of the skirt from the pavement's edge down to the ground (m). */
export const PAVEMENT_SKIRT_M = 15;
/** Side of the cells the triangles are filed in (m). */
const PAVEMENT_CELL_M = 100;

/**
 * Colliders for a soup of drawn pavement triangles (9 numbers each, relative
 * to `origin`), lifted `liftM` above the ground they were draped on.
 */
export function pavementColliders(
    triangles: readonly number[],
    origin: { x: number; y: number; z: number },
    liftM: number,
): CarrierMeshCollider[] {
    const soup = [...triangles, ...skirts(triangles, liftM)];
    const cells = new Map<string, number[]>();
    for (let i = 0; i + 8 < soup.length; i += 9) {
        const cx = (soup[i] + soup[i + 3] + soup[i + 6]) / 3;
        const cz = (soup[i + 2] + soup[i + 5] + soup[i + 8]) / 3;
        const key = `${Math.floor(cx / PAVEMENT_CELL_M)},${Math.floor(cz / PAVEMENT_CELL_M)}`;
        let cell = cells.get(key);
        if (cell === undefined) {
            cell = [];
            cells.set(key, cell);
        }
        for (let k = 0; k < 9; k++) {
            cell.push(soup[i + k]);
        }
    }
    const out: CarrierMeshCollider[] = [];
    for (const tris of cells.values()) {
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < tris.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], tris[i + k]);
                max[k] = Math.max(max[k], tris[i + k]);
            }
        }
        out.push({ originX: origin.x, originY: origin.y, originZ: origin.z, triangles: tris, aabb: { min, max } });
    }
    return out;
}

/**
 * A sloped quad outward from every edge no other triangle shares, from the
 * pavement down `liftM` to the ground. Where pieces of pavement overlap
 * without sharing an edge, a skirt runs under the neighbouring pavement;
 * the higher surface is the one sampled, so it is never felt there.
 */
function skirts(triangles: readonly number[], liftM: number): number[] {
    const key = (x: number, z: number) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
    const edgeCount = new Map<string, number>();
    const edgeKey = (ax: number, az: number, bx: number, bz: number) => {
        const a = key(ax, az);
        const b = key(bx, bz);
        return a < b ? `${a}|${b}` : `${b}|${a}`;
    };
    for (let i = 0; i + 8 < triangles.length; i += 9) {
        for (let e = 0; e < 3; e++) {
            const p = i + e * 3;
            const q = i + ((e + 1) % 3) * 3;
            const k = edgeKey(triangles[p], triangles[p + 2], triangles[q], triangles[q + 2]);
            edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
        }
    }
    const out: number[] = [];
    for (let i = 0; i + 8 < triangles.length; i += 9) {
        for (let e = 0; e < 3; e++) {
            const p = i + e * 3;
            const q = i + ((e + 1) % 3) * 3;
            const r = i + ((e + 2) % 3) * 3;
            const ax = triangles[p], ay = triangles[p + 1], az = triangles[p + 2];
            const bx = triangles[q], by = triangles[q + 1], bz = triangles[q + 2];
            if (edgeCount.get(edgeKey(ax, az, bx, bz)) !== 1) {
                continue;
            }
            const dx = bx - ax;
            const dz = bz - az;
            const len = Math.hypot(dx, dz);
            if (len < 1e-3) {
                continue;
            }
            // Outward: away from the triangle's third corner.
            let nx = -dz / len;
            let nz = dx / len;
            if ((triangles[r] - ax) * nx + (triangles[r + 2] - az) * nz > 0) {
                nx = -nx;
                nz = -nz;
            }
            const ox = nx * PAVEMENT_SKIRT_M;
            const oz = nz * PAVEMENT_SKIRT_M;
            out.push(
                ax, ay, az, bx, by, bz, bx + ox, by - liftM, bz + oz,
                ax, ay, az, bx + ox, by - liftM, bz + oz, ax + ox, ay - liftM, az + oz,
            );
        }
    }
    return out;
}
