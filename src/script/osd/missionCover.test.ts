import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TERRAIN_COLOUR_MODE_INDEX, TerrainColours } from '../state/gameDefs';
import { makeEnuBasis } from '../terrain/geodesy';
import { PtmTile } from '../terrain/ptm';
import { TileKey, tileAtLonLat, tileBounds } from '../terrain/tiling';
import { TerrainClass, TerrainTone } from '../terrain/tones';
import { DEFAULT_FACET_SHADE, FacetPalette, Rgb } from '../mission/facetColour';
import { MapView } from '../mission/mapProjection';
import { tileOriginWorld } from '../terrain/tileMesh';
import { MissionCoverRaster, hexToRgb } from './missionCover';

/**
 * The cover layer against synthetic tiles. What matters is that it paints the
 * mesh's own colours where the mesh has something to say, leaves everything
 * else alone for the height layer underneath, and refuses to blanket the view
 * with a tile far coarser than the screen.
 */

const ORIGIN = { lat: 28.0015, lon: -15.3937 };
const BASIS = makeEnuBasis(ORIGIN.lat, ORIGIN.lon, 0);

const GRASS: Rgb = { r: 0.30, g: 0.50, b: 0.25 };
const WATER: Rgb = { r: 0.10, g: 0.40, b: 0.50 };

function palette(over: Partial<FacetPalette> = {}): FacetPalette {
    const tones: Rgb[] = [];
    tones[TerrainTone.Water] = WATER;
    tones[TerrainTone.ShallowWater] = { r: 0.2, g: 0.5, b: 0.6 };
    tones[TerrainTone.Sand] = { r: 0.8, g: 0.75, b: 0.55 };
    tones[TerrainTone.Grass] = GRASS;
    tones[TerrainTone.Bare] = { r: 0.5, g: 0.45, b: 0.4 };
    tones[TerrainTone.Forest] = { r: 0.12, g: 0.30, b: 0.14 };
    tones[TerrainTone.Scrub] = { r: 0.4, g: 0.44, b: 0.26 };
    tones[TerrainTone.Crop] = { r: 0.55, g: 0.55, b: 0.25 };
    tones[TerrainTone.Urban] = { r: 0.45, g: 0.44, b: 0.43 };
    tones[TerrainTone.Snow] = { r: 0.92, g: 0.94, b: 0.96 };
    tones[TerrainTone.Wetland] = { r: 0.3, g: 0.4, b: 0.35 };
    return {
        mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.LANDCOVER],
        toneColours: tones,
        swatches: [],
        ...DEFAULT_FACET_SHADE,
        ...over,
    };
}

/**
 * A tile whose land is one big quad of `cls`, covering most of its own bounds.
 * Positions are quantised offsets from the tile centre, exactly as baked.
 */
function tileOf(id: TileKey, cls: number, withWater = false): PtmTile {
    const b = tileBounds(id);
    // Half the tile's ground span in metres, roughly; the exact figure does not
    // matter because the raster derives its bitmap bounds from the vertices.
    const halfM = (b.east - b.west) * 111320 * Math.cos(ORIGIN.lat * Math.PI / 180) / 2;
    const q = 1;
    const h = Math.round(halfM * 0.9);
    // Two triangles, counter-clockwise, spanning the tile.
    const corners: Array<[number, number]> = [
        [-h, -h], [h, -h], [h, h],
        [-h, -h], [h, h], [-h, h],
    ];
    const landPositions = new Int16Array(corners.length * 3);
    for (let i = 0; i < corners.length; i++) {
        landPositions[i * 3] = corners[i][0];
        landPositions[i * 3 + 1] = 0;
        landPositions[i * 3 + 2] = corners[i][1];
    }
    const landAttrs = new Uint8Array(corners.length * 4);
    for (let i = 0; i < corners.length; i++) {
        landAttrs[i * 4] = 128;
        landAttrs[i * 4 + 1] = 128;
        landAttrs[i * 4 + 2] = 128;
        landAttrs[i * 4 + 3] = cls;
    }

    // Optional water: one triangle over the tile's north-west quarter.
    const waterPositions = withWater
        ? new Int16Array([-h, 0, -h, 0, 0, -h, -h, 0, 0])
        : new Int16Array(0);
    const waterIndices = withWater ? new Uint16Array([0, 1, 2]) : new Uint16Array(0);
    const waterGroups: Array<readonly [number, number]> = withWater
        ? [[0, 3], [0, 0]]
        : [[0, 0], [0, 0]];

    return {
        id, version: 5, flags: 0, centerHeightM: 0, quantScale: q,
        boundingRadiusM: halfM, skirtDepthM: 0, geometricErrorM: 0,
        landPositions, landNormals: new Int8Array(corners.length * 4), landAttrs,
        waterPositions, waterTones: new Uint8Array(0), waterIndices, waterGroups,
        riverPositions: new Int16Array(0), riverDirections: new Int8Array(0),
        riverHalfWidths: new Uint16Array(0), riverIndices: new Uint16Array(0),
    };
}

