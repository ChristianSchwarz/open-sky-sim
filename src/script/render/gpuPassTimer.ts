/**
 * Per-pass GPU time, via EXT_disjoint_timer_query_webgl2.
 *
 * Draw calls and triangle counts (see recordDrawStats in renderer.ts) turned
 * out not to explain frame time at 4K on their own — passes with far fewer
 * triangles were not proportionally faster, which is what fragment/fill-rate
 * cost looks like instead of geometry cost. This answers that directly: real
 * GPU milliseconds per named pass, published to globalThis.__gpuStats
 * alongside the existing dev-aid globals (see perfHud.ts).
 *
 * A timer query is asynchronous — the result is not available until some
 * frames after it was recorded — so this never blocks waiting on one. Only
 * one query per label may be outstanding at a time: begin() for a label
 * whose previous query has not resolved yet is a no-op for that frame rather
 * than piling up query objects.
 */
/** Not in TS's DOM lib — the extension is real, its typings just are not. */
interface DisjointTimerQueryExt {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
}

export class GpuPassTimer {
    private readonly ext: DisjointTimerQueryExt | null;
    private pendingLabel: string | undefined;
    private pendingQuery: WebGLQuery | undefined;
    /** One in-flight (begun, not yet read back) query per label. */
    private readonly inFlight = new Map<string, WebGLQuery>();
    private readonly results = new Map<string, number>();

    constructor(private readonly gl: WebGL2RenderingContext, isWebGL2: boolean) {
        this.ext = isWebGL2 ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    }

    get available(): boolean {
        return this.ext !== null;
    }

    /**
     * Start timing `label`. Must be paired with exactly one {@link end} before
     * any other pass's `begin` — WebGL2 allows only one TIME_ELAPSED query
     * active at a time, and every call site here brackets one render3D/render2D
     * submission with no other GL work sequenced between passes.
     */
    begin(label: string): void {
        if (!this.ext || this.pendingLabel !== undefined || this.inFlight.has(label)) {
            return;
        }
        const query = this.gl.createQuery();
        if (!query) {
            return;
        }
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
        this.pendingLabel = label;
        this.pendingQuery = query;
    }

    end(): void {
        if (!this.ext || this.pendingLabel === undefined || this.pendingQuery === undefined) {
            return;
        }
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.inFlight.set(this.pendingLabel, this.pendingQuery);
        this.pendingLabel = undefined;
        this.pendingQuery = undefined;
    }

    /** Read back whatever queries have resolved, and publish. Call once per frame. */
    poll(): void {
        if (!this.ext) {
            return;
        }
        // A disjoint operation (e.g. a display mode change) invalidates every
        // query timed across it — there is no way to tell which, so drop them
        // all rather than publish numbers that may not mean anything.
        const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
        for (const [label, query] of this.inFlight) {
            if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) {
                continue;
            }
            this.inFlight.delete(label);
            if (!disjoint) {
                const ns = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number;
                this.results.set(label, ns / 1e6);
            }
            this.gl.deleteQuery(query);
        }
        (globalThis as Record<string, unknown>).__gpuStats = Object.fromEntries(this.results);
    }
}
