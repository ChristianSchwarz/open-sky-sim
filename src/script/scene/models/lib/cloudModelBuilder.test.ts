import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { HDNoonPalette } from '../../../config/palettes/hd-noon';
import { DisplayShading, FogQuality } from '../../../config/profiles/profile';
import { SceneMaterialManager } from '../../materials/materials';
import { CLOUD_PUFF_SHAPES, CloudModelLibBuilder } from './cloudModelBuilder';

function build() {
    const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
    return new CloudModelLibBuilder('large', CLOUD_PUFF_SHAPES.large).build(materials);
}

describe('cloud haze', () => {
    it('draws every level as the solid body plus at most one haze mesh', () => {
        const counts = build().lod.map(level => level.volumes.length);
        assert.deepEqual(counts, [2, 2, 2, 1]);
    });

    it('draws nested prefixes of one buffer, each puff at its own tier level', () => {
        const lod = build().lod;
        const hazes = lod.slice(0, 3).map(level => level.volumes[1] as THREE.Mesh);
        const ranges = hazes.map(h => h.geometry.drawRange.count);
        assert.ok(ranges[0] > ranges[1] && ranges[1] > ranges[2] && ranges[2] > 0, `${ranges}`);
        const levels = hazes[0].geometry.getAttribute('ditherLevel');
        assert.equal(levels, hazes[2].geometry.getAttribute('ditherLevel'), 'levels share one buffer');
        // Densest first: the three-tier level holds the three densest tiers only.
        const seen = new Set<number>();
        for (let v = 0; v < ranges[2]; v++) {
            seen.add(levels.getX(v));
        }
        assert.deepEqual([...seen].sort(), [0.88, 0.95, 0.98].map(Math.fround));
        // Whole puffs: every triangle sits in one tier.
        for (let v = 0; v < ranges[0]; v += 3) {
            assert.equal(levels.getX(v), levels.getX(v + 2));
        }
        assert.equal(ranges[0], levels.count);
    });

    it('gives all levels one material that takes its opacity per vertex', () => {
        const lod = build().lod;
        const materials = new Set(lod.slice(0, 3).map(level => (level.volumes[1] as THREE.Mesh).material));
        assert.equal(materials.size, 1);
        const material = [...materials][0] as THREE.ShaderMaterial;
        assert.ok('VERTEX_ALPHA_DITHER' in (material.defines ?? {}));
    });
});
