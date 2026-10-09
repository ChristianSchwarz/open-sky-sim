import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    Lanes, Step, dataSteps, deletePlan, extractPathFor, formatDuration, isProgressLine, parseProgress, plan, chunkBbox,
    snapBboxToTiles, splitStream, stepOutcome, EXIT_NO_LAND, landChunks,
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

    it('reads the extract download counter', () => {
        // tools/osm_extract.py: `  {got_mb:.1f}/{total_mb:.1f} MB ({pct:.1f}%)`
        assert.equal(parseProgress('  12.3/456.7 MB (2.7%)'), 2.7);
        assert.equal(parseProgress('  456.7/456.7 MB (100.0%)'), 100);
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
        assert.equal(isProgressLine('  12.3/456.7 MB (2.7%)'), true);
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
    /**
     * The mesh bake must be followed, immediately, by the texture bake with
     * the same --bbox. An import then drapes the road strokes over the
     * finished meshes, measures the lines in the lidar, bakes the bridges
     * over them and grades the beds into the land, the last write of a tile;
     * then the far land is made from the graded land, then the buildings stood on it, and nothing runs after.
     */
    function assertMeshThenTextures(steps: Step[], withRoads: boolean): void {
        const tools = steps.map(s => s.args.find(a => a.startsWith('tools/')));
        const mesh = tools.indexOf('tools/bake_planet_mesh.ts');
        assert.ok(mesh >= 0, 'no mesh bake in the plan');
        assert.equal(tools[mesh + 1], 'tools/bake_planet_tex.ts', 'texture bake does not follow the mesh bake');
        // `--bbox w,s,e,n`, or `--bbox=w,s,e,n` for a Python stage (argparse reads a
        // negative west as an option of its own).
        const bboxOf = (s: Step) => s.args.find(a => a.startsWith('--bbox='))?.slice('--bbox='.length)
            ?? s.args[s.args.indexOf('--bbox') + 1];
        assert.equal(bboxOf(steps[mesh + 1]), bboxOf(steps[mesh]));
        assert.ok(bboxOf(steps[mesh]).split(',').length === 4, 'mesh bake has no box');
        if (withRoads) {
            assert.equal(tools[mesh + 2], 'tools/bake_planet_roads.ts', 'road strokes do not follow the textures');
            assert.equal(bboxOf(steps[mesh + 2]), bboxOf(steps[mesh]));
            assert.equal(tools[mesh + 3], 'tools/measure_lidar.py', 'the lidar is not measured after the road strokes');
            assert.equal(bboxOf(steps[mesh + 3]), bboxOf(steps[mesh]));
            assert.equal(tools[mesh + 4], 'tools/bake_planet_bridges.ts', 'bridges do not follow the lidar');
            assert.equal(tools[mesh + 5], 'tools/bake_planet_grade.ts', 'grading does not follow the bridges');
            assert.equal(bboxOf(steps[mesh + 5]), bboxOf(steps[mesh]));
            assert.equal(tools[mesh + 6], 'tools/bake_planet_farland.ts', 'far land does not follow the grading');
            assert.equal(bboxOf(steps[mesh + 6]), bboxOf(steps[mesh]));
            assert.equal(tools[mesh + 7], 'tools/bake_planet_buildings.ts', 'buildings do not follow the far land');
            assert.equal(bboxOf(steps[mesh + 7]), bboxOf(steps[mesh]));
            assert.equal(mesh + 8, steps.length, 'something runs after the buildings');
        } else {
            assert.equal(mesh + 2, steps.length, 'something runs after the texture bake');
        }
    }

    it('holds for an import', () => {
        const job = { name: 'Test Area', bbox: [7.6, 45.9, 7.8, 46.0] };
        assertMeshThenTextures(plan(job), true);
    });

    it('holds for a delete', () => {
        assertMeshThenTextures(deletePlan('mad', [-17.53, 32.3, -16.17, 33.35]), true);
    });
});

