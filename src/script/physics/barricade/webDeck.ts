/**
 * The carrier's deck under the barricade webbing, in the barricade's frame
 * (carrier-local, as the web is stepped): the height the aircraft's gear
 * meets, from the carrier's mesh, not a flat plane. The deck is not flat:
 * on this Kuznetsov it stood 0.22-0.31 m above BARRICADE_DECK_Y at the
 * barricade and rose another 0.15 m toward the bow over the run-out, so a
 * net floored on the plane lay under the drawn deck.
 *
 * Sampled from a world-height function (the sim's carrierHeightAt, the
 * game's sampleCarrierMeshSurfaceYMax: a scan of the mesh's triangles, tens
 * of microseconds a sample) on a DECK_CELL_M grid, each cell once, then
 * interpolated. The ship moves the mesh and the barricade together, so a
 * cell keeps its height. Surfaces more than DECK_BAND_UP_M above the deck at
 * the barricade (the island's roof) are not deck: those cells keep that
 * reference height. Where there is no surface at all (over the side) there
 * is no floor.
 */
import * as THREE from 'three';
import { BARRICADE_DECK_Y, BARRICADE_LOCAL_Z, BARRICADE_MID_X } from '../../scene/entities/barricadeSpec';

/** Grid spacing (m), and the region covered (carrier-local, m): the span and the run-out. */
const DECK_CELL_M = 1;
const DECK_X0 = BARRICADE_MID_X - 40, DECK_X1 = BARRICADE_MID_X + 40;
const DECK_Z0 = BARRICADE_LOCAL_Z - 160, DECK_Z1 = BARRICADE_LOCAL_Z + 30;
/** A surface this far above the deck at the barricade is structure, not deck (m). */
const DECK_BAND_UP_M = 1;
/** Below this, no floor (over the side, m below the reference). */
const NO_FLOOR = -1e9;

/** World height under (x, z), or 0 / NaN where there is no surface. */
export type WorldHeight = (worldX: number, worldZ: number) => number;

/** The barricade's frame: carrier-local to world. */
export interface DeckFrame {
    readonly origin: THREE.Vector3;
    readonly quaternion: THREE.Quaternion;
}

export class WebDeck {
    private readonly nx = Math.round((DECK_X1 - DECK_X0) / DECK_CELL_M) + 1;
    private readonly nz = Math.round((DECK_Z1 - DECK_Z0) / DECK_CELL_M) + 1;
    /** Carrier-local deck height per grid point; NaN not yet sampled. */
    private readonly h = new Float32Array(this.nx * this.nz).fill(NaN);
    private next = 0;
    private readonly p = new THREE.Vector3();
    /** The deck's height at the barricade line's middle (carrier-local m). */
    readonly reference: number;

    constructor(private readonly height: WorldHeight, private readonly frame: () => DeckFrame) {
        this.reference = this.rawAt(BARRICADE_MID_X, BARRICADE_LOCAL_Z) ?? BARRICADE_DECK_Y;
    }

    /** The deck's carrier-local height at (x, z), interpolated; very low where there is none. */
    heightAt(x: number, z: number): number {
        const fx = (x - DECK_X0) / DECK_CELL_M, fz = (z - DECK_Z0) / DECK_CELL_M;
        if (fx < 0 || fz < 0 || fx > this.nx - 1 || fz > this.nz - 1) return this.reference;
        const i = Math.min(this.nx - 2, Math.floor(fx)), j = Math.min(this.nz - 2, Math.floor(fz));
        const tx = fx - i, tz = fz - j;
        const a = this.cell(i, j), b = this.cell(i + 1, j), c = this.cell(i, j + 1), d = this.cell(i + 1, j + 1);
        // Next to the edge (a cell with no deck) the nearest corner, not a blend down the side.
        if (a <= NO_FLOOR || b <= NO_FLOOR || c <= NO_FLOOR || d <= NO_FLOOR) {
            return (tx < 0.5 ? (tz < 0.5 ? a : c) : (tz < 0.5 ? b : d));
        }
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    }

    /** Sample up to `cells` more of the grid ahead of need (idle frames); true once all are. */
    fill(cells: number): boolean {
        const n = this.h.length;
        while (cells > 0 && this.next < n) {
            if (Number.isNaN(this.h[this.next])) {
                this.sample(this.next);
                cells--;
            }
            this.next++;
        }
        return this.next >= n;
    }

    private cell(i: number, j: number): number {
        const k = j * this.nx + i;
        const v = this.h[k];
        return Number.isNaN(v) ? this.sample(k) : v;
    }

    private sample(k: number): number {
        const i = k % this.nx, j = Math.floor(k / this.nx);
        const y = this.rawAt(DECK_X0 + i * DECK_CELL_M, DECK_Z0 + j * DECK_CELL_M);
        const ref = this.reference;
        const v = y === undefined ? NO_FLOOR : y > ref + DECK_BAND_UP_M ? ref : y;
        this.h[k] = v;
        return v;
    }

    /** The surface's carrier-local height at a carrier-local (x, z), or undefined where there is none. */
    private rawAt(x: number, z: number): number | undefined {
        const f = this.frame();
        const p = this.p.set(x, BARRICADE_DECK_Y, z).applyQuaternion(f.quaternion).add(f.origin);
        const wy = this.height(p.x, p.z);
        if (!(wy > 0)) return undefined;
        // Back into the frame: the local height of the world point straight above (x, z) at wy.
        // The frame is level to within the ship's trim; the world vertical is the local one.
        const local = this.p.set(p.x, wy, p.z).sub(f.origin).applyQuaternion(_inv.copy(f.quaternion).invert());
        return local.y;
    }
}
const _inv = new THREE.Quaternion();
