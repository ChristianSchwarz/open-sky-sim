import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCameraRoute, parseCameraRoute, searchWithCameraRoute } from './cameraRoute';

describe('parseCameraRoute', () => {
    it('reads the named parameters from the query', () => {
        assert.deepEqual(parseCameraRoute('?lat=28.1&lng=-15.4&alt=500&hdg=90&pitch=-10'),
            { lat: 28.1, lon: -15.4, altM: 500, headingDeg: 90, pitchDeg: -10 });
    });

    it('defaults altitude, heading and pitch, and reads the fragment too', () => {
        assert.deepEqual(parseCameraRoute('', '#lat=28.1&lng=-15.4'),
            { lat: 28.1, lon: -15.4, altM: 1000, headingDeg: 0, pitchDeg: 0 });
    });

    it('wraps heading and clamps pitch', () => {
        const r = parseCameraRoute('?lat=0&lng=0&hdg=-90&pitch=120');
        assert.equal(r?.headingDeg, 270);
        assert.equal(r?.pitchDeg, 89);
    });

    it('rejects absent or malformed routes', () => {
        assert.equal(parseCameraRoute(''), undefined);
        assert.equal(parseCameraRoute('?lat=1'), undefined);
        assert.equal(parseCameraRoute('?lat=1&lng=x'), undefined);
        assert.equal(parseCameraRoute('?lat=95&lng=0'), undefined);
        assert.equal(parseCameraRoute('?camera=1,2,3'), undefined);
    });
});

describe('formatCameraRoute', () => {
    it('round-trips through the parser at sensible precision', () => {
        const route = { lat: 45.93001234, lon: 6.87, altM: 2500.4, headingDeg: 150.3, pitchDeg: -5 };
        assert.deepEqual(formatCameraRoute(route), ['45.93001', '6.87', '2500', '150', '-5']);
        assert.deepEqual(parseCameraRoute(searchWithCameraRoute('', route)),
            { lat: 45.93001, lon: 6.87, altM: 2500, headingDeg: 150, pitchDeg: -5 });
    });
});

describe('searchWithCameraRoute', () => {
    const route = { lat: 1, lon: 2, altM: 3, headingDeg: 4, pitchDeg: 5 };
    it('writes the values unescaped and keeps other parameters', () => {
        assert.equal(searchWithCameraRoute('', route), '?lat=1&lng=2&alt=3&hdg=4&pitch=5');
        assert.equal(searchWithCameraRoute('?lat=9&x=1&hdg=7', route), '?lat=1&lng=2&alt=3&hdg=4&pitch=5&x=1');
    });
});
