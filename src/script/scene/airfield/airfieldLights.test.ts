import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { PaletteTime } from '../../config/palettes/palette';
import { Airfield } from '../../terrain/airfields';
import { padsOnPlane } from '../../terrain/airfieldTestPads';
import { makeEnuBasis } from '../../terrain/geodesy';
import { SceneMaterialManager } from '../materials/materials';
import { papiWhite, runwayIsLit } from './airfieldLights';
import { buildAirfieldModel } from './airfieldModel';

const MATERIALS = {
    build: (p: { category: string; fadeM?: readonly [number, number] }) => {
        const m = new THREE.MeshBasicMaterial();
        m.userData.category = p.category;
        m.userData.fadeM = p.fadeM;
        return m;
    },
} as unknown as SceneMaterialManager;

const BASIS = makeEnuBasis(28.0015, -15.3937, 0);

function gclp(overrides: Partial<Airfield> = {}): Airfield {
    const field: Airfield = {
        name: 'Gran Canaria', icao: 'GCLP', iata: 'LPA', kind: 'international', area: 'home',
        lat: 27.93016, lon: -15.38801, elevationM: 12.97,
        plane: { heightMsl: 12.97, gradient: -0.00385, headingDeg: 21.4354 },
        runways: [{
            ref: '03L/21R', headingDeg: 21.4354, lengthM: 3103, widthM: 45, surface: 'asphalt', lit: false,
            lat: 27.931904, lon: -15.386584,
            thresholds: [[27.918871, -15.392346], [27.944937, -15.380823]],
        }],
        taxiways: [], aprons: [], buildings: [], pads: [],
        ...overrides,
    };
    return { ...field, pads: padsOnPlane(field) };
}

type Lights = THREE.Points & {
    onEye?: (points: THREE.Points, eye: THREE.Vector3, timeS: number) => void;
};

function lightsOf(airfield: Airfield, level = 0): Lights[] {
    const built = buildAirfieldModel(airfield, BASIS, MATERIALS)!;
    return built.model.lod[level].flats.filter(o => (o as THREE.Points).isPoints) as Lights[];
}

function categoryOf(p: THREE.Points): string {
    return (p.material as THREE.Material).userData.category as string;
}

function count(p: THREE.Points): number {
    return p.geometry.getAttribute('position').count;
}

function shown(p: THREE.Points): number {
    return Math.min(p.geometry.drawRange.count, count(p) - p.geometry.drawRange.start);
}

