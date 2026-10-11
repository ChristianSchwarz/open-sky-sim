/**
 * Cockpit MFDs and the moving map (workstream M8): the 2D paint of
 * scene/entities/overlay/cockpit.ts and movingMap.ts, recorded through the
 * RecordingPainter.
 *
 * - Functions: layout (MFD size and corners), the tactical scope range ladder
 *   and contact plot, moving-map zoom / placement / tiles in view / colour
 *   parse / RGBA conversion.
 * - Sequences: the real CockpitEntity with a stub PlayerEntity (display pose,
 *   devices, weapons target, contacts) and a stub map source. Each sequence
 *   keeps one cockpit and one recording painter, so the moving map's raster
 *   cache (LRU, ancestor fallback, image identity) carries across frames. Per
 *   frame: the source's pending tiles arrive, the actor is posed, update(1)
 *   rescans contacts, the map option is set, render2D paints. Outputs are the
 *   frame's painter calls, the target camera state, every sidecar request
 *   (tile, priority) and every raster built (tile, hash; the first few dumped).
 *
 * The map source stub: tiles at z <= 6 are always there; finer ones arrive
 * the frame after a fetching request (priority > 0); tiles whose
 * (7x + 3y) % 11 == 0 at z >= 9 never exist (unbaked). Texels are a formula
 * of the tile key (4x4, some no-data), mirrored on the C# side.
 *
 * Every input is written to the fixture, so the C# replay never re-derives
 * the scripted states.
 */
import * as THREE from 'three';
import {
    CockpitEntity,
    CockpitMFD1X,
    CockpitMFD1Y,
    CockpitMFD2X,
    CockpitMFD2Y,
    CockpitMFDSize,
    plotTacticalContact,
    tacticalScopeRange,
} from '../../../src/script/scene/entities/overlay/cockpit';
import {
    MapTileSource,
    mapTilePixels,
    mapTilesInView,
    movingMapZoom,
    parseHexColor,
    placeMapTile,
    texelMetres,
} from '../../../src/script/scene/entities/overlay/movingMap';
import { PtxTile } from '../../../src/script/terrain/ptx';
import { TileKey, tileKeyString } from '../../../src/script/terrain/tiling';
import { makeEnuBasis } from '../../../src/script/terrain/geodesy';
import { SceneLayers } from '../../../src/script/scene/scene';
import { CanvasPainter } from '../../../src/script/render/screen/canvasPainter';
import { Palette } from '../../../src/script/config/palettes/palette';
import { HDNoonPalette } from '../../../src/script/config/palettes/hd-noon';
import { HDMidnightPalette } from '../../../src/script/config/palettes/hd-midnight';
import { HDNightVisionPalette } from '../../../src/script/config/palettes/hd-nightvision';
import { RecordingPainter } from '../recordingPainter';
import { arr, DEG, fnv1a32, hex32, Rng, SuiteOutput } from '../lib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const PALETTES: Record<string, Palette> = {
    noon: HDNoonPalette,
    midnight: HDMidnightPalette,
    nightvision: HDNightVisionPalette,
};

const FORWARD = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------- map source stub

const STUB_TILE_SIZE = 4;

function tileExists(id: TileKey): boolean {
    return id.z <= 11 && !(id.z >= 9 && (id.x * 7 + id.y * 3) % 11 === 0);
}

/** The stub's texels: a formula of the key, every fifth texel (shifted by x + y) no-data. */
export function stubTile(id: TileKey): PtxTile {
    const n = STUB_TILE_SIZE * STUB_TILE_SIZE;
    const texels = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        texels[o] = (id.x * 31 + i * 7) & 255;
        texels[o + 1] = (id.y * 17 + i * 13) & 255;
        texels[o + 2] = (id.z * 29 + i * 5) & 255;
        texels[o + 3] = (i + id.x + id.y) % 5 === 0 ? 255 : (i + id.z) % 12;
    }
    return { id, size: STUB_TILE_SIZE, texels };
}

class StubMapSource implements MapTileSource {
    readonly loaded = new Set<string>();
    readonly pending = new Set<string>();
    requests: Array<[string, number]> = [];
    lastTile: string | undefined;

    constructor(readonly zoomRange: { min: number; max: number }) { }

    texelsAt(z: number): number {
        return z >= 10 ? 512 : 256;
    }

