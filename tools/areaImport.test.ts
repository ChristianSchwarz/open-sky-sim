import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    Step, deletePlan, formatDuration, isProgressLine, parseProgress, plan, snapBboxToTiles, splitStream,
    stepOutcome,
} from './areaImport';

/**
 * The lines below are copied from the tools that emit them. If one of those
 * changes its format these tests fail, which is the point: the alternative is
 * a progress bar that silently stops moving.
 */
describe('parseProgress', () => {
    it('reads the mesh bake counter', () => {
        // tools/bake_planet_mesh.ts: `\r  ${i+1}/${n} (${pct}%)  ${mb} MB`
        assert.equal(parseProgress('  123/456 (27.0%)  1.2 MB'), 27);
        assert.equal(parseProgress('  456/456 (100.0%)  12.3 MB'), 100);
    });

    it('reads the cover bake counter', () => {
        // tools/bake_planet_cover.py, same shape.
        assert.equal(parseProgress('  50/1430 (3.5%)  0.4 MB'), 3.5);
    });

    it('reads the fetch coverage line', () => {
        // tools/fetch_planet_dem.py and fetch_cover_sources.py.
        assert.equal(
            parseProgress('  merged Copernicus_DSM_COG_10_N45_00_E007_00_DEM.tif -> 50.1% covered'),
            50.1,
        );
        assert.equal(parseProgress('  merged x -> 100.0% covered'), 100);
    });

    it('reads the DEM sampling counter', () => {
        // tools/bake_planet_dem.py: `  sampling {i+1}/{len(candidates)}`
        assert.equal(parseProgress('  sampling 9/18'), 50);
    });

    it('reads the coast bake stage percentage, whatever phase it is in', () => {
        // tools/bake_osm_coast.py StageProgress: `  <label> <detail>  (NN.N% of stage)`
        assert.equal(parseProgress('  fetching OSM coastline 4.2 MB received  (13.1% of stage)'), 13.1);
        assert.equal(parseProgress('  assembling land and water polygons classifying piece 3/9  (25.0% of stage)'), 25);
        assert.equal(parseProgress('  writing coast and vector tiles zoom 11 40/120  (88.5% of stage)'), 88.5);
        assert.equal(parseProgress('  writing coast and vector tiles  (100.0% of stage)'), 100);
    });

    it('reads the coastline rasterise counter', () => {
        // tools/bake_osm_coast.py: `  rasterize {i+1}/{len(max_tiles)}`
        assert.equal(parseProgress('  rasterize 12/24'), 50);
    });

    it('ignores lines that carry no progress', () => {
        for (const line of [
            'level 12    18 tiles with land',
            'wrote 38 tiles, 1.6 MB',
            'pyramid     assets/planet: 1386 tiles, z0..12, tileSize 257',
            '',
            'heights   1752.8 .. 4324.6 m, 100.0% land',
        ]) {
            assert.equal(parseProgress(line), undefined, `should ignore: ${line}`);
        }
    });

    it('never reports outside 0..100', () => {
        assert.equal(parseProgress('  1/0 (999.0%)  0 MB'), 100);
        assert.equal(parseProgress('  sampling 5/0'), undefined);
    });
});

describe('isProgressLine', () => {
    it('matches the redrawn counters, which the log replaces rather than stacks', () => {
        assert.equal(isProgressLine('  123/456 (27.0%)  1.2 MB'), true);
        assert.equal(isProgressLine('  sampling 9/18'), true);
        assert.equal(isProgressLine('  rasterize 12/24'), true);
        assert.equal(isProgressLine('  fetching OSM coastline 4.2 MB received  (13.1% of stage)'), true);
        assert.equal(isProgressLine('  writing coast and vector tiles zoom 11 40/120  (88.5% of stage)'), true);
    });

    it('keeps the coast bake phase headings and summaries in the log', () => {
        assert.equal(isProgressLine('phase 3/8  assembling land and water polygons'), false);
        assert.equal(isProgressLine('phase 6/8  sampling inland water heights - skipped, no flat inland water'), false);
        assert.equal(isProgressLine('  fetching OSM coastline done in 4.2s, 1832 elements'), false);
        assert.equal(isProgressLine('  still waiting for https://overpass-api.de/api/interpreter (30s)'), false);
    });

    it('does not match one-off lines that happen to contain a percentage', () => {
        // This one is printed once per source and belongs in the log for good.
        assert.equal(isProgressLine('  merged tile.tif -> 50.1% covered'), false);
        assert.equal(isProgressLine('heights   1752.8 .. 4324.6 m, 100.0% land'), false);
        assert.equal(isProgressLine('level 12    18 tiles with land'), false);
    });
});

describe('splitStream', () => {
    it('splits on newlines and keeps the partial tail', () => {
        const r = splitStream('', 'one\ntwo\nthr');
        assert.deepEqual(r.lines, ['one', 'two']);
        assert.equal(r.tail, 'thr');
    });

    it('joins a line split across two chunks', () => {
        const a = splitStream('', 'hal');
        const b = splitStream(a.tail, 'ves\n');
        assert.deepEqual(a.lines, []);
        assert.deepEqual(b.lines, ['halves']);
    });

    it('treats a bare carriage return as a line break', () => {
        // What bake_planet_mesh.ts and bake_planet_cover.py actually emit:
        // one redrawn progress line, no newline until the stage ends.
        const r = splitStream('', '\r  100/456 (21.9%)  1 MB\r  200/456 (43.9%)  2 MB');
        assert.deepEqual(r.lines, ['  100/456 (21.9%)  1 MB']);
        assert.equal(r.tail, '  200/456 (43.9%)  2 MB');
    });

    it('does not split \r\n into two lines', () => {
        const r = splitStream('', 'one\r\ntwo\r\n');
        assert.deepEqual(r.lines, ['one', 'two']);
        assert.equal(r.tail, '');
    });

    it('drops blank lines', () => {
        assert.deepEqual(splitStream('', 'a\n\n\nb\n').lines, ['a', 'b']);
    });
});

