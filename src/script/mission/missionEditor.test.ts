import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_FLIGHTS } from './flightPlan';
import { MissionEditor, MissionEditorHost, RunwayEnd } from './missionEditor';

const RUNWAY: RunwayEnd = { airfield: 'EDDB', designator: '25L', lat: 52.36, lon: 13.51 };

function editor(): MissionEditor {
    const host: MissionEditorHost = {
        aircraft: [{ id: 'f16', name: 'F-16' }],
        defaultAircraftId: 'f16',
        area: 'DACH',
        centre: () => ({ lat: 52.4, lon: 13.06 }),
        // A runway 'under' anything east of 13.5.
        runwayEndAt: (_lat, lon) => (lon > 13.5 ? RUNWAY : undefined),
        runwayEnds: () => [RUNWAY],
    };
    return new MissionEditor(host);
}

describe('MissionEditor', () => {
    it('makes the first flight the player and the next ones AI', () => {
        const e = editor();
        e.addFlight();
        e.addFlight();
        assert.deepEqual(e.mission().flights.map(f => f.control), ['player', 'ai']);
        assert.equal(e.selected(), 1);
        e.updateFlight(1, { control: 'player' });
        assert.deepEqual(e.mission().flights.map(f => f.control), ['ai', 'player']);
    });

    it('adds waypoints where the map is clicked, at the last one\'s altitude and speed', () => {
        const e = editor();
        e.addFlight();
        e.clickMap(52.5, 13.1);
        e.updateWaypoint(0, 0, { altM: 1234, speedMps: 150 });
        e.clickMap(52.6, 13.2);
        const [a, b] = e.mission().flights[0].waypoints;
        assert.deepEqual(a, { lat: 52.5, lon: 13.1, altM: 1234, speedMps: 150 });
        assert.deepEqual(b, { lat: 52.6, lon: 13.2, altM: 1234, speedMps: 150 });
        assert.deepEqual(e.errors(), []);
    });

    it('starts and lands on a clicked runway end, then goes back to adding waypoints', () => {
        const e = editor();
        e.addFlight();
        e.pick.set('start');
        e.clickMap(52.36, 13.52);
        assert.deepEqual(e.mission().flights[0].start, { kind: 'runway', ...RUNWAY });
        assert.equal(e.pick(), 'waypoint');
        e.pick.set('land');
        e.clickMap(52.36, 13.52);
        assert.deepEqual(e.mission().flights[0].land, { kind: 'runway', ...RUNWAY });
    });

    it('starts in the air off a runway, and will not land there', () => {
        const e = editor();
        e.addFlight();
        e.pick.set('start');
        e.clickMap(52.1, 13.0);
        assert.equal(e.mission().flights[0].start.kind, 'air');
        e.pick.set('land');
        e.clickMap(52.1, 13.0);
        assert.equal(e.mission().flights[0].land, undefined);
        assert.equal(e.pick(), 'land');
        assert.match(e.status(), /runway/);
    });

    it('adds after the selected waypoint, selects it, and deletes back down the route', () => {
        const e = editor();
        e.addFlight();
        e.clickMap(1, 1);
        e.clickMap(3, 3);
        e.selectPoint(0, 0);
        e.clickMap(2, 2);
        assert.deepEqual(e.mission().flights[0].waypoints.map(w => w.lat), [1, 2, 3]);
        assert.equal(e.selectedPoint(), 1);
        e.removeWaypoint(0, 1);
        assert.deepEqual(e.mission().flights[0].waypoints.map(w => w.lat), [1, 3]);
        assert.equal(e.selectedPoint(), 0);
        e.removeWaypoint(0, 0);
        assert.equal(e.selectedPoint(), undefined);
    });

    it('adds a waypoint from the menu halfway on, or past the end, and deletes any point but the start', () => {
        const e = editor();
        e.addFlight();
        e.moveStart(0, 0, 0);
        e.clickMap(0, 2);
        e.addWaypointAfter(0, 'start');
        assert.deepEqual(e.mission().flights[0].waypoints.map(w => [w.lat, w.lon]), [[0, 1], [0, 2]]);
        assert.equal(e.selectedPoint(), 0);
        e.addWaypointAfter(0, 1);
        assert.deepEqual(e.mission().flights[0].waypoints.map(w => [w.lat, w.lon]), [[0, 1], [0, 2], [0, 3]]);
        assert.equal(e.selectedPoint(), 2);
        e.deletePoint(0, 'start');
        e.deletePoint(0, 0);
        assert.deepEqual(e.mission().flights[0].waypoints.map(w => w.lon), [2, 3]);
    });

    it('drops the waypoint selection with another flight', () => {
        const e = editor();
        e.addFlight();
        e.clickMap(1, 1);
        e.addFlight();
        assert.equal(e.selectedPoint(), undefined);
        e.selectPoint(0, 0);
        assert.deepEqual([e.selected(), e.selectedPoint()], [0, 0]);
    });

    it('drags the start onto a runway end and back into the air', () => {
        const e = editor();
        e.addFlight();
        e.updateAirStart(0, { altM: 999 });
        e.selectPoint(0, 'start');
        e.moveStart(0, 52.36, 13.52);
        assert.deepEqual(e.mission().flights[0].start, { kind: 'runway', ...RUNWAY });
        e.moveStart(0, 52.0, 13.0);
        assert.deepEqual(e.mission().flights[0].start,
            { kind: 'air', lat: 52.0, lon: 13.0, altM: 3_000, speedMps: 650 * (1 / 3.6), headingDeg: 0 });
        // A waypoint added with the start selected goes first.
        e.clickMap(1, 1);
        e.selectPoint(0, 'start');
        e.clickMap(2, 2);
        assert.deepEqual(e.mission().flights[0].waypoints.map(w => w.lat), [2, 1]);
    });

    it('drags the landing only from runway end to runway end, and Delete-style clearing drops the selection', () => {
        const e = editor();
        e.addFlight();
        e.pick.set('land');
        e.clickMap(52.36, 13.52);
        e.selectPoint(0, 'land');
        e.moveLand(0, 52.0, 13.0);
        assert.deepEqual(e.mission().flights[0].land, { kind: 'runway', ...RUNWAY }, 'moved off the runway');
        e.clickMap(1, 1);
        assert.equal(e.mission().flights[0].waypoints.length, 1, 'a waypoint with the landing selected goes before it');
        e.selectPoint(0, 'land');
        e.clearLanding(0);
        assert.equal(e.mission().flights[0].land, undefined);
        assert.equal(e.selectedPoint(), undefined);
    });

    it('stops at the flights the sim has room for', () => {
        const e = editor();
        for (let i = 0; i < MAX_FLIGHTS + 2; i++) {
            e.addFlight();
        }
        assert.equal(e.mission().flights.length, MAX_FLIGHTS);
    });

    it('never changes a mission in place, so its identity says when it changed', () => {
        const e = editor();
        const before = e.mission();
        e.addFlight();
        assert.notEqual(e.mission(), before);
        assert.equal(before.flights.length, 0);
    });
});
