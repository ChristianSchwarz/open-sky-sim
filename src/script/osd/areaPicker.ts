/**
 * Terrain import in the settings dialog's World tab (F9): pick an area on an OpenStreetMap map
 * and bake it into the terrain.
 *
 * The bake itself is the command line in tools/README.md — six stages sharing
 * one bbox — driven by the dev server (tools/areaImport.ts) and reported back
 * over server-sent events, because the whole thing takes minutes and the
 * imagery stage takes half an hour.
 *
 * The map is drawn here rather than pulled in as a mapping library. All it has
 * to do is show where you are and let you drag a rectangle, which is a few
 * hundred lines of Web Mercator and a canvas; a library would be a bigger
 * dependency than the feature.
 */

const TILE_PX = 256;
const MIN_ZOOM = 2;
/** Matches OSM_MAX_ZOOM in tools/areaImport.ts. */
const MAX_ZOOM = 12;
/** Matches --max-span in tools/fetch_planet_dem.py. */
const MAX_SPAN_DEG = 3;
/** The pyramid's finest level, for estimating what a box will cost to bake. */
const BAKE_ZOOM = 12;

export interface Area {
    name: string;
    west: number;
    south: number;
    east: number;
    north: number;
}

interface Box { west: number; south: number; east: number; north: number }

const MARKUP = `
<div id="area-dialog">
    <canvas id="area-map"></canvas>
    <div id="area-readout">Shift-drag on the map to choose an area. Drag to pan, wheel to zoom.</div>
    <div id="area-existing"></div>
    <div id="area-controls">
        <label for="area-name">Name</label>
        <input type="text" id="area-name" placeholder="alps" autocomplete="off">
        <label id="area-cover-label" for="area-cover">
            <input type="checkbox" id="area-cover"> Satellite colour (adds ~30 min)
        </label>
        <button type="button" id="area-import" disabled>Import</button>
    </div>
    <div id="area-progress" class="hidden">
        <div id="area-progress-label"></div>
        <div id="area-progress-track"><div id="area-progress-fill"></div></div>
    </div>
    <pre id="area-log"></pre>
</div>`;

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

let instance: AreaPicker | undefined;

/**
 * The one picker. It outlives the dialog so that a bake started from it keeps
 * its progress stream and log when the dialog is closed and reopened.
 */
export function areaPicker(): AreaPicker {
    instance ??= new AreaPicker();
    return instance;
}

// --- Web Mercator ----------------------------------------------------------

function lonToWorld(lon: number, z: number): number {
    return ((lon + 180) / 360) * TILE_PX * (1 << z);
}

