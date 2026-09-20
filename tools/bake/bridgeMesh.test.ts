import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zlibSync } from 'fflate';
import { BridgeRole, decodePbr, encodePbr } from '../../src/script/terrain/pbr';
import { BridgeGround, BridgeSpan, planBridge } from './bridges';
import {
    DECK_SIMPLIFY_TOLERANCE_M, IDENTITY_FRAME, buildBridgeMesh, buildTileBridgeMesh, keptStations,
} from './bridgeMesh';
import { RBR_MAGIC, decodeRbr } from './rbr';

const valley = (len: number, depth: number): BridgeGround => ({
    groundY: (x) => 100 - depth * (1 - Math.abs(x - len / 2) / (len / 2)),
});

const span = (structure: BridgeSpan['structure'], len = 300): BridgeSpan => ({
    structure, deckWidthM: 12, layer: 0, points: [{ x: 0, z: 0 }, { x: len, z: 0 }],
});

const NO_SHEAR = IDENTITY_FRAME;
const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

describe('buildBridgeMesh', () => {
    const plan = planBridge(span('beam'), valley(300, 40))!;
    const mesh = buildBridgeMesh(plan, NO_SHEAR);

    it('emits triangles for a deck, its piers and its abutments', () => {
        assert.ok(plan.piers.length > 0);
        // A deck box, its parapets, four sides per pier, and the abutment blocks.
        assert.ok(mesh.triangleCount >= plan.piers.length * 8 + 16);
        assert.equal(mesh.vertexCount, mesh.positions.length / 3);
    });

    it('gives every face a unit normal and every index a vertex', () => {
        for (let i = 0; i < mesh.vertexCount; i++) {
            close(Math.hypot(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]), 1, 1e-4);
        }
        for (const ix of mesh.indices) {
            assert.ok(ix < mesh.vertexCount);
        }
    });

    it('faces the deck surface up and marks it as Deck', () => {
        let deckVerts = 0;
        for (let i = 0; i < mesh.vertexCount; i++) {
            if (mesh.roles[i] === BridgeRole.Deck) {
                deckVerts++;
                assert.ok(mesh.normals[i * 3 + 1] > 0.99);
            }
        }
        assert.equal(deckVerts, (keptStations(plan, DECK_SIMPLIFY_TOLERANCE_M).length - 1) * 4);
    });

    it('winds every triangle so its normal points out of the bridge', () => {
        // Every face of a pier must point away from that pier's centre.
        const p = plan.piers[0];
        const cy = (p.topY + p.baseY) / 2;
        let checked = 0;
        for (let i = 0; i < mesh.vertexCount; i++) {
            const dx = mesh.positions[i * 3] - p.x;
            const y = mesh.positions[i * 3 + 1];
            const dz = mesh.positions[i * 3 + 2] - p.z;
            if (Math.abs(dx) > p.widthM || Math.abs(dz) > p.widthM || y > p.topY + 1e-3 || y < p.baseY - 1e-3) {
                continue;
            }
            checked++;
            const dot = dx * mesh.normals[i * 3] + (y - cy) * mesh.normals[i * 3 + 1] + dz * mesh.normals[i * 3 + 2];
            assert.ok(dot > 0);
        }
        assert.equal(checked, 16);   // four sides; the top and base are hidden and not built
    });

    it('builds nothing for a tunnel', () => {
        const tunnel = planBridge(span('tunnel'), valley(300, 40))!;
        assert.equal(buildBridgeMesh(tunnel, NO_SHEAR).triangleCount, 0);
    });

    it('puts the plan back into a tilted tile frame with its height along the real vertical', () => {
        // A frame whose y axis leans 32.5 degrees off the real vertical, as Berlin's does.
        const t = 32.5 * Math.PI / 180;
        const up: [number, number, number] = [Math.sin(t), Math.cos(t), 0];
        const a: [number, number, number] = [Math.cos(t), -Math.sin(t), 0];
        const tilted = buildBridgeMesh(plan, { a, b: [0, 0, 1], up });
        assert.equal(tilted.vertexCount, mesh.vertexCount);
        for (let i = 0; i < mesh.vertexCount; i++) {
            const x = tilted.positions[i * 3], y = tilted.positions[i * 3 + 1], z = tilted.positions[i * 3 + 2];
            // Height along up is the plan's height, and the horizontal position is the plan's.
            close(x * up[0] + y * up[1] + z * up[2], mesh.positions[i * 3 + 1], 1e-3);
            close(x * a[0] + y * a[1] + z * a[2], mesh.positions[i * 3], 1e-3);
            close(z, mesh.positions[i * 3 + 2], 1e-3);
        }
    });

    it('builds a straight, evenly graded deck as one box however many stations the plan has', () => {
        const flat = planBridge(span('beam', 200), { groundY: () => 100 })!;
        assert.ok(flat.stations.length > 20);
        assert.deepEqual(keptStations(flat, DECK_SIMPLIFY_TOLERANCE_M), [0, flat.stations.length - 1]);
    });

    it('keeps the stations a deck needs where a hill forces it off its straight line', () => {
        const hill: BridgeGround = { groundY: (x) => (x > 100 && x < 200 ? 106 : 100) };
        const bumped = planBridge(span('beam', 300), hill)!;
        const kept = keptStations(bumped, DECK_SIMPLIFY_TOLERANCE_M);
        assert.ok(kept.length > 2 && kept.length < bumped.stations.length);
        // Every dropped station stays within the tolerance of the deck actually built.
        for (let k = 0; k + 1 < kept.length; k++) {
            const a = bumped.stations[kept[k]], b = bumped.stations[kept[k + 1]];
            for (let i = kept[k] + 1; i < kept[k + 1]; i++) {
                const t = (bumped.stations[i].s - a.s) / (b.s - a.s);
                close(bumped.stations[i].deckY, a.deckY + (b.deckY - a.deckY) * t, DECK_SIMPLIFY_TOLERANCE_M + 1e-6);
            }
        }
    });

    it('costs fewer triangles than the undecimated deck, and never more', () => {
        const hill: BridgeGround = { groundY: (x) => (x > 100 && x < 200 ? 106 : 100) };
        const bumped = planBridge(span('beam', 300), hill)!;
        assert.ok(buildBridgeMesh(bumped, NO_SHEAR).triangleCount < buildBridgeMesh(bumped, NO_SHEAR, -1).triangleCount);
        const flat = planBridge(span('beam', 200), { groundY: () => 100 })!;
        assert.ok(buildBridgeMesh(flat, NO_SHEAR).triangleCount < buildBridgeMesh(flat, NO_SHEAR, -1).triangleCount / 5);
    });

    it('joins several plans into one mesh', () => {
        assert.equal(buildTileBridgeMesh([plan, plan], NO_SHEAR).triangleCount, mesh.triangleCount * 2);
    });
});

