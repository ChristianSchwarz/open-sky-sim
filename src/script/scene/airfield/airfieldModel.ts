/**
 * A real airfield, built as flat-shaded geometry.
 *
 * Not a `ModelLibBuilder`: those are keyed by a type string and take no
 * per-instance parameters, and every airfield here has its own length, width,
 * bearing and slope. So this builds a {@link Model} directly and hands it to a
 * plain `StaticSceneryEntity`, which is what gets the existing LOD, culling and
 * palette machinery for free.
 *
 * Every vertex goes geodetic → ECEF → ENU, exactly as `tools/bake/buildTile.ts`
 * places terrain vertices. Laying the pavement out on the tangent plane instead
 * would leave the ends of a 3.4 km runway floating a metre above the ground the
 * bake curved away underneath them.
 */

import * as THREE from 'three';
import { PaletteCategory } from '../../config/palettes/palette';
import {
    Airfield, AirfieldBuilding, AirfieldRunway, RunwaySurface, primaryRunway,
} from '../../terrain/airfields';
import { bearingAxisAt } from '../../terrain/flattenPad';
import {
    Ecef, Enu, EnuBasis, ecefToEnu, enuToGeodeticApprox, geodeticToEcef, sceneFromEnu,
} from '../../terrain/geodesy';
import { toneCategoryOfClass } from '../../terrain/terrainEntity';
import { TileCover } from '../../terrain/tileHeightIndex';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { Model } from '../models/models';
import { updateUniforms } from '../utils';
import { MarkingKind, MarkingRect, runwayMarkings } from './runwayMarkings';

/**
 * How far the pavement floats over the flattened terrain.
 *
 * The ground under it was cut to the same plane, so in principle they coincide;
 * in practice the terrain is quantised into a 16-bit tile and this has to win
 * the depth test from every angle. Matches SCENERY_SURFACE_EPS_M.
 */
export const AIRFIELD_SURFACE_EPS_M = 1.5;

/** Paint sits this far over its own pavement. Coplanar flats would z-fight. */
const PAINT_LIFT_M = 0.05;

/** Taxiway centreline stripe width. */
const TAXIWAY_STRIPE_M = 0.5;

/**
 * Below this a segment is two nodes in the same place, and normalising it
 * would divide by zero.
 *
 * There used to be an 8 m floor here, on the theory that a short taxiway was a
 * stub not worth drawing. It is applied per *segment of a polyline*, not per
 * taxiway — so a continuous taxiway digitised with nodes a few metres apart,
 * which is what happens around a curve, lost exactly those segments and came
 * out with holes punched through the middle of it. At Belbek that was 119 of
 * 363 segments and 8.6% of the taxiway network. Merging into one buffer per
 * palette category means a short segment costs no draw call anyway.
 */
const DEGENERATE_SEGMENT_M = 0.01;

/**
 * A draped taxiway is cut into pieces this long before it is laid down.
 *
 * One quad per OSM segment would span a hundred metres and be flat across all
 * of it, so a leg crossing a rise cuts straight through. Twenty metres is
 * about the DEM's own cell, past which there is no more ground detail to
 * follow.
 */
const TAXIWAY_STEP_M = 20;

/**
 * What each surface fogs as, and what it is drawn in before the terrain
 * under it has streamed in (see {@link GroundStrip}).
 *
 * Every runway surface - paved or not - is drawn in the observed colour of
 * the ground it sits on (see {@link groundPaint}); this is only the tone
 * used for fog and for the stand-in before that colour is known. Concrete
 * gets its own stand-in rather than sharing asphalt's - a military field laid
 * in slabs is markedly paler than an asphalt civil field, and OSM records
 * which it is, so there is no reason to guess even for a placeholder.
 */
const RUNWAY_FALLBACK_CATEGORY: Record<RunwaySurface, PaletteCategory> = {
    asphalt: PaletteCategory.SCENERY_ROAD_SECONDARY,
    concrete: PaletteCategory.SCENERY_BASE_CONCRETE,
    grass: PaletteCategory.TERRAIN_GRASS,
    gravel: PaletteCategory.TERRAIN_BARE,
};

/**
 * How much brighter an unpaved strip is drawn than the terrain tone under it.
 *
 * A mown or rolled strip reads a shade paler than the field or scrub round
 * it, and that lift is all that marks it out: the hue is the ground's own.
 * Paved surfaces get none of this - asphalt and concrete are drawn at the
 * ground's own observed brightness, not lifted above it.
 */
export const GROUND_STRIP_LIGHTEN = 1.1;

/** How much a runway surface is lifted above the ground colour it samples. */
function runwayLighten(surface: RunwaySurface): number {
    return surface === 'asphalt' || surface === 'concrete' ? 1 : GROUND_STRIP_LIGHTEN;
}

/**
 * A runway this close to sea level (its own baked plane, not the ground -
 * see below) is not trusted to read its own cover.
 *
 * The bake resolves any facet where the OSM coastline calls a spot land but
 * the WorldCover raster calls it water by painting it Grass rather than sea
 * (see tools/bake/buildTile.ts's own comment on that fallback) - reasonable
 * for the usual sliver either source could have the shoreline off by, but a
 * runway's own footprint is exactly where that sliver is widest: the pad cut
 * for it is real land by construction, so the coast vector always calls it
 * land, while a low-lying strip is exactly the kind of ground a coarse
 * raster mismeasures as water. Reading that facet's colour back onto the
 * runway would just be redrawing the bake's own guess in a brighter green.
 *
 * `airfield.plane.heightMsl` is what decides this, not the ground reading -
 * it comes from the same OSM/SRTM elevation the bake trusted to cut the pad,
 * so it says how high the real runway is regardless of what any one facet's
 * disputed colour claims.
 */
const RUNWAY_SEA_LEVEL_GUARD_M = 2;

/**
 * A colour to draw a part in: a palette tone, optionally lifted, and
 * optionally a literal colour in place of the tone (the tone still says how
 * it fogs).
 */
