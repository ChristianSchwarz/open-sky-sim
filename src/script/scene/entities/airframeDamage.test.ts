import * as THREE from 'three';
import { describe, it } from 'node:test';
import { expect } from './testExpect';
import { Model } from '../models/models';
import { AirframeDamage } from './airframeDamage';
import { WreckField, WreckPart, WreckSource } from './wreckField';

const fuselageMat = new THREE.MeshBasicMaterial();
const wingMat = new THREE.MeshBasicMaterial();
const aileronMat = new THREE.MeshBasicMaterial();
const gearMat = new THREE.MeshBasicMaterial();

/** A fuselage (z -7..7, front +Z) with a 14 m wing across it. */
function jet(): Model {
    const fuselage = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 14, 3, 3, 28).toNonIndexed(), fuselageMat);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(14, 0.3, 3, 14, 1, 3).translate(0, 0, 0.5).toNonIndexed(), wingMat);
    return { lod: [{ flats: [], volumes: [fuselage, wing] }], animations: [], maxSize: 14, center: new THREE.Vector3() };
}

function smallPart(mat: THREE.Material, size: [number, number, number]): Model {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size, 2, 1, 2).toNonIndexed(), mat);
    return { lod: [{ flats: [], volumes: [mesh] }], animations: [], maxSize: size[0], center: new THREE.Vector3() };
}

const POSITION = new THREE.Vector3(100, 5, 40);

function parts(): WreckPart[] {
    return [
        // gear = 0, surface i = 1 + i: two ailerons far out on the wing and an elevator at the tail
        { model: smallPart(gearMat, [0.5, 1.5, 0.5]), kind: 'gear', id: 0, position: POSITION.clone().add(new THREE.Vector3(0, -1, 1)), quaternion: new THREE.Quaternion() },
        { model: smallPart(aileronMat, [3, 0.2, 1]), kind: 'surface', id: 1, position: POSITION.clone().add(new THREE.Vector3(5, 0, -1)), quaternion: new THREE.Quaternion() },
        { model: smallPart(aileronMat, [3, 0.2, 1]), kind: 'surface', id: 2, position: POSITION.clone().add(new THREE.Vector3(-5, 0, -1)), quaternion: new THREE.Quaternion() },
        { model: smallPart(aileronMat, [3, 0.2, 1]), kind: 'surface', id: 3, position: POSITION.clone().add(new THREE.Vector3(0, 0.8, -6)), quaternion: new THREE.Quaternion() },
    ];
}

function src(velocity = new THREE.Vector3(0, -20, 40), quaternion = new THREE.Quaternion()): WreckSource {
    return {
        id: 't',
        body: jet(),
        position: POSITION.clone(),
        quaternion,
        scale: new THREE.Vector3(1, 1, 1),
        velocity,
        parts: parts(),
        cockpit: new THREE.Vector3(0, 0.8, 5.5),
    };
}

function field(): WreckField {
    const f = new WreckField();
    f.setGroundHeightAt(() => POSITION.y - 1.2);
    return f;
}

const fragmentsOf = (f: WreckField): THREE.Object3D[] => (f as unknown as { root: THREE.Object3D }).root.children;
const countVerts = (obj: THREE.Object3D, mat?: THREE.Material): number => {
    let n = 0;
    obj.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && (mat === undefined || mesh.material === mat)) {
            n += mesh.geometry.getAttribute('position').count;
        }
    });
    return n;
};
const HIT = POSITION.clone().add(new THREE.Vector3(0, -1.2, 0));

