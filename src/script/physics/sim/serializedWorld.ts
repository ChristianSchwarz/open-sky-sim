import * as THREE from 'three';
import { Obstacle, Runway, SceneWorldQuery } from '../../ai/worldQuery';
import { CarrierMeshCollider } from '../../scene/entities/carrierDeck';
import {
    ArrestorCableField,
    buildArrestorCableField,
} from '../../scene/entities/arrestorCables';
import { HillCollider } from '../../scene/entities/hillCollider';
import { SurfacePadCollider } from '../../scene/entities/surfacePad';
import { SkiJumpCollider } from '../../scene/entities/skiJump';

/**
 * Plain, structured-clone-safe views of the static world the AI pilots need
 * (terrain hills, ski jumps, carrier meshes, static obstacles, the runways).
 * These are posted once to the combat sim worker so it can rebuild a
 * {@link SceneWorldQuery} on its side.
 *
 * `isLand` is deliberately not serialized: the {@link import('../../ai/aiPilot').AiPilot}
 * never calls it (only groundHeightAt / obstacles / runways), so the worker-side
 * query stubs it to `true`.
 *
 * The DEM is *not* serialized here either. It is mirrored tile by tile as the
 * aircraft move (see {@link import('../../terrain/heightMirror')}) rather than
 * frozen into a lattice at boot.
 */
interface SerializedHill {
    worldToLocal: number[];
    localToWorld: number[];
    baseRadius: number;
    height: number;
    worldX: number;
    worldZ: number;
    worldReach: number;
}

interface SerializedObstacle {
    position: [number, number, number];
    radius: number;
    height: number;
}

interface SerializedRunway {
    center: [number, number, number];
    heading: number;
    halfLength: number;
    halfWidth: number;
}

interface SerializedSkiJump {
    originX: number;
    originY: number;
    originZ: number;
    heading: number;
    length: number;
    height: number;
    halfWidth: number;
}

interface SerializedCarrierMesh {
    originX: number;
    originY: number;
    originZ: number;
    triangles: number[];
    aabb: { min: [number, number, number]; max: [number, number, number] };
}

/** Structured-clone-safe arrestor cable field (one carrier). */
export interface SerializedArrestorCables {
    originX: number;
    originY: number;
    originZ: number;
    /** Unit landing/roll-out direction. */
    deckAxis: [number, number, number];
    /** Local endpoints [ax, ay, az, bx, by, bz] per cable. */
    segmentsLocal: [number, number, number, number, number, number][];
}

/** Structured-clone-safe barricade state (one carrier). */
export interface SerializedBarricade {
    originX: number;
    originY: number;
    originZ: number;
    /** Unit landing/roll-out direction. */
    deckAxis: [number, number, number];
    /** Unit deck +X (stanchion to stanchion). */
    lateralAxis: [number, number, number];
    /** World centre of the webbing at the stanchion feet. */
    center: [number, number, number];
    halfSpan: number;
    height: number;
    /** 0 = folded flush, 1 = fully upright. */
    deploy: number;
    /** Carrier attitude as [x, y, z, w]. */
    quaternion: [number, number, number, number];
    /**
     * The rig as actually fitted to the deck, in carrier-local coordinates.
     *
     * Only what the sim needs to lace the same net the main thread drew: the
     * stanchion stations and the deck they are bolted to. How much of that span
     * is webbing rather than bare wire is the rig's own business, and both ends
     * work it out the same way from these.
     */
    rigLeftX: number;
    rigRightX: number;
    rigDeckY: number;
    /** Bumped when a fresh webbing assembly goes up; the sim re-laces on it. */
    rigGeneration: number;
}

export interface SerializedWorld {
    hills: SerializedHill[];
    obstacles: SerializedObstacle[];
    /**
     * Every runway in the play area, longest first. Named plural since the
     * world stopped having exactly one airfield in it.
     */
    runways: SerializedRunway[];
    skiJumps?: SerializedSkiJump[];
    carrierMeshes?: SerializedCarrierMesh[];
    arrestorCables?: SerializedArrestorCables[];
    barricades?: SerializedBarricade[];
    /** Flat solid surfaces — runway strip, pavement pads (already structured-clone-safe). */
    surfacePads?: SurfacePadCollider[];
    /** Static scenery collision soups — hangars, towers, depots (same layout as carrier meshes). */
    sceneryMeshes?: SerializedCarrierMesh[];
}

