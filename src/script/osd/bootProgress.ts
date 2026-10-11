/** Full-screen boot progress overlay (#boot-progress). */

/** One step of the boot: where the bar stands and what it says. */
export interface BootStage {
    percent: number;
    label: string;
}

/**
 * The boot's fixed steps, in the order the game passes them (index.ts, then
 * Game.setup and Game.setupScene). Between `aircraft` and `ready` the bar runs
 * through {@link BOOT_TERRAIN_RANGE} while the terrain under the spawn meshes
 * ({@link terrainBootStage}); a first boot of the dev server with no terrain
 * shows the bake instead ({@link bootstrapBakeStage}) before `terrain`.
 */
export const BOOT_STAGES = {
    start: { percent: 0, label: 'Loading...' },
    renderer: { percent: 5, label: 'Initializing renderer...' },
    aircraftPacks: { percent: 15, label: 'Loading aircraft packs...' },
    scene: { percent: 25, label: 'Building scene...' },
    terrain: { percent: 35, label: 'Loading terrain...' },
    terrainTiles: { percent: 45, label: 'Loading terrain tiles...' },
    terrainMeshes: { percent: 50, label: 'Building terrain meshes...' },
    airfields: { percent: 60, label: 'Loading airfields...' },
    airbase: { percent: 68, label: 'Loading airbase...' },
    scenery: { percent: 75, label: 'Loading scenery...' },
    aircraft: { percent: 90, label: 'Loading aircraft...' },
    ready: { percent: 100, label: 'Ready' },
} as const satisfies Record<string, BootStage>;

/** The stretch of the bar the pinned terrain under the spawn fills. */
export const BOOT_TERRAIN_RANGE = { min: 90, max: 99 } as const;

/** The bar while the pinned terrain meshes: `meshed` of `total` tiles across [min, max]. */
export function terrainBootStage(meshed: number, total: number, min: number, max: number): BootStage {
    const frac = total > 0 ? meshed / total : 1;
    return {
        percent: min + (max - min) * frac,
        label: total > 0 ? `Loading terrain (${meshed}/${total})...` : 'Loading terrain...',
    };
}

/** The bar while the dev server bakes the first terrain (manifest.ts waitForBootstrapBake). */
export function bootstrapBakeStage(
    name: string | undefined, step: string | undefined, stepIndex: number | undefined,
    stepCount: number | undefined, percent: number | undefined,
): BootStage {
    const count = Math.max(1, stepCount ?? 1);
    const overall = (((stepIndex ?? 0) + (percent ?? 0) / 100) / count) * 100;
    return {
        percent: Math.min(99, overall),
        label: `No terrain yet - baking ${name} (step ${(stepIndex ?? 0) + 1}/${count}: ${step}). `
            + 'This runs once and can take a while.',
    };
}

/** What the bar says when the boot throws. */
export function bootFailedStage(message: string): BootStage {
    return { percent: 100, label: `Load failed: ${message}` };
}

/** The blurred pane over a respawn, before the streaming hold takes over. */
export const RESPAWN_STAGE: BootStage = { percent: 0, label: 'Loading terrain...' };

export function streamingLabel(shown: number): string {
    return `Streaming terrain... ${Math.floor(100 * shown)}%`;
}

/** How long the terrain backlog must stay empty before the boot blur lifts; see Game.holdUntilStreamed. */
export const STREAM_SETTLE_MS = 600;
/** The boot blur lifts after this even if streaming never goes quiet (a failing tile, a slow link). */
export const STREAM_HOLD_MAX_MS = 20_000;
/** Seconds counted down, still paused, once streaming has settled; "Go" follows. */
export const STREAM_COUNTDOWN_FROM = 3;
/** How long "Go" stays up over the running flight. */
export const STREAM_GO_SHOWN_MS = 800;
/** Fastest the streaming bar may advance (fraction of full per second), so it sweeps rather than jumps. */
export const STREAM_BAR_RATE_PER_S = 0.5;