type Paint = PaletteCategory | { category: PaletteCategory; lighten: number; rawColor?: string };

function paintKey(paint: Paint): string {
    return typeof paint === 'string'
        ? paint
        : paint.category + '*' + paint.lighten + (paint.rawColor ?? '');
}

/** The material for a flat, unlit part in one paint. */
function flatMaterial(materials: SceneMaterialManager, paint: Paint): THREE.Material {
    return materials.build({
        type: SceneMaterialPrimitiveType.MESH,
        category: typeof paint === 'string' ? paint : paint.category,
        depthWrite: false,
        shaded: false,
        overbright: typeof paint === 'string' ? 1 : paint.lighten,
        rawColor: typeof paint === 'string' ? undefined : paint.rawColor,
    });
}

/**
 * The paint of a runway strip on ground of a given cover.
 *
 * Always the observed colour, never a predefined palette tone: `cover.rgb` is
 * the imagery-averaged colour the bake itself recorded for this facet (see
 * groundColor.ts), the same one every land vertex carries regardless of its
 * class, so a strip painted from it always matches the ground it sits in
 * rather than a generic swatch for "grass", "bare" or "asphalt" that happens
 * to look wrong against a particular facet's real colour. `category` is kept
 * only to say how the paint fogs - it plays no part in the colour itself.
 */
function groundPaint(cover: TileCover, lighten: number): Paint {
    return {
        category: toneCategoryOfClass(cover.cls),
        lighten,
        rawColor: '#' + cover.rgb.toString(16).padStart(6, '0'),
    };
}

/**
 * Where a runway's colour is sampled: its low threshold, its midpoint and its
 * high threshold - not just the midpoint alone, since a long runway can cross
 * more than one kind of ground (a 3 km strip is not one facet), and the
 * midpoint by itself can just as easily land on the odd one out as on the
 * typical one.
 */
function runwaySamplePoints(runway: AirfieldRunway): { lat: number; lon: number }[] {
    const [low, high] = runway.thresholds;
    return [
        { lat: low[0], lon: low[1] },
        { lat: runway.lat, lon: runway.lon },
        { lat: high[0], lon: high[1] },
    ];
}

/**
 * One reading for several samples along a runway, or undefined where none of
 * them has anything to say yet.
 *
 * The colour is the plain average of whichever samples have resolved -
 * partial is still better than the single-point reading this replaced, and
 * waiting for every last one would leave a runway on its stand-in tone for as
 * long as its slowest-to-stream end. The zoom is the *worst* of them, though:
 * repainting has to wait for every sample to reach a given depth before that
 * depth's colour is trusted, or a runway would flicker between a fine answer
 * at one end and a stale coarse one blended in from the other.
 */
export function combineCover(covers: readonly (TileCover | undefined)[]): TileCover | undefined {
    const present = covers.filter((c): c is TileCover => c !== undefined);
    if (present.length === 0) {
        return undefined;
    }
    let r = 0, g = 0, b = 0, zoom = Infinity;
    for (const c of present) {
        r += (c.rgb >> 16) & 0xff;
        g += (c.rgb >> 8) & 0xff;
        b += c.rgb & 0xff;
        zoom = Math.min(zoom, c.zoom);
    }
    const n = present.length;
    const rgb = (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
    return { cls: present[0].cls, rgb, zoom };
}

/**
 * What the taxiways and aprons of an airfield are paved with.
 *
 * Taken from its longest runway, because OSM does not tag a surface on either
 * of them and an airfield is laid in one material: a concrete-plate military
 * field has concrete taxiways, and drawing them in asphalt puts a civil apron
 * in the middle of it.
 *
 * A grass or gravel *runway* still gets hard taxiways, since what little
 * pavement such a field has is where the aircraft turn and park.
 */
function groundSurfaceOf(airfield: Airfield): PaletteCategory {
    const primary = primaryRunway(airfield);
    return primary !== undefined && primary.surface === 'concrete'
        ? PaletteCategory.SCENERY_BASE_CONCRETE
        : PaletteCategory.SCENERY_ROAD_SECONDARY;
}

const MARKING_CATEGORY: Record<MarkingKind, PaletteCategory> = {
    pavement: PaletteCategory.SCENERY_ROAD_SECONDARY,
    threshold: PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD,
    designator: PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD,
    aiming: PaletteCategory.SCENERY_BASE_RUNWAY_LINES,
    centreline: PaletteCategory.SCENERY_BASE_RUNWAY_LINES,
    edge: PaletteCategory.SCENERY_BASE_RUNWAY_LINES,
};

const BUILDING_CATEGORY: Record<AirfieldBuilding['kind'], PaletteCategory> = {
    hangar: PaletteCategory.SCENERY_BUILDING_METAL,
    terminal: PaletteCategory.SCENERY_BUILDING_PLASTER_WHITE,
    tower: PaletteCategory.SCENERY_BUILDING_CONCRETE,
};

/**
 * How tall a building is when OSM does not say - which is almost always: not
 * one of Gran Canaria's sixty airport buildings carries a height or a storey
 * count.
 *
 * Inferred from the footprint, because the two really are related. A hangar is
 * built around a tail, so it is tall in proportion to how wide it is: a fighter
 * shelter is ten metres and a widebody hangar thirty. A terminal is a long low
 * shed of two to four storeys whatever its length. A control tower is the one
 * building at an airfield taller than it is wide, and it has to see over
 * everything else.
 */
const BUILDING_SHAPE: Record<AirfieldBuilding['kind'],
    { of: 'min' | 'max'; ratio: number; min: number; max: number }> = {
    // The floors are low on purpose. A 10 m floor put the median hangar
    // exactly on it — most of the 234 baked are small, and a row of T-hangars
    // is nearer five metres to the eaves than ten.
    hangar: { of: 'min', ratio: 0.45, min: 6, max: 30 },
    terminal: { of: 'min', ratio: 0.25, min: 6, max: 25 },
    tower: { of: 'max', ratio: 1.6, min: 20, max: 45 },
};

/** Height of one building, from OSM where it says so and from its shape where not. */
export function buildingHeightM(building: AirfieldBuilding): number {
    if (building.heightM !== undefined && building.heightM > 0) {
        return building.heightM;
    }
    const shape = BUILDING_SHAPE[building.kind] ?? BUILDING_SHAPE.hangar;
    const base = shape.of === 'min'
        ? Math.min(building.widthM, building.depthM)
        : Math.max(building.widthM, building.depthM);
    return Math.min(shape.max, Math.max(shape.min, base * shape.ratio));
}

/**
 * What each level of detail draws.
 *
 * The markings are most of the triangles and the first thing to go: a runway
 * two miles out is a grey strip, and a runway ten miles out is a grey strip
 * with numbers nobody can read. Level 2 keeps the pavement alone, which is
 * still the shape that says "airfield" from the air.
 */
const LOD_KINDS: MarkingKind[][] = [
    ['pavement', 'threshold', 'designator', 'aiming', 'centreline', 'edge'],
    ['pavement', 'threshold', 'designator'],
    ['pavement'],
];
/** Coarsest level that still draws taxiways and aprons. */
const LOD_WITH_SURROUNDS = 1;

const _ecef: Ecef = { x: 0, y: 0, z: 0 };
const _enu: Enu = { e: 0, n: 0, u: 0 };

/**
 * Accumulates triangles per palette category, so one category is one draw.
 *
 * `shaded` splits flat pavement from solid buildings: pavement is unlit paint
 * on the ground and must not write depth, a building is a lit box that must.
 */
class MeshParts {
    private readonly parts = new Map<string, { paint: Paint; positions: number[] }>();
    /** The mesh each paint became, filled by {@link build}. */
    readonly meshes = new Map<string, THREE.Mesh>();

    constructor(private readonly shaded = false) { }

    add(paint: Paint, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
        const key = paintKey(paint);
        let part = this.parts.get(key);
        if (part === undefined) {
            part = { paint, positions: [] };
            this.parts.set(key, part);
        }
        part.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }

    /** Two triangles from four corners wound a, b, c, d. */
    addQuad(
        paint: Paint,
        a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
    ): void {
        this.add(paint, a, b, c);
        this.add(paint, a, c, d);
    }

    build(materials: SceneMaterialManager): THREE.Object3D[] {
        const out: THREE.Object3D[] = [];
        for (const [key, { paint, positions }] of this.parts) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                'position', new THREE.BufferAttribute(new Float32Array(positions), 3));
            geometry.computeBoundingSphere();
            if (this.shaded) {
                // Volumes are lit, so they need normals; flats never are.
                geometry.computeVertexNormals();
            }
            const material = this.shaded
                ? materials.build({
                    type: SceneMaterialPrimitiveType.MESH,
                    category: typeof paint === 'string' ? paint : paint.category,
                    depthWrite: true,
                    shaded: true,
                })
                : flatMaterial(materials, paint);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.onBeforeRender = updateUniforms;
            this.meshes.set(key, mesh);
            out.push(mesh);
        }
        return out;
    }
}

