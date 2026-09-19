import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { FlyableAircraftDef } from './aircraftDef';
import {
    nextWingSweepMode,
    poseSurface,
    stepWingSweep,
    sweptTip,
    tipSweepsFromDef,
    WingSweepMode,
    wingSweepTarget,
} from './wingSweep';

const CFG = { minKias: 400, maxKias: 500, travelSeconds: 4 };
const KT = 0.514444;

describe('wing sweep schedule', () => {
    it('is spread below min, swept above max, linear between', () => {
        assert.equal(wingSweepTarget(WingSweepMode.AUTO, 300 * KT, CFG), 0);
        assert.equal(wingSweepTarget(WingSweepMode.AUTO, 600 * KT, CFG), 1);
        assert.ok(Math.abs(wingSweepTarget(WingSweepMode.AUTO, 450 * KT, CFG) - 0.5) < 1e-6);
    });

    it('holds a manual position regardless of speed', () => {
        assert.equal(wingSweepTarget(WingSweepMode.SPREAD, 900 * KT, CFG), 0);
        assert.equal(wingSweepTarget(WingSweepMode.SWEPT, 0, CFG), 1);
    });

    it('cycles AUTO -> SPREAD -> SWEPT -> AUTO', () => {
        let mode = WingSweepMode.AUTO;
        mode = nextWingSweepMode(mode);
        assert.equal(mode, WingSweepMode.SPREAD);
        mode = nextWingSweepMode(mode);
        assert.equal(mode, WingSweepMode.SWEPT);
        assert.equal(nextWingSweepMode(mode), WingSweepMode.AUTO);
    });

    it('slews at the travel rate and does not overshoot', () => {
        assert.ok(Math.abs(stepWingSweep(0, 1, 1, CFG) - 0.25) < 1e-9);
        assert.equal(stepWingSweep(0.9, 1, 1, CFG), 1);
        assert.ok(Math.abs(stepWingSweep(1, 0, 2, CFG) - 0.5) < 1e-9);
    });
});

describe('poseSurface', () => {
    const identity = new THREE.Quaternion();
    const origin = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();

    it('without a parent matches a plain hinge rotation', () => {
        const hinge = {
            pivot: new THREE.Vector3(2, 0, -1),
            axis: new THREE.Vector3(1, 0, 0),
            deflection: 0.3,
        };
        poseSurface(hinge, undefined, origin, identity, pos, quat);
        assert.deepEqual(pos.toArray(), [2, 0, -1]);
        const expected = new THREE.Quaternion().setFromAxisAngle(hinge.axis, 0.3);
        assert.ok(quat.angleTo(expected) < 1e-6);
    });

    it('carries a child hinge round its sweeping parent', () => {
        // Wing pivot at the origin sweeping 90 degrees about +Y; a flap hinge
        // 3 m out along +X must end up 3 m along -Z, with its +X axis turned to -Z.
        const parent = {
            pivot: new THREE.Vector3(),
            axis: new THREE.Vector3(0, 1, 0),
            deflection: Math.PI / 2,
        };
        const child = {
            pivot: new THREE.Vector3(3, 0, 0),
            axis: new THREE.Vector3(1, 0, 0),
            deflection: 0,
        };
        poseSurface(child, parent, origin, identity, pos, quat);
        assert.ok(pos.distanceTo(new THREE.Vector3(0, 0, -3)) < 1e-9);
        const turned = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
        assert.ok(turned.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9);
    });

    it('deflects the child about its swept axis', () => {
        const parent = {
            pivot: new THREE.Vector3(),
            axis: new THREE.Vector3(0, 1, 0),
            deflection: Math.PI / 2,
        };
        const child = {
            pivot: new THREE.Vector3(3, 0, 0),
            axis: new THREE.Vector3(1, 0, 0),
            deflection: 0.4,
        };
        poseSurface(child, parent, origin, identity, pos, quat);
        // The swept hinge axis is -Z; the flap turns 0.4 rad about it on top of the sweep.
        const sweep = new THREE.Quaternion().setFromAxisAngle(parent.axis, parent.deflection);
        const flap = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), 0.4);
        assert.ok(quat.angleTo(flap.multiply(sweep)) < 1e-6);
    });
});

describe('wingtip trails on swing wings', () => {
    const surface = (role: string, x: number, sign: number, rangeRad: number, sweepParent?: string) => ({
        role, model: '', pivot: [x, 0, 0] as [number, number, number],
        axis: [0, 1, 0] as [number, number, number], control: 'sweep' as const, sign, rangeRad, sweepParent,
    });
    const def = {
        surfaces: [
            surface('glove', 1.5, -1, 0.18),
            surface('wingL', 2, 1, 0.8),
            surface('wingR', -2, -1, 0.8),
        ],
        fx: { wingtips: [[8, 0, -3], [-8, 0, -3]] },
    } as unknown as FlyableAircraftDef;

    it('rides the widest wing on its own side, not the glove', () => {
        const tips = tipSweepsFromDef(def);
        assert.ok(tips);
        assert.equal(tips[0].pivot.x, 2);
        assert.equal(tips[1].pivot.x, -2);
    });

    it('stays put spread and moves aft and inboard when swept', () => {
        const tips = tipSweepsFromDef(def)!;
        const out = new THREE.Vector3();
        assert.ok(sweptTip(out, tips[0], 0).distanceTo(tips[0].spread) < 1e-9);
        sweptTip(out, tips[0], 1);
        assert.ok(out.z < -3, `tip should move aft, z=${out.z}`);
        assert.ok(out.x < 8, `tip should move inboard, x=${out.x}`);
        // Length from the pivot is preserved.
        assert.ok(Math.abs(out.distanceTo(tips[0].pivot) - tips[0].spread.distanceTo(tips[0].pivot)) < 1e-9);
        // Mirror image on the right.
        const right = new THREE.Vector3();
        sweptTip(right, tips[1], 1);
        assert.ok(Math.abs(right.x + out.x) < 1e-9 && Math.abs(right.z - out.z) < 1e-9);
    });

    it('is null without sweep surfaces', () => {
        assert.equal(tipSweepsFromDef({ surfaces: [], fx: { wingtips: [[8, 0, 0], [-8, 0, 0]] } } as unknown as FlyableAircraftDef), null);
    });
});
