/**
 * Diagnostic: a plan view of one airfield's taxiway pavement, as built.
 *
 * Draws the actual triangles `buildAirfieldModel` emits, straight down, so a
 * notch bitten out of the outside of a curve is visible as a notch rather than
 * as a number.
 *
 *   node --import tsx tools/diag_taxiway_svg.ts GCLP out.svg [halfSpanM]
 */

import * as fs from 'fs';
import * as io from 'path';
import * as THREE from 'three';

import { Airfield } from '../src/script/terrain/airfields';
import { ecefToEnu, enuFromScene, geodeticToEcef, makeEnuBasis } from '../src/script/terrain/geodesy';
import { buildAirfieldModel } from '../src/script/scene/airfield/airfieldModel';
import { SceneMaterialManager } from '../src/script/scene/materials/materials';

const MATERIALS = {
    build: (p: { category: string }) => {
        const m = new THREE.MeshBasicMaterial();
        m.userData.category = p.category;
        return m;
    },
} as unknown as SceneMaterialManager;

const icao = process.argv[2] ?? 'GCLP';
const out = process.argv[3] ?? 'taxiways.svg';
const halfSpan = Number(process.argv[4] ?? 300);

const manifest = JSON.parse(fs.readFileSync(io.join('assets/terrain', 'manifest.json'), 'utf8'));
const fields = JSON.parse(fs.readFileSync(io.join('assets/terrain', 'airfields.json'), 'utf8'));
const airfield: Airfield = fields.items.find((a: any) => a.icao === icao);
if (!airfield) {
    throw new Error(`no airfield ${icao}`);
}
const basis = makeEnuBasis(
    manifest.enuOrigin.lat, manifest.enuOrigin.lon, manifest.enuOrigin.height ?? 0);

// Only the taxiways: the runway and aprons share their palette category and
// would flood the picture.
const only: Airfield = { ...airfield, aprons: [], buildings: [], runways: [airfield.runways[0]] };
const built = buildAirfieldModel(only, basis, MATERIALS, () => 0)!;

const enuAt = (lat: number, lon: number) => {
    const e = ecefToEnu(basis, geodeticToEcef(lat, lon, 0));
    return { e: e.e, n: e.n };
};

/** The sharpest bend in the network, which is where a notch shows worst. */
let focus = enuAt(airfield.lat, airfield.lon);
let sharpest = 0;
for (const tx of airfield.taxiways) {
    const pts = tx.points.map(p => enuAt(p[0], p[1]));
    for (let i = 1; i + 1 < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const c = pts[i + 1];
        const d0 = Math.hypot(b.e - a.e, b.n - a.n);
        const d1 = Math.hypot(c.e - b.e, c.n - b.n);
        if (d0 < 6 || d1 < 6) {
            continue;               // a node too close to read a bend from
        }
        const cross = ((b.e - a.e) * (c.n - b.n) - (b.n - a.n) * (c.e - b.e)) / (d0 * d1);
        const dot = ((b.e - a.e) * (c.e - b.e) + (b.n - a.n) * (c.n - b.n)) / (d0 * d1);
        const turn = Math.atan2(Math.abs(cross), dot);
        if (turn > sharpest) {
            sharpest = turn;
            focus = b;
        }
    }
}

const polys: string[] = [];
const toPx = (e: number, n: number) =>
    `${(((e - focus.e) + halfSpan) / (2 * halfSpan) * 1000).toFixed(2)},`
    + `${((halfSpan - (n - focus.n)) / (2 * halfSpan) * 1000).toFixed(2)}`;

for (const obj of built.model.lod[0].flats) {
    const mesh = obj as THREE.Mesh;
    const category = (mesh.material as THREE.Material).userData.category as string;
    const fill = category === 'SCENERY_FIELD_YELLOW' ? '#e8c53a' : '#4a4a52';
    const pos = mesh.geometry.getAttribute('position');
    for (let t = 0; t + 2 < pos.count; t += 3) {
        const pts: string[] = [];
        let visible = false;
        for (let k = 0; k < 3; k++) {
            const v = new THREE.Vector3(pos.getX(t + k), pos.getY(t + k), pos.getZ(t + k));
            const enu = enuFromScene(v.add(built.origin));
            if (Math.abs(enu.e - focus.e) < halfSpan * 1.5
                && Math.abs(enu.n - focus.n) < halfSpan * 1.5) {
                visible = true;
            }
            pts.push(toPx(enu.e, enu.n));
        }
        if (visible) {
            polys.push(`<polygon points="${pts.join(' ')}" fill="${fill}"/>`);
        }
    }
}

fs.writeFileSync(out,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">\n`
    + `<rect width="1000" height="1000" fill="#7f9b63"/>\n`
    + `${polys.join('\n')}\n`
    + `<text x="16" y="30" font-family="monospace" font-size="20" fill="#fff">`
    + `${icao} taxiways, ${(2 * halfSpan).toFixed(0)} m across, sharpest bend `
    + `${(sharpest * 180 / Math.PI).toFixed(0)}&#176;</text>\n</svg>\n`);
console.log(`${polys.join('').length ? polys.length : 0} facets -> ${out}`
    + `  (bend ${(sharpest * 180 / Math.PI).toFixed(1)} deg at ${focus.e.toFixed(0)},`
    + `${focus.n.toFixed(0)})`);