    sidecar(id: TileKey, priority: number): PtxTile | undefined {
        const key = tileKeyString(id);
        this.requests.push([key, priority]);
        if (tileExists(id) && (id.z <= 6 || this.loaded.has(key))) {
            this.lastTile = key;
            return stubTile(id);
        }
        if (priority > 0 && tileExists(id)) {
            this.pending.add(key);
        }
        return undefined;
    }

    /** The frame boundary: everything asked for arrives. */
    tick(): void {
        for (const k of this.pending) this.loaded.add(k);
        this.pending.clear();
    }
}

// ---------------------------------------------------------------- fake canvas

interface RasterRecord {
    tile: string | undefined;
    size: number;
    hash: string;
    rgba?: number[];
}

/** document.createElement('canvas') and ImageData for movingMap.ts' canvasFor, in node. */
function installFakeCanvas(onPut: (data: Uint8ClampedArray, width: number) => void): () => void {
    const g = globalThis as Any;
    const prevDocument = g.document;
    const prevImageData = g.ImageData;
    g.ImageData = class {
        constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) { }
    };
    g.document = {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({
                putImageData: (img: { data: Uint8ClampedArray; width: number }) => onPut(img.data, img.width),
            }),
        }),
    };
    return () => {
        g.document = prevDocument;
        g.ImageData = prevImageData;
    };
}

// ---------------------------------------------------------------- scripted states

interface ObjectIn {
    position: number[];
    localCenter: number[];
    maxSize: number;
    targetType: string;
    targetLocation: string;
    airborne: boolean;
    targetSpeedMps?: number;
    targetLoadFactorG?: number;
    targetHealthFraction?: number;
    targetStickPitch?: number;
    targetStickRoll?: number;
    targetThrottle?: number;
    targetManeuver?: string;
}

interface FrameIn {
    width: number;
    height: number;
    palette: string;
    mapEnabled: boolean;
    fov: number;
    aspect: number;
    position: number[];
    quaternion: number[];
    landingGear: number;
    flaps: number;
    airbrakes: number;
    tailhook: number;
    wheelBrakes: boolean;
    barricade: string | null;
    objects: ObjectIn[];
    /** Indices into objects: the contact list, in cycling order. */
    contacts: number[];
    /** Index into objects, or null. */
    target: number | null;
}

/** AircraftDeviceState: RETRACTING 0, RETRACTED 1, EXTENDING 2, EXTENDED 3. */
const RETRACTED = 1;

function attitude(headingDeg: number, pitchDeg: number, rollDeg: number): number[] {
    // Heading clockwise from north (-Z): yaw about +Y by -heading, then pitch
    // (nose up about the body -X... any composition will do, it only has to
    // be written down), then roll about the nose.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        -pitchDeg * DEG, (180 - headingDeg) * DEG, rollDeg * DEG, 'YXZ'));
    return [q.x, q.y, q.z, q.w];
}

function baseFrame(over: Partial<FrameIn> = {}): FrameIn {
    return {
        width: 1280,
        height: 720,
        palette: 'noon',
        mapEnabled: false,
        fov: 50,
        aspect: 1280 / 720,
        position: [0, 1500, 0],
        quaternion: attitude(0, 0, 0),
        landingGear: RETRACTED,
        flaps: RETRACTED,
        airbrakes: RETRACTED,
        tailhook: RETRACTED,
        wheelBrakes: false,
        barricade: null,
        objects: [],
        contacts: [],
        target: null,
        ...over,
    };
}

function ground(x: number, z: number, type = 'SAM SITE', location = 'GANDO'): ObjectIn {
    return {
        position: [x, 20, z], localCenter: [0, 4, 0], maxSize: 30,
        targetType: type, targetLocation: location, airborne: false,
    };
}

function air(x: number, y: number, z: number, extra: Partial<ObjectIn> = {}): ObjectIn {
    return {
        position: [x, y, z], localCenter: [0, 1, 0], maxSize: 15,
        targetType: 'MIG-29', targetLocation: 'AIRBORNE', airborne: true,
        targetSpeedMps: 240, targetLoadFactorG: 2.4, targetHealthFraction: 0.8,
        targetStickPitch: 0.3, targetStickRoll: -0.4, targetThrottle: 0.75,
        targetManeuver: 'PURSUE',
        ...extra,
    };
}

const SIZES: Array<[number, number]> = [
    [1280, 720], [1920, 1080], [640, 400], [320, 200], [2560, 1440], [400, 900], [300, 120], [1366, 768],
];

