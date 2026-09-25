import * as THREE from 'three';
import { CarrierMeshCollider, sampleCarrierMeshSurfaceYMax } from '../scene/entities/carrierDeck';
import { HillCollider, sampleHillSurfaceY } from '../scene/entities/hillCollider';
import { SurfacePadCollider, sampleSurfacePadYMax } from '../scene/entities/surfacePad';
import { SkiJumpCollider, sampleSkiJumpSurfaceYMax } from '../scene/entities/skiJump';

/** A static world obstacle approximated as an upright cylinder for avoidance. */
export interface Obstacle {
    /** Base position (ground level) in world space. */
    position: THREE.Vector3;
    /** Horizontal safety radius (m). */
    radius: number;
    /** Top height above ground (m). */
    height: number;
}

/** One runway an AI can take off from or land on. */
export interface Runway {
    /** Runway centre (threshold-to-threshold midpoint), world space. */
    center: THREE.Vector3;
    /** Runway heading (rad), 0 = aligned with +Z (approach from -Z). */
    heading: number;
    /** Half the paved length along the runway axis (m). */
    halfLength: number;
    /** Half the paved width across the runway axis (m). */
    halfWidth: number;
}

/**
 * Read-only view of the world an AI pilot uses for terrain/obstacle clearance
 * and navigation. Extracted from the otherwise-private {@link import('../state/game').Game}
 * state so pilots do not depend on the game object.
 */
export interface WorldQuery {
    /** Highest solid ground Y at (x, z): flat datum, hills, ski jumps, surface pads, scenery + carrier meshes. */
    groundHeightAt(x: number, z: number): number;
    /** True if (x, z) is over land rather than water. */
    isLand(x: number, z: number): boolean;
    /** All static building/scenery obstacles. */
    obstacles(): readonly Obstacle[];
    /**
     * Every runway in the play area, longest first.
     *
     * Plural since the world stopped having exactly one airfield in it. A
     * pilot picks once and keeps it — see {@link nearestRunway} — rather than
     * re-deciding mid-approach, which would hand off to a different runway the
     * moment one drifted closer.
     */
    runways(): readonly Runway[];
    /** The main runway of the area: the one a session starts on. */
    runway(): Runway;
    /** Closest runway to a point, for choosing somewhere to come home to. */
    nearestRunway(x: number, z: number): Runway;
}

const TMP = new THREE.Vector3();

/**
 * Concrete {@link WorldQuery} backed by the game's hill colliders, ski jumps,
 * carrier meshes, terrain land/water sampler, static obstacle list and runways.
 */
export class SceneWorldQuery implements WorldQuery {

    constructor(
        private readonly hills: HillCollider[],
        private readonly isLandFn: (x: number, z: number) => boolean,
        private readonly obstacleList: Obstacle[],
        private readonly runwayList: readonly Runway[],
        private readonly skiJumps: readonly SkiJumpCollider[] = [],
        private readonly carrierMeshes: readonly CarrierMeshCollider[] = [],
        /** Optional DEM / base terrain height under hills and decks. */
        private readonly baseHeightAt: (x: number, z: number) => number = () => 0,
        /** Flat solid surfaces (runway strip, pavement pads) sitting slightly above the terrain. */
        private readonly surfacePads: readonly SurfacePadCollider[] = [],
        /** Static scenery collision soups (hangars, towers, depots...). */
        private readonly sceneryMeshes: readonly CarrierMeshCollider[] = [],
    ) { }

    groundHeightAt(x: number, z: number): number {
        return Math.max(
            this.baseHeightAt(x, z),
            sampleHillSurfaceY(x, z, this.hills),
            sampleSkiJumpSurfaceYMax(x, z, this.skiJumps),
            sampleSurfacePadYMax(x, z, this.surfacePads),
            sampleCarrierMeshSurfaceYMax(x, z, this.sceneryMeshes),
            this.carrierHeightAt(x, z),
        );
    }

    /**
     * Carrier-deck surface Y at (x, z), or -Infinity if no carrier triangle
     * covers that point. Used to detect gear-on-deck for riding a
     * steaming ship — test it with `Number.isFinite`, not against zero: a deck
     * is only above Y = 0 near the play area's origin.
     */
    carrierHeightAt(x: number, z: number): number {
        return sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes);
    }

    /** First carrier mesh origin, or false if none. */
    carrierOrigin(out: { x: number; y: number; z: number }): boolean {
        if (this.carrierMeshes.length === 0) return false;
        const c = this.carrierMeshes[0];
        out.x = c.originX;
        out.y = c.originY;
        out.z = c.originZ;
        return true;
    }

    isLand(x: number, z: number): boolean {
        return this.isLandFn(x, z);
    }

    obstacles(): readonly Obstacle[] {
        return this.obstacleList;
    }

    runways(): readonly Runway[] {
        return this.runwayList;
    }

    runway(): Runway {
        return this.runwayList[0];
    }

    nearestRunway(x: number, z: number): Runway {
        let best = this.runwayList[0];
        let bestSq = Infinity;
        for (let i = 0; i < this.runwayList.length; i++) {
            const r = this.runwayList[i];
            const dx = r.center.x - x;
            const dz = r.center.z - z;
            const d = dx * dx + dz * dz;
            if (d < bestSq) {
                bestSq = d;
                best = r;
            }
        }
        return best;
    }

    /** Move carrier collision soups when the ship translates (local mesh frame unchanged). */
    setCarrierMeshOrigins(origins: readonly { originX: number; originY: number; originZ: number }[]): void {
        for (let i = 0; i < this.carrierMeshes.length && i < origins.length; i++) {
            const c = this.carrierMeshes[i];
            const o = origins[i];
            c.originX = o.originX;
            c.originY = o.originY;
            c.originZ = o.originZ;
        }
    }

    /**
     * Nearest obstacle whose safety cylinder the point is within `horizon`
     * metres of (horizontally). Returns undefined when clear. Used by the
     * pilot's steering avoidance.
     */
    nearestObstacleWithin(x: number, z: number, horizon: number): Obstacle | undefined {
        let best: Obstacle | undefined;
        let bestDist = Infinity;
        for (let i = 0; i < this.obstacleList.length; i++) {
            const o = this.obstacleList[i];
            TMP.set(x - o.position.x, 0, z - o.position.z);
            const d = TMP.length() - o.radius;
            if (d < horizon && d < bestDist) {
                bestDist = d;
                best = o;
            }
        }
        return best;
    }
}
