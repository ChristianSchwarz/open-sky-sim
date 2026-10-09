import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCameraRoute, parseCameraRoute, searchWithCameraRoute } from './cameraRoute';

describe('parseCameraRoute', () => {
    it('reads a Google Maps style view from the query', () => {
        assert.deepEqual(parseCameraRoute('?@28.1,-15.4,500a,90h,80t'),
            { lat: 28.1, lon: -15.4, altM: 500, headingDeg: 90, pitchDeg: -10 });
    });

    it('takes the @ part of a Maps URL as pasted, ignoring what it does not use', () => {
        assert.deepEqual(parseCameraRoute('?@46.5584197,7.9853448,2499.83a,35y,150.27h,84.97t/data=!3m1!1e3'),
            { lat: 46.5584197, lon: 7.9853448, altM: 2499.83, headingDeg: 150.27, pitchDeg: 84.97 - 90 });
        assert.deepEqual(parseCameraRoute('?@46.55,7.98,15z'),
            { lat: 46.55, lon: 7.98, altM: 1000, headingDeg: 0, pitchDeg: 0 });
        assert.equal(parseCameraRoute('?@46.55,7.98,1200m')?.altM, 1200);
    });

    it('still reads the older named parameters', () => {
        assert.deepEqual(parseCameraRoute('?lat=28.1&lng=-15.4&alt=500&hdg=90&pitch=-10'),
            { lat: 28.1, lon: -15.4, altM: 500, headingDeg: 90, pitchDeg: -10 });
    });

    it('defaults altitude, heading and pitch, and reads the fragment too', () => {
        assert.deepEqual(parseCameraRoute('', '#@28.1,-15.4'),
            { lat: 28.1, lon: -15.4, altM: 1000, headingDeg: 0, pitchDeg: 0 });
        assert.deepEqual(parseCameraRoute('', '#lat=28.1&lng=-15.4'),
            { lat: 28.1, lon: -15.4, altM: 1000, headingDeg: 0, pitchDeg: 0 });
    });

    it('wraps heading and clamps pitch', () => {
        const r = parseCameraRoute('?@0,0,-90h,210t');
        assert.equal(r?.headingDeg, 270);
        assert.equal(r?.pitchDeg, 89);
        assert.equal(parseCameraRoute('?@0,0,0t')?.pitchDeg, -89);
    });

    it('rejects absent or malformed routes', () => {
        assert.equal(parseCameraRoute(''), undefined);
        assert.equal(parseCameraRoute('?@1'), undefined);
        assert.equal(parseCameraRoute('?@1,x'), undefined);
        assert.equal(parseCameraRoute('?@95,0'), undefined);
        assert.equal(parseCameraRoute('?@1,2,abc'), undefined);
        assert.equal(parseCameraRoute('?lat=1'), undefined);
        assert.equal(parseCameraRoute('?lat=1&lng=x'), undefined);
        assert.equal(parseCameraRoute('?camera=1,2,3'), undefined);
    });
});

describe('formatCameraRoute', () => {
    it('round-trips through the parser at sensible precision', () => {
        const route = { lat: 45.93001234, lon: 6.87, altM: 2500.4, headingDeg: 150.3, pitchDeg: -5 };
        assert.equal(formatCameraRoute(route), '@45.93001,6.87,2500a,150h,85t');
        assert.deepEqual(parseCameraRoute(searchWithCameraRoute('', route)),
            { lat: 45.93001, lon: 6.87, altM: 2500, headingDeg: 150, pitchDeg: -5 });
    });
});

describe('searchWithCameraRoute', () => {
    const route = { lat: 1, lon: 2, altM: 3, headingDeg: 4, pitchDeg: 5 };
    it('writes the view unescaped and keeps other parameters', () => {
        assert.equal(searchWithCameraRoute('', route), '?@1,2,3a,4h,95t');
        assert.equal(searchWithCameraRoute('?@9,9,9a&x=1', route), '?@1,2,3a,4h,95t&x=1');
        assert.equal(searchWithCameraRoute('?%409,9&x=1', route), '?@1,2,3a,4h,95t&x=1');
    });

    it('replaces the older named parameters', () => {
        assert.equal(searchWithCameraRoute('?lat=9&x=1&hdg=7', route), '?@1,2,3a,4h,95t&x=1');
    });
});
