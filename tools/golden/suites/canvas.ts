/**
 * The 2D layer under the overlay (workstream M8): what the real CanvasPainter
 * and TextRenderer do to a CanvasRenderingContext2D, recorded at the context
 * level with a mock context (tools/golden/mockContext2d.ts).
 *
 * Each scene is a script of painter calls in the RecordingPainter format
 * (tools/golden/recordingPainter.ts), so the C# side can replay it through
 * Retro.Game.CanvasCommandPainter. The fixture holds, per scene:
 *   - calls:    every context call and property assignment, in order;
 *   - commands: the mock's browser-semantics interpretation of that stream
 *               (the flat command list a GPU frontend draws);
 *   - tints:    the offscreen atlas tints created, in order (font, colour).
 *
 * Node has no Image/canvas/document: the suite installs stand-ins while it
 * runs (atlas sizes are read from the real PNG headers under assets/) and
 * removes them afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CanvasPainter } from '../../../src/script/render/screen/canvasPainter';
import { Font, TextAlignment, TextEffect } from '../../../src/script/render/screen/text';
import { Call, IMAGE_INFO, imageInfo, MockContext2D, MockImageInfo } from '../mockContext2d';
import { Rng, SuiteOutput } from '../lib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ASSETS = path.resolve(__dirname, '../../../assets');
const FONTS: Record<string, Font> = { HUD_SMALL: Font.HUD_SMALL, HUD_MEDIUM: Font.HUD_MEDIUM, HUD_LARGE: Font.HUD_LARGE };

function pngSize(file: string): [number, number] {
    const b = fs.readFileSync(file);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const ATLAS_SIZES = new Map<string, [number, number]>(
    Object.values(FONTS).map(f => [path.basename(f.atlas), pngSize(path.join(ASSETS, path.basename(f.atlas)))]));

/** new Image(): complete at once, sized from the real PNG. */
class MockImage {
    width = 0;
    height = 0;
    readonly complete = true;
    [IMAGE_INFO]: MockImageInfo = { label: '?', width: 0, height: 0 };
    private _src = '';
    get src() { return this._src; }
    set src(v: string) {
        this._src = v;
        const name = path.basename(new URL(v).pathname);
        const size = ATLAS_SIZES.get(name);
        if (!size) throw new Error(`no atlas ${name}`);
        [this.width, this.height] = size;
        const font = Object.values(FONTS).find(f => path.basename(f.atlas) === name)!;
        this[IMAGE_INFO] = { label: `atlas:${font.id}`, fontId: font.id, tint: null, width: this.width, height: this.height };
    }
    addEventListener() { /* complete: never fires */ }
}

interface TintRecord { canvas: MockCanvas }

/** document.createElement('canvas') for the tinted atlases. */
class MockCanvas {
    width = 0;
    height = 0;
    ctx?: MockContext2D;
    constructor(private readonly tints: TintRecord[]) { }
    getContext(kind: string) {
        if (kind !== '2d') throw new Error(kind);
        if (!this.ctx) {
            this.ctx = new MockContext2D(this.width, this.height);
            this.tints.push({ canvas: this });
        }
        return this.ctx;
    }
    /** The atlas it copies and the colour it multiplies by, read off its own recorded calls. */
    get [IMAGE_INFO](): MockImageInfo {
        const calls = this.ctx?.calls ?? [];
        const src = calls.find(c => c[0] === 'drawImage');
        const fill = calls.find(c => c[0] === 'set' && c[1] === 'fillStyle');
        const fontId = String(src?.[1] ?? '?').replace(/^atlas:/, '');
        const tint = String(fill?.[2] ?? '?');
        return { label: `tint:${fontId}:${tint}`, fontId, tint, width: this.width, height: this.height };
    }
}

function withDom<T>(tints: TintRecord[], run: () => T): T {
    const g = globalThis as Any;
    const saved = { Image: g.Image, window: g.window, document: g.document };
    g.Image = MockImage;
    g.window = { location: { href: 'http://localhost/' } };
    g.document = { createElement: (tag: string) => { if (tag !== 'canvas') throw new Error(tag); return new MockCanvas(tints); } };
    try {
        return run();
    } finally {
        g.Image = saved.Image;
        g.window = saved.window;
        g.document = saved.document;
    }
}

