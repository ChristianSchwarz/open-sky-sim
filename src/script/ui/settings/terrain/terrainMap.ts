import {
    AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, effect, inject, viewChild,
} from '@angular/core';
import { AreaImportService } from './areaImportService';
import {
    Box, MAX_SPAN_DEG, MAX_ZOOM, MIN_ZOOM, TILE_PX, boxSpanDeg, latToWorld, lonToWorld, worldToLat, worldToLon,
} from './importMath';

/** OSM tiles, kept for the session so reopening the dialog does not refetch them. */
const tiles = new Map<string, HTMLImageElement | 'pending' | 'failed'>();

/**
 * The importer's slippy map: drag pans, wheel zooms, shift-drag draws the box.
 *
 * Drawn on a canvas rather than pulled in as a mapping library. All it has to
 * do is show where you are and let you drag a rectangle, which is a little Web
 * Mercator and a canvas; a library would be a bigger dependency than the
 * feature, and Material has no map component.
 */
@Component({
    selector: 'rfs-terrain-map',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        class: 'block',
        '(window:pointerup)': 'onUp()',
    },
    template: `
<canvas #canvas
    class="block box-border h-[clamp(180px,34vh,280px)] w-full cursor-grab touch-none rounded border border-white/20 bg-[#0d1a26] active:cursor-grabbing"
    (pointerdown)="onDown($event)" (pointermove)="onMove($event)"
    (wheel)="onWheel($event)" (contextmenu)="$event.preventDefault()"></canvas>
`,
})
export class TerrainMap implements AfterViewInit, OnDestroy {
    private readonly service = inject(AreaImportService);
    private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
    private ctx: CanvasRenderingContext2D | undefined;
    private observer: ResizeObserver | undefined;
    private dragging: { mode: 'pan' | 'box'; x: number; y: number } | undefined;
    private dragTo: { x: number; y: number } | undefined;

    constructor() {
        effect(() => {
            this.service.areas();
            this.service.selection();
            this.draw();
        });
    }

    ngAfterViewInit(): void {
        const canvas = this.canvasRef().nativeElement;
        this.ctx = canvas.getContext('2d') ?? undefined;
        // The dialog can be resized with the window, so size follows the element.
        this.observer = new ResizeObserver(() => {
            this.resize();
            this.draw();
        });
        this.observer.observe(canvas);
        this.resize();
        this.draw();
    }

    ngOnDestroy(): void {
        this.observer?.disconnect();
    }

    private get canvas(): HTMLCanvasElement {
        return this.canvasRef().nativeElement;
    }

