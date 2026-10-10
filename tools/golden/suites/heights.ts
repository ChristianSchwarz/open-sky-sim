/**
 * Terrain height-query fixtures (workstream G): HeightSampler over real DEM
 * tiles with the manifest's airfield flatten pads, as the physics sees the
 * ground. Fine tier: a 3x3 block of z11 tiles around Gran Canaria airport;
 * coarse tier: the z7 tile under it. Rail-bed clamping is not in this suite
 * (it needs the bed field and BandResolver; later).
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePdm, DemTile } from '../../../src/script/terrain/demTile';
import {
    applyFlattenPad, FlattenPad, FlattenPadRecord, PadGrid, padBlendWeight, padFromRecord, padReachM, padSurfaceHeight,
} from '../../../src/script/terrain/flattenPad';
import { ecefToEnu, geodeticToEcef, makeEnuBasis } from '../../../src/script/terrain/geodesy';
import { HeightSampler, isWaterHeight } from '../../../src/script/terrain/heightSampler';
import { TileKey, tileAtLonLat, tileKeyString } from '../../../src/script/terrain/tiling';
import { Rng, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

/** The airfield the fine block is centred on (GCLP), and the ENU origin of the home area. */
export const HEIGHT_CENTRE: [number, number] = [-15.3937, 28.0015];
export const HEIGHT_FINE_ZOOM = 11;
export const HEIGHT_COARSE_ZOOM = 7;
const PAD_RELEVANCE_M = 400_000;

/** The DEM tiles the suite needs, for selectTiles to copy. */
export function heightTileKeys(): TileKey[] {
    const centre = tileAtLonLat(HEIGHT_FINE_ZOOM, HEIGHT_CENTRE[0], HEIGHT_CENTRE[1]);
    const keys: TileKey[] = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            keys.push({ z: HEIGHT_FINE_ZOOM, x: centre.x + dx, y: centre.y + dy });
        }
    }
    keys.push(tileAtLonLat(HEIGHT_COARSE_ZOOM, HEIGHT_CENTRE[0], HEIGHT_CENTRE[1]));
    return keys;
}

function loadTiles(dir: string): Map<string, DemTile> {
    const out = new Map<string, DemTile>();
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir).sort()) {
        const m = /^(\d+)_(\d+)_(\d+)\.pdm$/.exec(name);
        if (!m) continue;
        out.set(`${m[1]}/${m[2]}/${m[3]}`, decodePdm(new Uint8Array(fs.readFileSync(path.join(dir, name)))));
    }
    return out;
}