/** Hand-written states, one aspect each, cycled over the sizes. */
function handFrames(): FrameIn[] {
    const frames: FrameIn[] = [];
    const contacts4 = [
        ground(2000, -2500), ground(-6000, 4000, 'RADAR', 'TEJEDA'),
        air(1500, 1800, -1200), air(40000, 3000, -70000, { targetManeuver: undefined }),
    ];
    for (const [w, h] of SIZES) {
        frames.push(baseFrame({ width: w, height: h, aspect: w / h }));
        frames.push(baseFrame({
            width: w, height: h, aspect: w / h, mapEnabled: true,
            quaternion: attitude(37, 5, 20),
            objects: contacts4, contacts: [0, 1, 2, 3], target: 0,
        }));
        frames.push(baseFrame({
            width: w, height: h, aspect: w / h, palette: 'midnight',
            quaternion: attitude(250, -10, -35),
            objects: contacts4, contacts: [0, 1, 2, 3], target: 2,
            landingGear: 3, flaps: 2, wheelBrakes: true,
        }));
    }
    // Airborne telemetry edge cases.
    const airFrames: Array<[ObjectIn, number[]]> = [
        [air(800, 1700, -3000, { targetLoadFactorG: 5.2, targetHealthFraction: 0.25, targetThrottle: 1 }), attitude(10, 2, 0)],
        [air(-500, 1400, 2500, { targetLoadFactorG: -1.3, targetThrottle: 0.995, targetStickPitch: -2, targetStickRoll: 3 }), attitude(0, 0, 0)],
        [{
            ...air(3000, 2500, -500), targetSpeedMps: undefined, targetLoadFactorG: undefined,
            targetHealthFraction: undefined, targetStickPitch: undefined, targetStickRoll: undefined,
            targetThrottle: undefined, targetManeuver: undefined,
        }, attitude(90, 15, 60)],
        [air(0, 1500, -4000, { targetHealthFraction: 0, targetThrottle: 0, targetStickPitch: 1, targetStickRoll: -1 }), attitude(0, 0, 0)],
        [air(0.3, 1500.2, -0.4, { targetHealthFraction: 1.4, targetLoadFactorG: 4 }), attitude(45, 0, 0)],
        [air(5000, 900, 9000, { targetSpeedMps: 512.3, targetManeuver: 'SHAW:HIGH_YO_YO' }), attitude(200, -45, 170)],
        [air(-60000, 8000, -100000, { targetHealthFraction: 0.3 }), attitude(300, 30, -90)],
    ];
    airFrames.forEach(([o, q], i) => {
        const [w, h] = SIZES[i % SIZES.length];
        frames.push(baseFrame({
            width: w, height: h, aspect: w / h, quaternion: q,
            objects: [o, ground(1000, 1000)], contacts: [1, 0], target: 0,
            palette: i % 3 === 2 ? 'nightvision' : 'noon',
        }));
    });
    // Attitude indicator: pitch and roll sweeps.
    const attitudes: Array<[number, number, number]> = [
        [0, 30, 0], [0, -30, 0], [0, 60, 45], [0, -70, -45], [0, 0, 90], [0, 0, -90],
        [0, 0, 180], [0, 10, 179], [123, 80, 10], [123, -85, -10], [359, 0.5, 0.5], [181, 20, -150],
    ];
    attitudes.forEach(([hd, p, r], i) => {
        const [w, h] = SIZES[(i * 3) % SIZES.length];
        frames.push(baseFrame({ width: w, height: h, aspect: w / h, quaternion: attitude(hd, p, r) }));
    });
    // Device stacks.
    const devices: Array<Partial<FrameIn>> = [
        { landingGear: 3, flaps: 3, airbrakes: 3, tailhook: 3, wheelBrakes: true, barricade: 'BARRICADE UP' },
        { landingGear: 0, flaps: 2, airbrakes: 0, tailhook: 2 },
        { landingGear: 2, barricade: 'BARRICADE' },
    ];
    devices.forEach((d, i) => {
        const [w, h] = SIZES[i];
        frames.push(baseFrame({ width: w, height: h, aspect: w / h, ...d }));
    });
    return frames;
}

