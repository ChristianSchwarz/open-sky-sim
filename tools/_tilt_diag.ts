import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { makeEnuBasis } from '../src/script/terrain/geodesy';
import { decodePtm } from '../src/script/terrain/ptm';
import { tileSurface } from './bake/tileSurface';
const m = JSON.parse(fs.readFileSync('assets/terrain/manifest.json', 'utf8'));
console.log('enuOrigin', m.enuOrigin);
const basis = makeEnuBasis(m.enuOrigin.lat, m.enuOrigin.lon, m.enuOrigin.height);
for (const [x, y] of [[4398, 852], [4398, 853]]) {
    const p = `assets/terrain/12/${x}/${y}.ptm`;
    if (!fs.existsSync(p)) { console.log('missing', p); continue; }
    const t = decodePtm(zlib.gunzipSync(fs.readFileSync(p)));
    const s = tileSurface(t, basis);
    console.log(p, 'up', s.up, 'shear', s.shear, 'tiltDeg', (Math.acos(s.up.y) * 180 / Math.PI).toFixed(1), 'centerH', t.centerHeightM);
}