function latToWorld(lat: number, z: number): number {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const s = Math.sin(clamped * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_PX * (1 << z);
}

function worldToLon(x: number, z: number): number {
    return (x / (TILE_PX * (1 << z))) * 360 - 180;
}

function worldToLat(y: number, z: number): number {
    const n = Math.PI - 2 * Math.PI * y / (TILE_PX * (1 << z));
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Rough ground size of a box, for the readout. */
function boxKm(b: Box): { w: number; h: number } {
    const midLat = (b.south + b.north) / 2;
    return {
        w: (b.east - b.west) * 111.32 * Math.cos(midLat * Math.PI / 180),
        h: (b.north - b.south) * 110.57,
    };
}

/** How many z12 terrain tiles the bake will touch — the cost that matters. */
function bakeTiles(b: Box): number {
    const span = 180 / (1 << BAKE_ZOOM);
    const nx = Math.ceil((b.east + 180) / span) - Math.floor((b.west + 180) / span);
    const ny = Math.ceil((90 - b.south) / span) - Math.floor((90 - b.north) / span);
    return Math.max(1, nx) * Math.max(1, ny);
}

// --- the picker ------------------------------------------------------------

export class AreaPicker {
    private readonly root: HTMLElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly nameInput: HTMLInputElement;
    private readonly coverInput: HTMLInputElement;
    private readonly importButton: HTMLButtonElement;
    private readonly readout: HTMLElement;
    private readonly logEl: HTMLElement;
    private readonly areaList: HTMLElement;
    private readonly progress: HTMLElement;
    private readonly progressLabel: HTMLElement;
    private readonly progressFill: HTMLElement;
    /** True when the last log line was a progress redraw, so the next replaces it. */
    private lastLineWasProgress = false;

    centreLon = 0;
    centreLat = 30;
    zoom = 3;

    private readonly images = new Map<string, HTMLImageElement | 'pending' | 'failed'>();
    private selection: Box | undefined;
    private areas: Area[] = [];
    private dragging: { mode: 'pan' | 'box'; x: number; y: number } | undefined;
    private dragTo: { x: number; y: number } | undefined;
    private running = false;
    private stream: EventSource | undefined;

    constructor() {
        const template = document.createElement('template');
        template.innerHTML = MARKUP.trim();
        this.root = template.content.firstElementChild as HTMLElement;
        const get = (id: string) => mustGet(this.root, id);

        this.canvas = get('area-map') as HTMLCanvasElement;
        this.nameInput = get('area-name') as HTMLInputElement;
        this.coverInput = get('area-cover') as HTMLInputElement;
        this.importButton = get('area-import') as HTMLButtonElement;
        this.readout = get('area-readout');
        this.logEl = get('area-log');
        this.areaList = get('area-existing');
        this.progress = get('area-progress');
        this.progressLabel = get('area-progress-label');
        this.progressFill = get('area-progress-fill');
        const ctx = this.canvas.getContext('2d');
        if (!ctx) {
            throw new Error('area picker needs a 2d canvas');
        }
        this.ctx = ctx;
        // Dev aid, alongside globalThis.__terrain.
        (globalThis as Record<string, unknown>).__areaPicker = this;

        this.canvas.addEventListener('pointerdown', e => this.onDown(e));
        this.canvas.addEventListener('pointermove', e => this.onMove(e));
        window.addEventListener('pointerup', () => this.onUp());
        this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());

        this.importButton.addEventListener('click', () => void this.startImport());
        this.nameInput.addEventListener('input', () => this.syncButton());

        // The tab lays the canvas out after it is attached, and the dialog can
        // be resized with the window, so size follows the element, not mount().
        new ResizeObserver(() => {
            if (this.root.isConnected) {
                this.resize();
                this.draw();
            }
        }).observe(this.canvas);
    }

    /** Shows the picker inside `host` — the settings dialog's World tab. */
    async mount(host: HTMLElement): Promise<void> {
        host.appendChild(this.root);
        this.resize();
        await this.loadAreas();
        this.syncButton();
        this.draw();
    }

    /**
     * Takes the picker off the page. A running bake is a server-side job and
     * is not affected, and the progress stream stays open, so the log is
     * still up to date when the tab is opened again.
     */
    unmount(): void {
        this.root.remove();
    }

    private resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
        this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    private async loadAreas(): Promise<void> {
        try {
            const res = await fetch('/api/areas');
            const body = await res.json();
            this.areas = Array.isArray(body.areas) ? body.areas : [];
        } catch {
            this.areas = [];
        }
        this.renderAreas();
    }

    private renderAreas(): void {
        this.areaList.textContent = '';
        if (this.areas.length === 0) {
            this.areaList.textContent = 'Nothing baked yet.';
            return;
        }
        this.areaList.append('Already baked: ');
        this.areas.forEach((area, i) => {
            if (i > 0) {
                this.areaList.append(', ');
            }
            this.areaList.append(area.name);
            if (this.areas.length <= 1) {
                return;
            }
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'area-delete';
            del.textContent = '×';
            del.title = `Delete "${area.name}" and its baked terrain`;
            del.disabled = this.running;
            del.addEventListener('click', () => void this.deleteArea(area.name));
            this.areaList.append(del);
        });
    }

    // --- view maths --------------------------------------------------------

    private viewSize(): { w: number; h: number } {
        const dpr = window.devicePixelRatio || 1;
        return { w: this.canvas.width / dpr, h: this.canvas.height / dpr };
    }

    /** World-pixel coordinate of the view's top-left corner. */
    private origin(): { x: number; y: number } {
        const { w, h } = this.viewSize();
        return {
            x: lonToWorld(this.centreLon, this.zoom) - w / 2,
            y: latToWorld(this.centreLat, this.zoom) - h / 2,
        };
    }

    private screenToLonLat(sx: number, sy: number): { lon: number; lat: number } {
        const o = this.origin();
        return {
            lon: worldToLon(o.x + sx, this.zoom),
            lat: worldToLat(o.y + sy, this.zoom),
        };
    }

    private lonLatToScreen(lon: number, lat: number): { x: number; y: number } {
        const o = this.origin();
        return { x: lonToWorld(lon, this.zoom) - o.x, y: latToWorld(lat, this.zoom) - o.y };
    }

    private pointer(e: PointerEvent | WheelEvent): { x: number; y: number } {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    // --- input -------------------------------------------------------------

    private onDown(e: PointerEvent): void {
        const p = this.pointer(e);
        // Drag pans, shift-drag draws the box — the same split every slippy map
        // uses, so it needs no explaining in the UI.
        this.dragging = { mode: e.shiftKey ? 'box' : 'pan', x: p.x, y: p.y };
        this.dragTo = p;
        try {
            // Keeps a drag alive when the pointer leaves the canvas. Throws for
            // a pointer id that is not actually down, which synthetic events hit.
            this.canvas.setPointerCapture(e.pointerId);
        } catch {
            // Falls back to plain move events over the canvas.
        }
    }

    private onMove(e: PointerEvent): void {
        if (!this.dragging) {
            return;
        }
        const p = this.pointer(e);
        if (this.dragging.mode === 'pan') {
            const o = this.origin();
            const dx = p.x - this.dragging.x;
            const dy = p.y - this.dragging.y;
            const { w, h } = this.viewSize();
            this.centreLon = worldToLon(o.x - dx + w / 2, this.zoom);
            this.centreLat = worldToLat(o.y - dy + h / 2, this.zoom);
            this.dragging.x = p.x;
            this.dragging.y = p.y;
        } else {
            this.dragTo = p;
            this.setSelectionFromDrag();
        }
        this.draw();
    }

    private onUp(): void {
        if (this.dragging?.mode === 'box') {
            this.setSelectionFromDrag();
        }
        this.dragging = undefined;
        this.draw();
    }

    private setSelectionFromDrag(): void {
        if (!this.dragging || !this.dragTo) {
            return;
        }
        const a = this.screenToLonLat(this.dragging.x, this.dragging.y);
        const b = this.screenToLonLat(this.dragTo.x, this.dragTo.y);
        const box = {
            west: Math.min(a.lon, b.lon), east: Math.max(a.lon, b.lon),
            south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
        };
        this.selection = (box.east - box.west) > 1e-6 && (box.north - box.south) > 1e-6
            ? box : undefined;
        this.syncButton();
    }

    private onWheel(e: WheelEvent): void {
        e.preventDefault();
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + (e.deltaY < 0 ? 1 : -1)));
        if (next === this.zoom) {
            return;
        }
        // Zoom about the cursor rather than the centre, so the thing under the
        // pointer stays under the pointer.
        const p = this.pointer(e);
        const before = this.screenToLonLat(p.x, p.y);
        this.zoom = next;
        const after = this.screenToLonLat(p.x, p.y);
        this.centreLon += before.lon - after.lon;
        this.centreLat += before.lat - after.lat;
        this.draw();
    }

    // --- drawing -----------------------------------------------------------

    private tile(z: number, x: number, y: number): HTMLImageElement | undefined {
        const key = `${z}/${x}/${y}`;
        const have = this.images.get(key);
        if (have === 'pending' || have === 'failed') {
            return undefined;
        }
        if (have) {
            return have;
        }
        this.images.set(key, 'pending');
        const img = new Image();
        img.onload = () => { this.images.set(key, img); this.draw(); };
        img.onerror = () => { this.images.set(key, 'failed'); };
        img.src = `/api/osm/${z}/${x}/${y}`;
        return undefined;
    }

    private draw(): void {
        const { w, h } = this.viewSize();
        const ctx = this.ctx;
        ctx.fillStyle = '#0d1a26';
        ctx.fillRect(0, 0, w, h);

        const o = this.origin();
        const span = 1 << this.zoom;
        const x0 = Math.floor(o.x / TILE_PX);
        const y0 = Math.floor(o.y / TILE_PX);
        const x1 = Math.floor((o.x + w) / TILE_PX);
        const y1 = Math.floor((o.y + h) / TILE_PX);
        for (let ty = y0; ty <= y1; ty++) {
            if (ty < 0 || ty >= span) {
                continue;
            }
            for (let tx = x0; tx <= x1; tx++) {
                const wrapped = ((tx % span) + span) % span;
                const img = this.tile(this.zoom, wrapped, ty);
                if (img) {
                    ctx.drawImage(img, tx * TILE_PX - o.x, ty * TILE_PX - o.y, TILE_PX, TILE_PX);
                }
            }
        }

        for (const area of this.areas) {
            this.strokeBox(area, 'rgba(120, 200, 255, 0.9)', 'rgba(120, 200, 255, 0.15)', area.name);
        }
        if (this.selection) {
            const tooBig = Math.max(
                this.selection.east - this.selection.west,
                this.selection.north - this.selection.south,
            ) > MAX_SPAN_DEG;
            this.strokeBox(
                this.selection,
                tooBig ? 'rgba(255, 110, 90, 0.95)' : 'rgba(255, 210, 90, 0.95)',
                tooBig ? 'rgba(255, 110, 90, 0.18)' : 'rgba(255, 210, 90, 0.18)',
            );
        }
        this.updateReadout();
    }

    private strokeBox(b: Box, stroke: string, fill: string, label?: string): void {
        const a = this.lonLatToScreen(b.west, b.north);
        const c = this.lonLatToScreen(b.east, b.south);
        const ctx = this.ctx;
        ctx.fillStyle = fill;
        ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
        if (label) {
            ctx.fillStyle = stroke;
            ctx.font = '11px monospace';
            ctx.fillText(label, a.x + 4, a.y + 13);
        }
    }

    /**
     * Why Import is unavailable, or undefined when it is ready.
     *
     * A greyed-out button with no reason is a guessing game, and two of these
     * are easy to hit without realising: the name field shows a placeholder
     * that reads like a value, and a box is only drawn while Shift is held.
     */
    private blockedBecause(): string | undefined {
        if (this.running) {
            return 'import running';
        }
        if (!this.selection) {
            return 'shift-drag on the map to choose an area';
        }
        const span = Math.max(
            this.selection.east - this.selection.west,
            this.selection.north - this.selection.south,
        );
        if (span > MAX_SPAN_DEG) {
            return `too big — ${span.toFixed(2)}° exceeds the ${MAX_SPAN_DEG}° limit`;
        }
        if (this.nameInput.value.trim().length === 0) {
            return 'type a name for the area';
        }
        return undefined;
    }

    private updateReadout(): void {
        const blocked = this.blockedBecause();
        if (!this.selection) {
            this.readout.textContent =
                'Shift-drag on the map to choose an area. Drag to pan, wheel to zoom.';
            return;
        }
        const b = this.selection;
        const km = boxKm(b);
        const where = `${b.west.toFixed(4)},${b.south.toFixed(4)} .. `
            + `${b.east.toFixed(4)},${b.north.toFixed(4)}`;
        const size = `${km.w.toFixed(0)} x ${km.h.toFixed(0)} km, ~${bakeTiles(b)} terrain tiles`;
        this.readout.textContent = `${where}  —  ${size}`
            + (blocked ? `  —  ${blocked}` : '  —  ready to import');
    }

    private syncButton(): void {
        const blocked = this.blockedBecause();
        this.importButton.disabled = blocked !== undefined;
        this.importButton.title = blocked ?? 'Bake this area into the terrain';
        for (const b of this.areaList.querySelectorAll('button')) {
            b.disabled = this.running;
        }
        this.updateReadout();
    }

    // --- running the bake --------------------------------------------------

    private async startImport(): Promise<void> {
        if (!this.selection || this.running) {
            return;
        }
        const b = this.selection;
        this.running = true;
        this.syncButton();
        this.logEl.textContent = '';
        this.lastLineWasProgress = false;

        let id: string;
        try {
            const res = await fetch('/api/import-area', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: this.nameInput.value.trim(),
                    bbox: [b.west, b.south, b.east, b.north],
                    withCover: this.coverInput.checked,
                }),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) {
                throw new Error(body.error ?? `server said ${res.status}`);
            }
            id = body.id;
        } catch (err) {
            this.append(`could not start: ${(err as Error).message}`);
            this.running = false;
            this.syncButton();
            return;
        }

        this.follow(id, 'Reload the page and pick it under Settings -> World -> Area.');
    }

    private async deleteArea(name: string): Promise<void> {
        if (this.running) {
            return;
        }
        const sure = window.confirm(
            `Delete the area "${name}"?\n\nIts terrain is removed from the baked `
            + 'pyramids and the coarse tiles around it are rebaked. Getting it '
            + 'back means importing it again.');
        if (!sure) {
            return;
        }
        this.running = true;
        this.syncButton();
        this.logEl.textContent = '';
        this.lastLineWasProgress = false;

        let id: string;
        try {
            const res = await fetch('/api/delete-area', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) {
                throw new Error(body.error ?? `server said ${res.status}`);
            }
            id = body.id;
        } catch (err) {
            this.append(`could not start: ${(err as Error).message}`);
            this.running = false;
            this.syncButton();
            return;
        }

        this.follow(id, 'Reload the page; the area is gone.');
    }

    private follow(id: string, doneNote: string): void {
        this.progress.classList.remove('hidden');
        this.progress.classList.remove('failed');
        this.setProgress(0, 1, 0, 'starting');

        this.stream = new EventSource(`/api/import-area/${id}`);
        this.stream.onmessage = ev => {
            const data = JSON.parse(ev.data) as {
                line?: string; step?: string; state?: string; replace?: boolean;
                stepIndex?: number; stepCount?: number; percent?: number; overall?: number;
            };
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
                this.running = false;
                this.syncButton();
                this.stream?.close();
                this.stream = undefined;
                this.progress.classList.toggle('failed', data.state === 'failed');
                if (data.state === 'done') {
                    const n = data.stepCount ?? 0;
                    this.setProgress(100, n, n, 'done', 100);
                    void this.loadAreas().then(() => this.draw());
                    this.append(`\n${doneNote}`);
                }
            }
        };
        this.stream.onerror = () => {
            // The server ends the stream when the job finishes, which surfaces
            // here as an error; only report it if the job never reported back.
            if (this.running) {
                this.append('lost the progress stream — the bake may still be running');
                this.running = false;
                this.syncButton();
            }
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
        this.progressFill.style.width = `${Math.max(0, Math.min(100, overall))}%`;
        const within = percent !== undefined && percent > 0 && percent < 100
            ? `  ·  ${percent}% of this step` : '';
        this.progressLabel.textContent = steps > 0
            ? `${overall}%  ·  step ${Math.min(step, steps)}/${steps}  ·  ${label}${within}`
            : label;
    }

    private append(text: string, replace = false): void {
        // A progress redraw supersedes the previous one instead of stacking:
        // the mesh bake emits one every hundred tiles and would otherwise bury
        // everything else in the log.
        if (replace && this.lastLineWasProgress) {
            const lines = (this.logEl.textContent ?? '').split('\n');
            lines[Math.max(0, lines.length - 2)] = text;
            this.logEl.textContent = lines.join('\n');
        } else {
            this.logEl.textContent += `${text}\n`;
        }
        this.lastLineWasProgress = replace;
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }
}

function mustGet(root: HTMLElement, id: string): HTMLElement {
    const el = root.id === id ? root : root.querySelector<HTMLElement>(`#${id}`);
    if (!el) {
        throw new Error(`missing element #${id}`);
    }
    return el;
}