    /**
     * Sizes the drawing buffer from the canvas's layout size, not its
     * on-screen rectangle. The dialog opens with a scale animation, and a
     * rectangle measured mid-animation is the scaled-down one: the map was
     * then drawn small and stretched to fit. Transforms do not trigger the
     * ResizeObserver either, so nothing would ever correct it.
     */
    private resize(): void {
        if (!this.ctx) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
        this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // --- view maths --------------------------------------------------------

    private viewSize(): { w: number; h: number } {
        const dpr = window.devicePixelRatio || 1;
        return { w: this.canvas.width / dpr, h: this.canvas.height / dpr };
    }

    /** World-pixel coordinate of the view's top-left corner. */
    private origin(): { x: number; y: number } {
        const { w, h } = this.viewSize();
        const view = this.service.view;
        return {
            x: lonToWorld(view.centreLon, view.zoom) - w / 2,
            y: latToWorld(view.centreLat, view.zoom) - h / 2,
        };
    }

    private screenToLonLat(sx: number, sy: number): { lon: number; lat: number } {
        const o = this.origin();
        const z = this.service.view.zoom;
        return { lon: worldToLon(o.x + sx, z), lat: worldToLat(o.y + sy, z) };
    }

    private lonLatToScreen(lon: number, lat: number): { x: number; y: number } {
        const o = this.origin();
        const z = this.service.view.zoom;
        return { x: lonToWorld(lon, z) - o.x, y: latToWorld(lat, z) - o.y };
    }

    /** Pointer position in drawing coordinates: inside the border, in layout pixels. */
    private pointer(e: PointerEvent | WheelEvent): { x: number; y: number } {
        const r = this.canvas.getBoundingClientRect();
        const scale = r.width > 0 ? this.canvas.offsetWidth / r.width : 1;
        return {
            x: (e.clientX - r.left) * scale - this.canvas.clientLeft,
            y: (e.clientY - r.top) * scale - this.canvas.clientTop,
        };
    }

    // --- input -------------------------------------------------------------

    onDown(e: PointerEvent): void {
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

    onMove(e: PointerEvent): void {
        if (!this.dragging) {
            return;
        }
        const p = this.pointer(e);
        if (this.dragging.mode === 'pan') {
            const o = this.origin();
            const { w, h } = this.viewSize();
            const view = this.service.view;
            view.centreLon = worldToLon(o.x - (p.x - this.dragging.x) + w / 2, view.zoom);
            view.centreLat = worldToLat(o.y - (p.y - this.dragging.y) + h / 2, view.zoom);
            this.dragging.x = p.x;
            this.dragging.y = p.y;
            this.draw();
        } else {
            this.dragTo = p;
            this.setSelectionFromDrag();
        }
    }

    onUp(): void {
        if (!this.dragging) {
            return;
        }
        if (this.dragging.mode === 'box') {
            this.setSelectionFromDrag();
        }
        this.dragging = undefined;
        this.draw();
    }

    onWheel(e: WheelEvent): void {
        e.preventDefault();
        const view = this.service.view;
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom + (e.deltaY < 0 ? 1 : -1)));
        if (next === view.zoom) {
            return;
        }
        // Zoom about the cursor rather than the centre, so the thing under the
        // pointer stays under the pointer.
        const p = this.pointer(e);
        const before = this.screenToLonLat(p.x, p.y);
        view.zoom = next;
        const after = this.screenToLonLat(p.x, p.y);
        view.centreLon += before.lon - after.lon;
        view.centreLat += before.lat - after.lat;
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
        this.service.selection.set(
            (box.east - box.west) > 1e-6 && (box.north - box.south) > 1e-6 ? box : undefined);
    }

    // --- drawing -----------------------------------------------------------

    private tile(z: number, x: number, y: number): HTMLImageElement | undefined {
        const key = `${z}/${x}/${y}`;
        const have = tiles.get(key);
        if (have === 'pending' || have === 'failed') {
            return undefined;
        }
        if (have) {
            return have;
        }
        tiles.set(key, 'pending');
        const img = new Image();
        img.onload = () => { tiles.set(key, img); this.draw(); };
        img.onerror = () => { tiles.set(key, 'failed'); };
        img.src = `/api/osm/${z}/${x}/${y}`;
        return undefined;
    }

    private draw(): void {
        const ctx = this.ctx;
        if (!ctx || !this.canvas.isConnected) {
            return;
        }
        const { w, h } = this.viewSize();
        ctx.fillStyle = '#0d1a26';
        ctx.fillRect(0, 0, w, h);

        const o = this.origin();
        const z = this.service.view.zoom;
        const span = 1 << z;
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
                const img = this.tile(z, wrapped, ty);
                if (img) {
                    ctx.drawImage(img, tx * TILE_PX - o.x, ty * TILE_PX - o.y, TILE_PX, TILE_PX);
                }
            }
        }

        for (const area of this.service.areas()) {
            this.strokeBox(ctx, area, 'rgba(120, 200, 255, 0.9)', 'rgba(120, 200, 255, 0.15)', area.name);
        }
        const selection = this.service.selection();
        if (selection) {
            const tooBig = boxSpanDeg(selection) > MAX_SPAN_DEG;
            this.strokeBox(
                ctx,
                selection,
                tooBig ? 'rgba(255, 110, 90, 0.95)' : 'rgba(255, 210, 90, 0.95)',
                tooBig ? 'rgba(255, 110, 90, 0.18)' : 'rgba(255, 210, 90, 0.18)',
            );
        }
    }

    private strokeBox(ctx: CanvasRenderingContext2D, b: Box, stroke: string, fill: string, label?: string): void {
        const a = this.lonLatToScreen(b.west, b.north);
        const c = this.lonLatToScreen(b.east, b.south);
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
}
