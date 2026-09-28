import { Injectable, computed, signal } from '@angular/core';
import { Area, Box, blockedReason } from './importMath';

/**
 * Terrain import state and the jobs behind it.
 *
 * The bake itself is the command line in tools/README.md — a local OSM
 * extract resolved (downloading it if needed) and then several stages
 * sharing one bbox, cover always included — driven by the dev server
 * (tools/areaImport.ts) and reported back over server-sent events, because
 * the whole thing takes minutes, and longer on a cold cache while the
 * extract and the imagery download answer.
 *
 * A root service rather than component state: the Angular application lives
 * for the whole session, so a bake started from the dialog keeps its progress
 * stream, log and selection when the dialog is closed and reopened.
 */

export interface ImportProgress {
    /** Overall percentage, 0..100. */
    value: number;
    label: string;
    failed: boolean;
}

/** localStorage key for the job currently being followed, so a reload can reconnect to it. */
const JOB_STORAGE_KEY = 'retroflightsim.areaImport.job';

interface SavedJob {
    id: string;
    doneNote: string;
}

interface JobMessage {
    line?: string;
    step?: string;
    state?: string;
    replace?: boolean;
    stepIndex?: number;
    stepCount?: number;
    percent?: number;
    overall?: number;
}

/**
 * Whether the page is served by the dev server, the only thing that can bake.
 * The published game is a static build with no /api at all.
 */
export async function isAreaImporterAvailable(): Promise<boolean> {
    try {
        const res = await fetch('/api/areas');
        if (!res.ok) {
            return false;
        }
        const body = await res.json();
        return Array.isArray(body?.areas);
    } catch {
        return false;
    }
}

@Injectable({ providedIn: 'root' })
export class AreaImportService {
    readonly areas = signal<Area[]>([]);
    readonly running = signal(false);
    readonly selection = signal<Box | undefined>(undefined);
    readonly name = signal('');
    /** Geofabrik regions already downloaded locally, so the map can shade them. */
    readonly extracts = signal<Area[]>([]);
    readonly progress = signal<ImportProgress | undefined>(undefined);
    readonly log = signal('');
    readonly blocked = computed(() => blockedReason(this.running(), this.selection(), this.name()));

    /** The map's view, kept here so reopening the dialog shows where you left it. */
    readonly view = { centreLon: 0, centreLat: 30, zoom: 3 };

    /** True when the last log line was a progress redraw, so the next replaces it. */
    private lastLineWasProgress = false;
    private stream: EventSource | undefined;

    constructor() {
        // Dev aid, alongside globalThis.__terrain.
        (globalThis as Record<string, unknown>).__areaImport = this;

        // A bake outlives the page: reconnect to whatever was running when
        // the tab was last open, so a reload or a browser restart doesn't
        // make the progress (or the eventual failure) disappear.
        const saved = this.readSavedJob();
        if (saved) {
            this.running.set(true);
            this.log.set('');
            this.lastLineWasProgress = false;
            this.follow(saved.id, saved.doneNote);
        }
    }

