import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CanvasDirt, DirtRect, trackCanvasDirt } from './canvasDirt';

/** Whether pixel (x, y) is inside one of the rectangles. */
const covers = (rects: DirtRect[], x: number, y: number) =>
    rects.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

/** A context with just enough of the API for the tracker to wrap. */
function fakeContext(width: number, height: number): CanvasRenderingContext2D {
    const noop = () => undefined;
    const names = ['save', 'restore', 'translate', 'scale', 'rotate', 'transform', 'setTransform', 'resetTransform',
        'beginPath', 'moveTo', 'lineTo', 'rect', 'roundRect', 'arc', 'ellipse', 'arcTo', 'quadraticCurveTo',
        'bezierCurveTo', 'stroke', 'fill', 'fillRect', 'strokeRect', 'clearRect', 'drawImage', 'putImageData',
        'fillText', 'strokeText'];
    const ctx: Record<string, unknown> = { canvas: { width, height }, lineWidth: 1 };
    for (const n of names) {
        ctx[n] = noop;
    }
    return ctx as unknown as CanvasRenderingContext2D;
}

describe('CanvasDirt', () => {
    it('asks for the whole canvas first, then only what was drawn', () => {
        const dirt = new CanvasDirt(1000, 500);
        assert.equal(dirt.take(), undefined, 'nothing uploaded yet');
        dirt.mark(100, 100, 110, 110);
        const rects = dirt.take()!;
        assert.ok(covers(rects, 105, 105));
        assert.ok(!covers(rects, 500, 300));
    });

    it('refreshes last frame\'s drawing once more, to erase it', () => {
        const dirt = new CanvasDirt(1000, 500);
        dirt.take();
        dirt.mark(100, 100, 110, 110);
        dirt.take();
        dirt.mark(700, 300, 710, 310);
        const rects = dirt.take()!;
        assert.ok(covers(rects, 105, 105), 'the old spot is cleared');
        assert.ok(covers(rects, 705, 305), 'the new one drawn');
        assert.deepEqual(dirt.take()!.filter(r => covers([r], 105, 105)), [], 'and two frames on, the old spot is left alone');
    });

    it('merges a column of tiles into one rectangle', () => {
        const dirt = new CanvasDirt(1000, 500);
        dirt.take();
        dirt.mark(40, 40, 90, 300);
        const rects = dirt.take()!;
        assert.equal(rects.length, 1);
        assert.ok(rects[0].height >= 260);
    });

    it('gives up on parts past half the canvas', () => {
        const dirt = new CanvasDirt(1000, 500);
        dirt.take();
        dirt.mark(0, 0, 900, 400);
        assert.equal(dirt.take(), undefined);
    });

    it('never reaches past the canvas edge', () => {
        const dirt = new CanvasDirt(1000, 500);
        dirt.take();
        dirt.mark(990, 490, 1200, 700);
        for (const r of dirt.take()!) {
            assert.ok(r.x + r.width <= 1000 && r.y + r.height <= 500);
        }
    });
});

describe('trackCanvasDirt', () => {
    it('bounds a stroke through the current transform', () => {
        const ctx = fakeContext(1000, 500);
        const dirt = new CanvasDirt(1000, 500);
        trackCanvasDirt(ctx, dirt);
        dirt.take();
        ctx.save();
        ctx.translate(600, 250);
        ctx.rotate(Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(100, 0);
        ctx.stroke();
        ctx.restore();
        const rects = dirt.take()!;
        // Rotated a quarter turn clockwise on screen: (100, 0) lands at (600, 350).
        assert.ok(covers(rects, 600, 340), 'the rotated line');
        assert.ok(!covers(rects, 690, 250), 'not where it would be unrotated');
    });

    it('does not count the full-canvas clear that starts a frame', () => {
        const ctx = fakeContext(1000, 500);
        const dirt = new CanvasDirt(1000, 500);
        trackCanvasDirt(ctx, dirt);
        dirt.take();
        ctx.clearRect(0, 0, 1000, 500);
        ctx.drawImage({ width: 8, height: 8 } as unknown as CanvasImageSource, 20, 20, 8, 8);
        const rects = dirt.take()!;
        assert.ok(covers(rects, 24, 24));
        assert.ok(!covers(rects, 500, 250));
    });

    it('falls back to the whole canvas for what it cannot bound', () => {
        const ctx = fakeContext(1000, 500);
        const dirt = new CanvasDirt(1000, 500);
        trackCanvasDirt(ctx, dirt);
        dirt.take();
        ctx.fillText('x', 10, 10);
        assert.equal(dirt.take(), undefined);
    });
});