/** Seeded mixes of everything. */
function randomFrames(rng: Rng, count: number): FrameIn[] {
    const frames: FrameIn[] = [];
    for (let i = 0; i < count; i++) {
        const [w, h] = rng.pick(SIZES);
        const own = [rng.range(-80000, 80000), rng.range(50, 9000), rng.range(-80000, 80000)];
        const objects: ObjectIn[] = [];
        const n = rng.int(0, 6);
        for (let k = 0; k < n; k++) {
            const reach = rng.pick([3000, 15000, 60000, 150000]);
            const x = own[0] + rng.range(-reach, reach);
            const z = own[2] + rng.range(-reach, reach);
            if (rng.next() < 0.5) {
                objects.push(ground(x, z, rng.pick(['SAM SITE', 'RADAR', 'BUNKER']), rng.pick(['GANDO', 'TEJEDA', 'MOGAN'])));
            } else {
                objects.push(air(x, own[1] + rng.range(-2000, 2000), z, {
                    targetSpeedMps: rng.range(80, 600),
                    targetLoadFactorG: rng.range(-2, 9),
                    targetHealthFraction: rng.range(0, 1),
                    targetStickPitch: rng.range(-1.2, 1.2),
                    targetStickRoll: rng.range(-1.2, 1.2),
                    targetThrottle: rng.pick([rng.range(0, 1), 0.985, 0.995, 1]),
                    targetManeuver: rng.next() < 0.3 ? undefined : rng.pick(['PURSUE', 'EVADE', 'SHAW:LAG']),
                }));
            }
        }
        const contacts = objects.map((_, k) => k);
        frames.push(baseFrame({
            width: w, height: h, aspect: w / h,
            fov: rng.pick([50, 50, 30, 70]),
            palette: rng.pick(['noon', 'midnight', 'nightvision']),
            mapEnabled: rng.next() < 0.5,
            position: own,
            quaternion: attitude(rng.range(0, 360), rng.range(-60, 60), rng.range(-180, 180)),
            landingGear: rng.int(0, 3), flaps: rng.int(0, 3), airbrakes: rng.int(0, 3), tailhook: rng.int(0, 3),
            wheelBrakes: rng.next() < 0.3,
            barricade: rng.next() < 0.2 ? 'BARRICADE UP' : null,
            objects,
            contacts,
            target: n > 0 && rng.next() < 0.8 ? rng.int(0, n - 1) : null,
        }));
    }
    return frames;
}

/**
 * A flight with the map on: fast steps across the chart (so tiles arrive a
 * frame late and the cache overflows its 48 rasters), a palette switch (new
 * water, new rasters), lock ranges that walk the scope ladder (5 / 10 / 80 Km
 * pick z11, z10, z7), and the way back over tiles evicted on the way out.
 */
function flightFrames(): FrameIn[] {
    const frames: FrameIn[] = [];
    const legs = 44;
    for (let i = 0; i < legs; i++) {
        const out = i < legs / 2;
        const t = out ? i : legs - 1 - i;
        const pos = [t * 14000 - 50000, 2000, -t * 9000 + 20000];
        const heading = (i * 23) % 360;
        const lockKm = [4, 4, 4, 9, 70, 4, 18, 4][i % 8];
        const targetPos = [pos[0] + lockKm * 1000 * 0.6, 2000, pos[2] - lockKm * 1000 * 0.8];
        const [w, h] = i % 5 === 4 ? [1920, 1080] : i % 7 === 6 ? [640, 400] : [1280, 720];
        frames.push(baseFrame({
            width: w, height: h, aspect: w / h,
            palette: i >= 30 && i < 34 ? 'midnight' : 'noon',
            mapEnabled: i !== 12,
            position: pos,
            quaternion: attitude(heading, 3, (i % 4 - 1.5) * 20),
            objects: [air(targetPos[0], targetPos[1], targetPos[2]), ground(pos[0] - 30000, pos[2] + 2000)],
            contacts: [1, 0],
            target: 0,
        }));
    }
    return frames;
}

// ---------------------------------------------------------------- replay

interface SequenceDef {
    name: string;
    /** null: the cockpit has no map source at all. */
    zoomRange: { min: number; max: number } | null;
    basis: [number, number];
    frames: FrameIn[];
}

const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

