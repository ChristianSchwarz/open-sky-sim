import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TerrainArea } from '../terrain/manifest';
import {
    AirfieldEntry, airfieldDestination, coordinateDestination, parseCoordinates,
    placesFromNominatim, searchAirfields, searchPlaces,
} from './spawnSearch';

const AREAS: TerrainArea[] = [
    { name: 'gc', west: -18, south: 27, east: -13, north: 29.5 },
    { name: 'DACH', west: 5.8, south: 45.8, east: 17.2, north: 55.1 },
];

function field(icao: string, iata: string, name: string, area: string, lengthM: number): AirfieldEntry {
    return { icao, iata, name, area, lat: 0, lon: 0, lengthM };
}

const FIELDS: AirfieldEntry[] = [
    field('GCLP', 'LPA', 'Gran Canaria Airport', 'gc', 3100),
    field('GCXO', 'TFN', 'Tenerife Norte', 'gc', 3400),
    field('EDDF', 'FRA', 'Frankfurt am Main', 'DACH', 4000),
    field('EDFE', '', 'Flugplatz Frankfurt-Egelsbach', 'DACH', 1400),
    field('LSZH', 'ZRH', 'Zürich Airport', 'DACH', 3700),
    field('', '', 'Segelfluggelände Hornberg', 'DACH', 600),
];

describe('searchAirfields', () => {
    it('puts an exact ICAO or IATA first', () => {
        assert.equal(searchAirfields(FIELDS, 'eddf')[0].icao, 'EDDF');
        assert.equal(searchAirfields(FIELDS, 'LPA')[0].icao, 'GCLP');
    });

    it('matches every word of a name, longest runway first among equals', () => {
        const hits = searchAirfields(FIELDS, 'frankfurt');
        assert.deepEqual(hits.map(h => h.icao), ['EDDF', 'EDFE']);
    });

    it('ignores accents and needs all words', () => {
        assert.equal(searchAirfields(FIELDS, 'zurich')[0].icao, 'LSZH');
        assert.deepEqual(searchAirfields(FIELDS, 'frankfurt zurich'), []);
    });

    it('finds airfields with no ICAO by name', () => {
        assert.equal(searchAirfields(FIELDS, 'hornberg')[0].name, 'Segelfluggelände Hornberg');
    });

    it('returns nothing for an empty query', () => {
        assert.deepEqual(searchAirfields(FIELDS, '  '), []);
    });
});

describe('airfieldDestination', () => {
    it('keys by icao, falling back to the name, and flags another area', () => {
        const here = airfieldDestination(FIELDS[0], 'gc');
        assert.equal(here.airfieldKey, 'GCLP');
        assert.ok(!here.detail.includes('reloads'));
        const there = airfieldDestination(FIELDS[5], 'gc');
        assert.equal(there.airfieldKey, 'Segelfluggelände Hornberg');
        assert.ok(there.detail.includes('DACH (reloads)'));
    });
});

describe('parseCoordinates', () => {
    it('reads decimal pairs in common forms', () => {
        assert.deepEqual(parseCoordinates('47.45, 8.56'), { lat: 47.45, lon: 8.56 });
        assert.deepEqual(parseCoordinates('27.93 -15.39'), { lat: 27.93, lon: -15.39 });
        assert.deepEqual(parseCoordinates('27.93N 15.39W'), { lat: 27.93, lon: -15.39 });
        assert.deepEqual(parseCoordinates('33.9° S, 18.6° E'), { lat: -33.9, lon: 18.6 });
    });

    it('rejects names and out-of-range values', () => {
        assert.equal(parseCoordinates('Zurich'), undefined);
        assert.equal(parseCoordinates('95, 10'), undefined);
        assert.equal(parseCoordinates('10, 200'), undefined);
    });
});

describe('coordinateDestination', () => {
    it('finds the area or says there is no terrain', () => {
        assert.equal(coordinateDestination(48, 11, AREAS, 'gc').area, 'DACH');
        const nowhere = coordinateDestination(0, 0, AREAS, 'gc');
        assert.equal(nowhere.area, undefined);
        assert.ok(nowhere.detail.includes('no terrain'));
    });
});

describe('placesFromNominatim', () => {
    it('lists startable places first and skips bad coordinates', () => {
        const out = placesFromNominatim([
            { lat: '40.7', lon: '-74.0', name: 'New York', display_name: 'New York, United States', type: 'city' },
            { lat: 'x', lon: '1', display_name: 'Broken' },
            { lat: '48.14', lon: '11.58', name: 'München', display_name: 'München, Bayern, Deutschland', addresstype: 'city' },
        ], AREAS, 'gc');
        assert.deepEqual(out.map(p => p.label), ['München', 'New York']);
        assert.equal(out[0].area, 'DACH');
        assert.equal(out[1].area, undefined);
        assert.ok(out[0].detail.startsWith('city · Bayern, Deutschland'));
    });
});

describe('searchPlaces', () => {
    it('asks Nominatim with the query encoded and rejects an HTTP failure', async () => {
        let asked = '';
        const ok = (async (url: string) => {
            asked = url;
            return new Response(JSON.stringify([]), { status: 200 });
        }) as typeof fetch;
        await searchPlaces('Santa Cruz', AREAS, 'gc', ok);
        assert.ok(asked.includes('q=Santa%20Cruz'));
        const failing = (async () => new Response('', { status: 429 })) as typeof fetch;
        await assert.rejects(searchPlaces('x', AREAS, 'gc', failing), /429/);
    });
});
