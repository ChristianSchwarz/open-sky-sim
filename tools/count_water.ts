/**
 * How much inland water each baked area's z12 coast vector tiles hold.
 *
 * A cached empty Overpass water answer bakes an area with no inland bodies at
 * all (see the overpass.osm.ch note in osm_common.py), so this is the check
 * for that: an area with lakes and zero bodies is one to re-bake.
 *
 *   node --import tsx tools/count_water.ts [area ...]
 */
import * as fs from 'fs';
import * as path from 'path';
import { decodeLvr } from './bake/lvr';
import { tileRangeForBounds } from '../src/script/terrain/tiling';

const root = 'assets/planet';
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const z: number = manifest.maxZoom ?? 12;
const wanted = new Set(process.argv.slice(2));

for (const area of manifest.areas ?? []) {
    if (wanted.size && !wanted.has(area.name)) continue;
    const r = tileRangeForBounds(z, area);
    let tiles = 0, withWater = 0, bodies = 0, courses = 0;
    for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
            const p = path.join(root, String(z), String(x), `${y}.lvr`);
            if (!fs.existsSync(p)) continue;
            tiles++;
            const t = decodeLvr(fs.readFileSync(p));
            if (t.inland.length) withWater++;
            bodies += t.inland.length;
            courses += t.watercourses.length;
        }
    }
    console.log(`${area.name.padEnd(6)} z${z} tiles ${tiles}, with inland water ${withWater}, `
        + `bodies ${bodies}, watercourses ${courses}`);
}