describe('damage to an aircraft that survives', () => {
    it('bends the fuselage and draws the damaged airframe in the body frame', () => {
        const f = field();
        const state = new AirframeDamage();
        expect(state.active).toBe(false);
        expect(f.applyDamage(src(new THREE.Vector3(15, -20, 40)), state, 0.6, HIT)).toBe(true);
        expect(state.active).toBe(true);
        expect(state.severity).toBeCloseTo(0.6, 6);
        expect(Math.abs(f.lastDislocationM)).toBeGreaterThan(0.2);
        // In the body frame, at the origin: not out where the aircraft is.
        const box = new THREE.Box3().setFromObject(state.root!);
        expect(box.getCenter(new THREE.Vector3()).length()).toBeLessThan(8);
        expect(countVerts(state.root!, fuselageMat)).toBeGreaterThan(100);
    });

    it('tears off wing sections and control surfaces on a hard enough blow, as pieces that fly off', () => {
        let sawWing = false;
        let sawSurface = false;
        for (let run = 0; run < 40 && !(sawWing && sawSurface); run++) {
            const f = field();
            const state = new AirframeDamage();
            f.applyDamage(src(), state, 0.9, HIT);
            sawWing = sawWing || state.rippedCells.size > 0;
            sawSurface = sawSurface || state.rippedParts.size > 0;
            // The torn pieces exist in the world, ahead of nothing being lost.
            if (state.rippedCells.size > 0 || state.rippedParts.size > 0) {
                expect(fragmentsOf(f).length).toBeGreaterThan(0);
            }
            // The fuselage never comes off.
            for (const cell of state.rippedCells) {
                expect(cell).toBeGreaterThanOrEqual(3);
            }
        }
        expect(sawWing).toBe(true);
        expect(sawSurface).toBe(true);
    });

    it('does nothing for a blow no harder than one it has already had', () => {
        const f = field();
        const state = new AirframeDamage();
        f.applyDamage(src(), state, 0.6, HIT);
        const root = state.root;
        const pieces = fragmentsOf(f).length;
        expect(f.applyDamage(src(), state, 0.5, HIT)).toBe(false);
        expect(f.applyDamage(src(), state, 0.605, HIT)).toBe(false);
        expect(state.root).toBe(root);
        expect(fragmentsOf(f).length).toBe(pieces);
    });

    it('starts fuel fires as soon as the fuselage is bent, and where wings are bent or torn, once per site', () => {
        const f = field();
        const events: { kinds: string[]; n: number }[] = [];
        f.onDamage = e => events.push({ kinds: e.fires.map(x => x.kind), n: e.fires.length });
        const state = new AirframeDamage();
        f.applyDamage(src(new THREE.Vector3(15, -40, 60)), state, 0.8, HIT);
        expect(events.length).toBe(1);
        expect(events[0].kinds.includes('fuselage')).toBe(true);
        // A wing section was bent or torn off: its root burns too.
        expect(events[0].kinds.includes('wingRoot')).toBe(true);
        // The same sites do not ignite again; only a new site would.
        const sites = state.fireSites.size;
        f.update(2);
        f.applyDamage(src(new THREE.Vector3(15, -40, 60)), state, 0.8, HIT);
        const again = events.slice(1).reduce((n, e) => n + e.n, 0);
        expect(state.fireSites.size).toBeGreaterThanOrEqual(sites);
        expect(again).toBe(state.fireSites.size - sites);
    });

    it('starts no fire for a blow too gentle to bend anything', () => {
        const f = field();
        let fired = 0;
        f.onDamage = () => { fired++; };
        const state = new AirframeDamage();
        f.applyDamage(src(), state, 0.2, HIT);
        // Nothing bent (too gentle); only a part that happened to be torn off may burn.
        expect(f.lastDislocationM).toBe(0);
        if (state.rippedCells.size === 0) {
            expect(fired).toBe(0);
        }
    });

    it('adds up: later, separate impacts of the same size do more than the first', () => {
        const f = field();
        const state = new AirframeDamage();
        f.applyDamage(src(), state, 0.5, HIT);
        expect(state.severity).toBeCloseTo(0.5, 5);
        f.update(1);
        expect(f.applyDamage(src(), state, 0.5, HIT)).toBe(true);
        expect(state.severity).toBeGreaterThan(0.65);
        f.update(1);
        f.applyDamage(src(), state, 0.5, HIT);
        expect(state.severity).toBeGreaterThan(0.8);
    });

    it('bends further with each impact, in the direction of that impact', () => {
        const yawSum = (st: AirframeDamage) => st.joints[1].yaw + st.joints[2].yaw;
        const f = field();
        const state = new AirframeDamage();
        f.applyDamage(src(new THREE.Vector3(25, -30, 40)), state, 0.6, HIT);
        const afterOne = yawSum(state);
        expect(Math.abs(afterOne)).toBeGreaterThan(0.05);
        // The same way again: further bent.
        f.update(1);
        f.applyDamage(src(new THREE.Vector3(25, -30, 40)), state, 0.6, HIT);
        const afterTwo = yawSum(state);
        expect(Math.abs(afterTwo)).toBeGreaterThan(Math.abs(afterOne));
        // The other way: it bends back and past, not left as it was.
        f.update(1);
        f.applyDamage(src(new THREE.Vector3(-25, -30, 40)), state, 0.6, HIT);
        const afterThree = yawSum(state);
        expect(Math.sign(afterThree - afterTwo)).toBe(-Math.sign(afterOne));
        expect(f.lastTotalBendRad).toBeGreaterThan(0);
    });

    it('folds a wing further with each impact, and the other way too', () => {
        let further = 0;
        let back = 0;
        for (let run = 0; run < 40; run++) {
            const f = field();
            const state = new AirframeDamage();
            f.applyDamage(src(new THREE.Vector3(5, -12, 30)), state, 0.3, HIT);
            const first = [...state.wingFold.entries()];
            f.update(1);
            f.applyDamage(src(new THREE.Vector3(5, -12, 30)), state, 0.3, HIT);
            for (const [cell, v] of first) {
                const now = state.wingFold.get(cell) ?? 0;
                if (v !== 0 && Math.abs(now) > Math.abs(v) + 1e-9) {
                    further++;
                }
                if (v !== 0 && Math.sign(now - v) === -Math.sign(v)) {
                    back++;
                }
            }
        }
        expect(further).toBeGreaterThan(0);
        expect(back).toBeGreaterThan(0);
    });

    it('folds a wing at most 20 degrees, then it breaks off', () => {
        const max = 20 * Math.PI / 180;
        let sawBreak = false;
        for (let run = 0; run < 30; run++) {
            const f = field();
            const state = new AirframeDamage();
            for (let k = 0; k < 8; k++) {
                f.applyDamage(src(new THREE.Vector3(5, -12, 30)), state, 0.35, HIT);
                f.update(1);
                for (const v of state.wingFold.values()) {
                    expect(Math.abs(v)).toBeLessThanOrEqual(max + 1e-9);
                }
            }
            sawBreak = sawBreak || state.rippedCells.size > 0;
        }
        // Folded to the limit and hit again: the wing goes.
        expect(sawBreak).toBe(true);
    });

    it('treats blows in quick succession as one impact', () => {
        const f = field();
        const state = new AirframeDamage();
        f.applyDamage(src(), state, 0.5, HIT);
        f.update(0.1);
        f.applyDamage(src(), state, 0.5, HIT);
        f.update(0.1);
        f.applyDamage(src(), state, 0.55, HIT);
        expect(state.severity).toBeCloseTo(0.55, 5);
    });

    it('tears more off with every impact: a damaged wing goes on a blow that would not have taken it', () => {
        let single = 0;
        let repeated = 0;
        for (let run = 0; run < 60; run++) {
            const a = field();
            const one = new AirframeDamage();
            a.applyDamage(src(new THREE.Vector3(0, -12, 30)), one, 0.35, HIT);
            single += one.rippedCells.size + one.rippedParts.size;
            const b = field();
            const many = new AirframeDamage();
            for (let k = 0; k < 4; k++) {
                b.applyDamage(src(new THREE.Vector3(0, -12, 30)), many, 0.35, HIT);
                b.update(1);
            }
            repeated += many.rippedCells.size + many.rippedParts.size;
        }
        expect(repeated).toBeGreaterThan(single);
    });

    it('goes on getting worse with harder blows, and nothing torn off comes back', () => {
        const f = field();
        const state = new AirframeDamage();
        f.applyDamage(src(), state, 0.45, HIT);
        const bendA = Math.abs(f.lastDislocationM);
        const cellsA = new Set(state.rippedCells);
        const partsA = new Set(state.rippedParts);
        f.applyDamage(src(), state, 0.95, HIT);
        expect(Math.abs(f.lastDislocationM)).toBeGreaterThan(bendA);
        for (const c of cellsA) {
            expect(state.rippedCells.has(c)).toBe(true);
        }
        for (const p of partsA) {
            expect(state.rippedParts.has(p)).toBe(true);
        }
        // A section torn off earlier is not in the airframe that is drawn now.
        for (const cell of cellsA) {
            expect(cell).toBeGreaterThanOrEqual(3);
        }
    });

    it('loses and doubles nothing: what is drawn plus what flew off is the airframe', () => {
        for (let run = 0; run < 20; run++) {
            const f = field();
            const state = new AirframeDamage();
            f.applyDamage(src(), state, 1.0, HIT);
            const original = countVerts(src().body.lod[0].volumes[0]) + countVerts(src().body.lod[0].volumes[1]);
            const drawn = countVerts(state.root!);
            let flown = 0;
            for (const frag of fragmentsOf(f)) {
                // Only the airframe\\'s own material (parts are drawn separately).
                flown += countVerts(frag, fuselageMat) + countVerts(frag, wingMat);
            }
            expect(drawn + flown + 3 * f.lastScrapTriangles).toBe(original);
        }
    });

    it('carries the parts that stay on rigidly with the bend', () => {
        // Hit forward so the elevator at the tail (when it is not torn off) is carried round.
        let state = new AirframeDamage();
        for (let tries = 0; tries < 40 && !state.partBends.has(3); tries++) {
            state = new AirframeDamage();
            field().applyDamage(src(new THREE.Vector3(30, -20, 40)), state, 0.5, POSITION.clone().add(new THREE.Vector3(0, -1.2, 5)));
        }
        const bend = state.partBends.get(3);
        expect(bend).toBeDefined();
        // Moved with its section: it has a rotation of its own.
        const rot = new THREE.Quaternion(bend!.q[0], bend!.q[1], bend!.q[2], bend!.q[3]);
        expect(rot.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.02);
        // Rigid: the distance between two points on the part is the same after.
        const bodyPos = POSITION.clone();
        const bodyQuat = new THREE.Quaternion();
        const scale = new THREE.Vector3(1, 1, 1);
        const origA = POSITION.clone().add(new THREE.Vector3(0.3, 0.8, -6.2));
        const a = origA.clone();
        const b = POSITION.clone().add(new THREE.Vector3(-0.3, 0.8, -5.8));
        const before = a.distanceTo(b);
        const qa = new THREE.Quaternion();
        const qb = new THREE.Quaternion();
        state.transformPart(3, a, qa, bodyPos, bodyQuat, scale);
        state.transformPart(3, b, qb, bodyPos, bodyQuat, scale);
        expect(a.distanceTo(b)).toBeCloseTo(before, 6);
        // And it has moved, and turned by the bend.
        expect(a.distanceTo(origA)).toBeGreaterThan(0.05);
        expect(Math.abs(qa.angleTo(new THREE.Quaternion()) - rot.angleTo(new THREE.Quaternion()))).toBeLessThan(1e-6);
    });

    it('leaves the parts alone where the fuselage has not bent', () => {
        const f = field();
        const state = new AirframeDamage();
        f.applyDamage(src(), state, 0.2, HIT);
        const p = POSITION.clone().add(new THREE.Vector3(1, 0, -6));
        const q = new THREE.Quaternion();
        const before = p.clone();
        state.transformPart(0, p, q, POSITION, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        expect(p.distanceTo(before)).toBeLessThan(1e-9);
        expect(q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9);
    });

    it('works for an aircraft that is banked and pointing somewhere', () => {
        const f = field();
        const state = new AirframeDamage();
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 1.2, -0.4));
        f.applyDamage(src(new THREE.Vector3(20, -20, 40), q), state, 0.7, HIT);
        // Still in the body frame: independent of how the aircraft is turned.
        const box = new THREE.Box3().setFromObject(state.root!);
        expect(box.getSize(new THREE.Vector3()).length()).toBeLessThan(30);
        expect(state.active).toBe(true);
    });

    it('the final break-up carries on from the damage: torn sections are not torn again', () => {
        const f = field();
        const state = new AirframeDamage();
        let tornFirst: number[] = [];
        for (let run = 0; run < 30 && state.rippedCells.size === 0; run++) {
            state.reset();
            f.clear();
            f.applyDamage(src(), state, 0.9, HIT);
            tornFirst = [...state.rippedCells];
        }
        expect(tornFirst.length).toBeGreaterThan(0);

        // The aircraft is then destroyed, in a field of its own: its wing sections that are already gone are not there.
        const final = field();
        const withDamage: WreckSource = { ...src(new THREE.Vector3(0, -100, 100)), damage: state };
        expect(final.spawn(withDamage)).toBe(true);
        const bare = field();
        bare.spawn(src(new THREE.Vector3(0, -100, 100)));
        const wingVertsAfter = fragmentsOf(final).reduce((n, o) => n + countVerts(o, wingMat), 0);
        const wingVertsFull = fragmentsOf(bare).reduce((n, o) => n + countVerts(o, wingMat), 0);
        expect(wingVertsAfter).toBeLessThan(wingVertsFull);
    });

    it('is at least as bent in the final break-up as it already was', () => {
        const f = field();
        const state = new AirframeDamage();
        f.applyDamage(src(new THREE.Vector3(10, -40, 40)), state, 0.9, HIT);
        const final = field();
        final.spawn({ ...src(new THREE.Vector3(0, -8, 12)), damage: state });
        // A fatal-but-gentle spawn would bend almost nothing by itself; it keeps the earlier damage.
        // It is still folded by what it had (the final blow adds to it, in its own direction).
        expect(final.lastTotalBendRad).toBeGreaterThan(0.3);
    });

    it('resets for a new aircraft', () => {
        const f = field();
        const state = new AirframeDamage();
        f.applyDamage(src(), state, 0.9, HIT);
        state.reset();
        expect(state.active).toBe(false);
        expect(state.severity).toBe(0);
        expect(state.rippedCells.size + state.rippedParts.size + state.partBends.size).toBe(0);
    });
});