describe('snapBboxToTiles', () => {
    const SPAN = 180 / (1 << 12);
    const onEdge = (v: number, base: number) => {
        const i = (base - v) / SPAN;
        assert.ok(Math.abs(i - Math.round(i)) < 1e-6, `${v} is not a tile edge`);
    };

    it('grows a hand-drawn box out to whole tiles', () => {
        // The second Crimea import, as drawn. Its southern edge fell a third of
        // the way down tile row 1019, and the coast bake rewrote that whole row
        // with the part it had no land for as open sea.
        const [w, s, e, n] = snapBboxToTiles([32.11, 45.204449, 35.02, 46.47]);
        onEdge(w, -180);
        onEdge(e, -180);
        onEdge(s, 90);
        onEdge(n, 90);
        // Outwards only: nothing the user drew is dropped.
        assert.ok(w <= 32.11 && s <= 45.204449 && e >= 35.02 && n >= 46.47);
    });

    it('leaves a box already on tile edges alone', () => {
        // Otherwise every re-import of the same area spreads a tile wider.
        const aligned: [number, number, number, number] =
            [32.0361328125, 45.17578125, 35.068359375, 46.494140625];
        assert.deepEqual(snapBboxToTiles(aligned), aligned);
    });

    it('snaps a western box the same way', () => {
        const [w, s, e, n] = snapBboxToTiles([-113.61, 35.60, -110.79, 37.10]);
        onEdge(w, -180);
        onEdge(e, -180);
        assert.ok(w <= -113.61 && e >= -110.79 && s <= 35.60 && n >= 37.10);
    });
});

describe('formatDuration', () => {
    it('renders sub-minute durations with one decimal of seconds', () => {
        assert.equal(formatDuration(1234), '1.2s');
        assert.equal(formatDuration(59900), '59.9s');
    });

    it('switches to minutes and whole seconds at one minute', () => {
        assert.equal(formatDuration(60000), '1m 0s');
        assert.equal(formatDuration(252000), '4m 12s');
    });

    it('never prints a fractional second once it is showing minutes', () => {
        // 119.6s must round to 2m 0s, not 1m 60s.
        assert.equal(formatDuration(119600), '2m 0s');
    });
});

describe('the bake plans end with meshes then textures over the same box', () => {
    /** The mesh bake must be followed, immediately, by the texture bake with the same --bbox. */
    function assertMeshThenTextures(steps: Step[]): void {
        const tools = steps.map(s => s.args.find(a => a.startsWith('tools/')));
        const mesh = tools.indexOf('tools/bake_planet_mesh.ts');
        assert.ok(mesh >= 0, 'no mesh bake in the plan');
        assert.equal(tools[mesh + 1], 'tools/bake_planet_tex.ts', 'texture bake does not follow the mesh bake');
        assert.equal(mesh + 2, steps.length, 'something runs after the texture bake');
        const bboxOf = (s: Step) => s.args[s.args.indexOf('--bbox') + 1];
        assert.equal(bboxOf(steps[mesh + 1]), bboxOf(steps[mesh]));
        assert.ok(bboxOf(steps[mesh]).split(',').length === 4, 'mesh bake has no box');
    }

    it('holds for an import, with and without cover', () => {
        const job = { name: 'Test Area', bbox: [7.6, 45.9, 7.8, 46.0] };
        assertMeshThenTextures(plan(job, true));
        assertMeshThenTextures(plan(job, false));
    });

    it('holds for a delete', () => {
        assertMeshThenTextures(deletePlan('mad', [-17.53, 32.3, -16.17, 33.35]));
    });
});

describe('stepOutcome', () => {
    it('is done on zero, whatever the step declares', () => {
        assert.equal(stepOutcome(0, {}), 'done');
        assert.equal(stepOutcome(0, { partialCode: 2 }), 'done');
    });

    it('is partial only on the code the step declares', () => {
        assert.equal(stepOutcome(2, { partialCode: 2 }), 'partial');
        assert.equal(stepOutcome(1, { partialCode: 2 }), 'failed');
        assert.equal(stepOutcome(2, {}), 'failed');
        assert.equal(stepOutcome(null, { partialCode: 2 }), 'failed');
    });

    it('lets an airfield bake that skipped an Overpass-less area finish the import', () => {
        // bake_osm_airports.py exits EXIT_PARTIAL (2) when it wrote the
        // manifest but every mirror failed for an area; one such area used
        // to abort the whole import after the DEM and coast stages.
        const airfields = plan({ name: 'lhg', bbox: [166.9, -21.8, 168.4, -20.6] }, true)
            .find(s => s.args.includes('tools/bake_osm_airports.py'));
        assert.ok(airfields, 'no airfield bake in the plan');
        assert.equal(airfields.partialCode, 2);
        assert.ok(airfields.partialWarning, 'a partial step needs a warning to report');
        assert.equal(stepOutcome(2, airfields), 'partial');
        assert.equal(stepOutcome(1, airfields), 'failed');
    });
});
