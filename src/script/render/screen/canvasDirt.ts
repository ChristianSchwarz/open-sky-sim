/**
 * Where a 2D canvas was drawn on this frame, by tile, so the texture it feeds
 * can be refreshed in parts.
 *
 * The overlay canvas is the size of the screen and was uploaded whole every
 * frame: on an ultrawide that is 16 MB a frame, about 1.8 ms of an integrated
 * GPU, for a HUD that covers a few percent of it. The canvas is cleared and
 * repainted every frame, so a tile has to be refreshed when it is drawn on now
 * (new content) or was drawn on last frame (content to erase).
 */

/** Tile edge in canvas pixels. */
const TILE = 32;
/** Past this share of the canvas, one whole upload beats the pieces. */
const WHOLE_SHARE = 0.5;
/** Past this many rectangles, their bounding box goes up instead. */
const MAX_RECTS = 32;

export interface DirtRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export class CanvasDirt {
    private cols = 0;
    private rows = 0;
    private current = new Uint8Array(0);
    private previous = new Uint8Array(0);
    /** Set by anything the tracker cannot bound: the next take() asks for a whole upload. */
    private everything = true;

    constructor(private width: number, private height: number) {
        this.resize(width, height);
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        this.cols = Math.ceil(width / TILE);
        this.rows = Math.ceil(height / TILE);
        this.current = new Uint8Array(this.cols * this.rows);
        this.previous = new Uint8Array(this.cols * this.rows);
        this.everything = true;
    }

    /** A box in canvas pixels was drawn on. */
    mark(x0: number, y0: number, x1: number, y1: number): void {
        if (!(x1 > 0 && y1 > 0 && x0 < this.width && y0 < this.height)) {
            // Off the canvas, or NaN from a degenerate transform.
            if (Number.isNaN(x0 + y0 + x1 + y1)) {
                this.everything = true;
            }
            return;
        }
        const c0 = Math.max(0, Math.floor(x0 / TILE));
        const c1 = Math.min(this.cols - 1, Math.floor(x1 / TILE));
        const r0 = Math.max(0, Math.floor(y0 / TILE));
        const r1 = Math.min(this.rows - 1, Math.floor(y1 / TILE));
        for (let r = r0; r <= r1; r++) {
            this.current.fill(1, r * this.cols + c0, r * this.cols + c1 + 1);
        }
    }

    /** Something was drawn whose extent is unknown. */
    markEverything(): void {
        this.everything = true;
    }

    /**
     * The rectangles to refresh for the frame just painted, or undefined for
     * the whole canvas; starts the next frame.
     */
    take(): DirtRect[] | undefined {
        const { cols, rows } = this;
        const both = this.previous;
        let tiles = 0;
        for (let i = 0; i < both.length; i++) {
            both[i] |= this.current[i];
            tiles += both[i];
        }
        let rects: DirtRect[] | undefined;
        if (!this.everything && tiles * TILE * TILE < WHOLE_SHARE * this.width * this.height) {
            // Runs along each tile row, and a run carried down while the rows
            // below repeat it exactly.
            rects = [];
            let open = new Map<number, DirtRect>();
            for (let r = 0; r < rows; r++) {
                const next = new Map<number, DirtRect>();
                for (let c = 0; c < cols;) {
                    if (!both[r * cols + c]) {
                        c++;
                        continue;
                    }
                    let end = c;
                    while (end + 1 < cols && both[r * cols + end + 1]) {
                        end++;
                    }
                    const key = c * 65536 + end;
                    const above = open.get(key);
                    if (above) {
                        above.height += TILE;
                        next.set(key, above);
                    } else {
                        const rect = { x: c * TILE, y: r * TILE, width: (end - c + 1) * TILE, height: TILE };
                        rects.push(rect);
                        next.set(key, rect);
                    }
                    c = end + 1;
                }
                open = next;
            }
            for (const rect of rects) {
                rect.width = Math.min(rect.width, this.width - rect.x);
                rect.height = Math.min(rect.height, this.height - rect.y);
            }
            if (rects.length > MAX_RECTS) {
                let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
                for (const rect of rects) {
                    x0 = Math.min(x0, rect.x);
                    y0 = Math.min(y0, rect.y);
                    x1 = Math.max(x1, rect.x + rect.width);
                    y1 = Math.max(y1, rect.y + rect.height);
                }
                rects = [{ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }];
            }
        }
        // This frame's tiles become the ones to erase next frame.
        this.previous = this.current;
        this.current = both.fill(0);
        this.everything = false;
        return rects;
    }
}

type Matrix = [number, number, number, number, number, number];

/**
 * Wraps a 2D context's drawing calls, on that one instance, to report what
 * they touch to `dirt`, in device pixels through the current transform.
 * Bounds are conservative: a stroke's box is padded by its width, an arc by
 * its whole circle. A full-canvas clearRect is not drawing - the frame starts
 * with one - and anything it cannot bound marks everything.
 */