    private readSavedJob(): SavedJob | undefined {
        try {
            const raw = localStorage.getItem(JOB_STORAGE_KEY);
            if (!raw) {
                return undefined;
            }
            const parsed = JSON.parse(raw);
            return typeof parsed?.id === 'string' && typeof parsed?.doneNote === 'string' ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    private saveJob(id: string, doneNote: string): void {
        try {
            localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify({ id, doneNote } satisfies SavedJob));
        } catch {
            // No persistence (private browsing, quota) - the job still runs, it just
            // won't be picked back up after a reload.
        }
    }

    private clearSavedJob(): void {
        try {
            localStorage.removeItem(JOB_STORAGE_KEY);
        } catch {
            // Nothing to clean up if it never got saved.
        }
    }

    async loadAreas(): Promise<void> {
        try {
            const res = await fetch('/api/areas');
            const body = await res.json();
            this.areas.set(Array.isArray(body.areas) ? body.areas : []);
        } catch {
            this.areas.set([]);
        }
    }

    /** Which Geofabrik regions already have a local extract on disk, for the map overlay. */
    async loadExtracts(): Promise<void> {
        try {
            const res = await fetch('/api/osm-extracts');
            const body = await res.json();
            this.extracts.set(Array.isArray(body.extracts) ? body.extracts : []);
        } catch {
            this.extracts.set([]);
        }
    }

    async startImport(): Promise<void> {
        const b = this.selection();
        if (!b || this.blocked() !== undefined) {
            return;
        }
        await this.startJob('/api/import-area', {
            name: this.name().trim(),
            bbox: [b.west, b.south, b.east, b.north],
        }, 'Reload the page and pick it under Settings -> World -> Area.');
    }

    async deleteArea(name: string): Promise<void> {
        if (this.running()) {
            return;
        }
        await this.startJob('/api/delete-area', { name }, 'Reload the page; the area is gone.');
    }

    private async startJob(url: string, body: unknown, doneNote: string): Promise<void> {
        this.running.set(true);
        this.log.set('');
        this.lastLineWasProgress = false;

        let id: string;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const reply = await res.json();
            if (!res.ok || !reply.ok) {
                throw new Error(reply.error ?? `server said ${res.status}`);
            }
            id = reply.id;
        } catch (err) {
            this.append(`could not start: ${(err as Error).message}`);
            this.running.set(false);
            return;
        }

        this.saveJob(id, doneNote);
        this.follow(id, doneNote);
    }

    private follow(id: string, doneNote: string): void {
        this.setProgress(0, 1, 0, 'starting');

        this.stream = new EventSource(`/api/import-area/${id}`);
        this.stream.onmessage = ev => {
            const data = JSON.parse(ev.data) as JobMessage;
            if (data.stepCount) {
                this.setProgress(
                    data.overall ?? 0,
                    (data.stepIndex ?? 0) + 1,
                    data.stepCount,
                    data.step ?? '',
                    data.percent,
                );
            }
            if (data.line) {
                this.append(data.line, data.replace === true);
            }
            if (data.state && data.state !== 'running') {
                this.running.set(false);
                this.stream?.close();
                this.stream = undefined;
                this.clearSavedJob();
                if (data.state === 'failed') {
                    this.progress.update(p => p && { ...p, failed: true });
                }
                if (data.state === 'done') {
                    const n = data.stepCount ?? 0;
                    this.setProgress(100, n, n, 'done', 100);
                    void this.loadAreas();
                    void this.loadExtracts();
                    this.append(`\n${doneNote}`);
                }
            }
        };
        this.stream.onerror = () => {
            // The server ends the stream when the job finishes, which surfaces
            // here as an error; only report it if the job never reported back.
            if (this.running()) {
                this.append('lost the progress stream — the bake may still be running');
                this.running.set(false);
            }
            this.clearSavedJob();
            this.stream?.close();
            this.stream = undefined;
        };
    }

    /**
     * `${overall}% · step 3/6 · baking meshes · 42% of this step`, plus the bar.
     *
     * Two numbers because one is not enough. The overall bar says how much of
     * the import is left; the step percentage says whether the stage you are
     * staring at is moving at all, which for a half-hour imagery fetch is the
     * question actually being asked.
     */
    private setProgress(
        overall: number, step: number, steps: number, label: string, percent?: number,
    ): void {
        const within = percent !== undefined && percent > 0 && percent < 100
            ? `  ·  ${percent}% of this step` : '';
        this.progress.set({
            value: Math.max(0, Math.min(100, overall)),
            label: steps > 0
                ? `${overall}%  ·  step ${Math.min(step, steps)}/${steps}  ·  ${label}${within}`
                : label,
            failed: false,
        });
    }

    private append(text: string, replace = false): void {
        // A progress redraw supersedes the previous one instead of stacking:
        // the mesh bake emits one every hundred tiles and would otherwise bury
        // everything else in the log.
        if (replace && this.lastLineWasProgress) {
            this.log.update(log => {
                const lines = log.split('\n');
                lines[Math.max(0, lines.length - 2)] = text;
                return lines.join('\n');
            });
        } else {
            this.log.update(log => `${log}${text}\n`);
        }
        this.lastLineWasProgress = replace;
    }
}