/**
 * A runway whose colour is not final yet, because the finest tile of the
 * terrain under it has not been drawn.
 *
 * Airfields are built at boot, before the first frame has put a single tile
 * on screen, so for most of them the ground's own tone cannot be read then;
 * and the first tile drawn there is a coarse one, whose facet under the strip
 * spans a district and may say "crop" over a field that is grass up close.
 * The strip is drawn in a stand-in tone meanwhile and repainted, with
 * {@link repaintGroundStrip}, each time a deeper tile is drawn under it.
 */
export interface GroundStrip {
    /** Scene positions to read the cover at: low threshold, midpoint, high threshold. */
    samples: { x: number; z: number }[];
    /** Its pavement, one mesh per LOD level. */
    meshes: THREE.Mesh[];
    /** Worst zoom among the samples last painted from; -1 for the stand-in. */
    paintedZoom: number;
    /** How far above the sampled ground colour this surface is lifted - see {@link runwayLighten}. */
    lighten: number;
}

/**
 * The strip's current reading: one cover per sample point, averaged - see
 * {@link combineCover} - or undefined where none of them has drawn ground yet.
 */
export function sampleGroundStrip(
    strip: GroundStrip, coverAt: (x: number, z: number) => TileCover | undefined,
): TileCover | undefined {
    return combineCover(strip.samples.map(p => coverAt(p.x, p.z)));
}

/** Repaint a runway strip in the colour of the ground under it. */
export function repaintGroundStrip(
    strip: GroundStrip, cover: TileCover, materials: SceneMaterialManager,
): void {
    const material = flatMaterial(materials, groundPaint(cover, strip.lighten));
    for (const mesh of strip.meshes) {
        mesh.material = material;
    }
    strip.paintedZoom = cover.zoom;
}

export interface AirfieldModel {
    model: Model;
    /** Scene position the geometry is built around. */
    origin: THREE.Vector3;
    /** Every runway, to be repainted as the ground under it is drawn. */
    groundStrips: GroundStrip[];
}

/**
 * Build one airfield.
 *
 * Returns undefined for an airfield with no runway, which the bake should not
 * produce but a hand-edited manifest can.
 */
/**
 * Elevation of the real ground at an ENU point, above the ellipsoid.
 *
 * Taxiways and aprons are draped on this rather than laid on the airfield's
 * plane. Only the runway strips are cut flat by the bake — the taxiway network
 * reaches a kilometre past them over ground nobody levelled, and on the plane
 * it floats or buries itself by up to twenty metres. Inside a runway's pad the
 * ground *is* the plane, so the two meet exactly where they have to.
 */
export type GroundElevation = (e: number, n: number) => number;

/**
 * Cover of the drawn terrain at an ENU point, or undefined where none is on
 * screen yet.
 */
export type GroundCover = (e: number, n: number) => TileCover | undefined;