export function trackCanvasDirt(ctx: CanvasRenderingContext2D, dirt: CanvasDirt): void {
    let m: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;

    const addPoint = (x: number, y: number) => {
        const dx = m[0] * x + m[2] * y + m[4];
        const dy = m[1] * x + m[3] * y + m[5];
        px0 = Math.min(px0, dx);
        py0 = Math.min(py0, dy);
        px1 = Math.max(px1, dx);
        py1 = Math.max(py1, dy);
    };
    const addBox = (x: number, y: number, w: number, h: number) => {
        addPoint(x, y);
        addPoint(x + w, y);
        addPoint(x, y + h);
        addPoint(x + w, y + h);
    };
    const scaleOf = () => Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
    /** Mark a box in device pixels, padded. */
    const markBox = (pad: number, x0: number, y0: number, x1: number, y1: number) => {
        dirt.mark(Math.floor(x0 - pad), Math.floor(y0 - pad), Math.ceil(x1 + pad), Math.ceil(y1 + pad));
    };
    /** Mark a shape's own box without disturbing the path being built. */
    const markShape = (pad: number, build: () => void) => {
        const saved = [px0, py0, px1, py1];
        px0 = py0 = Infinity;
        px1 = py1 = -Infinity;
        build();
        markBox(pad, px0, py0, px1, py1);
        [px0, py0, px1, py1] = saved;
    };
    const strokePad = () => (ctx.lineWidth * scaleOf()) / 2 + 2;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each hook takes its own method's arguments
    const wrap = <K extends keyof CanvasRenderingContext2D>(name: K, before: (...args: any[]) => void) => {
        const original = (ctx[name] as unknown as (...args: unknown[]) => unknown).bind(ctx);
        (ctx as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
            before(...args);
            return original(...args);
        };
    };

    // The transform, mirrored.
    wrap('save', () => stack.push([...m]));
    wrap('restore', () => {
        m = stack.pop() ?? m;
    });
    wrap('translate', (x: number, y: number) => {
        m = [m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y, m[5] + m[1] * x + m[3] * y];
    });
    wrap('scale', (sx: number, sy: number) => {
        m = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]];
    });
    wrap('rotate', (t: number) => {
        const c = Math.cos(t), s = Math.sin(t);
        m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, m[2] * c - m[0] * s, m[3] * c - m[1] * s, m[4], m[5]];
    });
    wrap('transform', (a: number, b: number, c: number, d: number, e: number, f: number) => {
        m = [
            m[0] * a + m[2] * b, m[1] * a + m[3] * b,
            m[0] * c + m[2] * d, m[1] * c + m[3] * d,
            m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5],
        ];
    });
    wrap('setTransform', (a?: number | DOMMatrix2DInit, b?: number, c?: number, d?: number, e?: number, f?: number) => {
        if (typeof a === 'number') {
            m = [a, b!, c!, d!, e!, f!];
        } else {
            const t = new DOMMatrix(a === undefined ? undefined : [a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0]);
            m = [t.a, t.b, t.c, t.d, t.e, t.f];
        }
    });
    wrap('resetTransform', () => {
        m = [1, 0, 0, 1, 0, 0];
    });

    // The path, bounded as it is built.
    wrap('beginPath', () => {
        px0 = py0 = Infinity;
        px1 = py1 = -Infinity;
    });
    wrap('moveTo', addPoint);
    wrap('lineTo', addPoint);
    wrap('rect', addBox);
    wrap('roundRect', addBox);
    wrap('arc', (x: number, y: number, r: number) => addBox(x - r, y - r, 2 * r, 2 * r));
    wrap('ellipse', (x: number, y: number, rx: number, ry: number) => {
        const r = Math.max(rx, ry);
        addBox(x - r, y - r, 2 * r, 2 * r);
    });
    wrap('arcTo', (x1: number, y1: number, x2: number, y2: number, r: number) => {
        addBox(x1 - r, y1 - r, 2 * r, 2 * r);
        addBox(x2 - r, y2 - r, 2 * r, 2 * r);
    });
    wrap('quadraticCurveTo', (cx: number, cy: number, x: number, y: number) => {
        addPoint(cx, cy);
        addPoint(x, y);
    });
    wrap('bezierCurveTo', (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) => {
        addPoint(c1x, c1y);
        addPoint(c2x, c2y);
        addPoint(x, y);
    });

    // What puts pixels down.
    wrap('stroke', (path?: Path2D) => {
        if (path !== undefined) {
            dirt.markEverything();
        } else if (px1 >= px0) {
            markBox(strokePad(), px0, py0, px1, py1);
        }
    });
    wrap('fill', (path?: Path2D | CanvasFillRule) => {
        if (typeof path === 'object') {
            dirt.markEverything();
        } else if (px1 >= px0) {
            markBox(2, px0, py0, px1, py1);
        }
    });
    wrap('fillRect', (x: number, y: number, w: number, h: number) => markShape(2, () => addBox(x, y, w, h)));
    wrap('strokeRect', (x: number, y: number, w: number, h: number) => markShape(strokePad(), () => addBox(x, y, w, h)));
    wrap('clearRect', (x: number, y: number, w: number, h: number) => {
        const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
        if (!(identity && x <= 0 && y <= 0 && x + w >= ctx.canvas.width && y + h >= ctx.canvas.height)) {
            markShape(2, () => addBox(x, y, w, h));
        }
    });
    wrap('drawImage', (image: CanvasImageSource, ...a: number[]) => {
        if (a.length === 2) {
            const size = image as { width: number; height: number };
            markShape(2, () => addBox(a[0], a[1], Number(size.width), Number(size.height)));
        } else if (a.length === 4) {
            markShape(2, () => addBox(a[0], a[1], a[2], a[3]));
        } else {
            markShape(2, () => addBox(a[4], a[5], a[6], a[7]));
        }
    });
    wrap('putImageData', (data: ImageData, dx: number, dy: number) => {
        dirt.mark(dx - 1, dy - 1, dx + data.width + 1, dy + data.height + 1);
    });
    wrap('fillText', () => dirt.markEverything());
    wrap('strokeText', () => dirt.markEverything());
}
