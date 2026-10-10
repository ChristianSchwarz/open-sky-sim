import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { carrierSurfaceY, chooseCarrierSite, CarrierSiteSamplers } from './carrierSite';

const allUsable = () => true;

describe('chooseCarrierSite', () => {
    it('takes the nearest open water and lets the ship steam', () => {
        // Sea east of x = 6000, plain land to the west.
        const s: CarrierSiteSamplers = {
            groundAt: x => (x > 6000 ? -3 : 120),
            isLand: x => x <= 6000,
            usable: allUsable,
        };
        const site = chooseCarrierSite({ x: 0, z: 0 }, 2000, s);
        assert.equal(site.atSea, true);
        assert.ok(site.x > 6000 + 40);
        assert.equal(site.surfaceY, -3);
    });

    it('moors on level ground when there is no water, avoiding a hillside', () => {
        // A ridge rising to the east and north, a plain to the south-west.
        const ground = (x: number, z: number) => (x > 0 || z < 0 ? 400 + Math.abs(x) * 0.2 : 300);
        const s: CarrierSiteSamplers = { groundAt: ground, isLand: () => true, usable: allUsable };
        const site = chooseCarrierSite({ x: 0, z: 0 }, 2000, s);
        assert.equal(site.atSea, false);
        const y = carrierSurfaceY(site.x, site.z, ground);
        assert.equal(site.surfaceY, y);
        // On the plain, not up the slope.
        assert.ok(y < 330, `seated at ${y}`);
    });

    it('stays inside what is usable and always answers', () => {
        const s: CarrierSiteSamplers = {
            groundAt: () => 100,
            isLand: () => true,
            usable: (x, z) => Math.hypot(x, z) < 5000,
        };
        const site = chooseCarrierSite({ x: 0, z: 0 }, 1500, s);
        assert.ok(Math.hypot(site.x, site.z) < 5000);
        assert.equal(site.atSea, false);
    });

    it('does not berth on top of the airbase', () => {
        const s: CarrierSiteSamplers = { groundAt: () => 0, isLand: () => true, usable: allUsable };
        const site = chooseCarrierSite({ x: 100, z: -50 }, 2300, s);
        assert.ok(Math.hypot(site.x - 100, site.z + 50) > 2299.9);
    });
});
