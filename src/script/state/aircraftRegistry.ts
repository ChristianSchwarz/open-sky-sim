/**
 * Registry of flyable player aircraft.
 *
 * The F-22 is built in code from the values that used to be hard-wired into
 * PlayerEntity (regression guard — it flies and animates identically). Imported
 * mods are shipped as `.aircraft.pack` archives built by
 * tools/pack_aircraft_mods.py and loaded at runtime into the same
 * {@link FlyableAircraftDef} shape.
 */
import { Fm2AircraftConfig, defaultFm2Config } from '../physics/fm2/fm2AircraftConfig';
import { ControlSurfaceConfig, FlyableAircraftDef, AircraftCollisionMesh, SwingWingsConfig } from '../scene/entities/aircraftDef';
import { aircraftPackStore, toPackUrl } from './aircraftPack';

const HINGE_RANGE = Math.PI / 6;

export function buildF22Def(): FlyableAircraftDef {
    return {
        id: 'f22',
        name: 'F-22',
        body: 'assets/f22.glb',
        shadow: 'assets/f22_shadow.glb',
        gear: 'assets/f22_landinggear.glb',
        gearAnimated: true,
        cockpitOffset: [0, 1.0, 8.0],
        fx: { wingtips: null, nozzles: null },
        flight: defaultFm2Config,
        surfaces: [
            {
                role: 'flaperonLeft', model: 'assets/f22_flaperon_left.glb',
                pivot: [4.5, -0.21, -3], axis: [1.681781, -0.152682, 0.57654],
                control: 'flaperonLeft', sign: 1, rangeRad: HINGE_RANGE,
            },
            {
                role: 'flaperonRight', model: 'assets/f22_flaperon_right.glb',
                pivot: [-4.5, -0.21, -3], axis: [-1.681781, -0.152682, 0.57654],
                control: 'flaperonRight', sign: 1, rangeRad: HINGE_RANGE,
            },
            {
                role: 'elevatorLeft', model: 'assets/f22_elevator_left.glb',
                pivot: [0, 0, -6], axis: [1, 0, 0],
                control: 'stabilatorLeft', sign: 1, rangeRad: HINGE_RANGE,
            },
            {
                role: 'elevatorRight', model: 'assets/f22_elevator_right.glb',
                pivot: [0, 0, -6], axis: [1, 0, 0],
                control: 'stabilatorRight', sign: 1, rangeRad: HINGE_RANGE,
            },
            {
                role: 'rudderLeft', model: 'assets/f22_rudder_left.glb',
                pivot: [2.34, 1.8, -4.05], axis: [0.383502, 0.802989, 0.456217],
                control: 'yaw', sign: 1, rangeRad: HINGE_RANGE,
            },
            {
                role: 'rudderRight', model: 'assets/f22_rudder_right.glb',
                pivot: [-2.34, 1.8, -4.05], axis: [-0.383502, 0.802989, 0.456217],
                control: 'yaw', sign: 1, rangeRad: HINGE_RANGE,
            },
        ],
    };
}

/** Raw shape of a packed `manifest.json` (subset the sim consumes). */
interface AircraftManifest {
    id?: string;
    name?: string;
    displayName?: string;
    canonicalName?: string;
    category?: string;
    description?: string;
    tags?: string[];
    sourceMod?: string;
    sourceModId?: string;
    sourceMaterial?: string;
    importMeta?: { confidence?: number; discoveredFrom?: string | null };
    body: string;
    shadow: string;
    gear?: string | null;
    gearAnimated?: boolean;
    static?: string | null;
    collision?: string | null;
    collisionMesh?: AircraftCollisionMesh | null;
    surfaces: {
        role: string; path: string;
        pivot: [number, number, number]; axis: [number, number, number];
        control: string; sign: number; rangeRad: number; sweepParent?: string;
    }[];
    swingWings?: SwingWingsConfig | null;
    fx?: { wingtips?: [[number, number, number], [number, number, number]] | null; nozzles?: [number, number, number][] | null; nozzleRadius?: number | null };
    attachments?: { name: string; position: [number, number, number]; forward: [number, number, number] }[] | null;
    cockpitOffset?: [number, number, number];
    spawn?: { offset?: number; rotation?: number; dotColors?: [number, number, number] };
    groundOffsetY?: number;
    groundRestHeightM?: number;
    flight?: Fm2AircraftConfig | null;
}

