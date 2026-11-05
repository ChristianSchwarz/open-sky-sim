/**
 * The Kuznetsov's deck as a surface to lay things on: the upward-facing
 * triangles of the hull mesh at deck height and the ski-jump ramp, in
 * carrier-local metres. The deck is not flat (Y 13.0–14.5 over the landing
 * area, a few big triangles, and the ramp rising to ~21 m at the lip), so
 * paint is clipped against each triangle and laid on its plane, and lights
 * are set on its height.
 */

/** Below this normal Y a face is a wall, not deck (the ramp is ~14°, cos 0.97). */
const DECK_MIN_NORMAL_Y = 0.75;
/** Deck faces sit above this carrier-local Y (the hull below is not walked on). */
const DECK_MIN_Y = 11;
/** Aft of the ramp, faces above this are the island's roofs, not deck. */
const DECK_MAX_Y = 16.5;
/** The ramp starts forward of this carrier-local Z; there the deck may rise. */
const RAMP_START_Z = -90;

/** One deck triangle in XZ with its plane y = a·x + b·z + c. */
interface DeckTri {
    ax: number; az: number; bx: number; bz: number; cx: number; cz: number;
    /** +1 when a→b→c turns counter-clockwise in (x, z), else −1. */
    wind: number;
    pa: number; pb: number; pc: number;
    minX: number; maxX: number; minZ: number; maxZ: number;
}

export class CarrierDeckSurface {
    private readonly tris: DeckTri[] = [];

    /** `triangles`: carrier-local soup, 9 floats per triangle (the hull's collision bake). */
    constructor(triangles: ArrayLike<number>) {
        for (let i = 0; i + 8 < triangles.length; i += 9) {
            const ax = triangles[i], ay = triangles[i + 1], az = triangles[i + 2];
            const bx = triangles[i + 3], by = triangles[i + 4], bz = triangles[i + 5];
            const cx = triangles[i + 6], cy = triangles[i + 7], cz = triangles[i + 8];
            // Normal = (b − a) × (c − a); keep faces whose |normal.y| is high, either winding.
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const len = Math.hypot(nx, ny, nz);
            if (len < 1e-9 || Math.abs(ny) / len < DECK_MIN_NORMAL_Y) continue;
            const my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
            if (my < DECK_MIN_Y || (my > DECK_MAX_Y && mz > RAMP_START_Z)) continue;
            // Plane: nx(x − ax) + ny(y − ay) + nz(z − az) = 0.
            const pa = -nx / ny, pb = -nz / ny, pc = ay + (nx * ax + nz * az) / ny;
            // Signed area in (x, z).
            const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
            if (Math.abs(area) < 1e-9) continue;
            this.tris.push({
                ax, az, bx, bz, cx, cz, wind: area > 0 ? 1 : -1, pa, pb, pc,
                minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
                minZ: Math.min(az, bz, cz), maxZ: Math.max(az, bz, cz),
            });
        }
    }

    get triangleCount(): number {
        return this.tris.length;
    }

    /** Deck height at (x, z), carrier-local; NaN where there is no deck. The highest face wins. */
    heightAt(x: number, z: number): number {
        let best = NaN;
        for (const t of this.tris) {
            if (x < t.minX - 1e-6 || x > t.maxX + 1e-6 || z < t.minZ - 1e-6 || z > t.maxZ + 1e-6) continue;
            if (!inside(t, x, z)) continue;
            const y = t.pa * x + t.pb * z + t.pc;
            if (!(y <= best)) best = y;
        }
        return best;
    }

    /**
     * Lay XZ triangles (x, z per corner) on the deck, `lift` above it: each is
     * clipped to every deck face under it and given that face's height. Returns
     * an xyz soup; whatever lies off the deck is dropped.
     */
    drape(xz: ArrayLike<number>, lift: number): number[] {
        const out: number[] = [];
        let poly: number[] = [];
        let next: number[] = [];
        for (let i = 0; i + 5 < xz.length; i += 6) {
            const x0 = xz[i], z0 = xz[i + 1], x1 = xz[i + 2], z1 = xz[i + 3], x2 = xz[i + 4], z2 = xz[i + 5];
            const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2);
            const minZ = Math.min(z0, z1, z2), maxZ = Math.max(z0, z1, z2);
            for (const t of this.tris) {
                if (maxX < t.minX || minX > t.maxX || maxZ < t.minZ || minZ > t.maxZ) continue;
                poly = [x0, z0, x1, z1, x2, z2];
                const edges = t.wind > 0
                    ? [t.ax, t.az, t.bx, t.bz, t.bx, t.bz, t.cx, t.cz, t.cx, t.cz, t.ax, t.az]
                    : [t.ax, t.az, t.cx, t.cz, t.cx, t.cz, t.bx, t.bz, t.bx, t.bz, t.ax, t.az];
                for (let e = 0; e < 12 && poly.length >= 6; e += 4) {
                    next = clipHalfPlane(poly, edges[e], edges[e + 1], edges[e + 2], edges[e + 3], next);
                    [poly, next] = [next, poly];
                }
                if (poly.length < 6) continue;
                // Fan, keeping the marking's own winding.
                for (let k = 2; k * 2 + 1 < poly.length; k++) {
                    for (const j of [0, k - 1, k]) {
                        const x = poly[j * 2], z = poly[j * 2 + 1];
                        out.push(x, t.pa * x + t.pb * z + t.pc + lift, z);
                    }
                }
            }
        }
        return out;
    }
}

function inside(t: DeckTri, x: number, z: number): boolean {
    const s = t.wind;
    const e0 = ((t.bx - t.ax) * (z - t.az) - (t.bz - t.az) * (x - t.ax)) * s;
    const e1 = ((t.cx - t.bx) * (z - t.bz) - (t.cz - t.bz) * (x - t.bx)) * s;
    const e2 = ((t.ax - t.cx) * (z - t.cz) - (t.az - t.cz) * (x - t.cx)) * s;
    return e0 >= -1e-9 && e1 >= -1e-9 && e2 >= -1e-9;
}

/**
 * Sutherland–Hodgman against the half-plane left of a→b (counter-clockwise
 * inside, in (x, z) with the cross product's sign as in {@link inside}).
 */
function clipHalfPlane(
    poly: number[], ax: number, az: number, bx: number, bz: number, out: number[],
): number[] {
    out.length = 0;
    const n = poly.length / 2;
    const side = (x: number, z: number) => (bx - ax) * (z - az) - (bz - az) * (x - ax);
    for (let i = 0; i < n; i++) {
        const px = poly[i * 2], pz = poly[i * 2 + 1];
        const qx = poly[((i + 1) % n) * 2], qz = poly[((i + 1) % n) * 2 + 1];
        const sp = side(px, pz), sq = side(qx, qz);
        if (sp >= 0) out.push(px, pz);
        if ((sp >= 0) !== (sq >= 0)) {
            const t = sp / (sp - sq);
            out.push(px + (qx - px) * t, pz + (qz - pz) * t);
        }
    }
    return out;
}