export function buildAirfieldModel(
    airfield: Airfield, basis: EnuBasis, materials: SceneMaterialManager,
    groundElevationAt?: GroundElevation, groundCoverAt?: GroundCover,
): AirfieldModel | undefined {
    const primary = primaryRunway(airfield);
    if (primary === undefined) {
        return undefined;
    }

    const toEnu = (lat: number, lon: number) => {
        const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, 0, _ecef), _enu);
        return { e: enu.e, n: enu.n };
    };

    // The plane every part of this airfield is cut to, as the pads carry it.
    const planeCentre = toEnu(primary.lat, primary.lon);
    const riseAxis = bearingAxisAt(
        primary.lat, primary.lon, airfield.plane.headingDeg, toEnu);
    const elevationAt = (e: number, n: number): number =>
        airfield.plane.heightMsl + airfield.plane.gradient
        * ((e - planeCentre.e) * riseAxis.e + (n - planeCentre.n) * riseAxis.n);

    // Geometry is built around the primary runway's centre so the numbers
    // stay small: a float32 vertex 200 km from the play origin has decimetre
    // steps in it, and a runway edge stripe is 0.9 m wide.
    const originScene = sceneAt(basis, planeCentre.e, planeCentre.n,
        elevationAt(planeCentre.e, planeCentre.n));

    const place = (e: number, n: number, lift: number): THREE.Vector3 =>
        sceneAt(basis, e, n, elevationAt(e, n) + lift).sub(originScene);
    // Draped, for everything the bake did not flatten. Without a ground
    // function this falls back to the plane, which is what the geometry tests
    // and any caller with no terrain loaded get.
    const drape = (e: number, n: number, lift: number): THREE.Vector3 =>
        sceneAt(basis, e, n, (groundElevationAt?.(e, n) ?? elevationAt(e, n)) + lift)
            .sub(originScene);

    // Every runway - paved or not - is the ground it is cut into, sampled at
    // its two thresholds and its midpoint (see runwaySamplePoints) once per
    // runway here from whatever is drawn, and handed back to be repainted as
    // deeper tiles come in; until anything is drawn it is a stand-in tone for
    // its surface.
    const unpaved: { runway: AirfieldRunway; paint: Paint; zoom: number; points: { e: number; n: number }[] }[] = [];
    const surfacePaint = (runway: AirfieldRunway): Paint => {
        const lighten = runwayLighten(runway.surface);
        const points = runwaySamplePoints(runway).map(p => toEnu(p.lat, p.lon));
        // See RUNWAY_SEA_LEVEL_GUARD_M: a runway this low is exactly where the
        // bake's own coast-vector-vs-raster fallback can hand back Grass for
        // what is really still water, so its cover reading is not trusted.
        const nearSeaLevel = Math.abs(airfield.plane.heightMsl) <= RUNWAY_SEA_LEVEL_GUARD_M;
        const cover = nearSeaLevel
            ? undefined
            : combineCover(points.map(p => groundCoverAt?.(p.e, p.n)));
        const paint = cover !== undefined ? groundPaint(cover, lighten) : {
            // A guarded runway falls back to sand rather than its surface's
            // usual stand-in: the usual fallback (grass for a grass runway)
            // is the same wrong green the guard exists to avoid, and sand is
            // what the bake itself paints the equivalent low-lying disputed
            // ground beside the coast (see SHORE_SAND_M in buildTile.ts).
            category: nearSeaLevel ? PaletteCategory.TERRAIN_SAND : RUNWAY_FALLBACK_CATEGORY[runway.surface],
            lighten,
        };
        // A guarded strip is never repainted: its cover is never trusted, no
        // matter how deep a tile eventually draws under it.
        unpaved.push({ runway, paint, zoom: nearSeaLevel ? Infinity : cover?.zoom ?? -1, points });
        return paint;
    };
    const paints = new Map(airfield.runways.map(r => [r, surfacePaint(r)]));

    const levels: Model['lod'] = [];
    const flatsPerLevel: MeshParts[] = [];
    let maxSize = 0;
    for (let level = 0; level < LOD_KINDS.length; level++) {
        const kinds = new Set(LOD_KINDS[level]);
        const parts = new MeshParts();
        const solids = new MeshParts(true);
        flatsPerLevel.push(parts);

        if (level <= LOD_WITH_SURROUNDS) {
            // Drawn under the runways, so a taxiway crossing one loses.
            const pavement = groundSurfaceOf(airfield);
            addAprons(parts, airfield, toEnu, drape, pavement);
            addTaxiways(parts, airfield, toEnu, drape, kinds.has('centreline'), pavement);
            addBuildings(solids, airfield, toEnu, drape);
        }
        for (const runway of airfield.runways) {
            maxSize = Math.max(maxSize, runway.lengthM);
            addRunway(parts, runway, paints.get(runway)!, kinds, toEnu, place);
        }
        levels.push({ flats: parts.build(materials), volumes: solids.build(materials) });
    }
    const groundStrips: GroundStrip[] = unpaved.map(({ runway, paint, zoom, points }) => {
        const key = paintKey(paint);
        return {
            samples: points.map(p => sceneAt(basis, p.e, p.n, elevationAt(p.e, p.n))),
            meshes: flatsPerLevel.flatMap(parts => {
                const mesh = parts.meshes.get(key);
                return mesh === undefined ? [] : [mesh];
            }),
            paintedZoom: zoom,
            lighten: runwayLighten(runway.surface),
        };
    });
    return {
        model: {
            lod: levels,
            animations: [],
            maxSize: Math.max(maxSize, 1),
            center: new THREE.Vector3(),
        },
        origin: originScene,
        groundStrips,
    };
}

/** Scene position of an ENU point at a given elevation. */
function sceneAt(basis: EnuBasis, e: number, n: number, elevation: number): THREE.Vector3 {
    const g = enuToGeodeticApprox(basis, e, n, 0);
    geodeticToEcef(g.lat, g.lon, elevation, _ecef);
    return sceneFromEnu(ecefToEnu(basis, _ecef, _enu));
}