describe('plan', () => {
    it('resolves a local OSM extract first and reads it from every OSM-fetching stage', () => {
        const job = { name: 'Test Area', bbox: [7.6, 45.9, 7.8, 46.0] };
        const steps = plan(job);
        assert.equal(steps[0].args[0], 'tools/osm_extract.py');
        assert.ok(steps[0].args.includes(`--bbox=${job.bbox.join(',')}`));
        const pbf = extractPathFor(job.bbox);
        for (const tool of ['tools/bake_osm_coast.py', 'tools/bake_osm_roads.py', 'tools/bake_osm_buildings.py',
            'tools/bake_osm_airports.py', 'tools/bake_planet_cover.py']) {
            const step = steps.find(s => s.args[0] === tool);
            assert.ok(step, `${tool} missing from the plan`);
            assert.ok(step.args.includes(`--pbf=${pbf}`), `${tool} does not read the local extract`);
        }
        // Satellite cover is no longer optional.
        assert.ok(steps.some(s => s.args[0] === 'tools/fetch_cover_sources.py'));
        assert.ok(steps.some(s => s.args[0] === 'tools/bake_planet_cover.py'));
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
        const airfields = plan({ name: 'lhg', bbox: [166.9, -21.8, 168.4, -20.6] })
            .find(s => s.args.includes('tools/bake_osm_airports.py'));
        assert.ok(airfields, 'no airfield bake in the plan');
        assert.equal(airfields.partialCode, 2);
        assert.ok(airfields.partialWarning, 'a partial step needs a warning to report');
        assert.equal(stepOutcome(2, airfields), 'partial');
        assert.equal(stepOutcome(1, airfields), 'failed');
    });
});

describe('chunkBbox', () => {
    it('leaves a small box whole', () => {
        const box: [number, number, number, number] = [-17.5, 32.25, -16.25, 33.5];
        assert.deepEqual(chunkBbox(box), [box]);
    });

    it('tiles a big box exactly, on tile edges, without overlap', () => {
        const box = snapBboxToTiles([10.03, 40.11, 15.2, 44.9]);
        const chunks = chunkBbox(box);
        assert.ok(chunks.length > 1);
        const area = (c: number[]) => (c[2] - c[0]) * (c[3] - c[1]);
        const total = chunks.reduce((s, c) => s + area(c), 0);
        assert.ok(Math.abs(total - area(box)) < 1e-6);
        const tile = 180 / 4096;
        for (const c of chunks) {
            assert.ok(c[2] - c[0] <= 2 + 1e-9 && c[3] - c[1] <= 2 + 1e-9);
            for (const v of [c[0] - box[0], c[1] - box[1]]) {
                assert.ok(Math.abs(v / tile - Math.round(v / tile)) < 1e-6);
            }
        }
    });
});

describe('chunkBbox slivers', () => {
    const tile = 180 / 4096;
    const spans = (chunks: number[][], axis: 0 | 1) =>
        [...new Set(chunks.map(c => c[axis + 2] - c[axis]).map(v => Math.round(v / tile)))];

    it('splits the Germany North East box evenly instead of ending on a sliver', () => {
        // 2026-09-28: this box ended on a 0.09 degree column whose northern
        // chunk was pure Baltic.
        const box = snapBboxToTiles([10.8, 52.5146484375, 14.8, 54.75]);
        const chunks = chunkBbox(box);
        const widths = spans(chunks, 0);
        const heights = spans(chunks, 1);
        assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `widths ${widths}`);
        assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `heights ${heights}`);
        for (const c of chunks) {
            assert.ok(c[2] - c[0] <= 2 + 1e-9 && c[3] - c[1] <= 2 + 1e-9);
            assert.ok(c[2] - c[0] >= 1 && c[3] - c[1] >= 1, `sliver ${c}`);
        }
        assert.equal(chunks[0][0], box[0]);
        assert.equal(chunks[chunks.length - 1][2], box[2]);
    });

    it('never cuts more chunks than a fixed 2 degree grid would', () => {
        for (const w of [2.05, 3.9, 4.09, 6.01]) {
            const box: [number, number, number, number] = [10, 50, 10 + Math.round(w / tile) * tile, 51];
            assert.equal(chunkBbox(box).length, Math.ceil(Math.round(w / tile) / Math.floor(2 / tile)));
        }
    });
});

