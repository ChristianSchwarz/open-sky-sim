import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PointVertProgram } from './pointVP';

/**
 * Source-level checks, in the style of riverVP.test.ts: neither tsc nor a
 * headless run can execute a vertex program, and an asymmetric rounding
 * constant is only visible in the source, not in a still frame.
 */
describe('point vertex program', () => {
    it('rounds x and y to the pixel grid with the same offset', () => {
        // y previously snapped with `+ 1.0` while x used `+ 0.5`, biasing
        // point sprites (stars/lights) by more than half a pixel whenever
        // the snap is active (every shading mode but FULL).
        const snaps = [...PointVertProgram.matchAll(/floor\([^)]*\+\s*([\d.]+)\)/g)];
        assert.equal(snaps.length, 2, 'expected one floor(...) snap each for x and y');
        assert.equal(snaps[0][1], '0.5');
        assert.equal(snaps[1][1], '0.5');
    });

    it('guards both snaps behind the same shadingType check', () => {
        const guardIndex = PointVertProgram.indexOf('if (shadingType != 3)');
        assert.ok(guardIndex > 0, 'the shadingType guard is gone');
        const blockEnd = PointVertProgram.indexOf('}', guardIndex);
        for (const m of PointVertProgram.matchAll(/floor\(/g)) {
            assert.ok(m.index! > guardIndex && m.index! < blockEnd,
                `pixel snap outside the shadingType guard: index ${m.index}`);
        }
    });
});
