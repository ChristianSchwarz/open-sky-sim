/**
 * Which baked area the session is flying in, and where its ENU origin sits.
 *
 * The world used to have exactly one origin, a constant in worldLayout.ts that
 * both the mesh bake and the runtime imported. That works while there is one
 * baked area and the hand-authored scenery — airbase, carrier, targets — is
 * built around it. Once a second area can be merged into the pyramid, the
 * origin has to be able to move, because ENU is a tangent frame: a thousand
 * kilometres from its origin the float32 the GPU gets for a vertex is coarse
 * enough to shimmer, and the ground is far below the horizon besides.
 *
 * So the origin becomes a function of the selected area. The area holding the
 * authored scenery keeps the original constant, exactly, so nothing about the
 * Canaries moves by a millimetre. Every other area gets its own box centre and
 * no scenery — there is no airbase there to place.
 */

import { TerrainArea, TerrainManifest } from './manifest';

export interface Geodetic {
    lat: number;
    lon: number;
    height: number;
}

export interface ActivePlayArea {
    area: TerrainArea;
    /** ENU origin to build the world around. */
    origin: Geodetic;
    /**
     * True when this is the area the authored scenery was placed in. Only then
     * does the airbase — and everything positioned relative to it — belong in
     * the scene.
     */
    isHome: boolean;
}

/**
 * The named areas, or one standing for the whole coverage box.
 *
 * A pyramid baked before areas were recorded has no list. Its coverage box is
 * a single area by construction, so describing it as one loses nothing.
 */
export function terrainAreas(manifest: TerrainManifest): TerrainArea[] {
    const areas = manifest.areas;
    if (areas && areas.length > 0) {
        return areas;
    }
    return [{ name: 'terrain', ...manifest.coverage }];
}

export function areaContains(area: TerrainArea, lat: number, lon: number): boolean {
    return lon >= area.west && lon <= area.east && lat >= area.south && lat <= area.north;
}

export function areaCentre(area: TerrainArea): Geodetic {
    return {
        lat: (area.south + area.north) / 2,
        lon: (area.west + area.east) / 2,
        height: 0,
    };
}

/**
 * The area holding `home`, if any.
 *
 * Found by position rather than by name so that renaming an area in the bake
 * cannot silently strand the scenery in a place it was not built for.
 */
export function homeArea(
    areas: readonly TerrainArea[], home: Geodetic,
): TerrainArea | undefined {
    return areas.find(a => areaContains(a, home.lat, home.lon));
}

/**
 * Pick the area to fly in.
 *
 * Falls back to home, then to the first area, so a stale name in saved
 * settings — an area since renamed or never baked in this clone — puts the
 * player somewhere real instead of failing to boot.
 */
export function resolvePlayArea(
    manifest: TerrainManifest,
    home: Geodetic,
    selectedName?: string,
): ActivePlayArea {
    const areas = terrainAreas(manifest);
    const atHome = homeArea(areas, home);
    const named = selectedName
        ? areas.find(a => a.name === selectedName)
        : undefined;
    const area = named ?? atHome ?? areas[0];
    const isHome = atHome !== undefined && area.name === atHome.name;
    return {
        area,
        // Home keeps the authored origin exactly, not the box centre: the
        // scenery is placed in metres from it, and a centre a few kilometres
        // off would drag the whole airbase across the island.
        origin: isHome ? home : areaCentre(area),
        isHome,
    };
}