/** The "get ready" count after the hold, one a second: 3, 2, 1, then Go. */
export function countdownTexts(): string[] {
    const out: string[] = [];
    for (let n = STREAM_COUNTDOWN_FROM; n > 0; n--) {
        out.push(String(n));
    }
    out.push('Go');
    return out;
}

/**
 * The streaming hold's bar. The backlog grows as the LOD pass finds more to
 * want, so a plain backlog/peak ratio jumps back and forth. Count what drained
 * instead, never let the bar go backwards, and move it at a capped rate so it
 * reads as a steady sweep.
 */
export class StreamBar {
    /** 0..1, what the bar and its label show. */
    shown = 0;
    private prevBacklog = 0;
    private drained = 0;
    private lastTick: number;
    private idleSince: number | undefined;

    constructor(private readonly start: number) {
        this.lastTick = start;
    }

    /** One frame at `now` (ms) with `backlog` tiles still wanted; true once the hold should end. */
    tick(now: number, backlog: number): boolean {
        this.drained += Math.max(0, this.prevBacklog - backlog);
        this.prevBacklog = backlog;
        const target = backlog > 0 ? this.drained / (this.drained + backlog) : 1;
        const step = STREAM_BAR_RATE_PER_S * (now - this.lastTick) / 1000;
        this.lastTick = now;
        this.shown = Math.min(Math.max(this.shown, target), this.shown + step);
        if (backlog > 0) {
            this.idleSince = undefined;
        } else {
            this.idleSince ??= now;
        }
        // Let the bar finish its sweep before clearing, so it never
        // vanishes at 70%.
        const settled = this.idleSince !== undefined && now - this.idleSince >= STREAM_SETTLE_MS && this.shown >= 1;
        return settled || now - this.start >= STREAM_HOLD_MAX_MS;
    }
}

/** The overlay's fill, in percent. */
export function clampBootPercent(percent: number): number {
    return Math.max(0, Math.min(100, percent));
}

export function setBootProgress(percent: number, label: string): void {
    const root = document.getElementById('boot-progress');
    const fill = document.getElementById('boot-progress-fill');
    const text = document.getElementById('boot-progress-label');
    if (!root || !fill || !text) {
        return;
    }
    const clamped = clampBootPercent(percent);
    fill.style.width = `${clamped}%`;
    text.textContent = label;
    root.classList.remove('hidden');
}

export function hideBootProgress(): void {
    const root = document.getElementById('boot-progress');
    if (!root) {
        return;
    }
    root.classList.add('hidden');
}

/**
 * Switch the overlay from the opaque boot screen to a blurred pane over the
 * live view, for the streaming hold after boot (see Game.holdUntilStreamed).
 */
export function setBootStreaming(percent: number, label: string): void {
    setBootProgress(percent, label);
    const root = document.getElementById('boot-progress');
    root?.classList.add('streaming');
    // A respawn can start before the previous fade finished.
    root?.classList.remove('fading');
}

/** Clear the blur and dim to nothing over a second (see style.css), then hide the overlay. */
export function fadeOutBootProgress(): void {
    const root = document.getElementById('boot-progress');
    if (!root) {
        return;
    }
    root.classList.add('fading');
    const done = () => {
        // Shown again (a respawn) since the fade began: leave it up.
        if (!root.classList.contains('fading')) {
            return;
        }
        root.classList.add('hidden');
        root.classList.remove('fading', 'streaming');
    };
    root.addEventListener('transitionend', done, { once: true });
    // transitionend never fires when the transition is skipped (reduced motion, hidden tab).
    setTimeout(done, 1100);
}

/** The big "get ready" number shown after the streaming blur lifts (#countdown). */
export function showCountdown(text: string): void {
    const el = document.getElementById('countdown');
    if (!el) {
        return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
    // Restart the pop animation for each number.
    el.classList.remove('tick');
    void el.offsetWidth;
    el.classList.add('tick');
}

export function hideCountdown(): void {
    document.getElementById('countdown')?.classList.add('hidden');
}
