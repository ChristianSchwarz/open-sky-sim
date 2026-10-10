import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FlightRecorder, ReplayPlayer, newReplayPose } from './flightRecorder';

function pose(x: number, yaw = 0) {
    const p = newReplayPose();
    p.position.set(x, 100, 0);
    p.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    p.devices.gear = true;
    p.devices.throttle = 0.5;
    return p;
}

describe('FlightRecorder', () => {
    it('interpolates between samples', () => {
        const r = new FlightRecorder(10, 60);
        r.record(0.1, pose(0));
        r.record(0.1, pose(10));
        const out = newReplayPose();
        assert.ok(r.sample((r.startTime + r.endTime) / 2, out));
        assert.ok(Math.abs(out.position.x - 5) < 1e-9);
        assert.equal(out.devices.gear, true);
    });

    it('slerps orientation', () => {
        const r = new FlightRecorder(10, 60);
        r.record(0.1, pose(0, 0));
        r.record(0.1, pose(0, Math.PI / 2));
        const out = newReplayPose();
        r.sample((r.startTime + r.endTime) / 2, out);
        const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
        assert.ok(out.quaternion.angleTo(expected) < 1e-9);
    });

    it('drops the oldest samples once full', () => {
        const r = new FlightRecorder(10, 1); // 10 slots
        for (let i = 0; i < 25; i++) r.record(0.1, pose(i));
        assert.equal(r.length, 10);
        const out = newReplayPose();
        r.sample(r.startTime, out);
        assert.equal(Math.round(out.position.x), 15);
        r.sample(r.endTime, out);
        assert.equal(Math.round(out.position.x), 24);
    });

    it('records nothing between sample ticks', () => {
        const r = new FlightRecorder(10, 60);
        for (let i = 0; i < 50; i++) r.record(0.01, pose(i));
        assert.ok(r.length >= 4 && r.length <= 6);
    });

    it('returns false when empty and clamps outside the span', () => {
        const r = new FlightRecorder(10, 60);
        const out = newReplayPose();
        assert.equal(r.sample(0, out), false);
        r.record(0.1, pose(1));
        r.record(0.1, pose(2));
        r.sample(1e6, out);
        assert.equal(Math.round(out.position.x), 2);
    });

    it('applies a rebase to every stored pose', () => {
        const r = new FlightRecorder(10, 60);
        r.record(0.1, pose(1));
        r.record(0.1, pose(2));
        const shift = {
            point: (p: THREE.Vector3) => p.set(p.x - 1000, p.y, p.z),
            orientation: (q: THREE.Quaternion) => q,
            vector: (v: THREE.Vector3) => v,
        };
        r.rebase(shift as never);
        const out = newReplayPose();
        r.sample(r.endTime, out);
        assert.equal(Math.round(out.position.x), -998);
    });
});

describe('ReplayPlayer', () => {
    it('loops, pauses, seeks and changes speed', () => {
        const r = new FlightRecorder(10, 60);
        for (let i = 0; i < 11; i++) r.record(0.1, pose(i)); // ~1 s
        const p = new ReplayPlayer(r);
        p.start();
        assert.equal(p.time, r.startTime);
        p.advance(0.5);
        assert.ok(Math.abs(p.time - (r.startTime + 0.5)) < 1e-9);
        p.paused = true;
        p.advance(10);
        assert.ok(Math.abs(p.time - (r.startTime + 0.5)) < 1e-9);
        p.paused = false;
        p.changeSpeed(1);
        assert.equal(p.speed, 2);
        p.advance(10); // past the end -> loops
        assert.equal(p.time, r.startTime);
        p.seek(-100);
        assert.equal(p.time, r.startTime);
    });
});
