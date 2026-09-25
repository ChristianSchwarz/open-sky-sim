import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
    ARRESTOR_CABLE_LOCAL_Z,
    ARRESTOR_CABLE_Y,
    ARRESTOR_CATCH_RADIUS_M,
    ARRESTOR_CARRIER_ORIGIN,
    ARRESTOR_DECK_MID_X,
    ARRESTOR_HALF_SPAN_M,
    ARRESTOR_HOOK_HINGE_FWD_M,
    ARRESTOR_PULL_OUT_M,
    ARRESTOR_STOP_SPEED_MPS,
    DEFAULT_ARRESTOR_HOOK_BODY,
    TAILHOOK_ARM_LENGTH_M,
    applyArrestorVelocity,
    arrestorHookPlacementForAircraft,
    buildArrestorCableField,
    distancePointToSegment,
    hookWorldPos,
    latchedHookTipWorld,
    resolveArrestorHookTip,
    trySnag,
} from './arrestorCables';
import { DEFAULT_ENGINE_NOZZLES } from './afterburnerCones';

describe('arrestorCables', () => {
    const origin = { ...ARRESTOR_CARRIER_ORIGIN };
    const field = buildArrestorCableField(origin.x, origin.y, origin.z);

    it('builds four lateral segments on the landing deck', () => {
        assert.equal(field.segments.length, 4);
        for (let i = 0; i < 4; i++) {
            const seg = field.segments[i];
            const z = origin.z + ARRESTOR_CABLE_LOCAL_Z[i];
            assert.ok(Math.abs(seg.a.z - z) < 1e-6);
            assert.ok(Math.abs(seg.b.z - z) < 1e-6);
            assert.ok(Math.abs(seg.a.y - ARRESTOR_CABLE_Y) < 1e-6);
            assert.ok(Math.abs(seg.a.x - (origin.x + ARRESTOR_DECK_MID_X - ARRESTOR_HALF_SPAN_M)) < 1e-6);
            assert.ok(Math.abs(seg.b.x - (origin.x + ARRESTOR_DECK_MID_X + ARRESTOR_HALF_SPAN_M)) < 1e-6);
        }
    });

    it('rotates cable field with carrier yaw', () => {
        const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        const yawed = buildArrestorCableField(100, 0, 200, undefined, yaw);
        // Local +X becomes world −Z after +90° yaw about Y.
        const localAx = ARRESTOR_DECK_MID_X - ARRESTOR_HALF_SPAN_M;
        const expected = new THREE.Vector3(localAx, ARRESTOR_CABLE_Y, ARRESTOR_CABLE_LOCAL_Z[0])
            .applyQuaternion(yaw)
            .add(new THREE.Vector3(100, 0, 200));
        assert.ok(yawed.segments[0].a.distanceTo(expected) < 1e-5);
        assert.ok(Math.abs(yawed.deckAxis.x - (-1)) < 1e-5, 'deck axis should face −X');
    });

    it('hookWorldPos transforms body offset by pose', () => {
        const pos = new THREE.Vector3(10, 20, 30);
        const quat = new THREE.Quaternion(); // identity
        const hookBody = new THREE.Vector3(...DEFAULT_ARRESTOR_HOOK_BODY);
        const out = new THREE.Vector3();
        hookWorldPos(pos, quat, hookBody, out);
        assert.ok(Math.abs(out.x - (10 + DEFAULT_ARRESTOR_HOOK_BODY[0])) < 1e-6);
        assert.ok(Math.abs(out.y - (20 + DEFAULT_ARRESTOR_HOOK_BODY[1])) < 1e-6);
        assert.ok(Math.abs(out.z - (30 + DEFAULT_ARRESTOR_HOOK_BODY[2])) < 1e-6);
    });

    it('resolveArrestorHookTip uses nozzle exit Z', () => {
        const tip = resolveArrestorHookTip({
            nozzleZs: [-4.2, -4.85],
            explicitHook: [0, -1.7, -8],
        });
        assert.equal(tip[2], -4.85);
    });

    it('resolveArrestorHookTip falls back to explicit when no nozzles', () => {
        const tip = resolveArrestorHookTip({ explicitHook: [0, -1.7, -6.2] });
        assert.equal(tip[2], -6.2);
    });

    it('arrestorHookPlacementForAircraft matches nozzle exits', () => {
        const { tip, hinge } = arrestorHookPlacementForAircraft({
            fx: { nozzles: [[-1, 0, -5.1], [1, 0, -5.1]] },
            surfaces: [{ pivot: [0, 0, -6] }],
        });
        assert.equal(tip[2], -5.1);
        assert.equal(hinge[2], tip[2] + ARRESTOR_HOOK_HINGE_FWD_M);
    });

    it('arrestorHookPlacementForAircraft uses default nozzles when unset', () => {
        const { tip } = arrestorHookPlacementForAircraft({
            surfaces: [{ pivot: [0, 0, -6] }],
        });
        assert.equal(tip[2], DEFAULT_ENGINE_NOZZLES[0][2]);
        assert.equal(tip[2], DEFAULT_ARRESTOR_HOOK_BODY[2]);
    });

    it('latchedHookTipWorld places tip colinear with hinge→sheave at arm length', () => {
        const hinge = new THREE.Vector3(2505, 15, -2000);
        const sheave = new THREE.Vector3(2480, 13.85, -2005);
        const tip = new THREE.Vector3();
        const dir = new THREE.Vector3();
        latchedHookTipWorld(hinge, sheave, tip, dir);

        assert.ok(Math.abs(tip.distanceTo(hinge) - TAILHOOK_ARM_LENGTH_M) < 1e-6);

        const toSheave = sheave.clone().sub(hinge).normalize();
        assert.ok(dir.distanceTo(toSheave) < 1e-6);

        const along = tip.clone().sub(hinge).normalize();
        assert.ok(along.distanceTo(toSheave) < 1e-6);
    });

    it('distancePointToSegment is zero on the wire and large when high', () => {
        const seg = field.segments[0];
        const mid = new THREE.Vector3().addVectors(seg.a, seg.b).multiplyScalar(0.5);
        assert.ok(distancePointToSegment(mid, seg.a, seg.b) < 1e-6);
        mid.y += 5;
        assert.ok(distancePointToSegment(mid, seg.a, seg.b) > 4.9);
    });

    it('misses when hook is high above the cable', () => {
        const seg = field.segments[0];
        const mid = new THREE.Vector3().addVectors(seg.a, seg.b).multiplyScalar(0.5);
        mid.y += 5;
        const prev = mid.clone();
        prev.z += 2;
        const vel = new THREE.Vector3(0, 0, -40);
        assert.equal(trySnag(mid, prev, vel, field, true), -1);
    });

    it('misses when the hook is up', () => {
        const seg = field.segments[0];
        const hook = new THREE.Vector3().addVectors(seg.a, seg.b).multiplyScalar(0.5);
        const prev = hook.clone();
        prev.z += 1;
        const vel = new THREE.Vector3(0, 0, -40);
        assert.equal(trySnag(hook, prev, vel, field, false), -1);
    });

    it('catches on stern-to-bow crossing within catch radius', () => {
        const seg = field.segments[1];
        const cableZ = (seg.a.z + seg.b.z) * 0.5;
        const midX = (seg.a.x + seg.b.x) * 0.5;
        const hook = new THREE.Vector3(midX, ARRESTOR_CABLE_Y, cableZ - 0.1);
        const prev = new THREE.Vector3(midX, ARRESTOR_CABLE_Y, cableZ + 1);
        const vel = new THREE.Vector3(0, 0, -50);
        assert.equal(trySnag(hook, prev, vel, field, true), 1);
    });

    it('catches on tight proximity without a prior sample', () => {
        const seg = field.segments[2];
        const mid = new THREE.Vector3().addVectors(seg.a, seg.b).multiplyScalar(0.5);
        mid.x += ARRESTOR_CATCH_RADIUS_M * 0.25;
        const vel = new THREE.Vector3(0, 0, -40);
        assert.equal(trySnag(mid, null, vel, field, true), 2);
    });

    it('catches a landed-height hook crossing the first wire', () => {
        // Real deck ~13.55; CG at deck+2; hook body Y=-1.7 → hook ≈ 13.85.
        const seg = field.segments[0];
        const cableZ = (seg.a.z + seg.b.z) * 0.5;
        const midX = (seg.a.x + seg.b.x) * 0.5;
        const hookY = 13.85;
        const hook = new THREE.Vector3(midX, hookY, cableZ - 0.2);
        const prev = new THREE.Vector3(midX, hookY, cableZ + 1.0);
        const vel = new THREE.Vector3(0, 0, -55);
        assert.equal(trySnag(hook, prev, vel, field, true), 0);
    });

    it('catches despite a multi-metre step across the wire', () => {
        const seg = field.segments[1];
        const cableZ = (seg.a.z + seg.b.z) * 0.5;
        const midX = (seg.a.x + seg.b.x) * 0.5;
        const hook = new THREE.Vector3(midX + 1.0, ARRESTOR_CABLE_Y, cableZ - 0.5);
        const prev = new THREE.Vector3(midX + 1.0, ARRESTOR_CABLE_Y, cableZ + 1.5);
        const vel = new THREE.Vector3(0, 0, -60);
        assert.equal(trySnag(hook, prev, vel, field, true), 1);
    });

    it('stops near 140 m from 70 m/s along the deck', () => {
        const vel = new THREE.Vector3(0, 0, -70);
        const deckAxis = field.deckAxis;
        const dt = 1 / 60;
        let dist = 0;
        let remaining = ARRESTOR_PULL_OUT_M;
        let steps = 0;
        while (applyArrestorVelocity(vel, deckAxis, dt, remaining)) {
            const along = Math.abs(vel.dot(deckAxis));
            const step = along * dt;
            dist += step;
            remaining = ARRESTOR_PULL_OUT_M - dist;
            steps++;
            assert.ok(steps < 10000, 'arrestor should stop');
        }
        assert.ok(Math.abs(vel.dot(deckAxis)) <= ARRESTOR_STOP_SPEED_MPS + 1e-6);
        assert.ok(Math.abs(dist - ARRESTOR_PULL_OUT_M) < 12, `stop distance ${dist} m`);
    });

    it('stops near 140 m from 50 m/s as well', () => {
        const vel = new THREE.Vector3(0, 0, -50);
        const deckAxis = field.deckAxis;
        const dt = 1 / 60;
        let dist = 0;
        let remaining = ARRESTOR_PULL_OUT_M;
        let steps = 0;
        while (applyArrestorVelocity(vel, deckAxis, dt, remaining)) {
            const along = Math.abs(vel.dot(deckAxis));
            dist += along * dt;
            remaining = ARRESTOR_PULL_OUT_M - dist;
            steps++;
            assert.ok(steps < 10000, 'arrestor should stop');
        }
        assert.ok(Math.abs(dist - ARRESTOR_PULL_OUT_M) < 12, `stop distance ${dist} m`);
    });
});

describe('arrestorCables serialize', () => {
    it('round-trips through SerializedWorld', async () => {
        const { serializeWorld, deserializeArrestorCables, defaultArrestorCableField } =
            await import('../../physics/sim/serializedWorld');
        const origin = { ...ARRESTOR_CARRIER_ORIGIN };
        const field = defaultArrestorCableField(origin.x, origin.y, origin.z);
        const world = serializeWorld([], [], [{
            center: new THREE.Vector3(),
            heading: 0,
            halfLength: 100,
            halfWidth: 20,
        }], [], [], [field]);
        const restored = deserializeArrestorCables(world);
        assert.equal(restored.length, 1);
        assert.equal(restored[0].segments.length, 4);
        for (let i = 0; i < 4; i++) {
            const a = field.segments[i].a;
            const b = restored[0].segments[i].a;
            assert.ok(a.distanceTo(b) < 1e-6);
        }
    });
});