function view(over: Partial<MapView> = {}): MapView {
    return { centreX: 0, centreZ: 0, mPerPx: 60, widthPx: 64, heightPx: 64, ...over };
}

function blank(w: number, h: number): Uint8ClampedArray {
    return new Uint8ClampedArray(w * h * 4);
}

/** RGB at a pixel. */
function px(buf: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number] {
    const at = (y * w + x) * 4;
    return [buf[at], buf[at + 1], buf[at + 2]];
}

describe('hexToRgb', () => {
    it('reads the palette\'s own colour strings', () => {
        assert.deepEqual(hexToRgb('#ffffff'), { r: 1, g: 1, b: 1 });
        assert.deepEqual(hexToRgb('#000000'), { r: 0, g: 0, b: 0 });
        const half = hexToRgb('#804020');
        assert.ok(Math.abs(half.r - 128 / 255) < 1e-9);
        assert.ok(Math.abs(half.g - 64 / 255) < 1e-9);
        assert.ok(Math.abs(half.b - 32 / 255) < 1e-9);
    });

    it('expands the three-digit form', () => {
        assert.deepEqual(hexToRgb('#fff'), { r: 1, g: 1, b: 1 });
    });
});

describe('MissionCoverRaster', () => {
    const fineId = tileAtLonLat(11, ORIGIN.lon, ORIGIN.lat);

    it('paints the mesh colour for a land facet', () => {
        const cover = new MissionCoverRaster();
        cover.setTiles([{ id: fineId, tile: tileOf(fineId, TerrainClass.Grass) }],
            BASIS, palette());
        const out = blank(64, 64);
        cover.render(view());
        const painted = cover.compositeInto(out, 64, 64);
        assert.ok(painted > 0, 'nothing was painted');
        const [r, g, b] = px(out, 64, 32, 32);
        // Within one: a Uint8ClampedArray rounds halves to even, so an exact
        // Math.round comparison is off by one on values landing on .5.
        assert.ok(Math.abs(r - GRASS.r * 255) <= 1, `r ${r}`);
        assert.ok(Math.abs(g - GRASS.g * 255) <= 1, `g ${g}`);
        assert.ok(Math.abs(b - GRASS.b * 255) <= 1, `b ${b}`);
    });

    it('leaves untouched pixels alone for the layer underneath', () => {
        const cover = new MissionCoverRaster();
        cover.setTiles([{ id: fineId, tile: tileOf(fineId, TerrainClass.Grass) }],
            BASIS, palette());
        // A view far away from the tile: nothing of it is visible.
        const out = blank(64, 64);
        out.fill(7);
        cover.render(view({ centreX: 4e6, centreZ: 4e6 }));
        const painted = cover.compositeInto(out, 64, 64);
        assert.equal(painted, 0);
        assert.deepEqual(px(out, 64, 32, 32), [7, 7, 7], 'painted over the fallback');
    });

    it('paints water from the mesh, not from a height threshold', () => {
        // The whole reason this layer exists: the coast is baked geometry.
        const cover = new MissionCoverRaster();
        cover.setTiles([{ id: fineId, tile: tileOf(fineId, TerrainClass.Grass, true) }],
            BASIS, palette());
        // Centred on the tile and wide enough to hold all of it: the water is
        // one quadrant, and the play origin is not the tile's centre.
        const centre = tileOriginWorld(fineId, 0, BASIS);
        const out = blank(64, 64);
        cover.render(view({ centreX: centre.x, centreZ: centre.z, mPerPx: 300 }));
        cover.compositeInto(out, 64, 64);
        const seen = new Set<string>();
        for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
                seen.add(px(out, 64, x, y).join(','));
            }
        }
        const isWater = [...seen].some(k => {
            const [r, g, b] = k.split(',').map(Number);
            return Math.abs(r - WATER.r * 255) <= 1
                && Math.abs(g - WATER.g * 255) <= 1
                && Math.abs(b - WATER.b * 255) <= 1;
        });
        assert.ok(isWater, `no water painted; saw ${[...seen].join(' | ')}`);
    });

    it('stays sharp when zoomed far past a tile\'s own detail', () => {
        // The reason this rasterises to screen rather than through a per-tile
        // bitmap: a bitmap fixes the detail a tile can ever show, and the guard
        // that suppressed a too-coarse tile then rejected the very tiles just
        // fetched for that view, leaving the height layer showing through in
        // tile-shaped rectangles.
        const cover = new MissionCoverRaster();
        cover.setTiles([{ id: fineId, tile: tileOf(fineId, TerrainClass.Grass) }],
            BASIS, palette());
        const centre = tileOriginWorld(fineId, 0, BASIS);
        const out = blank(64, 64);
        // Two metres per pixel: a 128-texel bitmap would be magnified ~20x.
        cover.render(view({ centreX: centre.x, centreZ: centre.z, mPerPx: 2 }));
        const painted = cover.compositeInto(out, 64, 64);
        assert.ok(painted > 3000, `only ${painted} px painted when zoomed right in`);
        const [r, g, b] = px(out, 64, 32, 32);
        assert.ok(Math.abs(r - GRASS.r * 255) <= 1
            && Math.abs(g - GRASS.g * 255) <= 1
            && Math.abs(b - GRASS.b * 255) <= 1, `got ${r},${g},${b}`);
    });

    it('rebuilds when the palette changes', () => {
        const cover = new MissionCoverRaster();
        const tiles = [{ id: fineId, tile: tileOf(fineId, TerrainClass.Grass) }];
        cover.setTiles(tiles, BASIS, palette());
        const first = blank(64, 64);
        cover.render(view());
        cover.compositeInto(first, 64, 64);

        const red: Rgb[] = palette().toneColours.slice();
        red[TerrainTone.Grass] = { r: 1, g: 0, b: 0 };
        cover.setTiles(tiles, BASIS, palette({ toneColours: red }));
        const second = blank(64, 64);
        cover.render(view());
        cover.compositeInto(second, 64, 64);

        assert.notDeepEqual(px(first, 64, 32, 32), px(second, 64, 32, 32),
            'the bitmap was reused after the palette changed');
        assert.deepEqual(px(second, 64, 32, 32), [255, 0, 0]);
    });

    it('caches a tile rather than rebuilding it each time', () => {
        const cover = new MissionCoverRaster();
        const tiles = [{ id: fineId, tile: tileOf(fineId, TerrainClass.Grass) }];
        cover.setTiles(tiles, BASIS, palette());
        assert.equal(cover.size, 1);
        cover.setTiles(tiles, BASIS, palette());
        assert.equal(cover.size, 1, 'the same tile was cached twice');
    });

    it('ignores a tile with no geometry at all', () => {
        const empty = tileOf(fineId, TerrainClass.Grass);
        const cover = new MissionCoverRaster();
        cover.setTiles([{
            id: fineId,
            tile: { ...empty, landPositions: new Int16Array(0), waterPositions: new Int16Array(0) },
        }], BASIS, palette());
        assert.equal(cover.size, 0);
    });
});
