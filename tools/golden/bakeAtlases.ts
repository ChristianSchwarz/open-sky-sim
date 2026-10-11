/**
 * Bakes the tree and stone billboard atlases to PNG for the Unity port.
 *
 * The web game builds both at runtime (treeAtlas.ts, stoneAtlas.ts): each
 * sprite is an SVG string from treeSprites.ts / stoneSprites.ts, drawn into a
 * 512 x 768 canvas with drawImage. The SVGs only use <polygon> and <ellipse>
 * with flat fills, so this rasterises them directly - no browser, no new
 * dependency - with 16 x 16 supersampled coverage composited source-over, the
 * way a canvas does. The SVG has a viewBox and no size, so its natural size is
 * the viewBox (100 x 150 for trees, 100 x 100 for stones) and drawImage
 * stretches it to the 128 x 128 cell: trees are squashed vertically by 128/150
 * and widened by 128/100, exactly as in the browser.
 *
 *   node --import tsx tools/golden/bakeAtlases.ts [outDir]
 *   node --import tsx tools/golden/bakeAtlases.ts --browser-check page.html
 *
 * outDir defaults to unity/Packages/com.retro.unity/Textures. --browser-check
 * writes a page that draws the same SVGs with a real canvas and prints per-cell
 * coverage next to this rasteriser's, for checking the two agree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { SPECIES_COUNT, SPECIES_SPECS, Species, TREE_VIEWS, TreeView, generateTreeSprite } from '../../src/script/scene/vegetation/treeSprites';
import { ROCK_SHAPE_COUNT, RockShape, generateRockSprite } from '../../src/script/scene/vegetation/stoneSprites';

const CELL = 128;
const BLOCK = CELL * 2;
const WIDTH = BLOCK * 2;
const HEIGHT = BLOCK * 3;
const SS = 16;
const VIEW_DEG: Record<TreeView, number> = { [TreeView.DEG_0]: 0, [TreeView.DEG_30]: 30, [TreeView.DEG_60]: 60, [TreeView.DEG_90]: 90 };
/** treeAtlas.ts VIEW_CELL: (col, row) of each view inside a block. */
const VIEW_CELL: Record<TreeView, [number, number]> = {
    [TreeView.DEG_0]: [0, 0], [TreeView.DEG_30]: [1, 0], [TreeView.DEG_60]: [0, 1], [TreeView.DEG_90]: [1, 1],
};
const SPECIES_NAMES = ['maple', 'pine', 'linden', 'fir', 'shrub', 'bush'];
const ROCK_NAMES = ['round', 'angular', 'flat', 'cluster', 'slab', 'pebble'];

type Shape =
    | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rgb: [number, number, number] }
    | { kind: 'polygon'; pts: number[]; rgb: [number, number, number] };

function hex(c: string): [number, number, number] {
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) throw new Error(`unsupported fill ${c}`);
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The two element kinds the sprite generators emit, in document order. */
function parseSvg(svg: string): { w: number; h: number; shapes: Shape[] } {
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    if (!vb) throw new Error('no viewBox');
    const shapes: Shape[] = [];
    const re = /<(ellipse|polygon)([^>]*)\/>/g;
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = re.exec(svg)) !== null) {
        seen++;
        const attr = (name: string) => {
            const a = new RegExp(`\\b${name}="([^"]*)"`).exec(m![2]);
            if (!a) throw new Error(`${m![1]} without ${name}`);
            return a[1];
        };
        if (m[1] === 'ellipse') {
            shapes.push({ kind: 'ellipse', cx: +attr('cx'), cy: +attr('cy'), rx: +attr('rx'), ry: +attr('ry'), rgb: hex(attr('fill')) });
        } else {
            shapes.push({ kind: 'polygon', pts: attr('points').trim().split(/[\s,]+/).map(Number), rgb: hex(attr('fill')) });
        }
    }
    const elements = (svg.match(/<[a-z]+[\s>]/g) ?? []).length - 1; // minus the <svg> root
    if (seen !== elements) throw new Error(`unexpected SVG elements in ${svg.slice(0, 120)}`);
    return { w: +vb[1], h: +vb[2], shapes };
}

