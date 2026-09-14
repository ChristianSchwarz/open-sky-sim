/** Terrain manifest v4, written by tools/bake_planet_mesh.ts. */

import { LonLatBounds } from './tiling';

export interface MeshStreamManifest {
    /** Path template, e.g. `{z}/{x}/{y}.ptm`. */
    path: string;
    indexPath: string;
    minZoom: number;
    maxZoom: number;
    encoding: string;
    /** `gzip` when tiles are stored pre-compressed and served with the header. */
    transport?: string;
    triangleBudget: number;
    /**
     * Per level, the largest header error of any tile on it. A node refines
     * on this until its tile is resident and can answer for itself - see
     * QuadtreeOptions.tileErrorM.
     */
    levelGeometricErrorM: number[];
    levelSkirtDepthM: number[];
    /**
     * The colours the SWATCH terrain mode quantises to, `#rrggbb`, most-used
     * first. Derived by the bake from the imagery it actually sampled, so it
     * describes this pyramid and travels with it. Absent on a pyramid baked
     * without cover, which leaves that mode with nothing to quantise to.
     */
    swatches?: string[];
    /**
     * Where this pyramid's baked colours sit in brightness. The HYBRID terrain
     * mode bands a facet against it, so it has to describe the ground actually
     * baked rather than an assumed mid-grey.
     */
    luminance?: { mid: number; spread: number };
}

/**
 * Far-tile cover textures, written by tools/bake_planet_tex.ts. One PTX1
 * raster per coarse tile, `size` texels across its lon/lat box, each texel
 * the same `r, g, b, TerrainClass` word a land vertex carries (alpha 255 =
 * no data). Absent on a pyramid baked without them, which the runtime treats
 * as "paint facets", exactly as before textures existed.
 */
export interface TextureStreamManifest {
    /** Path template, e.g. `{z}/{x}/{y}.ptx`. */
    path: string;
    indexPath: string;
    encoding: string;
    transport?: string;
    /** Texels across a far tile. Informational: every PTX1 carries its own size. */
    size: number;
    /** Texels across a tile at `nearZoom` and finer, where a texel per pixel is tight. */
    nearSize?: number;
    nearZoom?: number;
    minZoom: number;
    /** The leaf zoom less one: a leaf draws its own facets. */
    maxZoom: number;
}

export interface HeightStreamManifest {
    path: string;
    indexPath: string;
    tileSize: number;
    minZoom: number;
    maxZoom: number;
    /**
     * The single zoom every fine CPU height query samples. Pinning it is what
     * makes ground height independent of what the renderer happens to have
     * cached — the bug that made the same (x, z) return different heights
     * depending on camera position.
     */
    queryZoom: number;
    /** Always-resident fallback level, so a query outside the fine set is a
     *  coarse answer with a stated bound rather than a silent lie. */
    coarseZoom: number;
}

export interface FlattenPadManifest {
    lat: number;
    lon: number;
    /** Half extent across the pad axis (m). */
    halfW: number;
    /** Half extent along the pad axis (m). */
    halfD: number;
    featherM: number;
    /** Baked DEM height at the pad centre. */
    heightMsl: number;
    /**
     * True bearing the pad's long axis runs along. Absent means due north,
     * which is what every pad baked before pads could turn was.
     */
    headingDeg?: number;
    /**
     * Longitudinal slope of the platform this pad belongs to, rise per metre,
     * and the true bearing it rises along. Absent means level.
     *
     * The direction is recorded separately from `headingDeg` because a
     * crossing runway keeps its own footprint while being cut to the same
     * plane as the rest of its airfield — see `FlattenPad.gradE`. It defaults
     * to `headingDeg`, which covers every pad whose runway is the platform's.
     */
    gradient?: number;
    gradientHeadingDeg?: number;
    /** ICAO identifier of the airfield this pad belongs to, where it has one. */
    icao?: string;
}

/**
 * One area the bake was told to cover, named.
 *
 * `coverage` is the union box of every area, so with two of them it describes
 * a rectangle spanning the sea in between and cannot name either. This list
 * can, which is what makes "fly somewhere else" a thing the runtime can offer.
 * Absent on a pyramid baked before areas were recorded — treat that as one
 * unnamed area covering `coverage`.
 */
export interface TerrainArea extends LonLatBounds {
    name: string;
}

export interface TerrainManifest {
    version: number;
    scheme: 'retro-terrain/1';
    ellipsoid: 'WGS84';
    seaLevel: number;
    coverage: LonLatBounds;
    areas?: TerrainArea[];
    enuOrigin: { lat: number; lon: number; height: number };
    mesh: MeshStreamManifest;
    texture?: TextureStreamManifest;
    height: HeightStreamManifest;
    flattenPads: FlattenPadManifest[];
    /**
     * Where the airfield descriptions live, beside this file. Only a pointer:
     * the runways, taxiways and aprons of a whole pyramid are an order of
     * magnitude larger than the manifest, and the manifest is fetched before
     * anything can be drawn. See `airfields.ts`.
     */
    airfields?: { path: string; count: number };
    bake?: { tool: string; version: string; utc: string };
}

export const DEFAULT_TERRAIN_URL = 'assets/terrain/manifest.json';

export async function loadTerrainManifest(
    url: string = DEFAULT_TERRAIN_URL,
): Promise<TerrainManifest> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(
            `Failed to load terrain manifest ${url}: ${res.status}. `
            + 'The terrain pyramid is a build product — run `npm run bake:mesh`.',
        );
    }
    const m = await res.json() as TerrainManifest;
    if (m.scheme !== 'retro-terrain/1') {
        throw new Error(`Unsupported terrain manifest scheme: ${m.scheme}`);
    }
    return m;
}

function expand(template: string, z: number, x: number, y: number): string {
    return template
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
}

export function meshTileUrl(
    manifest: TerrainManifest, z: number, x: number, y: number, base: string,
): string {
    return `${base}/${expand(manifest.mesh.path, z, x, y)}`;
}

export function heightTileUrl(
    manifest: TerrainManifest, z: number, x: number, y: number, base: string,
): string {
    return `${base}/${expand(manifest.height.path, z, x, y)}`;
}

/** Only meaningful when `manifest.texture` is present. */
export function textureTileUrl(
    manifest: TerrainManifest, z: number, x: number, y: number, base: string,
): string {
    return `${base}/${expand(manifest.texture!.path, z, x, y)}`;
}

export function textureIndexUrl(manifest: TerrainManifest, base: string): string | undefined {
    return manifest.texture ? `${base}/${manifest.texture.indexPath}` : undefined;
}

export function meshIndexUrl(manifest: TerrainManifest, base: string): string {
    return `${base}/${manifest.mesh.indexPath}`;
}

export function heightIndexUrl(manifest: TerrainManifest, base: string): string {
    return `${base}/${manifest.height.indexPath}`;
}

/** Base directory the manifest was loaded from. */
export function baseUrlOf(manifestUrl: string): string {
    const i = manifestUrl.lastIndexOf('/');
    return i < 0 ? '.' : manifestUrl.slice(0, i);
}
