import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Airfield } from '../../terrain/airfields';
import { makeEnuBasis } from '../../terrain/geodesy';
import { AIRFIELD_SURFACE_EPS_M } from '../airfield/airfieldModel';
import { trySnag } from './arrestorCables';
import {
    LAND_WIRE_CLEARANCE_M, LAND_WIRE_ID_BASE, LandArrestorWire,
    landArrestorFields, landArrestorWiresOf, landWireById,
} from './landArrestorWires';

/** A 36 m wire running 135/315 (x east, z south), across a deck that runs 045/225. */
function diagonalWire(): LandArrestorWire {
    const half = 18 / Math.SQRT2;
    return {
        id: LAND_WIRE_ID_BASE, name: 'Svetlana-2',
        a: new THREE.Vector3(-half, 0.35, -half),
        b: new THREE.Vector3(half, 0.35, half),
    };
}

/** Scene direction of a true bearing: x east, z south. */
function along(bearingDeg: number, m: number): THREE.Vector3 {
    const r = bearingDeg * Math.PI / 180;
    return new THREE.Vector3(Math.sin(r) * m, 1.0, -Math.cos(r) * m);
}

describe('land arresting wires', () => {

    it('is a field each way across the wire', () => {
        const fields = landArrestorFields([diagonalWire()]);
        assert.equal(fields.length, 2);
        assert.ok(fields[0].deckAxis.dot(fields[1].deckAxis) < -0.999);
        for (const f of fields) {
            assert.equal(f.fixed, true);
            assert.deepEqual(f.cableIds, [LAND_WIRE_ID_BASE]);
            // Square to the wire, level.
            const w = diagonalWire();
            assert.ok(Math.abs(f.deckAxis.dot(w.b.clone().sub(w.a))) < 1e-9);
            assert.equal(f.deckAxis.y, 0);
        }
    });

    it('catches a hook crossing at the deck heading, from either end', () => {
        const fields = landArrestorFields([diagonalWire()]);
        for (const bearing of [45, 225]) {
            const vel = along(bearing, 60).setY(0);
            const prev = along(bearing, -0.6);
            const now = along(bearing, 0.4);
            const hits = fields.map(f => trySnag(now, prev, vel, f, true));
            assert.equal(hits.filter(i => i === 0).length, 1, `bearing ${bearing}`);
        }
    });

    it('lets a hook past the end of the wire go', () => {
        const fields = landArrestorFields([diagonalWire()]);
        const offset = along(135, 30).setY(0); // 30 m along the wire: past its 18 m half span
        const vel = along(45, 60).setY(0);
        const prev = along(45, -0.6).add(offset);
        const now = along(45, 0.4).add(offset);
        assert.ok(fields.every(f => trySnag(now, prev, vel, f, true) < 0));
    });

    it('needs the hook down', () => {
        const fields = landArrestorFields([diagonalWire()]);
        const vel = along(45, 60).setY(0);
        assert.ok(fields.every(f => trySnag(along(45, 0.4), along(45, -0.6), vel, f, false) < 0));
    });

    it('lays each wire on the airfield plane, numbered past the carrier', () => {
        const basis = makeEnuBasis(45.09, 33.59, 0);
        const field = {
            name: 'Saki', icao: 'URFI', iata: '', kind: 'military', area: 'Krim',
            lat: 45.09, lon: 33.59, elevationM: 14.9,
            plane: { heightMsl: 14.9, gradient: 0, headingDeg: 45 },
            runways: [{
                ref: '04/22', headingDeg: 45, lengthM: 3000, widthM: 45,
                surface: 'concrete', lit: false, lat: 45.09, lon: 33.59,
                thresholds: [[45.08, 33.58], [45.10, 33.60]],
            }],
            taxiways: [], aprons: [], buildings: [], pads: [],
            arrestingWires: [
                { name: 'Svetlana-2', points: [[45.0901, 33.5901], [45.0903, 33.5899]] },
                { name: 'Svetlana-2', points: [[45.0902, 33.5902], [45.0904, 33.5900]] },
            ],
        } satisfies Airfield;
        const wires = landArrestorWiresOf([field], basis);
        assert.deepEqual(wires.map(w => w.id), [LAND_WIRE_ID_BASE, LAND_WIRE_ID_BASE + 1]);
        for (const w of wires) {
            // A few metres from the origin the tangent plane has not dropped away yet.
            assert.ok(Math.abs(w.a.y - (14.9 + AIRFIELD_SURFACE_EPS_M + LAND_WIRE_CLEARANCE_M)) < 0.05, `${w.a.y}`);
        }
        assert.equal(landWireById(wires, LAND_WIRE_ID_BASE + 1), wires[1]);
        assert.equal(landWireById(wires, 2), undefined);
    });
});
