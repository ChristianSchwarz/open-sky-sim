/**
 * Many boxes for one scoped bake: `--bboxes FILE`, one `west,south,east,north`
 * a line (blank lines and `#` comments skipped).
 *
 * A stage given them bakes the tiles overlapping any box and carries the rest
 * of its index over, exactly as with one `--bbox` - its `bbox` becomes the
 * boxes' union, for everything that only asks whether the bake is scoped. It
 * is what lets the airfields of a whole area be re-baked in one run
 * (tools/rebake_airfields.ts): a run per airfield re-baked the coarse tiles
 * over them once for every airfield under them, and paid each stage's start-up
 * a thousand times over.
 */

import * as fs from 'node:fs';

export interface Box {
    west: number;
    south: number;
    east: number;
    north: number;
}

export function readBboxes(file: string): Box[] {
    const boxes: Box[] = [];
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) {
            continue;
        }
        const [west, south, east, north] = line.split(',').map(Number);
        if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
            throw new Error(`${file}: not west,south,east,north: ${line}`);
        }
        boxes.push({ west, south, east, north });
    }
    if (boxes.length === 0) {
        throw new Error(`${file}: no boxes`);
    }
    return boxes;
}

export function unionOf(boxes: readonly Box[]): Box {
    return {
        west: Math.min(...boxes.map(b => b.west)),
        south: Math.min(...boxes.map(b => b.south)),
        east: Math.max(...boxes.map(b => b.east)),
        north: Math.max(...boxes.map(b => b.north)),
    };
}

/** Whether `b` overlaps any of `boxes` (edges touching do not count, as with one box); true when there are none. */
export function inBoxes(b: Box, boxes: readonly Box[] | undefined): boolean {
    if (boxes === undefined) {
        return true;
    }
    for (const x of boxes) {
        if (!(b.east <= x.west || b.west >= x.east || b.north <= x.south || b.south >= x.north)) {
            return true;
        }
    }
    return false;
}
