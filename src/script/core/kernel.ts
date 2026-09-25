import { assertExpr } from "../utils/asserts";

export interface KernelUpdateTask {
    // delta - Time elapsed for the previous frame, measured in seconds.
    update(delta: number): void;
}

export interface KernelRenderTask {
    render(): void;
}

/** @deprecated Use KernelUpdateTask or KernelRenderTask. */
export type KernelTask = KernelUpdateTask;

// 60fps, measured in ms
const DEFAULT_FRAME_DURATION: number = 1000.0 / 60.0;

export class Kernel {
    private runTasksFn = () => { this.runTasks(); };

    private updateTasks: KernelUpdateTask[] = [];
    private renderTasks: KernelRenderTask[] = [];

    private prevTime: number = performance.now();

    private targetFPSLength: number = 0.0;
    private targetFPSprogress: number = 0.0;

    constructor(private targetFPS?: number) {
        this.setTargetFPS(targetFPS);
    }

    addUpdateTask(task: KernelUpdateTask) {
        this.updateTasks.push(task);
    }

    addRenderTask(task: KernelRenderTask) {
        this.renderTasks.push(task);
    }

    /** @deprecated Use addUpdateTask. */
    addTask(task: KernelUpdateTask) {
        this.addUpdateTask(task);
    }

    setTargetFPS(targetFPS?: number) {
        if (targetFPS) {
            this.targetFPSLength = 1.0 / targetFPS * 1000.0;
        } else {
            this.targetFPSLength = 0.0;
        }
        this.targetFPS = targetFPS;
        this.targetFPSprogress = 0.0;
    }

    start() {
        assertExpr(this.updateTasks.length > 0, 'No KernelUpdateTasks registered!');
        assertExpr(this.renderTasks.length > 0, 'No KernelRenderTasks registered!');
        window.requestAnimationFrame(this.runTasksFn);
        this.prevTime = performance.now() - DEFAULT_FRAME_DURATION;
    }

    private runTasks() {
        const deltaMs = this.updateDeltas();
        window.requestAnimationFrame(this.runTasksFn);

        if (this.targetFPS) {
            this.targetFPSprogress += deltaMs;
            // Skip the whole frame when early so the event loop can drain worker
            // messages instead of burning the budget on another HD render.
            if (this.targetFPSprogress < this.targetFPSLength) {
                return;
            }
            do {
                this.targetFPSprogress -= this.targetFPSLength;
            } while (this.targetFPSprogress >= this.targetFPSLength);

            const delta = this.targetFPSLength / 1000.0;
            this.runUpdates(delta);
            this.runRenders();
            return;
        }

        const delta = deltaMs / 1000.0;
        this.runUpdates(delta);
        this.runRenders();
    }

    /**
     * EMA'd wall-clock split between game logic and rendering, published
     * alongside the renderer's own __drawStats/__gpuStats: a GPU pass timer
     * only accounts for GPU execution time, not the CPU time spent building
     * and issuing the draw calls in the first place (matrix updates, state
     * diffing, three.js's own submission overhead) or anything outside
     * rendering altogether (physics, AI, terrain streaming). This is the
     * top-level split that says which side of that line is worth chasing.
     */
    private updateEmaMs = 0;
    private renderEmaMs = 0;
    private static readonly STATS_EMA_ALPHA = 0.1;

    private runUpdates(delta: number) {
        const start = performance.now();
        for (let i = 0; i < this.updateTasks.length; i++) {
            this.updateTasks[i].update(delta);
        }
        this.updateEmaMs += (performance.now() - start - this.updateEmaMs) * Kernel.STATS_EMA_ALPHA;
        this.publishStats();
    }

    private runRenders() {
        const start = performance.now();
        for (let i = 0; i < this.renderTasks.length; i++) {
            this.renderTasks[i].render();
        }
        this.renderEmaMs += (performance.now() - start - this.renderEmaMs) * Kernel.STATS_EMA_ALPHA;
        this.publishStats();
    }

    private publishStats(): void {
        (globalThis as Record<string, unknown>).__kernelStats = {
            updateMs: this.updateEmaMs,
            renderMs: this.renderEmaMs,
        };
    }

    private updateDeltas(): number {
        const now = performance.now();
        const deltaMs = now - this.prevTime;
        this.prevTime = now;
        return deltaMs;
    }
}