function runSequence(def: SequenceDef): unknown {
    const source = def.zoomRange ? new StubMapSource(def.zoomRange) : undefined;
    const basis = makeEnuBasis(def.basis[0], def.basis[1]);
    const rasters: RasterRecord[] = [];
    let dumped = 0;
    const restore = installFakeCanvas((data, width) => {
        const rec: RasterRecord = {
            tile: source?.lastTile,
            size: width,
            hash: hex32(fnv1a32(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))),
        };
        if (dumped < 3) {
            rec.rgba = arr(data);
            dumped++;
        }
        rasters.push(rec);
    });

    const displayPosition = new THREE.Vector3();
    const displayQuaternion = new THREE.Quaternion();
    let contacts: Any[] = [];
    const actor: Any = {
        weaponsTarget: undefined,
        landingGear: RETRACTED,
        flaps: RETRACTED,
        airbrakes: RETRACTED,
        tailhook: RETRACTED,
        wheelBrakesApplied: false,
        barricadeStatus: undefined,
        getDisplayPosition: () => displayPosition,
        getDisplayQuaternion: () => displayQuaternion,
        getDisplayWorldDirection: (v: THREE.Vector3) => v.copy(FORWARD).applyQuaternion(displayQuaternion),
        collectWeaponsTargets: (out: Any[]) => {
            out.length = 0;
            out.push(...contacts);
            return out;
        },
    };
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 10000);
    const targetCamera = new THREE.PerspectiveCamera(50, 1, 1, 10000);
    const cockpit = new CockpitEntity(actor, camera, targetCamera,
        source ? { basis, coverTextures: source } : undefined);
    const painter = new RecordingPainter();
    const lists = new Set<string>([SceneLayers.Overlay]);

    const frames: unknown[] = [];
    try {
        for (const f of def.frames) {
            source?.tick();
            if (source) source.requests = [];
            rasters.length = 0;

            displayPosition.set(f.position[0], f.position[1], f.position[2]);
            displayQuaternion.set(f.quaternion[0], f.quaternion[1], f.quaternion[2], f.quaternion[3]);
            actor.landingGear = f.landingGear;
            actor.flaps = f.flaps;
            actor.airbrakes = f.airbrakes;
            actor.tailhook = f.tailhook;
            actor.wheelBrakesApplied = f.wheelBrakes;
            actor.barricadeStatus = f.barricade ?? undefined;
            const objects = f.objects.map(o => ({
                ...o,
                position: v3(o.position),
                localCenter: v3(o.localCenter),
            }));
            contacts = f.contacts.map(k => objects[k]);
            actor.weaponsTarget = f.target === null ? undefined : objects[f.target];
            camera.fov = f.fov;
            camera.aspect = f.aspect;
            camera.updateProjectionMatrix();

            cockpit.update(1);
            cockpit.setMovingMapEnabled(f.mapEnabled);
            const start = painter.calls.length;
            cockpit.render2D(f.width, f.height, camera, lists, painter as unknown as CanvasPainter, PALETTES[f.palette]);

            frames.push({
                input: f,
                movingMapEnabled: cockpit.movingMapEnabled,
                calls: painter.calls.slice(start),
                targetCamera: actor.weaponsTarget === undefined ? null : {
                    position: [targetCamera.position.x, targetCamera.position.y, targetCamera.position.z],
                    quaternion: [targetCamera.quaternion.x, targetCamera.quaternion.y, targetCamera.quaternion.z, targetCamera.quaternion.w],
                    fov: targetCamera.fov,
                    near: targetCamera.near,
                    far: targetCamera.far,
                },
                requests: source ? source.requests.map(([k, p]) => [k, p]) : [],
                rasters: rasters.map(r => ({ ...r })),
            });
        }
    } finally {
        restore();
    }
    return {
        name: def.name,
        zoomRange: def.zoomRange,
        basis: def.basis,
        movingMapAvailable: cockpit.movingMapAvailable,
        frames,
    };
}

// ---------------------------------------------------------------- functions

