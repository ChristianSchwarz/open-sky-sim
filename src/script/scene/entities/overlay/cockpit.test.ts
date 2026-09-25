import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    plotTacticalContact,
    TACTICAL_DEFAULT_RANGE_KM,
    tacticalScopeRange,
} from './cockpit';

const RADIUS = 28;

describe('tactical display scope range', () => {
    it('holds the default range with nothing designated', () => {
        assert.equal(tacticalScopeRange(undefined), TACTICAL_DEFAULT_RANGE_KM);
    });

    it('picks the smallest ladder range that holds the lock', () => {
        assert.equal(tacticalScopeRange(0.5), 5);
        assert.equal(tacticalScopeRange(5), 5);
        assert.equal(tacticalScopeRange(5.1), 10);
        assert.equal(tacticalScopeRange(12), 20);
        assert.equal(tacticalScopeRange(41), 80);
    });

    it('clamps a lock past the longest range to the outer ladder step', () => {
        assert.equal(tacticalScopeRange(500), 80);
    });
});

describe('tactical display contact plotting', () => {
    it('plots a contact dead ahead straight up the scope', () => {
        // Heading north; the contact is 10 Km north (world -Z).
        const plot = plotTacticalContact(0, -10000, 0, 20, RADIUS);
        assert.ok(Math.abs(plot.x) < 1e-6, `x ${plot.x}`);
        assert.ok(plot.y < 0, `y ${plot.y}`);
        assert.equal(plot.offScope, false);
    });

    it('scales range linearly against the outer ring', () => {
        // Half the scope range plots at half the radius.
        const plot = plotTacticalContact(0, -10000, 0, 20, RADIUS);
        assert.ok(Math.abs(Math.hypot(plot.x, plot.y) - RADIUS / 2) < 1e-6);
    });

    it('plots a contact off the right wing to the right', () => {
        // Heading north; the contact is 10 Km east.
        const plot = plotTacticalContact(10000, 0, 0, 20, RADIUS);
        assert.ok(plot.x > 0, `x ${plot.x}`);
        assert.ok(Math.abs(plot.y) < 1e-6, `y ${plot.y}`);
    });

    it('is heading-up: the same contact swings with the aircraft', () => {
        // Flying east, a contact 10 Km east is now dead ahead.
        const plot = plotTacticalContact(10000, 0, 90, 20, RADIUS);
        assert.ok(Math.abs(plot.x) < 1e-6, `x ${plot.x}`);
        assert.ok(Math.abs(plot.y + RADIUS / 2) < 1e-6, `y ${plot.y}`);

        // Flying south, that same contact is off the left wing.
        const behind = plotTacticalContact(10000, 0, 180, 20, RADIUS);
        assert.ok(behind.x < 0, `x ${behind.x}`);
    });

    it('plots a contact astern below the ownship marker', () => {
        // Heading north; the contact is 10 Km south.
        const plot = plotTacticalContact(0, 10000, 0, 20, RADIUS);
        assert.ok(plot.y > 0, `y ${plot.y}`);
    });

    it('pins contacts past the scope range to the rim', () => {
        const plot = plotTacticalContact(0, -50000, 0, 20, RADIUS);
        assert.equal(plot.offScope, true);
        assert.ok(Math.abs(Math.hypot(plot.x, plot.y) - RADIUS) < 1e-6);
        // Still on the contact's bearing: dead ahead stays at the top.
        assert.ok(Math.abs(plot.x) < 1e-6, `x ${plot.x}`);
    });

    it('keeps a contact right on the range ring on the scope', () => {
        const plot = plotTacticalContact(0, -20000, 0, 20, RADIUS);
        assert.equal(plot.offScope, false);
        assert.ok(Math.abs(Math.hypot(plot.x, plot.y) - RADIUS) < 1e-6);
    });

    it('parks a co-located contact at the centre', () => {
        const plot = plotTacticalContact(0.2, -0.3, 45, 20, RADIUS);
        assert.deepEqual(plot, { x: 0, y: 0, offScope: false });
    });
});
