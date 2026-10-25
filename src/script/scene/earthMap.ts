import * as THREE from 'three';

/**
 * The colour map the planet is drawn with from orbit, where no baked terrain
 * stands: NASA Blue Marble, cut by tools/prep_earth_tiles.py.
 *
 * The map at full resolution, 86400x43200, is far too big for one texture, so
 * it is a 4096x2048 base of the whole planet, always resident, and two levels
 * of tiles - 1.85 km and 463 m a pixel - each kept as a block round the point
 * under the camera in a texture array and refilled tile by tile as the camera
 * moves. The shell shader asks {@link EARTH_MAP_PARS_FRAGMENT}'s `earthAlbedo`
 * and gets the sharpest level that covers the ground and that the pixel can
 * use.
 */

const BASE_URL = 'assets/earth/base.jpg';
const BASE_ROWS = 2048;
/** Tile edge, pixels; must match tools/prep_earth_tiles.py. */
const TILE_PX = 675;
/** Tile fetches in flight at once, per level. */
const MAX_INFLIGHT = 4;

interface LevelSpec {
    /** Folder under assets/earth, and the uniforms' suffix. */
    name: string;
    cols: number;
    rows: number;
    /** The resident block is window x window tiles. */
    window: number;
    /** Rows of the next coarser level, which this one fades in over. */
    coarserRows: number;
    /** Camera height (m) above which the block stops following the camera. */
    maxHeightM: number;
}

/** Must match tools/prep_earth_tiles.py. */
const LEVELS: readonly LevelSpec[] = [
    // 1.85 km, 11.25 degree tiles: a block 67.5 degrees a side.
    { name: '1', cols: 32, rows: 16, window: 6, coarserRows: BASE_ROWS, maxHeightM: Infinity },
    // 463 m, 2.8 degree tiles: 17 degrees, about as far as a pixel can use them.
    { name: '2', cols: 128, rows: 64, window: 6, coarserRows: 16 * TILE_PX, maxHeightM: 1_500_000 },
];

export const EARTH_MAP_UNIFORMS: Record<string, THREE.IUniform> = {
    uEarthBase: { value: null as THREE.Texture | null },
};
for (const level of LEVELS) {
    EARTH_MAP_UNIFORMS[`uEarthDetail${level.name}`] = { value: null as THREE.DataArrayTexture | null };
    // Column and row of the block's first tile.
    EARTH_MAP_UNIFORMS[`uEarthOrigin${level.name}`] = { value: new THREE.Vector2() };
    // Texture-array layer holding each block cell, row-major, or -1.
    EARTH_MAP_UNIFORMS[`uEarthLayer${level.name}`] = { value: new Float32Array(level.window ** 2).fill(-1) };
}

function levelPars(l: LevelSpec): string {
    const f = (v: number) => v.toFixed(4);
    // This level's mip level for a base mip level, and the one past which the
    // coarser level is just as sharp; the tiles fade out over the level before.
    const offset = Math.log2(l.rows * TILE_PX / BASE_ROWS);
    const maxLod = Math.log2(l.rows * TILE_PX / l.coarserRows) + 0.6;
    const w = l.window;
    return `
  uniform highp sampler2DArray uEarthDetail${l.name};
  uniform vec2 uEarthOrigin${l.name};
  uniform float uEarthLayer${l.name}[${w * w}];

  vec3 earthLevel${l.name}(vec3 colour, vec2 uv, float baseLod) {
    float lod = baseLod + ${f(offset)};
    if (lod >= ${f(maxLod)}) {
      return colour;
    }
    vec2 cell = uv * vec2(${l.cols.toFixed(1)}, ${l.rows.toFixed(1)});
    vec2 tile = floor(cell);
    float ci = mod(tile.x - uEarthOrigin${l.name}.x, ${l.cols.toFixed(1)});
    float cj = tile.y - uEarthOrigin${l.name}.y;
    if (ci >= ${w.toFixed(1)} || cj < 0.0 || cj >= ${w.toFixed(1)}) {
      return colour;
    }
    float layer = uEarthLayer${l.name}[int(cj) * ${w} + int(ci)];
    if (layer < 0.0) {
      return colour;
    }
    vec3 detail = textureLod(uEarthDetail${l.name}, vec3(fract(cell), layer), max(lod, 0.0)).rgb;
    return mix(colour, detail, smoothstep(${f(maxLod)}, ${f(maxLod - 1)}, lod));
  }
`;
}