describe('open-sea chunks', () => {
    it('the heights fetch declares the DEM tool\'s no-land code as a skip', () => {
        const steps = dataSteps({ name: 'Test Area', bbox: [7.6, 45.9, 7.8, 46.0], pbf: 'x.osm.pbf' });
        const fetch = steps.find(s => s.args[0] === 'tools/fetch_planet_dem.py');
        assert.equal(fetch?.skipCode, EXIT_NO_LAND);
        assert.equal(stepOutcome(EXIT_NO_LAND, fetch!), 'skipped');
        assert.equal(stepOutcome(1, fetch!), 'failed');
        assert.equal(stepOutcome(EXIT_NO_LAND, {}), 'failed');
        for (const s of steps.filter(s => s !== fetch)) {
            assert.equal(s.skipCode, undefined, `${s.label} can be skipped`);
        }
    });

    const fakeChunks = (sea: Set<number>) => {
        const ran: string[] = [];
        const landBefore: boolean[] = [];
        const stepsFor = (ci: number, before: boolean): Step[] => {
            landBefore[ci] = before;
            return ['fetch', 'merge'].map(k => ({ label: `${k} ${ci}`, cmd: 'x', args: [], lane: 'dem' as const }))
                .concat([{ label: `coast ${ci}`, cmd: 'x', args: [], lane: 'coast' }]);
        };
        const run = async (s: Step) => {
            ran.push(s.label);
            return s.label.startsWith('fetch') && sea.has(Number(s.label.split(' ')[1])) ? 'skipped' : 'done';
        };
        return { ran, landBefore, stepsFor, run };
    };

    it('skips a sea chunk\'s merge and later stages, and the next land chunk founds the area', async () => {
        const f = fakeChunks(new Set([0, 2]));
        const skipped: number[] = [];
        const land = await landChunks(4, f.stepsFor, f.run, ci => skipped.push(ci));
        assert.deepEqual(skipped, [0, 2]);
        assert.deepEqual(f.ran, ['fetch 0', 'fetch 1', 'merge 1', 'fetch 2', 'fetch 3', 'merge 3']);
        assert.deepEqual(land.map(steps => steps[2].label), ['coast 1', 'coast 3']);
        // Chunk 1 is the first with land, so it must not --extend-area.
        assert.deepEqual(f.landBefore, [false, false, true, true]);
    });

    it('fails when every chunk is sea', async () => {
        const f = fakeChunks(new Set([0, 1]));
        await assert.rejects(landChunks(2, f.stepsFor, f.run, () => undefined), /no land/);
    });

    it('a failed fetch still fails the import', async () => {
        const f = fakeChunks(new Set());
        const run = async (s: Step) => {
            if (s.label === 'fetch 1') {
                throw new Error('fetching heights exited with code 1');
            }
            return f.run(s);
        };
        await assert.rejects(landChunks(3, f.stepsFor, run, () => undefined), /code 1/);
    });
});

describe('dataSteps lanes', () => {
    it('gives every data step a lane, and reads the OSM data before the coast bake', () => {
        const steps = dataSteps({ name: 'Test Area', bbox: [7.6, 45.9, 7.8, 46.0], pbf: 'x.osm.pbf' });
        for (const s of steps) {
            assert.ok(s.lane, `${s.label} has no lane`);
        }
        const tools = steps.map(s => s.args[0]);
        const read = tools.indexOf('tools/osm_prefetch.py');
        assert.ok(read >= 0, 'no shared OSM read');
        assert.ok(read < tools.indexOf('tools/bake_osm_coast.py'), 'the coast bake runs before the OSM read');
        assert.ok(steps[read].args.includes('--pbf=x.osm.pbf'));
    });
});

describe('Lanes', () => {
    const tick = () => new Promise(r => setTimeout(r, 5));

    it('runs a lane in order, one at a time, and waits for dependencies', async () => {
        const lanes = new Lanes();
        const events: string[] = [];
        let busy = 0;
        const step = (name: string) => async () => {
            busy++;
            assert.equal(busy, 1, `${name} overlapped another step of its lane`);
            events.push(`start ${name}`);
            await tick();
            events.push(`end ${name}`);
            busy--;
        };
        const gate = lanes.run('other', [], async () => {
            await tick();
            await tick();
            events.push('gate');
        });
        lanes.run('a', [], step('a1'));
        lanes.run('a', [gate], step('a2'));
        await lanes.join();
        assert.deepEqual(events, ['start a1', 'end a1', 'gate', 'start a2', 'end a2']);
    });

    it('starts nothing after a failure, and join throws it', async () => {
        const lanes = new Lanes();
        let ran = false;
        const failed = lanes.run('a', [], async () => {
            throw new Error('cover bake exited with code 1');
        });
        lanes.run('b', [failed], async () => {
            ran = true;
        });
        await assert.rejects(lanes.join(), /cover bake exited/);
        assert.equal(ran, false);
        assert.ok(lanes.error);
    });
});