const ALIGN: Record<string, TextAlignment> = { LEFT: TextAlignment.LEFT, CENTER: TextAlignment.CENTER, RIGHT: TextAlignment.RIGHT };
const EFFECT: Record<string, TextEffect> = {
    NONE: TextEffect.NONE, SHADOW: TextEffect.SHADOW, BACKGROUND: TextEffect.BACKGROUND, BOLD: TextEffect.BOLD,
};

/** Apply one RecordingPainter-format call to a real painter. */
function apply(p: CanvasPainter, call: Call, st: { batch?: Any; clip?: Any; images: Map<string, object> }): void {
    const [name, ...a] = call as Any[];
    const img = (id: string) => {
        let o = st.images.get(id);
        if (!o) {
            o = { id };
            st.images.set(id, o);
        }
        return o;
    };
    switch (name) {
        case 'setColor': p.setColor(a[0]); break;
        case 'setBackground': p.setBackground(a[0]); break;
        case 'setTextEffect': p.setTextEffect(EFFECT[a[0]], a[1]); break;
        case 'setLineWidth': p.setLineWidth(a[0]); break;
        case 'clear':
            if (a[0] === null) p.clear();
            else p.clear(a[0], a[1], a[2], a[3]);
            break;
        case 'fillRect': p.fillRect(a[0], a[1], a[2], a[3]); break;
        case 'hLine': p.hLine(a[0], a[1], a[2]); break;
        case 'vLine': p.vLine(a[0], a[1], a[2]); break;
        case 'line': p.line(a[0], a[1], a[2], a[3]); break;
        case 'rightTriangle': p.rightTriangle(a[0], a[1], a[2], a[3]); break;
        case 'rectangle': p.rectangle(a[0], a[1], a[2], a[3], a[4]); break;
        case 'circle': p.circle(a[0], a[1], a[2], a[3]); break;
        case 'text': p.text(FONTS[a[0]], a[1], a[2], a[3], a[4] ?? undefined, ALIGN[a[5]]); break;
        case 'image': p.image(img(a[0]) as Any, a[1], a[2], a[3], a[4]); break;
        case 'pushTransform': p.pushTransform(a[0], a[1], a[2], a[3]); break;
        case 'popTransform': p.popTransform(); break;
        case 'batch': st.batch = p.batch(); break;
        case 'b.hLine': st.batch.hLine(a[0], a[1], a[2]); break;
        case 'b.vLine': st.batch.vLine(a[0], a[1], a[2]); break;
        case 'b.line': st.batch.line(a[0], a[1], a[2], a[3]); break;
        case 'b.rightTriangle': st.batch.rightTriangle(a[0], a[1], a[2], a[3]); break;
        case 'b.commit': st.batch.commit(); break;
        case 'clip': st.clip = p.clip(); break;
        case 'c.rectangle': st.clip.rectangle(a[0], a[1], a[2], a[3]); break;
        case 'c.circle': st.clip.circle(a[0], a[1], a[2]); break;
        case 'c.clip': st.clip.clip(); break;
        case 'c.clear': st.clip.clear(); break;
        default: throw new Error(`unknown painter call ${name}`);
    }
}

interface Scene {
    name: string;
    width: number;
    height: number;
    textColors: string[];
    script: Call[];
}

const ALL_CHARS = (() => {
    let s = '';
    for (let c = 32; c < 127; c++) s += String.fromCharCode(c);
    return s + 'αéÄβ—';
})();

