import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { PTM_SIDE_E, PTM_SIDE_N, PTM_SIDE_S, PTM_SIDE_W, packBorderEntry } from './ptm';
import { StitchableTile, masterOf, masterParam, stitchSeams } from './seamStitch';
import { TileKey, tileKeyString } from './tiling';

/**
 * A tile whose land stream is just the listed points, all in one frame (the
 * group sits at the origin, unscaled), with the listed border entries and
 * edges. Triangles do not matter to the stitcher.
 */
function withLand(t: StitchableTile): StitchableTile {
    t.land = new THREE.Mesh(t.landGeometryFaceted!, new THREE.MeshBasicMaterial());
    t.group.add(t.land);
    return t;
}

const fillPoints = (t: StitchableTile) => {
    if (!t.seamFill) {
        return [];
    }
    const p = t.seamFill.geometry.getAttribute('position').array as Int16Array;
    return Array.from({ length: p.length / 3 }, (_, i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
};

function tile(
    points: Array<[number, number, number]>,
    entries: Array<[side: number, vertex: number, param: number]>,
    edges: Array<[side: number, a: number, b: number, pa: number, pb: number]>,
    offset = new THREE.Vector3(),
): StitchableTile {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Int16Array(points.flat()), 3));
    const group = new THREE.Group();
    group.position.copy(offset);
    group.updateMatrix();
    return {
        group,
        landGeometryFaceted: g,
        border: {
            vertices: new Uint32Array(entries.map(([s, v]) => packBorderEntry(s, v))),
            vertexParams: new Float32Array(entries.map(([, , p]) => p)),
            edges: new Uint32Array(edges.flatMap(([s, a, b]) => [packBorderEntry(s, a), packBorderEntry(s, b)])),
            edgeParams: new Float32Array(edges.flatMap(([, , , pa, pb]) => [pa, pb])),
        },
    };
}

const heights = (t: StitchableTile) => {
    const p = t.landGeometryFaceted!.getAttribute('position').array as Int16Array;
    return Array.from({ length: p.length / 3 }, (_, i) => p[i * 3 + 1]);
};

// A z3 tile and the z4 tile against the north half of its east side. The
// side runs along x = 100; z grows southwards.
const M_ID: TileKey = { z: 3, x: 0, y: 0 };
const T_ID: TileKey = { z: 4, x: 2, y: 0 };
const coarse = () => tile(
    [[100, 0, 0], [100, 10, 100], [100, 0, 200]],
    [[PTM_SIDE_E, 0, 0], [PTM_SIDE_E, 1, 0.5], [PTM_SIDE_E, 2, 1]],
    [[PTM_SIDE_E, 0, 1, 0, 0.5], [PTM_SIDE_E, 1, 2, 0.5, 1]],
);
// Surface at 2, 7, 12 down its west side, and a skirt hanging 30 m under
// the middle vertex.
const fine = () => tile(
    [[100, 2, 0], [100, 7, 50], [100, 12, 100], [100, -23, 50]],
    [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 0.5], [PTM_SIDE_W, 2, 1], [PTM_SIDE_W, 3, 0.5]],
    [[PTM_SIDE_W, 0, 1, 0, 0.5], [PTM_SIDE_W, 1, 2, 0.5, 1]],
);

describe('masterOf', () => {
    const drawn = (...ids: TileKey[]) => new Map(ids.map(id => [tileKeyString(id), id]));

    it('finds a coarser tile across the side', () => {
        assert.deepEqual(masterOf(T_ID, PTM_SIDE_W, drawn(M_ID, T_ID))?.id, M_ID);
    });

    it('gives a same-level side to the west or north neighbour only', () => {
        const east: TileKey = { z: 4, x: 3, y: 0 };
        const south: TileKey = { z: 4, x: 2, y: 1 };
        const d = drawn(T_ID, east, south);
        assert.deepEqual(masterOf(east, PTM_SIDE_W, d)?.id, T_ID);
        assert.equal(masterOf(T_ID, PTM_SIDE_E, d), undefined);
        assert.deepEqual(masterOf(south, PTM_SIDE_N, d)?.id, T_ID);
        assert.equal(masterOf(T_ID, PTM_SIDE_S, d), undefined);
    });

    it('never moves a side that faces finer tiles', () => {
        assert.equal(masterOf(M_ID, PTM_SIDE_E, drawn(M_ID, T_ID)), undefined);
    });

    it('wraps west across the antimeridian and stops at the pole', () => {
        const edge: TileKey = { z: 2, x: 0, y: 0 };
        const wrapped: TileKey = { z: 2, x: 7, y: 0 };
        assert.deepEqual(masterOf(edge, PTM_SIDE_W, drawn(edge, wrapped))?.id, wrapped);
        assert.equal(masterOf(edge, PTM_SIDE_N, drawn(edge)), undefined);
    });
});

