import assert from 'node:assert/strict';
import * as THREE from 'three';
import { describe, it } from 'node:test';
import { TREE_MIN_SPACING_PX } from '../scene/materials/shaders/treeBillboardVP';
import { Species } from '../scene/vegetation/treeSprites';
import { PtmTile } from './ptm';
import {
    TREE_MIN_SIZE_PX, TREE_REORDER_SLACK, orderTreesFor, scatterTreeSpecies, shuffledSlots, splitIntoCells,
    treeInstancesToDraw, treeOrderSlack, treeReorderWanted,
} from './treeBillboards';

const SPACING_M = 3;
/** Metres per unit of a tile group's frame, about what a z12 leaf has. */
const SCALE = 0.0776;
/** Ground metres per pixel per metre of range: a 60 degree view 1,440 px tall. */
const PIXEL_ANGLE = 2 * Math.tan(Math.PI / 6) / 1440;

/**
 * A patch of `n` trees spread over x in [1000, 4000] m, hashes shuffled as
 * buildTreeMesh shuffles them. Its tile group scales and moves it like a real
 * one: the land is quantised, and the group's matrix scales it up to metres.
 */
function patch(n: number): { mesh: THREE.InstancedMesh; group: THREE.Group } {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), n);
    const hash = new Float32Array(n);
    const species = new Float32Array(n);
    let seed = 12345;
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        m.makeTranslation((1000 + 3000 * (seed / 2 ** 32)) / SCALE, 0, ((i % 50) * 20) / SCALE);
        mesh.setMatrixAt(i, m);
        hash[i] = (i + 0.5) / n;
        species[i] = i;
    }
    geometry.setAttribute('instanceHash', new THREE.InstancedBufferAttribute(hash, 1));
    geometry.setAttribute('instanceSpecies', new THREE.InstancedBufferAttribute(species, 1));
    mesh.userData.treeTotal = n;
    mesh.userData.treeSpacingM = SPACING_M;
    mesh.computeBoundingSphere();
    const group = new THREE.Group();
    group.add(mesh);
    group.scale.setScalar(SCALE);
    group.updateMatrix();
    return { mesh, group };
}

/** The indices of the instances the shader keeps seen from `eye`: its own rule, per tree. */
function kept(mesh: THREE.InstancedMesh, eye: THREE.Vector3): number[] {
    const hash = (mesh.geometry.getAttribute('instanceHash') as THREE.BufferAttribute).array;
    const out: number[] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
        p.setFromMatrixPosition(new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, i * 16)).multiplyScalar(SCALE);
        const spacingPx = SPACING_M / (p.distanceTo(eye) * PIXEL_ANGLE);
        const keep = Math.min(1, spacingPx * spacingPx / (TREE_MIN_SPACING_PX * TREE_MIN_SPACING_PX));
        if (keep - hash[i] > 0) {
            out.push(i);
        }
    }
    return out;
}

describe('tree ordering', () => {
    it('submits every tree the shader keeps, and few more, once ordered', () => {
        const { mesh, group } = patch(4000);
        const eye = new THREE.Vector3(-1000, 300, 500);
        const before = treeInstancesToDraw(mesh, group, eye, PIXEL_ANGLE);
        assert.ok(Math.max(...kept(mesh, eye)) < before, 'the near-edge prefix covers them all');

        orderTreesFor(mesh, group, eye);
        const after = treeInstancesToDraw(mesh, group, eye, PIXEL_ANGLE);
        const keep = kept(mesh, eye);
        assert.ok(Math.max(...keep) < after, 'the ordered prefix covers them all');
        assert.ok(after <= keep.length * 1.01, `submits ${after} for ${keep.length} kept`);
        assert.ok(after < before / 2, `ordered ${after} vs near edge ${before}`);
    });

    it('keeps the same trees: the hash goes with its tree', () => {
        const { mesh, group } = patch(1000);
        const eye = new THREE.Vector3(-1000, 300, 500);
        const species = (mesh.geometry.getAttribute('instanceSpecies') as THREE.BufferAttribute).array;
        const keptBefore = new Set(kept(mesh, eye).map(i => species[i]));
        orderTreesFor(mesh, group, eye);
        const keptAfter = new Set(kept(mesh, eye).map(i => species[i]));
        assert.deepEqual([...keptAfter].sort((a, b) => a - b), [...keptBefore].sort((a, b) => a - b));
    });

    it('still covers every kept tree after the eye moves, within the slack', () => {
        const { mesh, group } = patch(4000);
        orderTreesFor(mesh, group, new THREE.Vector3(-1000, 300, 500));
        for (const dx of [-60, -20, 20, 60]) {
            const eye = new THREE.Vector3(-1000 + dx, 300, 500 + dx);
            const slack = treeOrderSlack(mesh, group, eye, PIXEL_ANGLE);
            assert.ok(Number.isFinite(slack) && slack > 1);
            const count = treeInstancesToDraw(mesh, group, eye, PIXEL_ANGLE);
            assert.ok(Math.max(...kept(mesh, eye)) < count, `moved ${dx}: kept beyond ${count}`);
        }
    });

    it('asks to be ordered again once the slack passes the limit', () => {
        const { mesh, group } = patch(4000);
        const eye = new THREE.Vector3(-1000, 300, 500);
        assert.ok(treeReorderWanted(mesh, group, eye, PIXEL_ANGLE), 'unordered and thinned');
        orderTreesFor(mesh, group, eye);
        assert.ok(!treeReorderWanted(mesh, group, eye, PIXEL_ANGLE));
        const far = new THREE.Vector3(-600, 300, 500);
        assert.ok(treeOrderSlack(mesh, group, far, PIXEL_ANGLE) > TREE_REORDER_SLACK);
        assert.ok(treeReorderWanted(mesh, group, far, PIXEL_ANGLE));
    });

    it('is not worth ordering a patch the thinning hardly touches', () => {
        const { mesh, group } = patch(4000);
        // From 1 km up and 300 m off, even the far edge keeps most trees.
        mesh.userData.treeSpacingM = 30;
        assert.ok(!treeReorderWanted(mesh, group, new THREE.Vector3(700, 1000, 500), PIXEL_ANGLE));
    });

    it('stays valid for a long way beside a patch: the trees within keep-all count once', () => {
        const { mesh, group } = patch(4000);
        const eye = new THREE.Vector3(990, 20, 500);
        orderTreesFor(mesh, group, eye);
        for (const dx of [50, 150, 300]) {
            const moved = new THREE.Vector3(990 - dx, 20, 500);
            const slack = treeOrderSlack(mesh, group, moved, PIXEL_ANGLE);
            assert.ok(Number.isFinite(slack), `moved ${dx}: finite slack`);
            const count = treeInstancesToDraw(mesh, group, moved, PIXEL_ANGLE);
            assert.ok(Math.max(...kept(mesh, moved)) < count, `moved ${dx}: kept beyond ${count}`);
        }
    });
});