/** Twice the signed area of a ring in east/north; positive is counter-clockwise. */
function signedArea(ring: readonly { e: number; n: number }[]): number {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        sum += a.e * b.n - b.e * a.n;
    }
    return sum;
}

type Place = (e: number, n: number, lift: number) => THREE.Vector3;
type ToEnu = (lat: number, lon: number) => { e: number; n: number };

function addRunway(
    parts: MeshParts, runway: AirfieldRunway, pavement: Paint, kinds: Set<MarkingKind>,
    toEnu: ToEnu, place: Place,
): void {
    const centre = toEnu(runway.lat, runway.lon);
    const axis = bearingAxisAt(runway.lat, runway.lon, runway.headingDeg, toEnu);
    // Right of the runway axis, which is what the marking layout calls +v.
    const right = { e: axis.n, n: -axis.e };
    const at = (u: number, v: number, lift: number) => place(
        centre.e + axis.e * u + right.e * v,
        centre.n + axis.n * u + right.n * v,
        lift,
    );

    for (const rect of runwayMarkings(
        runway.lengthM, runway.widthM, runway.ref, runway.surface)) {
        if (!kinds.has(rect.kind)) {
            continue;
        }
        const paint = rect.kind === 'pavement' ? pavement : MARKING_CATEGORY[rect.kind];
        const lift = AIRFIELD_SURFACE_EPS_M + (rect.kind === 'pavement' ? 0 : PAINT_LIFT_M);
        parts.addQuad(paint, ...quadCorners(rect, at, lift));
    }
}

function quadCorners(
    rect: MarkingRect, at: (u: number, v: number, lift: number) => THREE.Vector3, lift: number,
): [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] {
    const u0 = rect.u - rect.lengthM / 2;
    const u1 = rect.u + rect.lengthM / 2;
    const v0 = rect.v - rect.widthM / 2;
    const v1 = rect.v + rect.widthM / 2;
    // Wound so the face normal points up in scene axes (x east, y up, z south).
    return [at(u0, v0, lift), at(u0, v1, lift), at(u1, v1, lift), at(u1, v0, lift)];
}

/** One usable leg of a taxiway centreline, with its left-hand normal. */
interface TaxiwaySegment {
    a: { e: number; n: number };
    de: number;
    dn: number;
    len: number;
    /** Unit normal, 90 degrees left of the direction of travel. */
    px: number;
    py: number;
}

/**
 * Below this a joint is straight and the two quads already meet along their
 * shared end edge. Filling it anyway would emit degenerate triangles for every
 * one of the many collinear nodes OSM puts down along a straight taxiway.
 */
const JOINT_MIN_TURN_RAD = 1 * Math.PI / 180;

/**
 * How far a joint fan may cut the corner off the turn it fills.
 *
 * The gap is a circular sector and this approximates it with a fan, so the
 * step count follows from the taxiway's own half width: a 23 m taxiway gets
 * five triangles round a 90 degree turn, and the 0.5 m centreline
 * stripe gets one, because at that radius a single chord is already inside a
 * decimetre of the arc.
 */
const JOINT_SAG_M = 0.2;

/** Most triangles one joint may spend, for a taxiway that doubles back. */
const JOINT_MAX_STEPS = 16;

/**
 * Below this a node is a wobble in the digitising, not a bend.
 *
 * A straight taxiway is not noded straight: OSM puts a node every hundred
 * metres along it and each one is out by a fraction of a degree. Splining
 * through those bows the run between them, and a taxiway laid alongside a
 * runway that undulates against it is worse than one that is faceted. So a
 * node under this threshold has its tangent pinned to the chord, which makes
 * the cubic through it collapse to exactly the straight line it replaces.
 */
const SMOOTH_MIN_TURN_RAD = 2 * Math.PI / 180;

/** How far a smoothed span may sit off its chord before it is subdivided again. */
const SMOOTH_SAG_M = 0.5;

/** Most extra points one span may spend, for a corner splined at full width. */
const SMOOTH_MAX_STEPS = 8;

/**
 * How far either side of a bend the curve through it reaches, in taxiway
 * widths.
 *
 * This is the fillet's own size, and it is what keeps the smoothing local. A
 * long leg is cut at this distance from the bend at its end and the cut point
 * pinned straight, so a bend two hundred metres down an otherwise straight
 * taxiway is rounded over the twenty metres around it and the other hundred
 * and eighty are left exactly where OSM put them.
 *
 * One width is about what a real fillet is: wide enough to read as a curve
 * from the air, short enough that the pavement never leaves its own corridor.
 */
const SMOOTH_REACH_WIDTHS = 1;

/**
 * A Catmull-Rom tangent, held to a length.
 *
 * Two things need holding. The tangent at a node is taken across it from both
 * neighbours, so where the legs either side are wildly different lengths — a
 * 10 m link off a 400 m straight, which is most of how a taxiway network joins
 * up — it comes out many times the length of the short leg and the cubic loops
 * right round. Sampling that loop puts a kink in the pavement far sharper than
 * the corner it was smoothing: unheld, Las Palmas went from a worst turn of 36
 * degrees to one of 148.
 *
 * The other is reach. A cubic leaves its chord by an eighth of the difference
 * between its two end tangents, so a tangent as long as the chord bows a long
 * leg in proportion to how long it is: a shallow bend at the end of a 100 m
 * straight dragged the whole straight 5 m sideways. Holding every tangent to
 * {@link SMOOTH_REACH_WIDTHS} of the taxiway's width instead makes the bend
 * cost the same wherever it is, and bounds the wander at a quarter of that
 * however sharp the turn.
 *
 * Scaling a tangent does not bend anything on its own: a span with both ends
 * held to the same length is still the straight line between them, whatever
 * that length is. Only the direction can bend it.
 */
