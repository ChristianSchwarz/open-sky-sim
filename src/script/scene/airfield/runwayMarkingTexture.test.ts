import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    MARKING_TEXEL_ACROSS_M, MARKING_TEXEL_ALONG_M, MARKING_TEXTURE_MAX, rasteriseMarkings,
} from './runwayMarkingTexture';
import { MarkingRect, runwayMarkings } from './runwayMarkings';

/** Total coverage of one channel, in texels. */
function channelSum(data: Uint8Array, channel: number): number {
    let sum = 0;
    for (let i = channel; i < data.length; i += 2) {
        sum += data[i] / 255;
    }
    return sum;
}

describe('rasteriseMarkings', () => {
    it('sizes the texture by the texel pitch', () => {
        const t = rasteriseMarkings([], 1200, 30);
        assert.equal(t.width, Math.ceil(1200 / MARKING_TEXEL_ALONG_M));
        assert.equal(t.height, Math.ceil(30 / MARKING_TEXEL_ACROSS_M));
        assert.equal(t.data.length, t.width * t.height * 2);
    });

    it('caps a long runway at the maximum texture size', () => {
        const t = rasteriseMarkings([], 4000, 60);
        assert.equal(t.width, MARKING_TEXTURE_MAX);
    });

    it('leaves the pavement itself out', () => {
        const t = rasteriseMarkings(runwayMarkings(1000, 30, '09/27', 'grass'), 1000, 30);
        assert.equal(channelSum(t.data, 0) + channelSum(t.data, 1), 0);
    });

    it('conserves painted area, split by tone', () => {
        const lengthM = 2400;
        const widthM = 45;
        const rects = runwayMarkings(lengthM, widthM, '03/21', 'asphalt');
        const t = rasteriseMarkings(rects, lengthM, widthM);
        const texelArea = (lengthM / t.width) * (widthM / t.height);
        const area = (kinds: string[]) => rects
            .filter(r => kinds.includes(r.kind))
            .reduce((s, r) => s + r.lengthM * r.widthM, 0);
        // Rounding each texel to 1/255 is the only loss.
        const tolerance = 0.002 * t.width * t.height;
        assert.ok(Math.abs(channelSum(t.data, 0) * texelArea
            - area(['threshold', 'designator'])) < tolerance * texelArea);
        assert.ok(Math.abs(channelSum(t.data, 1) * texelArea
            - area(['aiming', 'centreline', 'edge'])) < tolerance * texelArea);
    });

    it('puts a stripe where its rectangle is, anti-aliased at the edges', () => {
        // A 0.9 m stripe down the middle of a 30 m runway is three 0.3 m
        // texels wide, centred on a texel boundary: it straddles, two full
        // texels and a half one either side.
        const stripe: MarkingRect = { u: 0, v: 0, lengthM: 100, widthM: 0.9, kind: 'centreline' };
        const t = rasteriseMarkings([stripe], 1000, 30);
        const x = Math.floor(t.width / 2);
        const column = (tex: typeof t) =>
            Array.from({ length: tex.height }, (_, y) => tex.data[(y * tex.width + x) * 2 + 1]);
        assert.equal(column(t).filter(c => c === 255).length, 2);
        assert.equal(column(t).filter(c => c === 128).length, 2);
        assert.equal(column(t).filter(c => c !== 0).length, 4);
        // Half a texel over, its edges land on texel boundaries: three solid.
        const shifted = rasteriseMarkings([{ ...stripe, v: 0.15 }], 1000, 30);
        assert.equal(column(shifted).filter(c => c === 255).length, 3);
        assert.equal(column(shifted).filter(c => c !== 0).length, 3);
        // And none of it in the threshold tone.
        assert.equal(channelSum(t.data, 0), 0);
    });
});