function centroid(p: THREE.Points): THREE.Vector3 {
    const pos = p.geometry.getAttribute('position');
    const c = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        c.add(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
    return c.divideScalar(pos.count);
}

/** An eye `distance` out from `from` along compass direction `k` of 16, `angle` degrees up. */
function eyeAt(from: THREE.Vector3, k: number, angleDeg: number, distance = 3000): THREE.Vector3 {
    const r = k / 16 * 2 * Math.PI;
    return new THREE.Vector3(
        from.x + Math.sin(r) * distance,
        from.y + Math.tan(angleDeg * Math.PI / 180) * distance,
        from.z + Math.cos(r) * distance);
}

describe('airfield lights', () => {

    it('lights a paved runway at a real airport, not a club strip or a grass field', () => {
        const field = gclp();
        assert.equal(runwayIsLit(field.runways[0], field), true);
        assert.equal(runwayIsLit(field.runways[0], { ...field, kind: 'ga' }), false);
        assert.equal(runwayIsLit({ ...field.runways[0], lit: true }, { ...field, kind: 'ga' }), true);
        assert.equal(runwayIsLit({ ...field.runways[0], surface: 'grass' }, field), false);
        assert.equal(lightsOf(gclp({ kind: 'ga' })).length, 0);
    });

    it('is drawn at every level of detail, and only at night', () => {
        for (const level of [0, 1, 2]) {
            const lights = lightsOf(gclp({
                taxiways: [{ widthM: 23, points: [[27.9300, -15.3960], [27.9300, -15.3930]] }],
            }), level);
            assert.ok(lights.length > 0, `no lights at level ${level}`);
            for (const p of lights) {
                assert.equal(p.userData.time, PaletteTime.NIGHT);
            }
            const kinds = new Set(lights.map(categoryOf));
            for (const c of ['LIGHT_WHITE', 'LIGHT_GREEN', 'LIGHT_RED', 'LIGHT_BLUE']) {
                assert.ok(kinds.has(c), `${c} missing at level ${level}`);
            }
        }
    });

    it('fades every light out with distance, the taxiway first and the flashers last', () => {
        const field = gclp({
            taxiways: [{ widthM: 23, points: [[27.92, -15.40], [27.925, -15.40]] }],
        });
        const fades = lightsOf(field).map(p => ({
            category: categoryOf(p), fade: (p.material as THREE.Material).userData.fadeM as [number, number],
        }));
        for (const { fade } of fades) {
            assert.ok(fade && fade[0] > 0 && fade[1] > fade[0], `fade ${fade}`);
        }
        const blue = fades.find(f => f.category === 'LIGHT_BLUE');
        assert.ok(blue, 'taxiway lights');
        const farthest = Math.max(...fades.map(f => f.fade[1]));
        assert.ok(blue.fade[1] < farthest);
        assert.ok(farthest >= 15000, 'flashers reach the farthest');
    });

    it('puts a light on each edge every 60 m', () => {
        const edges = lightsOf(gclp()).filter(p => categoryOf(p) === 'LIGHT_WHITE' && p.onEye === undefined);
        const total = edges.reduce((n, p) => n + count(p), 0);
        // 53 pairs of edge lights and the approach lights.
        assert.ok(total >= 2 * Math.round(3103 / 60), `${total}`);
    });

    it('codes the centreline red over the last 900 m, for each direction on its own', () => {
        // A club strip too: every lit runway has its centreline lit.
        const field = gclp({ kind: 'regional' } as Partial<Airfield>);
        const lights = lightsOf(field);
        const centre = lights.filter(p => p.name === 'centreline');
        // White and red for each direction.
        assert.equal(centre.length, 4);
        const [whiteUp, redUp, whiteDown, redDown] = centre;
        assert.equal(categoryOf(whiteUp), 'LIGHT_WHITE');
        assert.equal(categoryOf(redUp), 'LIGHT_RED');
        // 103 fixtures in all: last 300 m red (10), 300-900 m every other one (10).
        assert.equal(count(whiteUp) + count(redUp), 103);
        assert.equal(count(redUp), 20);
        assert.equal(count(redDown), 20);
        // Looking up the runway from the 03 approach: the up set shows, the down set does not.
        const behind03 = new THREE.Vector3();
        const pos = whiteUp.geometry.getAttribute('position');
        const first = new THREE.Vector3().fromBufferAttribute(pos, 0);
        const last = new THREE.Vector3().fromBufferAttribute(pos, pos.count - 1);
        behind03.copy(first).addScaledVector(last.clone().sub(first).normalize(), -2000).setY(first.y + 100);
        for (const p of centre) {
            p.onEye!(p, behind03, 0);
        }
        assert.ok(shown(whiteUp) > 0 && shown(redUp) > 0);
        assert.equal(shown(whiteDown), 0);
        assert.equal(shown(redDown), 0);
        // The red ones are at the far end, for the up direction.
        const redPos = redUp.geometry.getAttribute('position');
        const farRed = new THREE.Vector3().fromBufferAttribute(redPos, redPos.count - 1);
        assert.ok(farRed.distanceTo(first) > 2800);
    });

    it('reads a PAPI two white two red on a 3 degree approach, and nothing from behind', () => {
        const lights = lightsOf(gclp());
        const papis = lights.filter(p => p.onEye !== undefined && count(p) === 4);
        // Two ends, a white and a red set each.
        assert.equal(papis.length, 4);
        for (let i = 0; i < papis.length; i += 2) {
            const [white, red] = [papis[i], papis[i + 1]];
            assert.equal(categoryOf(white), 'LIGHT_WHITE');
            assert.equal(categoryOf(red), 'LIGHT_RED');
            const at = centroid(white);
            const look = (k: number, angle: number) => {
                const eye = eyeAt(at, k, angle);
                white.onEye!(white, eye, 0);
                red.onEye!(red, eye, 0);
                return [shown(white), shown(red)];
            };
            const facing = [...Array(16).keys()].filter(k => look(k, 3).reduce((a, b) => a + b) === 4);
            assert.ok(facing.length > 0 && facing.length < 16, `seen from ${facing.length} of 16 directions`);
            const k = facing[0];
            assert.deepEqual(look(k, 3), [2, 2]);
            assert.deepEqual(look(k, 6), [4, 0]);
            assert.deepEqual(look(k, 1), [0, 4]);
            assert.deepEqual(look((k + 8) % 16, 3), [0, 0]);
        }
    });

    it('settles a unit by its own setting', () => {
        const units = [0, 1, 2, 3].map(k => new THREE.Vector3(k * 9, 0, 0));
        const eye = new THREE.Vector3(0, Math.tan(3 * Math.PI / 180) * 3000, 3000);
        assert.deepEqual(papiWhite(units, [3.5, 3 + 1 / 6, 3 - 1 / 6, 2.5], eye), [false, false, true, true]);
    });

    it('shows green to the approach and red to the runway, from the same fixtures', () => {
        const bars = lightsOf(gclp()).filter(p => p.onEye !== undefined && count(p) > 4 && p.name !== 'centreline'
            && (categoryOf(p) === 'LIGHT_GREEN' || categoryOf(p) === 'LIGHT_RED'));
        assert.equal(bars.length, 4);
        const [green, red] = bars;
        assert.equal(count(green), count(red));
        const at = centroid(green);
        for (let k = 0; k < 16; k++) {
            const eye = eyeAt(at, k, 3);
            green.onEye!(green, eye, 0);
            red.onEye!(red, eye, 0);
            assert.equal(shown(green) > 0, shown(red) === 0, `direction ${k}`);
        }
    });

    it('runs the approach flashers in towards the threshold', () => {
        const flashers = lightsOf(gclp()).filter(p => p.onEye !== undefined && categoryOf(p) === 'LIGHT_WHITE' && count(p) > 4
            && p.name !== 'centreline');
        assert.equal(flashers.length, 2);
        const f = flashers[0];
        const steps: number[] = [];
        for (let t = 0; t < 0.5; t += 0.5 / count(f)) {
            f.onEye!(f, new THREE.Vector3(), t + 1e-6);
            assert.equal(f.geometry.drawRange.count, 1);
            steps.push(f.geometry.drawRange.start);
        }
        assert.deepEqual(steps, [...Array(count(f)).keys()]);
        // The first lit is the outermost: farther from the runway than the last.
        const pos = f.geometry.getAttribute('position');
        const runway = centroid(lightsOf(gclp())[0]);
        const first = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0));
        const last = new THREE.Vector3(pos.getX(pos.count - 1), pos.getY(pos.count - 1), pos.getZ(pos.count - 1));
        assert.ok(first.distanceTo(runway) > last.distanceTo(runway));
    });
});
