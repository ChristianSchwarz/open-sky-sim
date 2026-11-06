import assert from 'node:assert/strict';
import * as THREE from 'three';
import { describe, it } from 'node:test';
import { Model } from '../scene/models/models';
import { getLodLevel, LODHelper, resolveLodLevel } from './helpers';

function modelWithLodLevels(populated: boolean[]): Model {
    return {
        lod: populated.map(hasGeometry => ({
            flats: hasGeometry ? [new THREE.Mesh()] : [],
            volumes: hasGeometry ? [new THREE.Mesh()] : [],
        })),
        animations: [],
        maxSize: 16,
        center: new THREE.Vector3(),
    };
}

describe('resolveLodLevel', () => {
    it('falls back to LOD 0 when higher levels are empty placeholders', () => {
        const model = modelWithLodLevels([true, false, false, false, false, false]);
        assert.equal(resolveLodLevel(model, 3), 0);
    });

    it('uses the requested level when it has geometry', () => {
        const model = modelWithLodLevels([true, true, true]);
        assert.equal(resolveLodLevel(model, 2), 2);
    });

    it('walks down to the nearest populated level', () => {
        const model = modelWithLodLevels([true, false, true]);
        assert.equal(resolveLodLevel(model, 2), 2);
        assert.equal(resolveLodLevel(model, 1), 0);
    });

    it('culls when the request is beyond the coarsest authored LOD', () => {
        const model = modelWithLodLevels([true, true, true]);
        assert.equal(resolveLodLevel(model, 3), -1);
    });

    it('keeps single-populated imports visible beyond the placeholder LOD count', () => {
        const model = modelWithLodLevels([true, false, false, false, false, false]);
        assert.equal(resolveLodLevel(model, 6), 0);
        assert.equal(resolveLodLevel(model, 99), 0);
    });

    it('culls when every level is empty', () => {
        const model = modelWithLodLevels([false, false]);
        assert.equal(resolveLodLevel(model, 0), -1);
    });
});

describe('getLodLevel + resolveLodLevel (imported aircraft)', () => {
    it('keeps single-LOD mod aircraft visible at long range', () => {
        const model = modelWithLodLevels([true, false, false, false, false, false]);
        const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 40000);
        camera.position.set(0, 500, 0);
        const position = new THREE.Vector3(0, 500, 8000);
        const scale = new THREE.Vector3(1, 1, 1);
        const requested = getLodLevel(position, scale, 320, camera, model.maxSize);
        const lodCount = model.lod.length;
        const forced = lodCount === 0 ? 0 : Math.min(requested, lodCount - 1);
        assert.equal(resolveLodLevel(model, forced), 0);
        assert.equal(resolveLodLevel(model, requested), 0);
    });
});

describe('LODHelper.setHideStaticAtClipStart', () => {
    /** A gear-like model: one door a clip swings, one bay mesh nothing moves. */
    function gearModel(): { model: Model; door: THREE.Mesh; bay: THREE.Mesh } {
        const door = new THREE.Mesh();
        door.name = 'Door';
        const bay = new THREE.Mesh();
        bay.name = 'Bay';
        const track = new THREE.NumberKeyframeTrack('.position[x]', [0, 1], [0, 1]);
        const model: Model = {
            lod: [{ flats: [], volumes: [door, bay] }],
            animations: [new THREE.AnimationClip('DoorAction', 1, [track])],
            maxSize: 16,
            center: new THREE.Vector3(),
        };
        return { model, door, bay };
    }

    it('hides only the static meshes, and only while the clip is at its start', () => {
        const { model, door, bay } = gearModel();
        const helper = new LODHelper(model);
        helper.setPlaybackDuration(3);
        helper.setHideStaticAtClipStart(true);

        helper.setPlaybackPosition(1); // gear down
        assert.equal(bay.visible, true);

        helper.playBackwards(); // retracting
        assert.equal(bay.visible, true);
        helper.update(1);
        assert.equal(bay.visible, true, 'still moving');
        helper.update(5);
        assert.equal(bay.visible, false, 'retracted: doors closed over the bay');
        assert.equal(door.visible, true);

        helper.play(); // extending
        assert.equal(bay.visible, true);
        helper.update(5);
        assert.equal(bay.visible, true, 'extended');

        helper.setPlaybackPosition(0); // snapped up
        assert.equal(bay.visible, false);

        helper.setHideStaticAtClipStart(false);
        assert.equal(bay.visible, true);
    });
});