function scenes(): Scene[] {
    const out: Scene[] = [];
    const add = (name: string, script: Call[], textColors: string[] = [], width = 320, height = 200) =>
        out.push({ name, width, height, textColors, script });

    // Lines from a centre to points around it: every octant, both directions, the diagonals.
    {
        const s: Call[] = [['setColor', '#00ff00']];
        const ends = [[10, 0], [10, 3], [10, 10], [3, 10], [0, 10], [-3, 10], [-10, 10], [-10, 3], [-10, 0],
            [-10, -3], [-10, -10], [-3, -10], [0, -10], [3, -10], [10, -10], [10, -3], [7, 5], [5, 7], [1, 9], [9, 1], [0, 0]];
        for (const [dx, dy] of ends) {
            s.push(['line', 50, 50, 50 + dx, 50 + dy]);
            s.push(['line', 50 + dx, 50 + dy, 50, 50]);
        }
        s.push(['line', 3.5, 4.25, 17.5, 9.75], ['line', 17.5, 9.75, 3.5, 4.25], ['line', -5, -5, 2, 300]);
        add('lines_octants', s);
    }
    // hLine / vLine, forwards, reversed, single pixel, fractional.
    add('hv_lines', [
        ['setColor', '#ff0000'],
        ['hLine', 10, 20, 5], ['hLine', 20, 10, 6], ['hLine', 7, 7, 7], ['hLine', 2.5, 9.25, 8.5],
        ['vLine', 30, 10, 20], ['vLine', 31, 20, 10], ['vLine', 32, 4, 4], ['vLine', 33.5, 1.5, 6.75],
        ['setLineWidth', 2], ['hLine', 40, 50, 10], ['vLine', 40, 20, 30],
        ['setLineWidth', 3], ['hLine', 60, 70, 10], ['vLine', 60, 30, 20],
        ['setLineWidth', 0], ['hLine', 1, 2, 3], ['setLineWidth', -1], ['vLine', 1, 2, 3],
        ['setLineWidth', 1.5], ['line', 0, 0, 9, 4],
    ]);
    // rightTriangle: four orientations, steep and shallow, degenerate.
    {
        const s: Call[] = [['setColor', '#ffff00']];
        for (const [dx, dy] of [[8, 3], [3, 8], [8, 8], [5, 0], [0, 5], [0, 0]]) {
            for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                s.push(['rightTriangle', 100, 100, 100 + sx * dx, 100 + sy * dy]);
            }
        }
        add('right_triangles', s);
    }
    // Batches: several spans in one stroke; a batch never committed; commit twice; colour change mid-batch.
    add('batches', [
        ['setColor', '#112233'],
        ['batch'], ['b.hLine', 0, 10, 0], ['b.vLine', 0, 0, 10], ['b.line', 0, 0, 10, 7], ['b.rightTriangle', 20, 20, 26, 14], ['b.commit'],
        ['batch'], ['b.hLine', 5, 6, 7],
        ['batch'], ['b.line', 1, 1, 4, 9], ['b.commit'], ['b.commit'],
        ['batch'], ['b.hLine', 0, 3, 9], ['setColor', '#445566'], ['b.vLine', 9, 0, 3], ['b.commit'],
        ['batch'], ['b.commit'],
    ]);
    // Rectangles and fills, including zero and negative sizes and line widths.
    add('rectangles', [
        ['setColor', '#abcdef'], ['setBackground', '#123456'],
        ['rectangle', 10, 10, 20, 10, false], ['rectangle', 40, 10, 20, 10, true],
        ['rectangle', 0, 0, 1, 1, false], ['rectangle', 2, 2, 1, 5, false], ['rectangle', 5, 5, 0, 0, false],
        ['rectangle', 5, 5, -3, 4, false], ['rectangle', 5, 5, -3, 4, true],
        ['setLineWidth', 2], ['rectangle', 70, 10, 10, 10, false],
        ['setLineWidth', 3], ['rectangle', 90, 10, 10, 10, false],
        ['fillRect', 1.5, 2.5, 3.25, 4], ['fillRect', 0, 0, 0, 10],
        ['setBackground', 'not-a-colour'], ['fillRect', 1, 1, 1, 1],
        ['setBackground', ''], ['fillRect', 2, 2, 1, 1],
        ['setColor', 'rgba(255, 0, 0, 0.5)'], ['rectangle', 3, 3, 4, 4, false],
        ['setBackground', '#FFF'], ['fillRect', 4, 4, 2, 2],
    ]);
    // Circles: stroke and fill, zero radius, fractional, wide stroke.
    add('circles', [
        ['setColor', '#00ffff'], ['setBackground', '#ff00ff'],
        ['circle', 50, 50, 10, false], ['circle', 80, 50, 10, true], ['circle', 10, 10, 0, false],
        ['circle', 20.5, 20.25, 3.5, true], ['setLineWidth', 3], ['circle', 100, 100, 30, false],
    ]);
    // Clear: whole canvas, a rectangle, and the falsy-argument fallbacks.
    add('clears', [
        ['clear', null, null, null, null], ['clear', 10, 20, 30, 40], ['clear', 0, 0, 0, 0], ['clear', 5, 6, 0, 7],
        ['pushTransform', 10, 10, 0.5, 2], ['clear', 1, 2, 3, 4], ['popTransform'],
    ], [], 64, 48);
    // Text: every font, alignment, effect, with and without colour.
    for (const font of Object.keys(FONTS)) {
        const s: Call[] = [];
        for (const effect of ['NONE', 'SHADOW', 'BACKGROUND', 'BOLD']) {
            s.push(['setTextEffect', effect, '#101010']);
            for (const align of ['LEFT', 'CENTER', 'RIGHT']) {
                s.push(['text', font, 100, 20, 'AB12', '#00ff00', align]);
                s.push(['text', font, 101, 40, 'xyz', null, align]);
                s.push(['text', font, 100, 60, '', '#ff0000', align]);
                s.push(['text', font, 100, 80, 'α', '#00FF00', align]);
            }
            s.push(['text', font, 5, 100, ALL_CHARS, '#ffffff', 'LEFT']);
            s.push(['text', font, 5, 120, '-12.5:30 ALTα a', null, 'LEFT']);
        }
        add(`text_${font}`, s, ['#00ff00', '#FFFFFF']);
    }
    // Effect state leaks into the context: BACKGROUND and alpha set fillStyle; empty effect colour.
    add('text_state_leaks', [
        ['setBackground', '#0000ff'], ['fillRect', 0, 0, 4, 4],
        ['setTextEffect', 'BACKGROUND', '#202020'], ['text', 'HUD_SMALL', 10, 10, 'HI', '#00ff00', 'LEFT'],
        ['fillRect', 0, 0, 4, 4],
        ['setTextEffect', 'NONE', '#000000'], ['text', 'HUD_SMALL', 10, 20, 'aα', '#ff0000', 'LEFT'], ['fillRect', 0, 0, 4, 4],
        ['text', 'HUD_SMALL', 10, 30, 'α', null, 'LEFT'], ['fillRect', 0, 0, 4, 4],
        ['setTextEffect', 'SHADOW', ''], ['text', 'HUD_MEDIUM', 10, 40, 'Sα', '#00ff00', 'CENTER'], ['fillRect', 0, 0, 4, 4],
        ['setTextEffect', 'BOLD', ''], ['text', 'HUD_LARGE', 10, 60, 'αB', null, 'RIGHT'],
        ['setTextEffect', 'BACKGROUND', ''], ['text', 'HUD_LARGE', 10, 80, 'X', '#00ff00', 'LEFT'], ['fillRect', 0, 0, 4, 4],
        ['text', 'HUD_SMALL', 10.5, 90.25, 'FR', '#00ff00', 'CENTER'],
    ]);
    // Transforms: nested with rotation and scale, every primitive inside, an unmatched pop.
    add('transforms', [
        ['setColor', '#ff8800'], ['setBackground', '#0088ff'],
        ['pushTransform', 160, 100, 0.3, 1],
        ['hLine', -10, 10, 0], ['line', -5, -5, 5, 7], ['rectangle', -4, -4, 8, 8, false], ['circle', 0, 0, 6, false],
        ['pushTransform', 20, 0, -1.1, 2.5],
        ['rightTriangle', 0, 0, 6, 4], ['fillRect', 1, 1, 2, 2], ['text', 'HUD_MEDIUM', 0, 0, 'ROT', '#ff8800', 'CENTER'],
        ['image', 'img0', -2, -2, 4, 4],
        ['popTransform'],
        ['text', 'HUD_SMALL', 0, 10, 'ONE', null, 'LEFT'],
        ['pushTransform', 0, 0, 0, 0.5], ['vLine', 3, 0, 9], ['popTransform'],
        ['popTransform'], ['popTransform'],
        ['hLine', 0, 5, 1], ['text', 'HUD_SMALL', 0, 0, 'AFTER', null, 'LEFT'],
    ]);
    // Clips: rectangle, circle, both, unused, nested in a transform, cleared.
    add('clips', [
        ['setColor', '#ffffff'], ['setBackground', '#00ff00'],
        ['clip'], ['c.rectangle', 10, 10, 50, 40], ['c.clip'], ['hLine', 0, 100, 20], ['fillRect', 0, 0, 100, 100], ['c.clear'],
        ['clip'], ['c.circle', 50, 50, 20], ['c.clip'], ['circle', 50, 50, 25, true], ['c.clear'],
        ['clip'], ['c.rectangle', 0, 0, 10, 10], ['c.circle', 30, 30, 5], ['c.clip'], ['line', 0, 0, 40, 40], ['c.clear'],
        ['clip'], ['c.rectangle', 0, 0, 10, 10], ['c.clear'],
        ['pushTransform', 100, 50, 0.7, 1.5],
        ['clip'], ['c.rectangle', -10, -10, 20, 20], ['c.clip'], ['text', 'HUD_LARGE', 0, 0, 'CLIP', '#ffffff', 'CENTER'],
        ['clip'], ['c.circle', 0, 0, 8], ['c.clip'], ['clear', null, null, null, null], ['c.clear'],
        ['c.clear'],
        ['popTransform'],
        ['clip'], ['c.clip'], ['hLine', 0, 9, 9], ['c.clear'],
        ['clip'], ['c.rectangle', 0, 0, 30, 30], ['hLine', 0, 5, 5], ['c.clip'], ['vLine', 1, 1, 9], ['c.clear'],
        ['clip'], ['c.rectangle', 0, 0, 30, 30], ['c.clip'], ['pushTransform', 5, 5, 0, 1], ['c.clear'], ['popTransform'],
        ['clip'], ['c.rectangle', 0, 0, 30, 30], ['c.clip'], ['c.clip'], ['c.clear'],
    ]);
    // Images: two handles, smoothing turned off by the first image() and never back on.
    add('images', [
        ['text', 'HUD_SMALL', 0, 0, 'PRE', null, 'LEFT'],
        ['image', 'img0', 0, 0, 16, 16], ['image', 'img1', 10.5, 20.5, 8, 4], ['image', 'img0', 0, 0, -16, 16],
        ['text', 'HUD_SMALL', 0, 0, 'POST', null, 'LEFT'],
        ['pushTransform', 50, 50, 1.2, 3], ['image', 'img1', -1, -1, 2, 2], ['popTransform'],
    ]);
    // Seeded fuzz over every painter call.
    {
        const rng = new Rng(0x2D_CA);
        const colors = ['#00ff00', '#ff0000', '#FFFFFF', '#0a0b0c', '#abc', 'rgb(1, 2, 3)', ''];
        const s: Call[] = [];
        let depth = 0;
        let clipOpen = false;
        for (let i = 0; i < 400; i++) {
            const k = rng.int(0, 17);
            const c = () => rng.int(-20, 340);
            const r = () => rng.int(-15, 15);
            switch (k) {
                case 0: s.push(['setColor', rng.pick(colors)]); break;
                case 1: s.push(['setBackground', rng.pick(colors)]); break;
                case 2: s.push(['setTextEffect', rng.pick(['NONE', 'SHADOW', 'BACKGROUND', 'BOLD']), rng.pick(colors)]); break;
                case 3: s.push(['setLineWidth', rng.pick([1, 1, 1, 2, 3, 0.5])]); break;
                case 4: { const x = c(), y = c(); s.push(['line', x, y, x + r(), y + r()]); break; }
                case 5: { const x = c(), y = c(); s.push(['rightTriangle', x, y, x + r(), y + r()]); break; }
                case 6: s.push(['hLine', c(), c(), c()]); break;
                case 7: s.push(['vLine', c(), c(), c()]); break;
                case 8: s.push(['rectangle', c(), c(), rng.int(-2, 40), rng.int(-2, 40), rng.next() < 0.5]); break;
                case 9: s.push(['circle', c(), c(), rng.int(0, 30), rng.next() < 0.5]); break;
                case 10: {
                    const n = rng.int(0, 6);
                    let t = '';
                    for (let j = 0; j < n; j++) t += ALL_CHARS[rng.int(0, ALL_CHARS.length - 1)];
                    s.push(['text', rng.pick(Object.keys(FONTS)), c(), c(), t, rng.next() < 0.3 ? null : rng.pick(colors.slice(0, 5)),
                        rng.pick(['LEFT', 'CENTER', 'RIGHT'])]);
                    break;
                }
                case 11: s.push(['fillRect', c(), c(), rng.int(0, 30), rng.int(0, 30)]); break;
                case 12:
                    if (depth < 3) { s.push(['pushTransform', c(), c(), rng.range(-3.2, 3.2), rng.pick([1, 1, 2, 0.5, 1.5])]); depth++; }
                    break;
                case 13: if (depth > 0) { s.push(['popTransform']); depth--; } break;
                case 14: s.push(['image', rng.pick(['img0', 'img1']), c(), c(), rng.int(1, 20), rng.int(1, 20)]); break;
                case 15:
                    if (!clipOpen) {
                        s.push(['clip'], rng.next() < 0.5 ? ['c.rectangle', c(), c(), rng.int(1, 80), rng.int(1, 80)] : ['c.circle', c(), c(), rng.int(1, 40)], ['c.clip']);
                        clipOpen = true;
                    } else {
                        s.push(['c.clear']);
                        clipOpen = false;
                    }
                    break;
                case 16: {
                    s.push(['batch']);
                    const n = rng.int(1, 4);
                    for (let j = 0; j < n; j++) {
                        const x = c(), y = c();
                        s.push(rng.pick([['b.hLine', x, x + r(), y], ['b.vLine', x, y, y + r()], ['b.line', x, y, x + r(), y + r()],
                            ['b.rightTriangle', x, y, x + r(), y + r()]] as Call[]));
                    }
                    s.push(['b.commit']);
                    break;
                }
                case 17: s.push(rng.next() < 0.5 ? ['clear', null, null, null, null] : ['clear', c(), c(), rng.int(0, 50), rng.int(0, 50)]); break;
            }
        }
        if (clipOpen) s.push(['c.clear']);
        while (depth-- > 0) s.push(['popTransform']);
        add('fuzz', s, ['#00ff00']);
    }
    return out;
}

