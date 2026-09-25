import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { PlayerEntity } from '../../scene/entities/player';
import { vectorHeading } from '../../utils/math';
import { FixedCameraUpdater } from './fixedCameraUpdater';

function forward(camera: THREE.Camera): THREE.Vector3 {
    return camera.getWorldDirection(new THREE.Vector3());
}

describe('FixedCameraUpdater', () => {
    it('sits at the position and faces the bearing', () => {
        const camera = new THREE.PerspectiveCamera();
        const updater = new FixedCameraUpdater({} as PlayerEntity, camera);
        updater.setPose(new THREE.Vector3(100, 50, -200), 90, 0);
        updater.update(0);
        assert.deepEqual(camera.position.toArray(), [100, 50, -200]);
        assert.equal(vectorHeading(forward(camera)), 90);
        assert.ok(Math.abs(forward(camera).y) < 1e-6);
    });

    it('pitches up and down', () => {
        const camera = new THREE.PerspectiveCamera();
        const updater = new FixedCameraUpdater({} as PlayerEntity, camera);
        updater.setPose(new THREE.Vector3(), 0, -30);
        updater.update(0);
        const f = forward(camera);
        assert.ok(Math.abs(f.y + 0.5) < 1e-6);
        assert.ok(f.z < 0);
        assert.ok(vectorHeading(f) === 0);
    });
});

describe('FixedCameraUpdater.move', () => {
    it('slides along the level heading, across it, and up', () => {
        const camera = new THREE.PerspectiveCamera();
        const updater = new FixedCameraUpdater({} as PlayerEntity, camera);
        updater.setPose(new THREE.Vector3(), 90, -45);
        updater.move(10, 2, 3);
        updater.update(0);
        const p = camera.position;
        assert.ok(Math.abs(p.x - 10) < 1e-9, `x ${p.x}`);
        assert.ok(Math.abs(p.z - 2) < 1e-9, `z ${p.z}`);
        assert.equal(p.y, 3);
    });
});

describe('FixedCameraUpdater.turn', () => {
    it('turns the heading clockwise and pitches, clamped short of the poles', () => {
        const camera = new THREE.PerspectiveCamera();
        const updater = new FixedCameraUpdater({} as PlayerEntity, camera);
        updater.setPose(new THREE.Vector3(), 350, 0);
        updater.turn(20, 0);
        updater.update(0);
        assert.equal(vectorHeading(forward(camera)), 10);
        updater.turn(0, 200);
        updater.update(0);
        assert.ok(forward(camera).y > 0.999);
        assert.ok(forward(camera).y < 1);
    });
});