describe('PBR1', () => {
    it('round-trips a mesh', () => {
        const plan = planBridge(span('beam'), valley(300, 40))!;
        const mesh = buildBridgeMesh(plan, NO_SHEAR);
        const bytes = encodePbr({
            id: { z: 12, x: 2200, y: 1350 }, quantScale: 0.05,
            positions: mesh.positions, normals: mesh.normals, roles: mesh.roles, indices: mesh.indices,
        });
        const tile = decodePbr(bytes);
        assert.deepEqual(tile.id, { z: 12, x: 2200, y: 1350 });
        assert.equal(tile.indices.length, mesh.indices.length);
        close(tile.positions[1] * tile.quantScale, mesh.positions[1], 0.1);
        assert.equal(tile.normals[3], mesh.roles[0]);
    });

    it('refuses a bad magic', () => {
        assert.throws(() => decodePbr(new Uint8Array(32)), /magic/);
    });
});

describe('RBR1', () => {
    it('reads what the Python bake writes', () => {
        // One span: structure 2 (arch), layer -1, width 14, maxheight 0, two points.
        const payload = new Uint8Array(6 + 12 + 16);
        const v = new DataView(payload.buffer);
        v.setUint32(0, RBR_MAGIC, true);
        v.setUint16(4, 1, true);
        v.setUint8(6, 2); v.setInt8(7, -1); v.setFloat32(8, 14, true); v.setFloat32(12, 0, true);
        v.setUint16(16, 2, true);
        v.setFloat32(18, 13.4, true); v.setFloat32(22, 52.5, true);
        v.setFloat32(26, 13.41, true); v.setFloat32(30, 52.51, true);
        const got = decodeRbr(zlibSync(payload));
        assert.equal(got.length, 1);
        assert.equal(got[0].structure, 'arch');
        assert.equal(got[0].layer, -1);
        assert.equal(got[0].deckWidthM, 14);
        assert.equal(got[0].points.length, 2);
        close(got[0].points[1].lat, 52.51, 1e-4);
    });
});
