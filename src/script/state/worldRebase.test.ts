import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { FrameShift, makeEnuBasis } from '../terrain/geodesy';
import { SurfacePadCollider, sampleSurfacePadY } from '../scene/entities/surfacePad';
import { rebaseMeshCollider, rebaseRunway, rebaseSurfacePad } from './worldRebase';

const SHIFT = FrameShift.between(makeEnuBasis(50.449, 11.536, 0), makeEnuBasis(50.62, 11.79, 0));

describe('worldRebase', () => {
    it('keeps a point on a sloped pad on the pad', () => {
        const pad: SurfacePadCollider = {
            centerX: -12_000, centerZ: 8_000, heading: 1.1, halfLength: 1500, halfWidth: 30,
            surfaceY: 412, baseY: 410, feather: 20, slope: 0.008,
        };
        const local = (along: number, across: number) => {
            const h = pad.heading;
            const x = pad.centerX + Math.sin(h) * along + Math.cos(h) * across;
            const z = pad.centerZ + Math.cos(h) * along - Math.sin(h) * across;
            return new THREE.Vector3(x, sampleSurfacePadY(x, z, pad), z);
        };
        const samples = [local(0, 0), local(1400, 25), local(-1400, -25), local(700, -10)];
        rebaseSurfacePad(pad, SHIFT);
        for (const s of samples) {
            const p = SHIFT.point(s.clone());
            // The cross-axis tilt a pad cannot hold: 25 m out, a 25 km shift.
            assert.ok(Math.abs(sampleSurfacePadY(p.x, p.z, pad) - p.y) < 0.15,
                `${sampleSurfacePadY(p.x, p.z, pad)} vs ${p.y}`);
        }
    });

    it('moves a runway centre and keeps its thresholds on its axis', () => {
        const r = { center: new THREE.Vector3(5000, 200, -3000), heading: -2.3, slope: -0.004 };
        const half = 1200;
        const end = (sign: number) => new THREE.Vector3(
            r.center.x + sign * half * Math.sin(r.heading),
            r.center.y + sign * half * r.slope,
            r.center.z + sign * half * Math.cos(r.heading));
        const a = SHIFT.point(end(1));
        rebaseRunway(r, SHIFT);
        const want = new THREE.Vector3(
            r.center.x + half * Math.sin(r.heading), r.center.y + half * r.slope,
            r.center.z + half * Math.cos(r.heading));
        assert.ok(a.distanceTo(want) < 0.01, `${a.distanceTo(want)} m`);
    });

    it('turns a mesh soup without touching the shared source array', () => {
        const source = [10, 0, 0, 0, 5, 0, 0, 0, -20];
        const c = { originX: 100, originY: 50, originZ: -100, triangles: source,
            aabb: { min: [0, 0, -20] as [number, number, number], max: [10, 5, 0] as [number, number, number] } };
        const world = new THREE.Vector3(100 + 10, 50, -100);
        rebaseMeshCollider(c, SHIFT);
        assert.deepEqual(source, [10, 0, 0, 0, 5, 0, 0, 0, -20]);
        const got = new THREE.Vector3(c.originX + c.triangles[0], c.originY + c.triangles[1], c.originZ + c.triangles[2]);
        assert.ok(got.distanceTo(SHIFT.point(world)) < 1e-6);
        assert.ok(c.aabb.min[2] <= c.triangles[8] && c.aabb.max[0] >= c.triangles[0]);
    });
});