function insidePolygon(pts: number[], x: number, y: number): boolean {
    let inside = false;
    const n = pts.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** Premultiplied RGBA float accumulation buffer. */
class Canvas {
    readonly px: Float64Array;

    constructor(readonly width: number, readonly height: number) {
        this.px = new Float64Array(width * height * 4);
    }

    /** drawImage(svg, dx, dy, CELL, CELL): the SVG's viewBox stretched onto the cell. */
    drawSvg(svg: string, dx: number, dy: number): void {
        const { w, h, shapes } = parseSvg(svg);
        const sx = CELL / w, sy = CELL / h;
        for (const s of shapes) {
            // Shape bounds in canvas pixels.
            let x0: number, x1: number, y0: number, y1: number;
            let test: (x: number, y: number) => boolean;
            if (s.kind === 'ellipse') {
                const cx = dx + s.cx * sx, cy = dy + s.cy * sy, rx = s.rx * sx, ry = s.ry * sy;
                x0 = cx - rx; x1 = cx + rx; y0 = cy - ry; y1 = cy + ry;
                test = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
            } else {
                const p = s.pts.map((v, i) => (i % 2 === 0 ? dx + v * sx : dy + v * sy));
                x0 = Math.min(...p.filter((_, i) => i % 2 === 0)); x1 = Math.max(...p.filter((_, i) => i % 2 === 0));
                y0 = Math.min(...p.filter((_, i) => i % 2 === 1)); y1 = Math.max(...p.filter((_, i) => i % 2 === 1));
                test = (x, y) => insidePolygon(p, x, y);
            }
            // Clipped to the cell, as drawImage clips to its destination rectangle.
            const px0 = Math.max(dx, Math.floor(x0)), px1 = Math.min(dx + CELL - 1, Math.ceil(x1));
            const py0 = Math.max(dy, Math.floor(y0)), py1 = Math.min(dy + CELL - 1, Math.ceil(y1));
            const [r, g, b] = s.rgb.map(c => c / 255);
            for (let y = py0; y <= py1; y++) {
                for (let x = px0; x <= px1; x++) {
                    let hits = 0;
                    for (let j = 0; j < SS; j++) {
                        const yy = y + (j + 0.5) / SS;
                        for (let i = 0; i < SS; i++) {
                            if (test(x + (i + 0.5) / SS, yy)) hits++;
                        }
                    }
                    if (hits === 0) continue;
                    const a = hits / (SS * SS);
                    const o = (y * this.width + x) * 4;
                    this.px[o] = r * a + this.px[o] * (1 - a);
                    this.px[o + 1] = g * a + this.px[o + 1] * (1 - a);
                    this.px[o + 2] = b * a + this.px[o + 2] * (1 - a);
                    this.px[o + 3] = a + this.px[o + 3] * (1 - a);
                }
            }
        }
    }

    /** Straight-alpha RGBA8, as getImageData / toDataURL hand it out. */
    rgba8(): Uint8Array {
        const out = new Uint8Array(this.width * this.height * 4);
        for (let i = 0; i < this.width * this.height; i++) {
            const a = this.px[i * 4 + 3];
            out[i * 4 + 3] = Math.round(a * 255);
            for (let c = 0; c < 3; c++) {
                out[i * 4 + c] = a > 0 ? Math.min(255, Math.round((this.px[i * 4 + c] / a) * 255)) : 0;
            }
        }
        return out;
    }
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(Buffer.from(type, 'ascii'), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, height);
    ihdr.set([8, 6, 0, 0, 0], 8); // 8 bit, RGBA, deflate, no filter method, no interlace
    const raw = new Uint8Array(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
        chunk('IEND', new Uint8Array(0)),
    ];
    return Buffer.concat(parts);
}

interface AtlasEntry {
    index: number;
    name: string;
    trunkColor?: string;
    views: Array<{ deg: number; rectPx: [number, number, number, number]; uvTopLeft: [number, number, number, number]; uvBottomLeft: [number, number, number, number] }>;
}

function cellOrigin(kind: number, view: TreeView): [number, number] {
    const [col, row] = VIEW_CELL[view];
    return [(kind % 2) * BLOCK + col * CELL, Math.floor(kind / 2) * BLOCK + row * CELL];
}

function entries(count: number, name: (i: number) => string, trunk?: (i: number) => string): AtlasEntry[] {
    const out: AtlasEntry[] = [];
    for (let k = 0; k < count; k++) {
        out.push({
            index: k,
            name: name(k),
            trunkColor: trunk?.(k),
            views: TREE_VIEWS.map(view => {
                const [x, y] = cellOrigin(k, view);
                return {
                    deg: VIEW_DEG[view],
                    rectPx: [x, y, CELL, CELL] as [number, number, number, number],
                    uvTopLeft: [x / WIDTH, y / HEIGHT, (x + CELL) / WIDTH, (y + CELL) / HEIGHT] as [number, number, number, number],
                    uvBottomLeft: [x / WIDTH, 1 - (y + CELL) / HEIGHT, (x + CELL) / WIDTH, 1 - y / HEIGHT] as [number, number, number, number],
                };
            }),
        });
    }
    return out;
}

function sprites(): { tree: Array<[number, TreeView, string]>; stone: Array<[number, TreeView, string]> } {
    const tree: Array<[number, TreeView, string]> = [];
    const stone: Array<[number, TreeView, string]> = [];
    for (let s = 0; s < SPECIES_COUNT; s++) {
        for (const v of TREE_VIEWS) tree.push([s, v, generateTreeSprite(s as Species, v)]);
    }
    for (let s = 0; s < ROCK_SHAPE_COUNT; s++) {
        for (const v of TREE_VIEWS) stone.push([s, v, generateRockSprite(s as RockShape, v)]);
    }
    return { tree, stone };
}

function render(list: Array<[number, TreeView, string]>): Canvas {
    const canvas = new Canvas(WIDTH, HEIGHT);
    for (const [kind, view, svg] of list) {
        const [x, y] = cellOrigin(kind, view);
        canvas.drawSvg(svg, x, y);
    }
    return canvas;
}

/** Per cell: pixels with alpha >= 128 (what the shader's 0.5 alpha test keeps). */
function cellCoverage(rgba: Uint8Array, list: Array<[number, TreeView, string]>): number[] {
    return list.map(([kind, view]) => {
        const [x0, y0] = cellOrigin(kind, view);
        let n = 0;
        for (let y = y0; y < y0 + CELL; y++) {
            for (let x = x0; x < x0 + CELL; x++) if (rgba[(y * WIDTH + x) * 4 + 3] >= 128) n++;
        }
        return n;
    });
}

function browserCheckPage(): string {
    const { tree, stone } = sprites();
    const mine = {
        tree: cellCoverage(render(tree).rgba8(), tree),
        stone: cellCoverage(render(stone).rgba8(), stone),
    };
    return `<!doctype html><meta charset="utf-8"><title>atlas check</title><pre id="out">running</pre><script>
const CELL=${CELL},BLOCK=${BLOCK},W=${WIDTH},H=${HEIGHT};
const VIEW_CELL=${JSON.stringify(VIEW_CELL)};
const lists=${JSON.stringify({ tree, stone })};
const mine=${JSON.stringify(mine)};
function load(svg){return new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);});}
(async()=>{const report={};for(const key of ['tree','stone']){const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');
await Promise.all(lists[key].map(([k,v,svg])=>load(svg).then(img=>{const [col,row]=VIEW_CELL[v];x.drawImage(img,(k%2)*BLOCK+col*CELL,Math.floor(k/2)*BLOCK+row*CELL,CELL,CELL);})));
const d=x.getImageData(0,0,W,H).data;const cov=lists[key].map(([k,v])=>{const [col,row]=VIEW_CELL[v];const x0=(k%2)*BLOCK+col*CELL,y0=Math.floor(k/2)*BLOCK+row*CELL;let n=0;for(let y=y0;y<y0+CELL;y++)for(let xx=x0;xx<x0+CELL;xx++)if(d[(y*W+xx)*4+3]>=128)n++;return n;});
report[key]={browser:cov,mine:mine[key]};}
window.__atlasCheck=report;document.getElementById('out').textContent=JSON.stringify(report);})();
</script>`;
}

function main(): void {
    const args = process.argv.slice(2);
    const check = args.indexOf('--browser-check');
    if (check >= 0) {
        fs.writeFileSync(args[check + 1], browserCheckPage());
        console.log(`wrote ${args[check + 1]}`);
        return;
    }
    const outDir = args[0] ?? path.resolve(__dirname, '../../unity/Packages/com.retro.unity/Textures');
    fs.mkdirSync(outDir, { recursive: true });
    const { tree, stone } = sprites();
    const treePng = render(tree).rgba8();
    const stonePng = render(stone).rgba8();
    fs.writeFileSync(path.join(outDir, 'TreeAtlas.png'), encodePng(WIDTH, HEIGHT, treePng));
    fs.writeFileSync(path.join(outDir, 'StoneAtlas.png'), encodePng(WIDTH, HEIGHT, stonePng));
    const meta = {
        generator: 'tools/golden/bakeAtlases.ts',
        source: ['src/script/scene/vegetation/treeSprites.ts', 'src/script/scene/vegetation/stoneSprites.ts',
            'src/script/scene/textures/treeAtlas.ts', 'src/script/scene/textures/stoneAtlas.ts'],
        width: WIDTH,
        height: HEIGHT,
        cellPx: CELL,
        blockPx: BLOCK,
        layout: 'kind k has its 2x2 block at block (k % 2, floor(k / 2)); views 0/30/60/90 deg at cells (0,0)/(1,0)/(0,1)/(1,1) of the block; '
            + 'rows count from the top of the image (the web texture has flipY = false, so its v runs downward: v = 0 at the top).',
        uv: 'uvTopLeft = [u0, v0, u1, v1] with v down (web shader convention); uvBottomLeft = the same rect with v up (Unity Texture2D convention).',
        sampling: 'magFilter Nearest, minFilter LinearMipmapLinear, mipmaps on, wrap clamp. Colour is sRGB. Alpha test at 0.5.',
        viewBands: 'camera elevation tangent above the instance: < 0.5774 -> 0 deg, < 1.4281 -> 30 deg, < 5.6713 -> 60 deg, else 90 deg',
        tint: 'Canopy and rock fill is #ffffff; any texel with max-min channel <= 0.12 is tinted, others (trunks) keep their colour.',
        tree: { file: 'TreeAtlas.png', species: entries(SPECIES_COUNT, i => SPECIES_NAMES[i], i => SPECIES_SPECS[i as Species].trunkColor) },
        stone: { file: 'StoneAtlas.png', shapes: entries(ROCK_SHAPE_COUNT, i => ROCK_NAMES[i]) },
        coverage: { tree: cellCoverage(treePng, tree), stone: cellCoverage(stonePng, stone) },
    };
    fs.writeFileSync(path.join(outDir, 'VegetationAtlases.json'), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`wrote TreeAtlas.png, StoneAtlas.png, VegetationAtlases.json to ${outDir}`);
}

main();
