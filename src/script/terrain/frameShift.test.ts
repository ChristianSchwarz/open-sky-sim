import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { FrameShift, geodeticToWorld, makeEnuBasis } from './geodesy';

// DACH box centre to Leipzig: the case that showed a tilted horizon.
const FROM = makeEnuBasis(50.449, 11.536, 0);
const TO = makeEnuBasis(51.339, 13.592, 0);

describe('FrameShift', () => {
    it('carries a point to where the new frame puts the same place', () => {
        const shift = FrameShift.between(FROM, TO);
        for (const [lat, lon, h] of [[51.34, 13.59, 4000], [50.45, 11.54, 0], [52.5, 13.4, 120]]) {
            const p = shift.point(geodeticToWorld(FROM, lat, lon, h));
            const want = geodeticToWorld(TO, lat, lon, h);
            assert.ok(p.distanceTo(want) < 1e-3, `${lat},${lon}: ${p.distanceTo(want)} m`);
        }
    });

    it('turns the old local up into the new frame +Y at the new origin', () => {
        const shift = FrameShift.between(FROM, TO);
        const a = geodeticToWorld(FROM, TO.lat0, TO.lon0, 0);
        const b = geodeticToWorld(FROM, TO.lat0, TO.lon0, 1000);
        const up = shift.vector(b.sub(a).normalize());
        assert.ok(up.angleTo(new THREE.Vector3(0, 1, 0)) < 1e-6);
    });

    it('is undone by the reverse shift', () => {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, -0.4));
        const back = FrameShift.between(TO, FROM);
        const there = FrameShift.between(FROM, TO).orientation(q.clone());
        assert.ok(back.orientation(there).angleTo(q) < 1e-6);
    });

    it('turns a sloped pad axis the way it turns the two ends of it', () => {
        const shift = FrameShift.between(FROM, TO);
        const h = 0.7, slope = 0.01, half = 1500;
        const c = new THREE.Vector3(-90_000, 300, 60_000);
        const dir = new THREE.Vector3(Math.sin(h), slope, Math.cos(h));
        const a = shift.point(c.clone().addScaledVector(dir, -half));
        const b = shift.point(c.clone().addScaledVector(dir, half));
        const d = b.sub(a);
        const got = shift.slopedHeading(h, slope);
        assert.ok(Math.abs(got.heading - Math.atan2(d.x, d.z)) < 1e-9);
        assert.ok(Math.abs(got.slope - d.y / Math.hypot(d.x, d.z)) < 1e-9);
    });

    it('round-trips through its structured-clone form', () => {
        const shift = FrameShift.between(FROM, TO);
        const back = FrameShift.fromArrays(shift.toArrays());
        const p = new THREE.Vector3(1234, 567, -8901);
        assert.ok(back.point(p.clone()).distanceTo(shift.point(p.clone())) < 1e-6);
    });
});
