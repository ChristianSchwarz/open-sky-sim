/**
 * A measured profile along one stroke segment of a graded line: its lidar
 * height and its embankment or cutting, at even steps from the segment's
 * first vertex (0) to its last (n - 1). Built at grade time from the lidar
 * store (tools/bake/lidarProfiles.ts) and fitted to by railBed.ts
 * (RailBedInput.measured).
 */

export interface LineProfile {
    /** Height along up at each sample, metres, the land's datum; NaN where unmeasured. */
    centre: Float32Array;
    /** Centre minus the ground beside the line, metres (fill > 0); NaN where unmeasured. */
    lift: Float32Array;
}

/** The measured profile at fraction `t` (0..1) along its segment. */
export function profileAt(p: LineProfile, t: number): { centre: number; lift: number } {
    const n = p.centre.length;
    if (n === 1) {
        return { centre: p.centre[0], lift: p.lift[0] };
    }
    const x = Math.max(0, Math.min(n - 1, t * (n - 1)));
    const i = Math.min(n - 2, Math.floor(x)), f = x - i;
    return {
        centre: p.centre[i] + (p.centre[i + 1] - p.centre[i]) * f,
        lift: p.lift[i] + (p.lift[i + 1] - p.lift[i]) * f,
    };
}
