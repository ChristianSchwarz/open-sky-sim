/**
 * Airfield geometry fixtures (workstream E/O): buildAirfieldModel on real
 * airfields from assets/terrain/airfields.json - runways with their paint,
 * taxiways with smoothing and joint fans, aprons, building boxes - plus the
 * runway marking layout and its coverage texture.
 *
 * The material manager is a stub (as in airfieldModel.test.ts): every part is
 * identified by the options it asked its material for. Apron triangulations
 * (THREE.ShapeUtils) are recorded in call order so the port can replay its
 * geometry with the oracle's faces as well as check its own earcut.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { Airfield } from '../../../src/script/terrain/airfields';
import { makeEnuBasis } from '../../../src/script/terrain/geodesy';
import { SceneMaterialManager } from '../../../src/script/scene/materials/materials';
import { buildAirfieldModel, smoothCentreline } from '../../../src/script/scene/airfield/airfieldModel';
import { runwayMarkings } from '../../../src/script/scene/airfield/runwayMarkings';
import { rasteriseMarkings } from '../../../src/script/scene/airfield/runwayMarkingTexture';
import { arr, fnv1a32, Rng, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

/** Airfields to build, and the ENU origin each is built in. */
const CASES: { icao: string; origin: [number, number, number]; drape: boolean }[] = [
    // Gran Canaria in its own area's frame: runways, 80 taxiways, aprons, 59 buildings.
    { icao: 'GCLP', origin: [28.0015, -15.3937, 0], drape: true },
    // Grass and concrete strips, 40 km off a DACH-ish origin so curvature matters.
    { icao: 'EDAB', origin: [51.0, 14.0, 0], drape: true },
    { icao: 'ETAR', origin: [49.2, 7.2, 0], drape: false },
];

/** A ground that is not the plane, so the drape path is exercised. */
function syntheticGround(e: number, n: number): number {
    return 40 + 3 * Math.sin(e / 47) + 2 * Math.cos(n / 31);
}

function b64f32(a: ArrayLike<number>): string {
    return Buffer.from(new Float32Array(a).buffer).toString('base64');
}

/** Small parts verbatim; big ones as a hash of their bytes and the first hundred vertices. */
function positionsOf(a: Float32Array): { count: number; positions?: string; hash?: number; head?: string } {
    if (a.length <= 6000) return { count: a.length, positions: b64f32(a) };
    return { count: a.length, hash: fnv1a32(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)), head: b64f32(a.subarray(0, 300)) };
}