function heldTangent(te: number, tn: number, limit: number): [number, number] {
    const len = Math.hypot(te, tn);
    return len > limit && len > 0 ? [(te / len) * limit, (tn / len) * limit] : [te, tn];
}

/**
 * Resample a taxiway centreline through a guarded Catmull-Rom.
 *
 * OSM digitises a curve as chords, so the pavement kinks at every node. The
 * fillet in {@link addTaxiwayJoint} rounds the *edges* of that kink but not
 * the path down the middle of it, which is what the centreline stripe follows
 * and what reads as a bend rather than a curve.
 *
 * Centripetal rather than uniform, because the node spacing here is not
 * remotely even — a few metres round a curve against a hundred down a
 * straight — and uniform Catmull-Rom cusps and self-intersects on exactly
 * that input.
 *
 * Guarded three ways, because a spline through every node is wrong for
 * pavement — this is a surveyed surface, not a curve through some points, and
 * every metre it wanders is a metre of taxiway on ground nobody paved:
 *
 *  - A node that is not a real bend keeps a chord tangent, which collapses the
 *    cubic through it to the straight line it replaced. So a straight run
 *    noded every hundred metres, each node out by a fraction of a degree,
 *    comes back exactly as it went in ({@link SMOOTH_MIN_TURN_RAD}).
 *  - A bend is rounded over a fixed reach either side and no further, so the
 *    cost of a bend does not grow with the legs that meet at it
 *    ({@link SMOOTH_REACH_WIDTHS}).
 *  - A span that still leaves its chord by more than half the taxiway's width
 *    is dropped back to that chord. Nothing measured across the baked fields
 *    trips this — the worst departure anywhere is 2.4 m on a 23 m taxiway —
 *    which is the point: it is the backstop that makes the bound a bound.
 *
 * Subdivision follows the departure it measures, so a span already within
 * {@link SMOOTH_SAG_M} of its chord — which is 96% of them, given how finely
 * a curve is noded — emits its endpoint and no more.
 *
 * Note what this does not do. A Catmull-Rom passes *through* every node, so it
 * eases a bend by spreading the turn either side of it; it cannot cut the
 * corner off, which is what a real fillet does. That leaves a slight
 * counter-bow on the approach, under a metre. Cutting corners properly wants
 * an approximating curve — a quadratic Bezier across the two cut points, with
 * the bend itself as the control point — which the cuts below already set up.
 */
export function smoothCentreline(
    points: readonly { e: number; n: number }[], widthM: number,
): { e: number; n: number }[] {
    const maxOffsetM = widthM / 2;
    const reach = widthM * SMOOTH_REACH_WIDTHS;
    // Duplicated nodes have no direction, and their zero chord divides through
    // the whole parameterisation. Out before anything measures an angle.
    let p: { e: number; n: number }[] = [];
    for (const q of points) {
        const last = p[p.length - 1];
        if (last === undefined || Math.hypot(q.e - last.e, q.n - last.n) >= DEGENERATE_SEGMENT_M) {
            p.push(q);
        }
    }
    if (p.length < 3) {
        return p;
    }

    /** True where the run really turns, and so where a smooth tangent belongs. */
    const turns = p.map((_, i) => {
        if (i === 0 || i === p.length - 1) {
            return false;
        }
        const ae = p[i].e - p[i - 1].e;
        const an = p[i].n - p[i - 1].n;
        const be = p[i + 1].e - p[i].e;
        const bn = p[i + 1].n - p[i].n;
        return Math.abs(Math.atan2(ae * bn - an * be, ae * be + an * bn)) >= SMOOTH_MIN_TURN_RAD;
    });

    // Cut every leg longer than the fillet a fillet's reach short of the bend
    // at either end of it, and pin the cut straight. Without this the cubic
    // runs the length of the leg and a bend at the end of a long straight
    // drags the whole straight sideways; with it, the leg arrives straight and
    // turns only where it has to. The cuts are also what put a bend's two
    // neighbours the same distance away, which is what a Catmull-Rom tangent
    // wants and what OSM, joining a 10 m link to a 400 m straight, never gives.
    const nodes: { e: number; n: number }[] = [];
    const corner: boolean[] = [];
    for (let i = 0; i + 1 < p.length; i++) {
        nodes.push(p[i]);
        corner.push(turns[i]);
        const de = p[i + 1].e - p[i].e;
        const dn = p[i + 1].n - p[i].n;
        const len = Math.hypot(de, dn);
        const cuts = (turns[i] ? 1 : 0) + (turns[i + 1] ? 1 : 0);
        // Two cuts need room for both, or they would cross and unstraighten
        // the very leg they were meant to hold.
        if (cuts === 0 || len <= cuts * reach) {
            continue;
        }
        for (const at of [turns[i] ? reach : 0, turns[i + 1] ? len - reach : 0]) {
            if (at > 0) {
                nodes.push({ e: p[i].e + (de / len) * at, n: p[i].n + (dn / len) * at });
                corner.push(false);
            }
        }
    }
    nodes.push(p[p.length - 1]);
    corner.push(false);
    p = nodes;

    /** Centripetal knot spacing: the square root of the chord. */
    const knot = (a: { e: number; n: number }, b: { e: number; n: number }) =>
        Math.sqrt(Math.hypot(b.e - a.e, b.n - a.n));

    const out = [p[0]];
    for (let i = 0; i + 1 < p.length; i++) {
        const p1 = p[i];
        const p2 = p[i + 1];
        const chordE = p2.e - p1.e;
        const chordN = p2.n - p1.n;
        const chordLen = Math.hypot(chordE, chordN);
        const dB = knot(p1, p2);

        // A tangent at a corner is the non-uniform Catmull-Rom one, taken
        // across the node from its two neighbours; anywhere else it is the
        // chord, which is what makes the cubic reduce to the chord itself.
        // Both ends are held to the same length, so a span between two
        // straight nodes stays exactly the straight line it was.
        const limit = Math.min(chordLen, reach);
        let [t1e, t1n] = heldTangent(chordE, chordN, limit);
        if (corner[i]) {
            const p0 = p[i - 1];
            const w = dB / (knot(p0, p1) + dB);
            [t1e, t1n] = heldTangent(w * (p2.e - p0.e), w * (p2.n - p0.n), limit);
        }
        let [t2e, t2n] = heldTangent(chordE, chordN, limit);
        if (corner[i + 1]) {
            const p3 = p[i + 2];
            const w = dB / (dB + knot(p2, p3));
            [t2e, t2n] = heldTangent(w * (p3.e - p1.e), w * (p3.n - p1.n), limit);
        }

        // Hermite over the unit interval, which is the same cubic.
        const at = (u: number) => {
            const uu = u * u;
            const uuu = uu * u;
            const h00 = 2 * uuu - 3 * uu + 1;
            const h10 = uuu - 2 * uu + u;
            const h01 = -2 * uuu + 3 * uu;
            const h11 = uuu - uu;
            return {
                e: h00 * p1.e + h10 * t1e + h01 * p2.e + h11 * t2e,
                n: h00 * p1.n + h10 * t1n + h01 * p2.n + h11 * t2n,
            };
        };

        // How far the span leaves its chord. Sampled at three points rather
        // than at the middle alone: a span with a tangent at each end pulling
        // opposite ways is an S, and an S crosses its chord exactly at the
        // middle while running far off it either side.
        let offset = 0;
        for (const u of [0.25, 0.5, 0.75]) {
            const q = at(u);
            // Sideways off the chord, not distance to the chord point at the
            // same u: holding the tangents short slides the samples along the
            // line without moving them off it, and that is not a departure.
            offset = Math.max(offset,
                Math.abs((q.e - p1.e) * chordN - (q.n - p1.n) * chordE) / chordLen);
        }
        // Chord error falls as the square of the step count, so this is the
        // count that brings it under the sag.
        const steps = offset > maxOffsetM
            ? 1
            : Math.min(SMOOTH_MAX_STEPS, Math.max(1, Math.ceil(Math.sqrt(offset / SMOOTH_SAG_M))));
        for (let s = 1; s < steps; s++) {
            out.push(at(s / steps));
        }
        out.push(p2);
    }
    return out;
}

