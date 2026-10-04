import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zlibSync } from 'fflate';
import { decodeRvr } from './rvr';

describe('decodeRvr', () => {
    it('reads RVR2: float32 offsets from a float64 origin, sub-millimetre', () => {
        const lon0 = 35.0592712345, lat0 = 45.2894412345;
        const buf = new ArrayBuffer(22 + 7 + 16);
        const v = new DataView(buf);
        [0x52, 0x56, 0x52, 0x32].forEach((b, i) => v.setUint8(i, b));
        v.setFloat64(4, lon0, true);
        v.setFloat64(12, lat0, true);
        v.setUint16(20, 1, true);
        v.setUint8(22, 7);
        v.setFloat32(23, 5, true);
        v.setUint16(27, 2, true);
        v.setFloat32(29, 0, true); v.setFloat32(33, 0, true);
        v.setFloat32(37, 0.000853, true); v.setFloat32(41, -0.000676, true);
        const [road] = decodeRvr(zlibSync(new Uint8Array(buf)));
        assert.equal(road.cls, 7);
        assert.ok(Math.abs(road.points[0].lon - lon0) * 78000 < 0.001);
        assert.ok(Math.abs(road.points[1].lat - (lat0 - 0.000676)) * 111320 < 0.001);
    });
});