describe('masterParam', () => {
    it('maps a fine side onto its stretch of the coarse one', () => {
        assert.equal(masterParam(T_ID, PTM_SIDE_W, M_ID, 0.5), 0.25);
        assert.equal(masterParam({ z: 4, x: 2, y: 1 }, PTM_SIDE_W, M_ID, 0.5), 0.75);
        assert.equal(masterParam({ z: 4, x: 3, y: 2 }, PTM_SIDE_N, { z: 3, x: 1, y: 0 }, 0), 0.5);
    });
});

describe('stitchSeams', () => {
    it('moves the fine border onto the coarse edge and carries the skirt along', () => {
        const m = coarse();
        const t = fine();
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        // The coarse edge runs 0 -> 10 over the fine tile's half: 0, 5, 10.
        assert.deepEqual(heights(t), [0, 5, 10, -25]);
        assert.deepEqual(heights(m), [0, 10, 0]);
    });

    it('follows the master through a tile offset', () => {
        // Same ground, but the fine tile's frame sits 1000 m up: its local
        // heights are 1000 lower than the world ones.
        const m = coarse();
        const t = tile(
            [[100, -998, 0], [100, -993, 50], [100, -988, 100]],
            [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 0.5], [PTM_SIDE_W, 2, 1]],
            [[PTM_SIDE_W, 0, 1, 0, 0.5], [PTM_SIDE_W, 1, 2, 0.5, 1]],
            new THREE.Vector3(0, 1000, 0),
        );
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        assert.deepEqual(heights(t), [-1000, -995, -990]);
    });

    it('does nothing again until the neighbourhood changes', () => {
        const m = coarse();
        const t = fine();
        const drawn = [{ id: M_ID, tile: m }, { id: T_ID, tile: t }];
        assert.equal(stitchSeams(drawn), 1);
        assert.equal(stitchSeams(drawn), 0);
    });

    it('puts the border back once the coarse neighbour is gone', () => {
        const m = coarse();
        const t = fine();
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        stitchSeams([{ id: T_ID, tile: t }]);
        assert.deepEqual(heights(t), [2, 7, 12, -23]);
    });

    it('chains: a tile follows a master that has itself moved', () => {
        const m = coarse();
        // East of the fine tile, same level, meeting its east side (x = 300).
        const tEast = tile(
            [[300, 50, 0], [300, 60, 100]],
            [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 1]],
            [[PTM_SIDE_W, 0, 1, 0, 1]],
        );
        const tWithEast = tile(
            [[100, 2, 0], [100, 12, 100], [300, 40, 0], [300, 40, 100]],
            [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 1], [PTM_SIDE_E, 2, 0], [PTM_SIDE_E, 3, 1]],
            [[PTM_SIDE_W, 0, 1, 0, 1], [PTM_SIDE_E, 2, 3, 0, 1]],
        );
        stitchSeams([
            { id: { z: 4, x: 3, y: 0 }, tile: tEast },
            { id: T_ID, tile: tWithEast },
            { id: M_ID, tile: m },
        ]);
        // The east tile takes the fine tile's east edge, which did not move.
        assert.deepEqual(heights(tEast), [40, 40]);
        assert.deepEqual(heights(tWithEast), [0, 10, 40, 40]);
    });

    it('leaves a tile with no border table alone', () => {
        const m = coarse();
        const t = fine();
        delete t.border;
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        assert.deepEqual(heights(t), [2, 7, 12, -23]);
    });

    it('leaves a point the master has no land at alone', () => {
        // Coarse land only along the south half of its side, where the
        // fine tile is not.
        const m = tile(
            [[100, 0, 100], [100, 0, 200]],
            [[PTM_SIDE_E, 0, 0.5], [PTM_SIDE_E, 1, 1]],
            [[PTM_SIDE_E, 0, 1, 0.5, 1]],
        );
        const t = fine();
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        // Only the end at param 1 (coarse 0.5) meets coarse land.
        assert.deepEqual(heights(t), [2, 7, 0, -23]);
    });

    it('lets the coarser master win a corner both sides claim', () => {
        // Fine tile's NW corner is on its west side (coarse master, z3) and
        // its north side (same-level master, z4).
        const north: TileKey = { z: 4, x: 2, y: 1 };
        const fineSouth = tile(
            [[100, 2, 100], [100, 12, 200], [300, 30, 100]],
            [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 1], [PTM_SIDE_N, 0, 0], [PTM_SIDE_N, 2, 1]],
            [[PTM_SIDE_W, 0, 1, 0, 1], [PTM_SIDE_N, 0, 2, 0, 1]],
        );
        const fineNorth = tile(
            [[100, 50, 100], [300, 50, 100]],
            [[PTM_SIDE_S, 0, 0], [PTM_SIDE_S, 1, 1]],
            [[PTM_SIDE_S, 0, 1, 0, 1]],
        );
        stitchSeams([
            { id: M_ID, tile: coarse() },
            { id: T_ID, tile: fineNorth },
            { id: north, tile: fineSouth },
        ]);
        // Coarse edge at params 0.5..1 runs 10 -> 0; the corner takes the
        // coarse value, the north side's far end the north tile's.
        assert.deepEqual(heights(fineSouth), [10, 0, 50]);
    });

    it('fills the T-junction where the coarse edge has a vertex the fine one lacks', () => {
        // Coarse: a 20 m bump at a quarter of its side, which lands mid-way
        // along the fine tile's single edge.
        const m = tile(
            [[100, 0, 0], [100, 20, 50], [100, 0, 100], [100, 0, 200]],
            [[PTM_SIDE_E, 0, 0], [PTM_SIDE_E, 1, 0.25], [PTM_SIDE_E, 2, 0.5], [PTM_SIDE_E, 3, 1]],
            [[PTM_SIDE_E, 0, 1, 0, 0.25], [PTM_SIDE_E, 1, 2, 0.25, 0.5], [PTM_SIDE_E, 2, 3, 0.5, 1]],
        );
        const t = withLand(tile(
            [[100, 2, 0], [100, 12, 100]],
            [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 1]],
            [[PTM_SIDE_W, 0, 1, 0, 1]],
        ));
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        // Both ends moved onto the coarse line; the bump is the crack.
        assert.deepEqual(heights(t), [0, 0]);
        assert.deepEqual(fillPoints(t), [[100, 0, 0], [100, 20, 50], [100, 0, 100]]);
        assert.equal(t.seamFill!.parent, t.group);
    });

    it('still fills a crack where the coarse land starts inside the fine edge', () => {
        // Coarse land begins at a fifth of its side (a coast), with the bump
        // still mid-way along the fine edge.
        const m = tile(
            [[100, 0, 40], [100, 20, 50], [100, 0, 100]],
            [[PTM_SIDE_E, 0, 0.2], [PTM_SIDE_E, 1, 0.25], [PTM_SIDE_E, 2, 0.5]],
            [[PTM_SIDE_E, 0, 1, 0.2, 0.25], [PTM_SIDE_E, 1, 2, 0.25, 0.5]],
        );
        const t = withLand(tile(
            [[100, 2, 0], [100, 12, 100]],
            [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 1]],
            [[PTM_SIDE_W, 0, 1, 0, 1]],
        ));
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        // The near end has no coarse land to move to; the far end does. The
        // coast point at z = 40 is off the fine edge too, so it is filled.
        assert.deepEqual(heights(t), [2, 0]);
        assert.deepEqual(fillPoints(t), [
            [100, 2, 0], [100, 0, 40], [100, 20, 50],
            [100, 2, 0], [100, 20, 50], [100, 0, 100],
        ]);
    });

    it('needs no fill where both sides have the same vertices', () => {
        const m = coarse();
        const t = withLand(tile(
            [[100, 2, 0], [100, 12, 100]],
            [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 1]],
            [[PTM_SIDE_W, 0, 1, 0, 1]],
        ));
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        assert.equal(t.seamFill, undefined);
    });

    it('drops the fill once the coarse neighbour is gone', () => {
        const m = tile(
            [[100, 0, 0], [100, 20, 50], [100, 0, 100]],
            [[PTM_SIDE_E, 0, 0], [PTM_SIDE_E, 1, 0.25], [PTM_SIDE_E, 2, 0.5]],
            [[PTM_SIDE_E, 0, 1, 0, 0.25], [PTM_SIDE_E, 1, 2, 0.25, 0.5]],
        );
        const t = withLand(tile(
            [[100, 2, 0], [100, 12, 100]],
            [[PTM_SIDE_W, 0, 0], [PTM_SIDE_W, 1, 1]],
            [[PTM_SIDE_W, 0, 1, 0, 1]],
        ));
        stitchSeams([{ id: M_ID, tile: m }, { id: T_ID, tile: t }]);
        assert.ok(t.seamFill);
        stitchSeams([{ id: T_ID, tile: t }]);
        assert.equal(t.seamFill, undefined);
        assert.equal(t.group.children.length, 1);
    });
});