function addTaxiways(
    parts: MeshParts, airfield: Airfield, toEnu: ToEnu, place: Place, withStripe: boolean,
    pavement: PaletteCategory,
): void {
    for (const taxiway of airfield.taxiways) {
        // Smoothed before it is cut into segments, so the pavement and the
        // stripe painted down the middle of it follow the same path.
        const points = smoothCentreline(
            taxiway.points.map(p => toEnu(p[0], p[1])), taxiway.widthM);
        // Segments are collected first so a turn can be measured *across* a
        // joint. Dropping the degenerate ones here rather than skipping them
        // in the middle of the walk matters: a duplicated node would otherwise
        // leave the two real segments either side of it unjoined, which is
        // exactly where a joint is most needed.
        const segments: TaxiwaySegment[] = [];
        for (let i = 0; i + 1 < points.length; i++) {
            const a = points[i];
            const b = points[i + 1];
            const de = b.e - a.e;
            const dn = b.n - a.n;
            const len = Math.hypot(de, dn);
            if (len < DEGENERATE_SEGMENT_M) {
                continue;
            }
            segments.push({ a, de, dn, len, px: -dn / len, py: de / len });
        }

        const lay = (width: number, lift: number, category: PaletteCategory) => {
            const h = width / 2;
            for (const seg of segments) {
                const { a, de, dn, px, py } = seg;
                // Cut into steps so the strip follows the ground under it
                // instead of spanning a rise as one flat quad.
                const steps = Math.max(1, Math.ceil(seg.len / TAXIWAY_STEP_M));
                for (let s = 0; s < steps; s++) {
                    const t0 = s / steps;
                    const t1 = (s + 1) / steps;
                    const e0 = a.e + de * t0;
                    const n0 = a.n + dn * t0;
                    const e1 = a.e + de * t1;
                    const n1 = a.n + dn * t1;
                    parts.addQuad(category,
                        place(e0 + px * h, n0 + py * h, lift),
                        place(e0 - px * h, n0 - py * h, lift),
                        place(e1 - px * h, n1 - py * h, lift),
                        place(e1 + px * h, n1 + py * h, lift));
                }
            }
            for (let i = 0; i + 1 < segments.length; i++) {
                addTaxiwayJoint(parts, segments[i], segments[i + 1], h, lift, category, place);
            }
        };

        lay(taxiway.widthM, AIRFIELD_SURFACE_EPS_M, pavement);
        if (withStripe) {
            lay(TAXIWAY_STRIPE_M, AIRFIELD_SURFACE_EPS_M + PAINT_LIFT_M,
                PaletteCategory.SCENERY_FIELD_YELLOW);
        }
    }
}

/**
 * Fills the wedge two segments leave open on the outside of a turn.
 *
 * Each leg is laid as its own rectangle around its own perpendicular, so at a
 * bend the two rectangles overlap on the inside of the turn and pull apart on
 * the outside, leaving a triangular notch of bare ground biting into the
 * pavement — one per node, and OSM nodes a curve every few metres, so a curved
 * taxiway comes out scalloped along its outer edge.
 *
 * The missing piece is a circular sector at the shared node, between the two
 * legs' outer edges, so that is what goes in: a fan of the same pavement, at
 * the same lift. Rounded rather than mitred because a mitre runs away to
 * infinity as the turn approaches a reversal, and because a real taxiway
 * fillet is a curve anyway.
 */