function rewriteManifestForPack(id: string, manifest: AircraftManifest): AircraftManifest {
    // Packs store assets by basename. Tolerate legacy manifests that still list
    // import-relative paths (e.g. tools/mods/imports/…_collision.gltf).
    const packEntry = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? path;
    const packPath = (path: string) => toPackUrl(id, packEntry(path));
    return {
        ...manifest,
        body: packPath(manifest.body),
        shadow: packPath(manifest.shadow),
        gear: manifest.gear ? packPath(manifest.gear) : manifest.gear,
        static: manifest.static ? packPath(manifest.static) : manifest.static,
        collision: manifest.collision ? packPath(manifest.collision) : manifest.collision,
        surfaces: manifest.surfaces.map(surface => ({
            ...surface,
            path: packPath(surface.path),
        })),
    };
}

function modelDisplayName(m: AircraftManifest): string {
    const full = m.displayName ?? m.name ?? '';
    const paren = full.lastIndexOf(' (');
    if (paren > 0) {
        return full.slice(0, paren);
    }
    return m.canonicalName ?? full;
}

function liveryDisplayName(m: AircraftManifest): string | undefined {
    if (m.sourceMaterial) {
        return m.sourceMaterial;
    }
    const full = m.displayName ?? m.name ?? '';
    const paren = full.lastIndexOf(' (');
    if (paren > 0 && full.endsWith(')')) {
        return full.slice(paren + 2, -1);
    }
    return undefined;
}

export interface AircraftModelGroup {
    key: string;
    label: string;
    variants: FlyableAircraftDef[];
}

/** Group flyable defs by airframe type for model + livery spawn selection. */
export function groupAircraftByModel(defs: FlyableAircraftDef[]): AircraftModelGroup[] {
    const groups = new Map<string, AircraftModelGroup>();
    for (const def of defs) {
        const key = def.canonicalName ?? def.id;
        const label = def.modelName ?? def.name;
        let group = groups.get(key);
        if (!group) {
            group = { key, label, variants: [] };
            groups.set(key, group);
        }
        group.variants.push(def);
    }
    for (const group of groups.values()) {
        group.variants.sort((a, b) =>
            (a.liveryName ?? a.name).localeCompare(b.liveryName ?? b.name),
        );
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function manifestToDef(id: string, m: AircraftManifest): FlyableAircraftDef {
    return {
        id: m.id ?? id,
        name: m.displayName ?? m.name ?? id,
        canonicalName: m.canonicalName,
        modelName: modelDisplayName(m),
        liveryName: liveryDisplayName(m),
        body: m.body,
        shadow: m.shadow,
        gear: m.gear ?? undefined,
        gearAnimated: m.gearAnimated ?? false,
        collision: m.collision ?? undefined,
        collisionMesh: m.collisionMesh ?? undefined,
        cockpitOffset: m.cockpitOffset ?? [0, 1.0, 6.0],
        spawn: m.spawn ?? undefined,
        attachments: m.attachments ?? undefined,
        fx: { wingtips: m.fx?.wingtips ?? null, nozzles: m.fx?.nozzles ?? null, nozzleRadius: m.fx?.nozzleRadius ?? null },
        flight: m.flight ?? undefined,
        swingWings: m.swingWings ?? undefined,
        surfaces: m.surfaces.map((s): ControlSurfaceConfig => {
            const role = s.role;
            // Older packs mapped speedbrakes to the flaps axis; drive them from airbrake.
            const control = (role.startsWith('speedbrake') && s.control === 'flaps')
                ? 'airbrake'
                : s.control as ControlSurfaceConfig['control'];
            return {
                role,
                model: s.path,
                pivot: s.pivot,
                axis: s.axis,
                control,
                sign: s.sign,
                rangeRad: s.rangeRad,
                sweepParent: s.sweepParent,
            };
        }),
    };
}

export class AircraftRegistry {
    private defs = new Map<string, FlyableAircraftDef>();
    private order: string[] = [];

    constructor() {
        this.register(buildF22Def());
    }

    private register(def: FlyableAircraftDef): void {
        if (!this.defs.has(def.id)) {
            this.order.push(def.id);
        }
        this.defs.set(def.id, def);
    }

    get(id: string): FlyableAircraftDef | undefined {
        return this.defs.get(id);
    }

    list(): FlyableAircraftDef[] {
        return this.order.map(id => this.defs.get(id)!).filter(Boolean);
    }

    /** Fetch, unpack, and register a mod pack; resolves to its id (or undefined on failure). */
    async loadPack(id: string, url: string): Promise<string | undefined> {
        try {
            const pack = await aircraftPackStore.loadFromUrl(id, url);
            const manifest = JSON.parse(pack.getText('manifest.json')) as AircraftManifest;
            this.register(manifestToDef(id, rewriteManifestForPack(id, manifest)));
            return id;
        } catch (err) {
            console.warn(`[aircraftRegistry] failed to load ${url}`, err);
            return undefined;
        }
    }
}