export function serializeWorld(
    hills: HillCollider[],
    obstacles: Obstacle[],
    runways: readonly Runway[],
    skiJumps: readonly SkiJumpCollider[] = [],
    carrierMeshes: readonly CarrierMeshCollider[] = [],
    arrestorCables: readonly ArrestorCableField[] = [],
    surfacePads: readonly SurfacePadCollider[] = [],
    sceneryMeshes: readonly CarrierMeshCollider[] = [],
): SerializedWorld {
    return {
        hills: hills.map(h => ({
            worldToLocal: h.worldToLocal.toArray(),
            localToWorld: h.localToWorld.toArray(),
            baseRadius: h.baseRadius,
            height: h.height,
            worldX: h.worldX,
            worldZ: h.worldZ,
            worldReach: h.worldReach,
        })),
        obstacles: obstacles.map(o => ({
            position: [o.position.x, o.position.y, o.position.z],
            radius: o.radius,
            height: o.height,
        })),
        runways: runways.map(r => ({
            center: [r.center.x, r.center.y, r.center.z] as [number, number, number],
            heading: r.heading,
            halfLength: r.halfLength,
            halfWidth: r.halfWidth,
        })),
        skiJumps: skiJumps.map(r => ({
            originX: r.originX,
            originY: r.originY,
            originZ: r.originZ,
            heading: r.heading,
            length: r.length,
            height: r.height,
            halfWidth: r.halfWidth,
        })),
        carrierMeshes: carrierMeshes.map(c => ({
            originX: c.originX,
            originY: c.originY,
            originZ: c.originZ,
            triangles: c.triangles,
            aabb: c.aabb,
        })),
        arrestorCables: arrestorCables.map(f => ({
            originX: f.originX,
            originY: f.originY,
            originZ: f.originZ,
            deckAxis: [f.deckAxis.x, f.deckAxis.y, f.deckAxis.z],
            segmentsLocal: f.segments.map(s => [
                s.a.x - f.originX, s.a.y - f.originY, s.a.z - f.originZ,
                s.b.x - f.originX, s.b.y - f.originY, s.b.z - f.originZ,
            ] as [number, number, number, number, number, number]),
        })),
        barricades: [],
        surfacePads: surfacePads.map(p => ({ ...p })),
        sceneryMeshes: sceneryMeshes.map(c => ({
            originX: c.originX,
            originY: c.originY,
            originZ: c.originZ,
            triangles: c.triangles,
            aabb: c.aabb,
        })),
    };
}

/**
 * Rebuild a {@link SceneWorldQuery} in the worker from serialized world data.
 * `baseHeightAt` is the DEM under everything: pass the worker's mirrored height
 * field so the sim's terrain is the terrain the renderer draws.
 */
export function deserializeWorldQuery(
    world: SerializedWorld,
    baseHeightAt: (x: number, z: number) => number = () => 0,
): SceneWorldQuery {
    const hills: HillCollider[] = world.hills.map(h => ({
        worldToLocal: new THREE.Matrix4().fromArray(h.worldToLocal),
        localToWorld: new THREE.Matrix4().fromArray(h.localToWorld),
        baseRadius: h.baseRadius,
        height: h.height,
        worldX: h.worldX,
        worldZ: h.worldZ,
        worldReach: h.worldReach,
    }));
    const obstacles: Obstacle[] = world.obstacles.map(o => ({
        position: new THREE.Vector3(o.position[0], o.position[1], o.position[2]),
        radius: o.radius,
        height: o.height,
    }));
    const runways: Runway[] = (world.runways ?? []).map(r => ({
        center: new THREE.Vector3(r.center[0], r.center[1], r.center[2]),
        heading: r.heading,
        halfLength: r.halfLength,
        halfWidth: r.halfWidth,
    }));
    const skiJumps: SkiJumpCollider[] = (world.skiJumps ?? []).map(r => ({
        originX: r.originX,
        originY: r.originY ?? 0,
        originZ: r.originZ,
        heading: r.heading,
        length: r.length,
        height: r.height,
        halfWidth: r.halfWidth,
    }));
    const carrierMeshes: CarrierMeshCollider[] = (world.carrierMeshes ?? []).map(c => ({
        originX: c.originX,
        originY: c.originY,
        originZ: c.originZ,
        triangles: c.triangles,
        aabb: c.aabb,
    }));
    // isLand is unused by the AI pilot; stub to land everywhere.
    const sceneryMeshes: CarrierMeshCollider[] = (world.sceneryMeshes ?? []).map(c => ({
        originX: c.originX,
        originY: c.originY,
        originZ: c.originZ,
        triangles: c.triangles,
        aabb: c.aabb,
    }));
    return new SceneWorldQuery(
        hills, () => true, obstacles, runways, skiJumps, carrierMeshes, baseHeightAt,
        world.surfacePads ?? [], sceneryMeshes,
    );
}

/** Rebuild arrestor cable fields for combat-sim trap physics. */
export function deserializeArrestorCables(world: SerializedWorld): ArrestorCableField[] {
    const list = world.arrestorCables ?? [];
    return list.map(s => {
        const field = buildArrestorCableField(
            s.originX, s.originY, s.originZ,
            new THREE.Vector3(s.deckAxis[0], s.deckAxis[1], s.deckAxis[2]),
        );
        // Prefer serialized local endpoints when present (keeps worker in sync with author).
        if (s.segmentsLocal.length > 0) {
            field.segments.length = 0;
            for (const seg of s.segmentsLocal) {
                field.segments.push({
                    a: new THREE.Vector3(s.originX + seg[0], s.originY + seg[1], s.originZ + seg[2]),
                    b: new THREE.Vector3(s.originX + seg[3], s.originY + seg[4], s.originZ + seg[5]),
                });
            }
        }
        return field;
    });
}

/** Helper: default Kuznetsov cable field at an origin (for game-side serialize). */
export function defaultArrestorCableField(
    originX: number,
    originY: number,
    originZ: number,
    orientation?: THREE.Quaternion,
): ArrestorCableField {
    return buildArrestorCableField(originX, originY, originZ, undefined, orientation);
}