/** One 18,000 m^2 land triangle of class `cls`, enough for a tile to scatter. */
function oneTriangleTile(cls: number): PtmTile {
    return {
        quantScale: 1,
        landPositions: new Float32Array([0, 0, 0, 200, 0, 0, 0, 0, 180]),
        landAttrs: new Uint8Array([90, 120, 60, cls, 90, 120, 60, cls, 90, 120, 60, cls]),
    } as unknown as PtmTile;
}

function speciesCounts(cls: number): Map<Species, number> {
    return new Map(scatterTreeSpecies(oneTriangleTile(cls)).map(g => [g.species, g.points.length]));
}

describe('scatterTreeSpecies biomes', () => {
    it('grows a forest on mangrove, like any wood', () => {
        const counts = speciesCounts(10);
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        assert.ok(total >= 85 && total <= 95, `${total} trees`);
        assert.ok(!counts.has(Species.SHRUB) && !counts.has(Species.BUSH));
    });

    it('grows sparse shrubs and the odd bush on heath, never a tree', () => {
        const counts = speciesCounts(14);
        const shrubs = counts.get(Species.SHRUB) ?? 0;
        const bushes = counts.get(Species.BUSH) ?? 0;
        assert.equal(counts.size, 2);
        assert.ok(shrubs + bushes >= 95 && shrubs + bushes <= 105, `${shrubs + bushes} plants`);
        assert.ok(bushes > 10 && bushes < shrubs, `${bushes} bushes, ${shrubs} shrubs`);
        // Thinner than scrub on the same ground.
        assert.ok(shrubs + bushes < (speciesCounts(2).get(Species.SHRUB) ?? 0) / 2);
    });

    it('grows nothing on sand or tundra', () => {
        assert.equal(scatterTreeSpecies(oneTriangleTile(12)).length, 0);
        assert.equal(scatterTreeSpecies(oneTriangleTile(11)).length, 0);
    });
});

describe('scatter patches', () => {
    it('splits groups into cells and keeps every point with its tint and normal', () => {
        const points = [];
        const tints: number[] = [];
        const normals: number[] = [];
        for (let i = 0; i < 64; i++) {
            points.push({ x: (i % 8) * 100, y: 0, z: Math.floor(i / 8) * 100 });
            tints.push(i, i, i);
            normals.push(0, 1, i);
        }
        const cells = splitIntoCells([{ shape: 2, points, tints, normals }], g => ({ shape: g.shape, points: [], tints: [], normals: [] }));
        assert.equal(cells.length, 16);
        const all = cells.flat();
        assert.equal(all.reduce((n, g) => n + g.points.length, 0), 64);
        for (const g of all) {
            assert.equal(g.shape, 2);
            g.points.forEach((p, k) => {
                const i = p.x / 100 + 8 * (p.z / 100);
                assert.deepEqual(g.tints.slice(k * 3, k * 3 + 3), [i, i, i]);
                assert.equal(g.normals[k * 3 + 2], i);
            });
        }
    });

    it('shuffles slots into a permutation, the same every time', () => {
        const a = shuffledSlots(500);
        assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 500 }, (_, i) => i));
        assert.deepEqual([...shuffledSlots(500)], [...a]);
    });
});

describe('size cutoff', () => {
    it('draws nothing once the tallest instance is under TREE_MIN_SIZE_PX at the near edge', () => {
        const { mesh, group } = patch(400);
        const sizeM = 1.5;
        mesh.userData.treeSizeM = sizeM;
        // The patch's near edge is about 1000 m out along x.
        const cutoffM = sizeM / (TREE_MIN_SIZE_PX * PIXEL_ANGLE);
        assert.ok(cutoffM > 1000, 'the patch starts inside the cutoff');
        const inside = new THREE.Vector3(0, 0, 0);
        assert.ok(treeInstancesToDraw(mesh, group, inside, PIXEL_ANGLE) > 0);
        // The near edge is the bounding sphere's, a little short of x = 1000.
        const beyond = new THREE.Vector3(-cutoffM, 0, 0);
        assert.equal(treeInstancesToDraw(mesh, group, beyond, PIXEL_ANGLE), 0);
        delete mesh.userData.treeSizeM;
        assert.ok(treeInstancesToDraw(mesh, group, beyond, PIXEL_ANGLE) > 0, 'a tree patch has no cutoff');
    });
});