function functionCases(rng: Rng): unknown {
    const layout = [];
    const sizes: Array<[number, number]> = [...SIZES, [1, 1], [10, 3], [3840, 2160], [1000, 4000], [7, 50]];
    for (const [w, h] of sizes) {
        const s = CockpitMFDSize(h, w);
        layout.push({
            width: w, height: h,
            sizeByHeight: CockpitMFDSize(h), size: s,
            mfd1: [CockpitMFD1X(w, h, s), CockpitMFD1Y(w, h, s)],
            mfd2: [CockpitMFD2X(w, h, s), CockpitMFD2Y(w, h, s)],
        });
    }

    const scopeRange = [];
    for (const km of [null, 0, 0.5, 5, 5.0000001, 7, 10, 12, 20, 21, 40, 41, 80, 80.5, 500]) {
        scopeRange.push([km, tacticalScopeRange(km === null ? undefined : km)]);
    }

    const plots = [];
    for (let i = 0; i < 200; i++) {
        const reach = rng.pick([0.5, 2000, 20000, 200000]);
        const dx = rng.range(-reach, reach);
        const dz = rng.range(-reach, reach);
        const heading = rng.pick([0, 90, 180, 270, rng.range(0, 360)]);
        const rangeKm = rng.pick([5, 10, 20, 40, 80]);
        const radius = rng.int(4, 160);
        const p = plotTacticalContact(dx, dz, heading, rangeKm, radius);
        plots.push({ dx, dz, heading, rangeKm, radius, x: p.x, y: p.y, offScope: p.offScope });
    }

    const texelsAt = (z: number) => z >= 10 ? 512 : 256;
    const zooms = [];
    for (const mpp of [0.5, 1, 10, 19, 20, 37.9, 38, 50, 100, 151, 152, 160, 200, 303, 304, 800, 1214, 1215, 5000, 1e6]) {
        zooms.push({
            metresPerPixel: mpp,
            z: movingMapZoom(mpp, texelsAt, { min: 4, max: 11 }),
            zNarrow: movingMapZoom(mpp, texelsAt, { min: 7, max: 9 }),
        });
    }
    const texel = [];
    for (let z = 0; z <= 14; z++) {
        texel.push([z, texelMetres(z, 256), texelMetres(z, 512)]);
    }

    const placements = [];
    for (let i = 0; i < 60; i++) {
        const lat = rng.range(-80, 80);
        const lon = rng.range(-179, 179);
        const z = rng.int(4, 12);
        const span = 180 / (1 << z);
        const x = Math.floor((lon + 180) / span) + rng.int(-2, 2);
        const y = Math.max(0, Math.floor((90 - lat) / span) + rng.int(-2, 2));
        const p = placeMapTile({ z, x, y }, lat, lon);
        placements.push({ id: [z, x, y], lat, lon, x: p.x, y: p.y, width: p.width, height: p.height });
    }

    const inView = [];
    for (let i = 0; i < 40; i++) {
        const lat = rng.pick([rng.range(-85, 85), 89.99, -89.99, 0]);
        const lon = rng.pick([rng.range(-180, 180), 179.99, -179.99]);
        const z = rng.int(4, 11);
        const half = rng.pick([100, 5000, 30000, 200000]);
        const ids = mapTilesInView(z, lat, lon, half);
        inView.push({ z, lat, lon, halfExtentM: half, tiles: ids.map(t => tileKeyString(t)) });
    }

    const colors = [];
    for (const c of ['#16355e', '#FFFFFF', ' #a0B1c2 ', 'nope', '#fff', '#1234567', '', '#00ff00\n']) {
        colors.push([c, parseHexColor(c)]);
    }

    const pixels = [];
    for (const id of [{ z: 4, x: 0, y: 0 }, { z: 10, x: 1090, y: 238 }, { z: 11, x: 2, y: 3 }]) {
        const tile = stubTile(id);
        const water = parseHexColor('#16355e');
        const px = mapTilePixels(tile, water);
        pixels.push({ id: tileKeyString(id), water, texels: arr(tile.texels), rgba: arr(px) });
    }

    return { layout, scopeRange, plots, zooms, texel, placements, inView, colors, pixels };
}

export function cockpitSuite(): SuiteOutput {
    const rng = new Rng(0xC0C4917);
    const functions = functionCases(rng);
    const sequences: SequenceDef[] = [
        { name: 'hand', zoomRange: { min: 4, max: 11 }, basis: [27.93, -15.39], frames: handFrames() },
        { name: 'random', zoomRange: { min: 4, max: 11 }, basis: [48.1, 11.6], frames: randomFrames(rng, 48) },
        { name: 'flight', zoomRange: { min: 4, max: 11 }, basis: [47.5, 11.1], frames: flightFrames() },
        // No chart baked (empty zoom range) and no map source at all: the map option is a no-op.
        { name: 'noChart', zoomRange: { min: 5, max: 4 }, basis: [47.5, 11.1], frames: handFrames().slice(0, 6) },
        { name: 'noSource', zoomRange: null, basis: [47.5, 11.1], frames: handFrames().slice(0, 6) },
    ];
    return {
        files: [{
            file: 'cockpit.json',
            data: {
                note: 'Oracle: scene/entities/overlay/{cockpit,movingMap}.ts. See tools/golden/suites/cockpit.ts.',
                stubTileSize: STUB_TILE_SIZE,
                functions,
                sequences: sequences.map(runSequence),
            },
        }],
    };
}
