import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    PTM_SIDE_E, PTM_SIDE_N, PTM_SIDE_S, PTM_SIDE_W, PtmBorder,
    borderEntryIndex, borderEntrySide, packBorderEntry,
} from '../../src/script/terrain/ptm';
import { simplifyLand } from './simplifyLand';

const Q = 0.1;
const CELLS = 8;
const CELL_M = 10;

/**
 * A flat leaf: CELLS x CELLS cells of two triangles at height 0 (y up), a
 * skirt hanging 5 m under its north side, and the border table the bake
 * writes for it (surface corners and edges only, never the skirt's).
 */
function flatLeaf() {
    const pos: number[] = [];
    const vertices: number[] = [], vertexParams: number[] = [];
    const edges: number[] = [], edgeParams: number[] = [];
    const ext = CELLS * CELL_M;
    const sides = (x: number, z: number): Array<[number, number]> => {
        const out: Array<[number, number]> = [];
        if (x === 0) out.push([PTM_SIDE_W, z / ext]);
        if (x === ext) out.push([PTM_SIDE_E, z / ext]);
        if (z === 0) out.push([PTM_SIDE_N, x / ext]);
        if (z === ext) out.push([PTM_SIDE_S, x / ext]);
        return out;
    };
    const tri = (pts: number[][], surface: boolean) => {
        const base = pos.length / 3;
        for (const p of pts) {
            pos.push(p[0] / Q, p[1] / Q, p[2] / Q);
        }
        if (!surface) {
            return;
        }
        pts.forEach((p, k) => {
            for (const [side, param] of sides(p[0], p[2])) {
                vertices.push(packBorderEntry(side, base + k));
                vertexParams.push(param);
            }
            const n = pts[(k + 1) % 3];
            for (const [side, pa] of sides(p[0], p[2])) {
                const pb = sides(n[0], n[2]).find(([s]) => s === side)?.[1];
                if (pb !== undefined) {
                    edges.push(packBorderEntry(side, base + k), packBorderEntry(side, base + (k + 1) % 3));
                    edgeParams.push(pa, pb);
                }
            }
        });
    };
    // The skirt first: its top edges must not be taken for the surface's.
    for (let i = 0; i < CELLS; i++) {
        const x0 = i * CELL_M, x1 = x0 + CELL_M;
        tri([[x0, 0, 0], [x1, 0, 0], [x0, -5, 0]], false);
        tri([[x1, 0, 0], [x1, -5, 0], [x0, -5, 0]], false);
    }
    for (let i = 0; i < CELLS; i++) {
        for (let j = 0; j < CELLS; j++) {
            const x0 = i * CELL_M, x1 = x0 + CELL_M, z0 = j * CELL_M, z1 = z0 + CELL_M;
            tri([[x0, 0, z0], [x0, 0, z1], [x1, 0, z0]], true);
            tri([[x1, 0, z0], [x0, 0, z1], [x1, 0, z1]], true);
        }
    }
    const n = pos.length / 3;
    const land = {
        positions: Int16Array.from(pos),
        normals: Int8Array.from({ length: n * 4 }, (_, i) => (i % 4 === 1 ? 127 : 0)),
        attrs: Uint8Array.from({ length: n * 4 }, (_, i) => (i % 4 === 3 ? 0 : 120)),
    };
    const border: PtmBorder = {
        vertices: Uint32Array.from(vertices), vertexParams: Float32Array.from(vertexParams),
        edges: Uint32Array.from(edges), edgeParams: Float32Array.from(edgeParams),
    };
    return { land, border, surfaceTris: CELLS * CELLS * 2 };
}

/** Share of each side its edges cover, by param. */
function coverage(b: PtmBorder): number[] {
    return [PTM_SIDE_W, PTM_SIDE_E, PTM_SIDE_N, PTM_SIDE_S].map(side => {
        const spans: Array<[number, number]> = [];
        for (let e = 0; e < b.edges.length; e += 2) {
            if (borderEntrySide(b.edges[e]) === side) {
                spans.push([Math.min(b.edgeParams[e], b.edgeParams[e + 1]), Math.max(b.edgeParams[e], b.edgeParams[e + 1])]);
            }
        }
        spans.sort((x, y) => x[0] - y[0]);
        let cov = 0, end = 0;
        for (const [a, c] of spans) {
            if (c > end) {
                cov += c - Math.max(a, end);
                end = c;
            }
        }
        return cov;
    });
}

describe('simplifyLand', () => {
    const { land, border, surfaceTris } = flatLeaf();
    const out = simplifyLand(land, { quantScale: Q, border }, [0, 1, 0], new Float32Array(0), 0.1)!;
    const P = out.land.positions;
    const at = (i: number) => `${P[i * 3]},${P[i * 3 + 1]},${P[i * 3 + 2]}`;

    it('makes a flat leaf lighter and keeps its skirt', () => {
        const tris = P.length / 9;
        assert.ok(tris < surfaceTris + CELLS * 2, `${tris} triangles`);
        const hanging = [...Array(tris).keys()].filter(t => [0, 1, 2].some(k => P[(t * 3 + k) * 3 + 1] < 0));
        assert.ok(hanging.length > 0, 'the skirt is gone');
    });

    it('moves every border vertex entry onto a corner at the same place, side and param', () => {
        const old = new Set<string>();
        for (let e = 0; e < border.vertices.length; e++) {
            const i = borderEntryIndex(border.vertices[e]);
            old.add(`${land.positions[i * 3]},${land.positions[i * 3 + 1]},${land.positions[i * 3 + 2]}|${borderEntrySide(border.vertices[e])}|${border.vertexParams[e]}`);
        }
        const b = out.border!;
        assert.ok(b.vertices.length > 0);
        for (let e = 0; e < b.vertices.length; e++) {
            const key = `${at(borderEntryIndex(b.vertices[e]))}|${borderEntrySide(b.vertices[e])}|${b.vertexParams[e]}`;
            assert.ok(old.has(key), key);
        }
    });

    it('keeps every side covered by edges of the surface, each once, none from the skirt', () => {
        const b = out.border!;
        assert.deepEqual(coverage(b).map(c => c.toFixed(6)), coverage(border).map(c => c.toFixed(6)));
        const seen = new Set<string>();
        for (let e = 0; e < b.edges.length; e += 2) {
            const i = borderEntryIndex(b.edges[e]), j = borderEntryIndex(b.edges[e + 1]);
            assert.equal(Math.floor(i / 3), Math.floor(j / 3), 'an edge is two corners of one facet');
            const t = Math.floor(i / 3), c = [0, 1, 2].map(k => [P[(t * 3 + k) * 3], P[(t * 3 + k) * 3 + 2]]);
            const plan = (c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[2][0] - c[0][0]) * (c[1][1] - c[0][1]);
            assert.ok(Math.abs(plan) > 0, 'an edge taken from the skirt');
            const key = `${borderEntrySide(b.edges[e])}|${[at(i), at(j)].sort().join('|')}`;
            assert.ok(!seen.has(key), `twice: ${key}`);
            seen.add(key);
        }
    });
});
