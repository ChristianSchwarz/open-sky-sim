/**
 * A stand-in CanvasRenderingContext2D for golden suites over the 2D layer
 * (canvasPainter.ts, text.ts). It does two things with every call:
 *
 *  1. records it verbatim, in order: method calls as [name, ...args],
 *     property assignments as ["set", prop, value], images by label
 *     ("atlas:HUD_SMALL", "tint:HUD_SMALL:#ff0000", "img0", ...);
 *  2. interprets it the way a browser would, into the flat command list a GPU
 *     frontend draws (Retro.Game.CanvasCommand on the C# side): the state
 *     machine (fillStyle/strokeStyle/lineWidth/..., save/restore stack,
 *     transform, clip depth) and the current path.
 *
 * The interpretation follows the HTML canvas spec, not a browser's source:
 * invalid colour strings and non-positive line widths are ignored, path
 * points are transformed when they are added, rect/arc start new subpaths,
 * arc joins the current point with a straight segment, clip() intersects and
 * is undone by the restore() that pops past it, fillRect/strokeRect/clearRect
 * leave the current path alone.
 *
 * Commands are flat arrays (see the C# CanvasCommandFormat):
 *   ["clearRect", x, y, w, h, ...m]
 *   ["fillRect", color, x, y, w, h, ...m]
 *   ["strokeRect", color, lineWidth, x, y, w, h, ...m]
 *   ["strokePath", color, lineWidth, ...m, n, ...shapes]
 *   ["fillPath", color, ...m, n, ...shapes]
 *   ["glyph", fontId, tint|null, sx, sy, sw, sh, dx, dy, dw, dh, smooth, ...m]
 *   ["image", label, dx, dy, dw, dh, smooth, ...m]
 *   ["clipPush", n, ...shapes]
 *   ["clipPop"]
 * where m = a, b, c, d, e, f (device = (a x + c y + e, b x + d y + f)) and a
 * shape is "seg", x0, y0, x1, y1 (device) | "rect", x, y, w, h, ...m (user,
 * with the matrix current when it was added) | "arc", x, y, r, start, end,
 * ccw, ...m (user, likewise).
 */

export type Call = (string | number | boolean | null)[];
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** The colour syntaxes the overlay uses; anything else is rejected like an invalid CSS colour. */
export function isCssColor(s: string): boolean {
    const t = s.trim().toLowerCase();
    if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(t)) return true;
    if (/^rgba?\(\s*[-+0-9.]+%?\s*,\s*[-+0-9.]+%?\s*,\s*[-+0-9.]+%?\s*(,\s*[-+0-9.]+%?\s*)?\)$/.test(t)) return true;
    return ['transparent', 'black', 'white', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'gray', 'grey'].includes(t);
}

interface State {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    lineCap: string;
    imageSmoothingEnabled: boolean;
    globalCompositeOperation: string;
    m: Matrix;
    clipDepth: number;
}

/** What drawImage was given: an atlas (tinted or not) or an opaque image. */
export interface MockImageInfo {
    label: string;
    fontId?: string;
    tint?: string | null;
    width: number;
    height: number;
}

export const IMAGE_INFO = Symbol('mockImageInfo');

export function imageInfo(img: unknown): MockImageInfo | undefined {
    return img && typeof img === 'object' ? (img as Record<symbol, MockImageInfo>)[IMAGE_INFO] : undefined;
}

export class MockContext2D {
    readonly calls: Call[] = [];
    readonly commands: Call[] = [];
    readonly canvas: { width: number; height: number };

    private s: State = {
        fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt',
        imageSmoothingEnabled: true, globalCompositeOperation: 'source-over', m: [...IDENTITY], clipDepth: 0,
    };
    private stack: State[] = [];
    private shapes: Call[] = [];
    private shapeCount = 0;
    /** Current point in device space, or null when there is no subpath. */
    private current: [number, number] | null = null;
    private readonly otherImages = new Map<unknown, string>();

    constructor(width: number, height: number, private readonly onDraw?: (ctx: MockContext2D, call: Call) => void) {
        this.canvas = { width, height };
    }

    // ---- properties ----

    private set(prop: string, value: string | number | boolean): void {
        this.calls.push(['set', prop, value]);
        this.onDraw?.(this, ['set', prop, value]);
    }

    get fillStyle(): string { return this.s.fillStyle; }
    set fillStyle(v: string) {
        this.set('fillStyle', v);
        if (isCssColor(v)) this.s.fillStyle = v;
    }

    get strokeStyle(): string { return this.s.strokeStyle; }
    set strokeStyle(v: string) {
        this.set('strokeStyle', v);
        if (isCssColor(v)) this.s.strokeStyle = v;
    }

    get lineWidth(): number { return this.s.lineWidth; }
    set lineWidth(v: number) {
        this.set('lineWidth', v);
        if (Number.isFinite(v) && v > 0) this.s.lineWidth = v;
    }

    get lineCap(): string { return this.s.lineCap; }
    set lineCap(v: string) {
        this.set('lineCap', v);
        if (v === 'butt' || v === 'round' || v === 'square') this.s.lineCap = v;
    }

    get imageSmoothingEnabled(): boolean { return this.s.imageSmoothingEnabled; }
    set imageSmoothingEnabled(v: boolean) {
        this.set('imageSmoothingEnabled', v);
        this.s.imageSmoothingEnabled = !!v;
    }

