/**
 * The baked swatch table: the handful of colours the whole archipelago gets
 * reduced to for the SWATCH terrain colour mode.
 *
 * Quantising in the bake rather than in the shader is what makes the mode
 * cheap and, more importantly, *stable*: every tile is reduced against the
 * same table, so a colour does not change swatch when the camera moves to a
 * different LOD level.
 *
 * Colours are accumulated into a 5-bit-per-channel histogram - 32768 bins,
 * one Uint32Array, constant memory whatever the bake size - and then reduced
 * by median cut, which puts swatches where the colours actually are rather
 * than on an even grid nothing in the Canaries happens to sit on.
 */

/** Bits kept per channel in the histogram. 5 gives 32768 bins. */
const BITS = 5;
const LEVELS = 1 << BITS;
export const HISTOGRAM_BINS = LEVELS * LEVELS * LEVELS;

export function newColorHistogram(): Uint32Array {
    return new Uint32Array(HISTOGRAM_BINS);
}

/** Add every rgb triple in `colors` (3 bytes per entry) to the histogram. */
export function accumulateColors(histogram: Uint32Array, colors: Uint8Array): void {
    const shift = 8 - BITS;
    for (let i = 0; i + 2 < colors.length; i += 3) {
        const r = colors[i] >> shift;
        const g = colors[i + 1] >> shift;
        const b = colors[i + 2] >> shift;
        histogram[(r * LEVELS + g) * LEVELS + b]++;
    }
}

/** Where the baked colours sit in brightness, and how far they spread. */
export interface LuminanceWindow {
    /** Mean sRGB luminance. */
    mid: number;
    /** One standard deviation, floored so a uniform bake still bands. */
    spread: number;
}

/**
 * Mean and spread of the histogram's sRGB luminance.
 *
 * The HYBRID mode bands a facet's brightness relative to an average one, and
 * "average" has to come from the data. Hard-coding mid-grey put every Canary
 * facet - volcanic, arid, and much darker than 0.5 - into the same bottom band,
 * which made the mode a slightly dimmed copy of LANDCOVER.
 *
 * sRGB, not linear: this is a perceptual "how light does this look", and in
 * linear light real ground bunches into the bottom fifth of the range.
 */
export function luminanceWindow(histogram: Uint32Array): LuminanceWindow {
    const step = 255 / (LEVELS - 1);
    let total = 0;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < histogram.length; i++) {
        const count = histogram[i];
        if (count === 0) {
            continue;
        }
        const b = (i % LEVELS) * step / 255;
        const g = (Math.floor(i / LEVELS) % LEVELS) * step / 255;
        const r = Math.floor(i / (LEVELS * LEVELS)) * step / 255;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        total += count;
        sum += lum * count;
        sumSq += lum * lum * count;
    }
    if (total === 0) {
        return { mid: 0.5, spread: 0.2 };
    }
    const mid = sum / total;
    const variance = Math.max(0, sumSq / total - mid * mid);
    // Floored: a bake whose colours are all one value has no spread to measure,
    // and dividing by it would put every facet in the outermost band.
    return { mid, spread: Math.max(0.02, Math.sqrt(variance)) };
}

interface Bin {
    r: number;
    g: number;
    b: number;
    count: number;
}

interface Box {
    bins: Bin[];
    count: number;
    /** Widest channel (0/1/2) and its range, cached from the last split. */
    axis: number;
    range: number;
}

function measure(bins: Bin[]): { axis: number; range: number; count: number } {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    let count = 0;
    for (const bin of bins) {
        if (bin.r < rMin) rMin = bin.r;
        if (bin.r > rMax) rMax = bin.r;
        if (bin.g < gMin) gMin = bin.g;
        if (bin.g > gMax) gMax = bin.g;
        if (bin.b < bMin) bMin = bin.b;
        if (bin.b > bMax) bMax = bin.b;
        count += bin.count;
    }
    // Weighted by how much of a channel the eye actually spends: an equal
    // numeric spread in green is a bigger visible spread than one in blue, and
    // splitting on raw range alone hands most of the table to sea blues.
    const spans = [(rMax - rMin) * 0.30, (gMax - gMin) * 0.59, (bMax - bMin) * 0.11];
    let axis = 0;
    for (let i = 1; i < 3; i++) {
        if (spans[i] > spans[axis]) {
            axis = i;
        }
    }
    return { axis, range: spans[axis], count };
}

function channelOf(bin: Bin, axis: number): number {
    return axis === 0 ? bin.r : axis === 1 ? bin.g : bin.b;
}

function toHex(r: number, g: number, b: number): string {
    const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Reduce a histogram to at most `count` swatches, as `#rrggbb` strings.
 *
 * Returns fewer than `count` only when the histogram holds fewer distinct bins
 * than that, which in practice means a bake with no imagery at all.
 */
export function medianCut(histogram: Uint32Array, count: number): string[] {
    const step = 255 / (LEVELS - 1);
    const bins: Bin[] = [];
    for (let i = 0; i < histogram.length; i++) {
        if (histogram[i] === 0) {
            continue;
        }
        const b = i % LEVELS;
        const g = Math.floor(i / LEVELS) % LEVELS;
        const r = Math.floor(i / (LEVELS * LEVELS));
        bins.push({ r: r * step, g: g * step, b: b * step, count: histogram[i] });
    }
    if (bins.length === 0) {
        return [];
    }

    const first = measure(bins);
    const boxes: Box[] = [{ bins, count: first.count, axis: first.axis, range: first.range }];

    while (boxes.length < count) {
        // Split the box that is both wide and populous. Range alone chases a
        // handful of outlying pixels; population alone splits the sea five ways.
        let target = -1;
        let best = 0;
        for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            if (box.bins.length < 2 || box.range <= 0) {
                continue;
            }
            const score = box.range * Math.sqrt(box.count);
            if (score > best) {
                best = score;
                target = i;
            }
        }
        if (target < 0) {
            break;
        }
        const box = boxes[target];
        const sorted = box.bins.slice().sort(
            (a, b) => channelOf(a, box.axis) - channelOf(b, box.axis));
        const half = box.count / 2;
        let acc = 0;
        let cut = 0;
        while (cut < sorted.length - 1 && acc + sorted[cut].count < half) {
            acc += sorted[cut].count;
            cut++;
        }
        const left = sorted.slice(0, Math.max(1, cut));
        const right = sorted.slice(Math.max(1, cut));
        if (right.length === 0) {
            break;
        }
        const lm = measure(left);
        const rm = measure(right);
        boxes[target] = { bins: left, count: lm.count, axis: lm.axis, range: lm.range };
        boxes.push({ bins: right, count: rm.count, axis: rm.axis, range: rm.range });
    }

    return boxes
        .map(box => {
            let r = 0, g = 0, b = 0;
            for (const bin of box.bins) {
                r += bin.r * bin.count;
                g += bin.g * bin.count;
                b += bin.b * bin.count;
            }
            return { hex: toHex(r / box.count, g / box.count, b / box.count), count: box.count };
        })
        // Most-used first, so a table truncated by a future consumer keeps the
        // colours that actually cover ground.
        .sort((a, b) => b.count - a.count)
        .map(s => s.hex);
}
