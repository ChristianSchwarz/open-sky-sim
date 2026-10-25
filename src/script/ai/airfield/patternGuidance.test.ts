import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arcHeading, fromRunwayFrame, lineHeading, runwayFrame, turnRadius } from './patternGuidance';

const DEG = Math.PI / 180;
const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

describe('patternGuidance', () => {
    it('places an aircraft in a runway frame and back', () => {
        // Runway landing toward +X (heading 90 deg), touchdown at (100, 50).
        const h = 90 * DEG;
        const f = runwayFrame(100, 50, h, -900, 50, h);
        assert.ok(close(f.toTouchdown, 1000), `toTouchdown ${f.toTouchdown}`);
        assert.ok(close(f.lateral, 0), `lateral ${f.lateral}`);
        assert.ok(close(f.headingError, 0));
        // (cos h, -sin h) for h = 90 deg is -Z.
        const side = runwayFrame(100, 50, h, 100, -250, h);
        assert.ok(close(side.lateral, 300), `lateral ${side.lateral}`);
        const back = fromRunwayFrame(100, 50, h, 1000, 300);
        assert.ok(close(back.x, -900) && close(back.z, -250), `${back.x}, ${back.z}`);
    });

    it('turns onto a line from either side and holds it once on', () => {
        assert.ok(close(lineHeading(0, 0, 500, 45 * DEG), 0));
        const fromRight = lineHeading(0, 2000, 500, 45 * DEG);
        const fromLeft = lineHeading(0, -2000, 500, 45 * DEG);
        assert.ok(fromRight < 0 && fromRight > -45 * DEG, `${fromRight / DEG}`);
        assert.ok(close(fromLeft, -fromRight));
        // Far off it flies at the line near the largest intercept.
        assert.ok(lineHeading(0, 1e6, 500, 45 * DEG) < -44 * DEG);
    });

    it('flies round a circle and steers back onto it', () => {
        // Centre at the origin, aircraft on the circle at +X. Direction +1 keeps
        // the centre on the (cos h, -sin h) side, so it flies -Z (heading 180).
        const onCircle = arcHeading(0, 0, 1000, 1, 1000, 0);
        assert.ok(close(Math.abs(onCircle), Math.PI, 1e-9), `${onCircle / DEG}`);
        const opposite = arcHeading(0, 0, 1000, -1, 1000, 0);
        assert.ok(close(opposite, 0, 1e-9), `${opposite / DEG}`);
        // Heading 180 has its (cos h, -sin h) side at -X, the centre: outside
        // the circle it turns that way (past 180), inside it turns away.
        assert.ok(arcHeading(0, 0, 1000, 1, 1500, 0) > Math.PI, 'outside: turn in');
        assert.ok(arcHeading(0, 0, 1000, 1, 500, 0) < Math.PI, 'inside: turn out');
    });

    it('sizes a level turn', () => {
        assert.ok(close(turnRadius(100, 45 * DEG), 100 * 100 / 9.81, 1e-6));
    });
});