    get globalCompositeOperation(): string { return this.s.globalCompositeOperation; }
    set globalCompositeOperation(v: string) {
        this.set('globalCompositeOperation', v);
        this.s.globalCompositeOperation = v;
    }

    // ---- helpers ----

    private rec(...call: Call): void {
        this.calls.push(call);
        this.onDraw?.(this, call);
    }

    private emit(...cmd: Call): void {
        this.commands.push(cmd);
    }

    private dev(x: number, y: number): [number, number] {
        const m = this.s.m;
        return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    private addShape(...shape: Call): void {
        this.shapes.push(...shape);
        this.shapeCount++;
    }

    private pathCall(): Call {
        return [this.shapeCount, ...this.shapes];
    }

    labelOf(img: unknown): string {
        const info = imageInfo(img);
        if (info) return info.label;
        let id = this.otherImages.get(img);
        if (id === undefined) {
            id = `img${this.otherImages.size}`;
            this.otherImages.set(img, id);
        }
        return id;
    }

    // ---- state ----

    save(): void {
        this.rec('save');
        this.stack.push({ ...this.s, m: [...this.s.m] as Matrix });
    }

    restore(): void {
        this.rec('restore');
        const popped = this.stack.pop();
        if (!popped) return;
        for (let i = popped.clipDepth; i < this.s.clipDepth; i++) this.emit('clipPop');
        this.s = popped;
    }

    translate(x: number, y: number): void {
        this.rec('translate', x, y);
        const m = this.s.m;
        this.s.m = [m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y, m[5] + m[1] * x + m[3] * y];
    }

    rotate(t: number): void {
        this.rec('rotate', t);
        const c = Math.cos(t), s = Math.sin(t);
        const m = this.s.m;
        this.s.m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, m[2] * c - m[0] * s, m[3] * c - m[1] * s, m[4], m[5]];
    }

    scale(sx: number, sy: number): void {
        this.rec('scale', sx, sy);
        const m = this.s.m;
        this.s.m = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]];
    }

    // ---- path ----

    beginPath(): void {
        this.rec('beginPath');
        this.shapes = [];
        this.shapeCount = 0;
        this.current = null;
    }

    moveTo(x: number, y: number): void {
        this.rec('moveTo', x, y);
        this.current = this.dev(x, y);
    }

    lineTo(x: number, y: number): void {
        this.rec('lineTo', x, y);
        const p = this.dev(x, y);
        if (this.current) {
            this.addShape('seg', this.current[0], this.current[1], p[0], p[1]);
        }
        this.current = p;
    }

    rect(x: number, y: number, w: number, h: number): void {
        this.rec('rect', x, y, w, h);
        this.addShape('rect', x, y, w, h, ...this.s.m);
        this.current = this.dev(x, y);
    }

    arc(x: number, y: number, r: number, start: number, end: number, ccw = false): void {
        this.rec('arc', x, y, r, start, end, ccw);
        const p0 = this.dev(x + r * Math.cos(start), y + r * Math.sin(start));
        if (this.current) {
            this.addShape('seg', this.current[0], this.current[1], p0[0], p0[1]);
        }
        this.addShape('arc', x, y, r, start, end, ccw, ...this.s.m);
        this.current = this.dev(x + r * Math.cos(end), y + r * Math.sin(end));
    }

    stroke(): void {
        this.rec('stroke');
        if (this.shapeCount > 0) {
            this.emit('strokePath', this.s.strokeStyle, this.s.lineWidth, ...this.s.m, ...this.pathCall());
        }
    }

    fill(): void {
        this.rec('fill');
        if (this.shapeCount > 0) {
            this.emit('fillPath', this.s.fillStyle, ...this.s.m, ...this.pathCall());
        }
    }

    clip(): void {
        this.rec('clip');
        this.emit('clipPush', ...this.pathCall());
        this.s.clipDepth++;
    }

    // ---- immediate ----

    clearRect(x: number, y: number, w: number, h: number): void {
        this.rec('clearRect', x, y, w, h);
        this.emit('clearRect', x, y, w, h, ...this.s.m);
    }

    fillRect(x: number, y: number, w: number, h: number): void {
        this.rec('fillRect', x, y, w, h);
        this.emit('fillRect', this.s.fillStyle, x, y, w, h, ...this.s.m);
    }

    strokeRect(x: number, y: number, w: number, h: number): void {
        this.rec('strokeRect', x, y, w, h);
        this.emit('strokeRect', this.s.strokeStyle, this.s.lineWidth, x, y, w, h, ...this.s.m);
    }

    drawImage(img: unknown, ...a: number[]): void {
        const label = this.labelOf(img);
        this.rec('drawImage', label, ...a);
        const info = imageInfo(img);
        let sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number;
        if (a.length === 8) {
            [sx, sy, sw, sh, dx, dy, dw, dh] = a;
        } else {
            const iw = info?.width ?? 0;
            const ih = info?.height ?? 0;
            [sx, sy, sw, sh] = [0, 0, iw, ih];
            [dx, dy] = a;
            [dw, dh] = a.length === 4 ? [a[2], a[3]] : [iw, ih];
        }
        if (info?.fontId) {
            this.emit('glyph', info.fontId, info.tint ?? null, sx, sy, sw, sh, dx, dy, dw, dh, this.s.imageSmoothingEnabled, ...this.s.m);
        } else {
            this.emit('image', label, dx, dy, dw, dh, this.s.imageSmoothingEnabled, ...this.s.m);
        }
    }
}