function runScene(sc: Scene) {
    const tints: TintRecord[] = [];
    return withDom(tints, () => {
        const ctx = new MockContext2D(sc.width, sc.height);
        const painter = new CanvasPainter(ctx as unknown as CanvasRenderingContext2D, sc.textColors);
        const st = { images: new Map<string, object>() };
        for (const call of sc.script) apply(painter, call, st);
        return {
            name: sc.name,
            width: sc.width,
            height: sc.height,
            textColors: sc.textColors,
            script: sc.script,
            calls: ctx.calls,
            commands: ctx.commands,
            tints: tints.map(t => {
                const info = imageInfo(t.canvas)!;
                return { font: info.fontId, color: info.tint, width: t.canvas.width, height: t.canvas.height, calls: t.canvas.ctx!.calls };
            }),
        };
    });
}

export function canvasSuite(): SuiteOutput {
    const fonts = Object.values(FONTS).map(f => {
        const [w, h] = ATLAS_SIZES.get(path.basename(f.atlas))!;
        return { id: f.id, atlas: f.atlas, width: w, height: h, charWidth: f.charWidth, charHeight: f.charHeight, charSpacing: f.charSpacing };
    });
    return {
        files: [{
            file: 'canvas_painter.json',
            data: {
                suite: 'canvas_painter',
                version: 1,
                source: ['src/script/render/screen/canvasPainter.ts', 'src/script/render/screen/text.ts', 'tools/golden/mockContext2d.ts'],
                notes: [
                    'calls: the real CanvasPainter + TextRenderer driven by `script` (RecordingPainter format) against a mock context; property assignments are ["set", prop, value], images by label (atlas:<font>, tint:<font>:<colour>, img<n>).',
                    'commands: the mock context\'s browser-semantics interpretation (see tools/golden/mockContext2d.ts for the flat format).',
                    'tints: offscreen tinted atlases in creation order with their own context calls.',
                ],
                tolerances: { calls: 0, commands: 1e-12 },
                fonts,
                scenes: scenes().map(runScene),
            },
        }],
    };
}