/**
 * `vec3 earthAlbedo(vec2 latLon, float footprint)`: linear surface colour at
 * a geodetic latitude and longitude (radians), filtered for a pixel covering
 * `footprint` metres of ground. Explicit mip levels throughout: the shell
 * calls it from non-uniform control flow, and the date line would break
 * hardware derivatives besides. Needs PI and A defined.
 */
export const EARTH_MAP_PARS_FRAGMENT = `
  uniform sampler2D uEarthBase;
${LEVELS.map(levelPars).join('')}
  vec3 earthAlbedo(vec2 ll, float footprint) {
    // u east from 180 W, v south from the north pole.
    vec2 uv = vec2(ll.y / (2.0 * PI) + 0.5, 0.5 - ll.x / PI);
    float baseLod = log2(max(footprint * ${BASE_ROWS.toFixed(1)} / (PI * A), 1e-6));
    // The base is an ordinary image texture, flipped on upload: north is v = 1.
    vec3 colour = textureLod(uEarthBase, vec2(uv.x, 1.0 - uv.y), baseLod).rgb;
${LEVELS.map(l => `    colour = earthLevel${l.name}(colour, uv, baseLod);\n`).join('')}    return colour;
  }
`;

/** One level's block of tiles round the camera, streamed into an array texture. */
class DetailLevel {
    private readonly texture: THREE.DataArrayTexture;
    private readonly layers: number;
    /** Tile key held by each layer, or -1. */
    private readonly layerTile: Int32Array;
    private readonly inflight = new Set<number>();
    private readonly failed = new Set<number>();
    private originCol = -1;
    private originRow = -1;
    /** Tiles of the current block, nearest the camera first. */
    private wanted: number[] = [];

    constructor(private readonly spec: LevelSpec) {
        this.layers = spec.window * spec.window;
        this.layerTile = new Int32Array(this.layers).fill(-1);
        const data = new Uint8Array(TILE_PX * TILE_PX * 4 * this.layers);
        const texture = new THREE.DataArrayTexture(data, TILE_PX, TILE_PX, this.layers);
        texture.format = THREE.RGBAFormat;
        texture.type = THREE.UnsignedByteType;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;
        this.texture = texture;
        EARTH_MAP_UNIFORMS[`uEarthDetail${spec.name}`].value = texture;
    }

    private key(col: number, row: number): number {
        return row * this.spec.cols + col;
    }

    /** Re-centre the block under the camera, geodetic degrees, and keep it filling. */
    update(latDeg: number, lonDeg: number, heightM: number): void {
        if (heightM > this.spec.maxHeightM) {
            return;
        }
        const { cols, rows, window } = this.spec;
        const tileDeg = 180 / rows;
        const x = (lonDeg + 180) / tileDeg;
        const y = (90 - latDeg) / tileDeg;
        const half = window / 2;
        // Move only once the camera is a whole tile off the block's centre, so
        // flying along a tile edge does not swap a column back and forth.
        let dx = x - (this.originCol + half);
        dx -= cols * Math.round(dx / cols);
        const rowTarget = THREE.MathUtils.clamp(Math.round(y - half), 0, rows - window);
        const rowOff = rowTarget !== this.originRow && Math.abs(y - (this.originRow + half)) > 1;
        if (this.originCol < 0 || Math.abs(dx) > 1 || rowOff) {
            this.recentre(x, rowTarget);
        }
        this.pump();
    }