function addTaxiwayJoint(
    parts: MeshParts, prev: TaxiwaySegment, next: TaxiwaySegment,
    half: number, lift: number, category: PaletteCategory, place: Place,
): void {
    const cross = prev.de * next.dn - prev.dn * next.de;
    const dot = prev.de * next.de + prev.dn * next.dn;
    const turn = Math.atan2(Math.abs(cross), dot);
    if (turn < JOINT_MIN_TURN_RAD) {
        return;
    }
    // The node itself: the end of `prev`, which is the start of `next`.
    const ce = prev.a.e + prev.de;
    const cn = prev.a.n + prev.dn;

    // A left turn (cross > 0) opens the gap on the right of the run, and the
    // right-hand normal is -p. The fan sweeps from prev's outer normal to
    // next's, which turns the same way the run does.
    const side = cross > 0 ? -1 : 1;
    const signed = cross > 0 ? turn : -turn;
    const chord = Math.max(-1, Math.min(1, 1 - JOINT_SAG_M / half));
    const perStep = 2 * Math.acos(chord);
    const steps = Math.max(1, Math.min(JOINT_MAX_STEPS, Math.ceil(turn / perStep)));

    const startE = prev.px * side;
    const startN = prev.py * side;
    const centre = place(ce, cn, lift);
    const rim = (t: number) => {
        const angle = signed * t;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        // Rotating the normal by the same signed angle the direction turns
        // through walks the rim from prev's outer edge to next's.
        return place(
            ce + half * (startE * cos - startN * sin),
            cn + half * (startE * sin + startN * cos),
            lift);
    };

    let from = rim(0);
    for (let s = 1; s <= steps; s++) {
        const to = rim(s / steps);
        // Wound counter-clockwise in east/north, which is what faces up once
        // east/north become the scene's x and -z; see addAprons.
        if (signed > 0) {
            parts.add(category, centre, from, to);
        } else {
            parts.add(category, centre, to, from);
        }
        from = to;
    }
}

/**
 * The terminals, hangars and control towers, as boxes.
 *
 * Boxes because that is what they are from the air, and because the sim draws
 * everything else this way: one flat colour per surface, no texture, no roof
 * pitch. A hangar seen from a mile up is a rectangle with a bright top and a
 * shaded side, and putting more into it would look less like the rest of the
 * world rather than more like an airport.
 *
 * The base sits at the *lowest* of the four corners' ground heights. Taking
 * the centre instead leaves a building on a slope with one corner in the air,
 * which is the one failure that reads instantly as wrong.
 */
function addBuildings(
    parts: MeshParts, airfield: Airfield, toEnu: ToEnu, place: Place,
): void {
    for (const building of airfield.buildings) {
        const centre = toEnu(building.lat, building.lon);
        const r = building.headingDeg * Math.PI / 180;
        // The footprint's long axis, and the direction across it.
        const ax = Math.sin(r);
        const ay = Math.cos(r);
        const halfDepth = building.depthM / 2;
        const halfWidth = building.widthM / 2;
        if (halfDepth < 1 || halfWidth < 1) {
            continue;
        }

        const corner = (along: number, across: number) => ({
            e: centre.e + ax * along + ay * across,
            n: centre.n + ay * along - ax * across,
        });
        const feet = [
            corner(-halfDepth, -halfWidth),
            corner(-halfDepth, halfWidth),
            corner(halfDepth, halfWidth),
            corner(halfDepth, -halfWidth),
        ];
        // `place` lifts by whatever it is given; ask for the ground itself and
        // take the lowest corner so nothing is left standing on one leg.
        const ground = feet.map(f => place(f.e, f.n, 0));
        let baseY = Infinity;
        for (const g of ground) {
            baseY = Math.min(baseY, g.y);
        }
        const height = buildingHeightM(building);
        const category = BUILDING_CATEGORY[building.kind]
            ?? PaletteCategory.SCENERY_BUILDING_CONCRETE;

        const low = ground.map(g => g.clone().setY(baseY));
        const high = low.map(g => g.clone().setY(baseY + height));
        // Walls, wound so the outward face is the front one. The feet run
        // counter-clockwise seen from above, which puts the outside on the
        // right of each edge — so the quad goes up the *far* corner first.
        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            parts.addQuad(category, low[j], high[j], high[i], low[i]);
        }
        parts.addQuad(category, high[0], high[1], high[2], high[3]);
    }
}

function addAprons(
    parts: MeshParts, airfield: Airfield, toEnu: ToEnu, place: Place,
    pavement: PaletteCategory,
): void {
    for (const apron of airfield.aprons) {
        const ring = apron.ring.map(p => toEnu(p[0], p[1]));
        // OSM closes its rings by repeating the first node; the triangulator
        // wants an open contour and produces a degenerate ear from the repeat.
        if (ring.length > 1
            && Math.abs(ring[0].e - ring[ring.length - 1].e) < 1e-6
            && Math.abs(ring[0].n - ring[ring.length - 1].n) < 1e-6) {
            ring.pop();
        }
        if (ring.length < 3) {
            continue;
        }
        // Turned counter-clockwise in east/north, which is the winding that
        // comes out facing up once east/north becomes the scene's x and -z.
        //
        // OSM does not promise either winding on a closed way, and it really
        // does use both: across the baked airfields, 118 apron rings run one
        // way and 170 the other. Triangulated blind, half of every airfield's
        // ramp is emitted back-facing — and the mesh material culls back faces,
        // so half the aprons simply are not there. Saki draws seven of its
        // fourteen.
        if (signedArea(ring) < 0) {
            ring.reverse();
        }
        const contour = ring.map(p => new THREE.Vector2(p.e, p.n));
        let faces: number[][];
        try {
            faces = THREE.ShapeUtils.triangulateShape(contour, []);
        } catch {
            // A self-intersecting apron is a mapping error, not a reason to
            // drop the whole airfield.
            continue;
        }
        for (const face of faces) {
            parts.add(
                pavement,
                place(ring[face[0]].e, ring[face[0]].n, AIRFIELD_SURFACE_EPS_M),
                place(ring[face[1]].e, ring[face[1]].n, AIRFIELD_SURFACE_EPS_M),
                place(ring[face[2]].e, ring[face[2]].n, AIRFIELD_SURFACE_EPS_M),
            );
        }
    }
}