export function heightsSuite(ctx: SuiteContext): SuiteOutput {
    const tilesDir = path.join(ctx.goldenRoot, 'tiles');
    const manifest = JSON.parse(fs.readFileSync(path.join(tilesDir, 'manifest.json'), 'utf8')) as {
        enuOrigin: { lat: number; lon: number; height: number }; seaLevel: number; flattenPads?: FlattenPadRecord[];
    };
    const dem = loadTiles(path.join(tilesDir, 'height'));
    const basis = makeEnuBasis(manifest.enuOrigin.lat, manifest.enuOrigin.lon, manifest.enuOrigin.height);
    const toEnu = (lat: number, lon: number) => {
        const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, 0));
        return { e: enu.e, n: enu.n };
    };
    const records = manifest.flattenPads ?? [];
    const pads: FlattenPad[] = records
        .map(p => padFromRecord(p, toEnu))
        .filter(p => Math.hypot(p.centerX, p.centerZ) - padReachM(p) <= PAD_RELEVANCE_M);

    const sampler = new HeightSampler({
        basis,
        seaLevel: manifest.seaLevel,
        queryZoom: HEIGHT_FINE_ZOOM,
        coarseZoom: HEIGHT_COARSE_ZOOM,
        pads,
        fine: id => (id.z === HEIGHT_FINE_ZOOM ? dem.get(tileKeyString(id)) : undefined),
        coarse: id => (id.z === HEIGHT_COARSE_ZOOM ? dem.get(tileKeyString(id)) : undefined),
    });

    const rng = new Rng(0xE1E7);
    const points: Array<[number, number]> = [];
    // A grid over the airport, where the pads are.
    for (let i = -10; i <= 10; i++) {
        for (let j = -10; j <= 10; j++) points.push([i * 300 + 17, j * 300 - 23]);
    }
    // Scattered over the fine block, and out into the coarse-only and empty tiers.
    for (let i = 0; i < 150; i++) points.push([rng.range(-14000, 14000), rng.range(-14000, 14000)]);
    for (let i = 0; i < 60; i++) points.push([rng.range(-150000, 150000), rng.range(-150000, 150000)]);

    // The pads that are near the grid, with their own geometry checks.
    const nearPads = pads.filter(p => Math.hypot(p.centerX, p.centerZ) < 8000);
    const grid = new PadGrid(pads);

    const queries = points.map(([e, n]) => {
        const cell = grid.at(e, n);
        return {
            e, n,
            heightAtEnu: sampler.heightAtEnu(e, n),
            geodeticHeightAtEnu: sampler.geodeticHeightAtEnu(e, n),
            isLandEnu: sampler.isLandEnu(e, n),
            tier: sampler.tierAtEnu(e, n),
            fineTileKey: sampler.fineTileKeyAtEnu(e, n),
            geodeticAltitudeAt100m: sampler.geodeticAltitudeAtEnu(e, n, 100),
            padCellCount: cell ? cell.length : 0,
        };
    });

    const lonLat: unknown[] = [];
    for (let i = 0; i < 80; i++) {
        const lon = HEIGHT_CENTRE[0] + rng.range(-0.3, 0.3);
        const lat = HEIGHT_CENTRE[1] + rng.range(-0.3, 0.3);
        const h = sampler.heightAtLonLat(lon, lat);
        lonLat.push({ lon, lat, height: h, water: isWaterHeight(h, manifest.seaLevel) });
    }

    const padChecks = nearPads.slice(0, 12).flatMap(p => {
        const out: unknown[] = [];
        for (let k = 0; k < 8; k++) {
            const e = p.centerX + rng.range(-p.halfW - p.featherM - 20, p.halfW + p.featherM + 20);
            const n = p.centerZ + rng.range(-p.halfD - p.featherM - 20, p.halfD + p.featherM + 20);
            out.push({
                pad: p,
                e, n,
                weight: padBlendWeight(e, n, p),
                surface: padSurfaceHeight(e, n, p),
                applied: applyFlattenPad(37.5, e, n, p),
                appliedNaN: applyFlattenPad(Number.NaN, e, n, p),
            });
        }
        return out;
    });

    return {
        files: [{
            file: 'heights.json',
            data: {
                suite: 'heights',
                version: 1,
                source: 'src/script/terrain/{heightSampler,flattenPad,demTile}.ts',
                notes: [
                    'Basis: manifest.enuOrigin (tiles/manifest.json). seaLevel: manifest.seaLevel.',
                    'Fine tier: tiles/height/11_*.pdm (queryZoom 11). Coarse tier: tiles/height/7_*.pdm (coarseZoom 7). A tile missing from the folder is absent.',
                    'Pads: manifest.flattenPads -> padFromRecord(p, toEnu) with toEnu(lat, lon) = ecefToEnu(basis, geodeticToEcef(lat, lon, 0)), kept when hypot(centerX, centerZ) - padReachM(p) <= 400 km; order preserved.',
                    'No rail-bed field. Pad checks use applyFlattenPad(37.5, ...) and applyFlattenPad(NaN, ...).',
                ],
                tolerances: { metres: 1e-6, degrees: 1e-9 },
                padCount: pads.length,
                pads: pads.slice(0, 40),
                queries,
                lonLat,
                padChecks,
            },
        }],
    };
}