export function airfieldsSuite(ctx: SuiteContext): SuiteOutput {
    const file = JSON.parse(fs.readFileSync(path.join(ctx.terrainRoot, 'airfields.json'), 'utf8')) as { items: Airfield[] };
    const cases = CASES.map(c => {
        const airfield = file.items.find(a => a.icao === c.icao);
        if (!airfield) throw new Error(`airfields suite: ${c.icao} not in airfields.json`);
        // Captured on every ShapeUtils.triangulateShape call, in order.
        const triangulations: number[][][] = [];
        const original = THREE.ShapeUtils.triangulateShape;
        THREE.ShapeUtils.triangulateShape = (contour, holes) => {
            const faces = original.call(THREE.ShapeUtils, contour, holes);
            triangulations.push(faces.map(f => [...f]));
            return faces;
        };
        const materials = {
            build: (p: Record<string, unknown>) => {
                const m = new THREE.MeshBasicMaterial();
                const markings = p.markings as { map: THREE.DataTexture } | undefined;
                m.userData = {
                    category: p.category,
                    overbright: p.overbright,
                    rawColor: p.rawColor,
                    maxFootprintM: p.maxFootprintM,
                    shaded: p.shaded,
                    markingHash: markings ? fnv1a32(markings.map.image.data as Uint8Array) : undefined,
                };
                return m;
            },
        } as unknown as SceneMaterialManager;
        const basis = makeEnuBasis(c.origin[0], c.origin[1], c.origin[2]);
        let built;
        try {
            built = buildAirfieldModel(airfield, basis, materials, c.drape ? syntheticGround : undefined);
        } finally {
            THREE.ShapeUtils.triangulateShape = original;
        }
        if (!built) throw new Error(`airfields suite: ${c.icao} built nothing`);
        const part = (o: THREE.Object3D) => {
            const mesh = o as THREE.Mesh;
            const u = (mesh.material as THREE.Material).userData;
            const uv = mesh.geometry.getAttribute('uv');
            return {
                category: u.category, overbright: u.overbright ?? null, rawColor: u.rawColor ?? null,
                maxFootprintM: u.maxFootprintM ?? null, shaded: !!u.shaded, markingHash: u.markingHash ?? null,
                ...positionsOf(mesh.geometry.getAttribute('position').array as Float32Array),
                uvs: uv ? arr(uv.array as Float32Array) : null,
            };
        };
        return {
            icao: c.icao,
            origin: c.origin,
            drape: c.drape,
            airfield,
            triangulations,
            result: {
                origin: [built.origin.x, built.origin.y, built.origin.z],
                maxSize: built.model.maxSize,
                levels: built.model.lod.map(l => ({ flats: l.flats.map(part), volumes: l.volumes.map(part) })),
                groundStrips: built.groundStrips.map(s => ({
                    samples: s.samples.map(p => [p.x, p.y, p.z]),
                    paintedZoom: Number.isFinite(s.paintedZoom) ? s.paintedZoom : 'Infinity',
                    lighten: s.lighten,
                    meshes: s.meshes.length,
                })),
            },
        };
    });

    // Marking layouts and textures over a spread of sizes and designators.
    const rng = new Rng(0xA1F1E1D);
    const markingCases: { lengthM: number; widthM: number; ref: string; surface: string }[] = [
        { lengthM: 3103, widthM: 45, ref: '03L/21R', surface: 'asphalt' },
        { lengthM: 800, widthM: 18, ref: '09/27', surface: 'concrete' },
        { lengthM: 1500, widthM: 30, ref: '18C/36C', surface: 'asphalt' },
        { lengthM: 600, widthM: 30, ref: '07/25', surface: 'grass' },
        { lengthM: 9000, widthM: 60, ref: '1/19', surface: 'asphalt' },
    ];
    const refs = ['01/19', '04R/22L', '11/29', '16/34', '05L/23R', '12C/30C', 'x/y', ''];
    for (let i = 0; i < 6; i++) {
        markingCases.push({
            lengthM: rng.range(400, 4200), widthM: rng.range(10, 61),
            ref: rng.pick(refs), surface: rng.pick(['asphalt', 'concrete', 'gravel']),
        });
    }
    const markings = markingCases.map(m => {
        const rects = runwayMarkings(m.lengthM, m.widthM, m.ref, m.surface as never);
        const tex = rasteriseMarkings(rects, m.lengthM, m.widthM);
        // A few texels by position, so a mismatch says where, not just that.
        const probes: number[][] = [];
        for (let k = 0; k < 24; k++) {
            const x = Math.floor(rng.next() * tex.width);
            const y = Math.floor(rng.next() * tex.height);
            const i = (y * tex.width + x) * 2;
            probes.push([x, y, tex.data[i], tex.data[i + 1]]);
        }
        return {
            ...m,
            rects: rects.map(r => [r.u, r.v, r.lengthM, r.widthM, r.kind]),
            texture: { width: tex.width, height: tex.height, hash: fnv1a32(tex.data), probes },
        };
    });

    // smoothCentreline on its own: real taxiways, plus a few synthetic zigzags.
    const smoothing: { points: number[][]; widthM: number; out: number[][] }[] = [];
    const gclp = file.items.find(a => a.icao === 'GCLP')!;
    for (const t of gclp.taxiways.slice(0, 12)) {
        const pts = t.points.map(p => ({ e: (p[1] + 15.39) * 98000, n: (p[0] - 27.93) * 110800 }));
        smoothing.push({ points: pts.map(p => [p.e, p.n]), widthM: t.widthM, out: smoothCentreline(pts, t.widthM).map(p => [p.e, p.n]) });
    }
    for (let k = 0; k < 6; k++) {
        const pts: { e: number; n: number }[] = [];
        let e = 0, n = 0;
        for (let i = 0; i < 9; i++) {
            pts.push({ e, n });
            e += rng.range(-60, 200);
            n += rng.range(-150, 150);
            if (k === 0 && i === 3) pts.push({ e: pts[pts.length - 1].e, n: pts[pts.length - 1].n });
        }
        const w = rng.range(8, 40);
        smoothing.push({ points: pts.map(p => [p.e, p.n]), widthM: w, out: smoothCentreline(pts, w).map(p => [p.e, p.n]) });
    }

    return {
        files: [{
            file: 'airfields.json',
            data: {
                notes: 'buildAirfieldModel per case (positions are float32 base64, relative to origin); '
                    + 'triangulations = THREE.ShapeUtils.triangulateShape results in call order; '
                    + 'markings = runwayMarkings + rasteriseMarkings (fnv1a32 of the RG bytes); smoothing = smoothCentreline.',
                syntheticGround: '40 + 3 * sin(e / 47) + 2 * cos(n / 31)',
                cases,
                markings,
                smoothing,
            },
        }],
    };
}