    private recentre(x: number, row0: number): void {
        const { cols, window, name } = this.spec;
        const col0 = ((Math.round(x - window / 2) % cols) + cols) % cols;
        this.originCol = col0;
        this.originRow = row0;
        EARTH_MAP_UNIFORMS[`uEarthOrigin${name}`].value.set(col0, row0);
        const cy = row0 + window / 2;
        const cells: { key: number; d: number }[] = [];
        for (let j = 0; j < window; j++) {
            for (let i = 0; i < window; i++) {
                const col = (col0 + i) % cols;
                let ddx = col + 0.5 - x;
                ddx -= cols * Math.round(ddx / cols);
                const ddy = row0 + j + 0.5 - cy;
                cells.push({ key: this.key(col, row0 + j), d: ddx * ddx + ddy * ddy });
            }
        }
        cells.sort((a, b) => a.d - b.d);
        this.wanted = cells.map(c => c.key);
        this.publishLayers();
    }

    /** Point each block cell at the layer holding its tile. */
    private publishLayers(): void {
        const { cols, window, name } = this.spec;
        const layers = EARTH_MAP_UNIFORMS[`uEarthLayer${name}`].value as Float32Array;
        for (let j = 0; j < window; j++) {
            for (let i = 0; i < window; i++) {
                const key = this.key((this.originCol + i) % cols, this.originRow + j);
                layers[j * window + i] = this.layerTile.indexOf(key);
            }
        }
    }

    private pump(): void {
        for (const key of this.wanted) {
            if (this.inflight.size >= MAX_INFLIGHT) {
                return;
            }
            if (this.inflight.has(key) || this.failed.has(key) || this.layerTile.includes(key)) {
                continue;
            }
            this.inflight.add(key);
            this.load(key).catch(err => {
                this.failed.add(key);
                console.warn(`earth map tile ${this.spec.name}/${key} failed`, err);
            }).finally(() => this.inflight.delete(key));
        }
    }

    private async load(key: number): Promise<void> {
        const row = Math.floor(key / this.spec.cols);
        const col = key % this.spec.cols;
        const response = await fetch(`assets/earth/${this.spec.name}/r${row}c${col}.jpg`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const bitmap = await createImageBitmap(await response.blob(),
            { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;

        // The block may have moved on while this was in flight.
        if (!this.wanted.includes(key)) {
            return;
        }
        const layer = this.freeLayer();
        const data = this.texture.image.data as Uint8Array;
        data.set(pixels, layer * TILE_PX * TILE_PX * 4);
        this.layerTile[layer] = key;
        this.texture.addLayerUpdate(layer);
        this.texture.needsUpdate = true;
        this.publishLayers();
    }

    /** An empty layer, or one holding a tile the block no longer covers. */
    private freeLayer(): number {
        for (let i = 0; i < this.layers; i++) {
            if (this.layerTile[i] < 0 || !this.wanted.includes(this.layerTile[i])) {
                return i;
            }
        }
        // Unreachable: the block has as many cells as there are layers.
        return 0;
    }
}

/** The base map and its detail levels. */
export class EarthMap {
    private readonly levels = LEVELS.map(spec => new DetailLevel(spec));

    constructor() {
        const base = new THREE.TextureLoader().load(BASE_URL);
        base.colorSpace = THREE.SRGBColorSpace;
        // Longitude wraps; latitude ends at the poles.
        base.wrapS = THREE.RepeatWrapping;
        base.wrapT = THREE.ClampToEdgeWrapping;
        EARTH_MAP_UNIFORMS.uEarthBase.value = base;
    }

    /** Follow the point under the camera (geodetic degrees) at a height (m). */
    update(latDeg: number, lonDeg: number, heightM: number): void {
        for (const level of this.levels) {
            level.update(latDeg, lonDeg, heightM);
        }
    }
}

let instance: EarthMap | undefined;

/** The one map, made on first use. */
export function earthMap(): EarthMap {
    return instance ??= new EarthMap();
}
