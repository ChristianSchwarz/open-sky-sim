import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { Fm3GroundContact } from './groundContact';

/** A deck at 9.3 m ahead of z = 0 and the sea at −8 m behind it: a carrier's stern. */
const STERN = { groundHeightAt: (_x: number, z: number) => (z < 0 ? 9.3 : -8) };

/** Total gear force (N) on a level airframe at `pos`, moving at `vel`, with the planes sampled there. */
function gearForce(pos: [number, number, number], vel: [number, number, number]): number {
    const gear = new Fm3GroundContact(defaultFm2Config.gear);
    gear.world = STERN;
    const quat = [0, 0, 0, 1];
    gear.samplePlanes(pos, quat);
    const force = new Float64Array(3);
    const moment = new Float64Array(3);
    // A trial state a little further on, as an integrator stage evaluates it.
    const trial: [number, number, number] = [pos[0] + vel[0] / 120, pos[1] + vel[1] / 120, pos[2] + vel[2] / 120];
    gear.addForces(trial, vel, quat, [0, 0, 0], false, force, moment, false);
    return Math.hypot(force[0], force[1], force[2]);
}

describe('FM3 gear over an edge', () => {
    it('does not spring an airborne jet off a deck edge it is crossing', () => {
        const rest = new Fm3GroundContact(defaultFm2Config.gear).restHeight;
        // Wheels 3 m over the deck, every leg near the stern edge, flying forward (−z) at 80 m/s.
        for (const z of [-0.3, -0.1, 0.1, 0.3]) {
            const f = gearForce([0, 9.3 + rest + 3, z], [0, 0, -80]);
            assert.equal(f, 0, `gear force ${f.toFixed(0)} N with the CG at z = ${z}`);
        }
    });

    it('still holds a jet resting on the deck near the edge', () => {
        const rest = new Fm3GroundContact(defaultFm2Config.gear).restHeight;
        const f = gearForce([0, 9.3 + rest - 0.05, -0.2], [0, 0, 0]);
        assert.ok(f > 0, 'no gear force with the legs compressed on the deck');
    });
});
