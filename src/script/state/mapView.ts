/**
 * The map mode (F12): the game's own renderer looking straight down through a
 * long lens, so the ground is seen almost in parallel projection.
 *
 * A true orthographic camera is not an option: the terrain picks its detail
 * by screen-space error from a perspective camera (quadtree.ts, lod.ts). A
 * MAP_FOV_DEG lens from high up keeps that working while the view stays close
 * to parallel: a 20 m house at the edge of the frame leans by about a metre.
 *
 * This holds the map's state - centre and metres per pixel - and its input:
 * drag and the wheel, arrows / WASD and +/-. The game owns the camera and
 * places it from {@link MapView.cameraHeightAboveGround} each frame.
 *
 * Opened as `index.html?map&@lat,lon` plus `mpp` (metres per pixel) and the
 * aircraft's `alat`, `alon`, `ahdg` for the marker; see {@link mapViewUrl}.
 * The map fills the right of the page; `split` is the share the empty left
 * pane takes, set by dragging the divider.
 */

import * as THREE from 'three';

/** Vertical field of view of the map camera, degrees. */
export const MAP_FOV_DEG = 6;
/** Terrain triangles a map frame may draw; see the call in Game.enterMapView. */
export const MAP_TRIANGLE_BUDGET = 2_000_000;
const MIN_MPP = 0.1;
const MAX_MPP = 3000;
const DEFAULT_MPP = 4;
/** One wheel notch (100 px of deltaY) zooms by this. */
const WHEEL_ZOOM_PER_100PX = Math.exp(0.15);
/** A key press moves the view by this much of its shorter side. */
const KEY_PAN_FRACTION = 0.25;
const URL_WRITE_DELAY_MS = 400;
/** Tilt from straight down, degrees: 0 is the map, the top a view toward the horizon. */
const MAX_TILT_DEG = 75;
/** Degrees of tilt per pixel dragged with both buttons down. */
const TILT_PER_PX = 0.25;

export interface MapAircraft {
    lat: number;
    lon: number;
    /** Degrees clockwise from north; omit for a dot instead of an arrow. */
    headingDeg?: number;
}

export interface MapViewParams {
    lat: number;
    lon: number;
    metresPerPixel?: number;
    aircraft?: MapAircraft;
}

/** The map mode's address: the game page with a camera route and the map's own parameters. */
export function mapViewUrl(p: MapViewParams): string {
    const q = new URLSearchParams();
    q.set('map', '1');
    if (p.metresPerPixel !== undefined) {
        q.set('mpp', p.metresPerPixel.toPrecision(4));
    }
    if (p.aircraft) {
        q.set('alat', p.aircraft.lat.toFixed(6));
        q.set('alon', p.aircraft.lon.toFixed(6));
        if (p.aircraft.headingDeg !== undefined) {
            q.set('ahdg', p.aircraft.headingDeg.toFixed(1));
        }
    }
    // The camera route is the game's own (cameraRoute.ts): t = 0 is straight down.
    return `index.html?${q.toString()}&@${p.lat.toFixed(6)},${p.lon.toFixed(6)},10000a,0h,0t`;
}

/** Whether this URL is the map's. */
export function isMapViewPage(search: string = location.search): boolean {
    return new URLSearchParams(search).has('map');
}

function num(q: URLSearchParams, k: string): number | undefined {
    const s = q.get(k);
    const v = s === null ? NaN : Number(s);
    return Number.isFinite(v) ? v : undefined;
}

export interface MapViewHost {
    /** The element the scene is drawn into; input is read off it. */
    container: HTMLElement;
    camera: THREE.PerspectiveCamera;
    /** Move the view centre by scene metres (x east, z south). */
    pan(dx: number, dz: number): void;
    /** The view centre, in scene metres. */
    centre(): THREE.Vector3;
    /** Scene position of a geodetic point, `heightM` above the ellipsoid (0 when not given). */
    worldOf(lat: number, lon: number, heightM?: number): THREE.Vector3;
    /** Geodetic of a scene point on the ground straight below it. */
    geodeticOf(x: number, z: number): { lat: number; lon: number };
    /** Rewrite the page's camera route to this centre. */
    writeRoute(lat: number, lon: number): void;
    /** Ground point under a CSS pixel of the container, or undefined above the horizon. */
    groundAt(px: number, py: number): THREE.Vector3 | undefined;
}

export class MapView {
    private mpp = DEFAULT_MPP;
    private tiltDeg = 0;
    aircraft?: MapAircraft;
    /** Shown and taking input; see open and close. */
    private shown = false;
    /** The map's own elements, hidden while it is closed. */
    private readonly parts: HTMLElement[] = [];
    private readonly marker: HTMLElement;
    private readonly scaleBar: HTMLElement;
    private readonly scaleLabel: HTMLElement;
    private readonly cursor: HTMLElement;
    /** Share of the page's width the empty left pane takes. */
    private split = 0.5;
    private urlTimer = 0;
    private readonly _p = new THREE.Vector3();

    /** Built once, closed; {@link open} shows it. */
    constructor(private readonly host: MapViewHost) {
        this.marker = el('div', 'map-aircraft pointer-events-none fixed -top-3 -left-2.5 z-5 h-6 w-5 origin-[10px_12px]'
            // No heading: a dot in place of the arrow.
            + ' [&.no-heading_svg]:hidden after:hidden [&.no-heading]:after:block after:absolute after:top-1.5 after:left-1'
            + ' after:size-3 after:box-border after:rounded-full after:border-2 after:border-black after:bg-[#ffcc33]');
        this.marker.innerHTML = '<svg width="20" height="24" viewBox="0 0 20 24">'
            + '<path d="M10 1 L18 22 L10 17 L2 22 Z" fill="#ffcc33" stroke="#000" stroke-width="1.5" '
            + 'stroke-linejoin="round" /></svg>';
        const info = el('div', `map-info ${PANEL} left-[calc(var(--map-split)+12px)] flex flex-col gap-1`
            + ' text-[13px]/[1.3] text-[#d8e4ee]');
        const scale = el('div', 'map-scale flex items-center gap-2', info);
        this.scaleBar = el('div', 'map-scale-bar h-1.5 border-2 border-t-0 border-[#d8e4ee]', scale);
        this.scaleLabel = el('span', '', scale);
        this.cursor = el('div', 'map-cursor', info);
        this.cursor.innerHTML = '&nbsp;';
        const help = el('div', `map-help ${PANEL} right-3 text-[12px]/[1.3] text-[#8aa0b2]`
            // Wraps rather than covering the scale bar when the split leaves the map narrow.
            + ' max-w-[calc(100%-var(--map-split)-280px)]');
        help.textContent =
            'drag to move · wheel or +/- to zoom · double-click adds a waypoint · left+right drag to tilt · arrows / WASD'
            + ' · C centres the aircraft';
        this.bindPointer();
        const divider = el('div', 'map-divider fixed inset-y-0 left-(--map-split) z-6 -ml-[3px] w-1.5 cursor-col-resize touch-none'
            + ' bg-[#3c5468] hover:bg-[#8aa0b2]');
        divider.addEventListener('pointerdown', e => divider.setPointerCapture(e.pointerId));
        divider.addEventListener('pointermove', e => {
            if (e.buttons & 1) {
                this.setSplit(e.clientX / window.innerWidth);
            }
        });
        divider.addEventListener('pointerup', () => this.scheduleUrl());
        this.parts.push(info, help, divider);
        // Inline: .map-info's own display would win over .hidden.
        for (const p of this.parts) {
            p.style.display = 'none';
        }
        this.marker.classList.add('hidden');
        // Dev aid, alongside __terrain: the map's camera and state.
        (globalThis as Record<string, unknown>).__mapView = this;
    }

    get isOpen(): boolean {
        return this.shown;
    }

    /** Show the map with the zoom, tilt, split and aircraft marker `search` gives (mapViewUrl). */
    open(search: string = location.search): void {
        const q = new URLSearchParams(search);
        this.mpp = clampMpp(num(q, 'mpp') ?? DEFAULT_MPP);
        this.tiltDeg = clampTilt(num(q, 'tilt') ?? 0);
        const alat = num(q, 'alat');
        const alon = num(q, 'alon');
        this.aircraft = alat !== undefined && alon !== undefined
            ? { lat: alat, lon: alon, headingDeg: num(q, 'ahdg') } : undefined;
        this.shown = true;
        document.body.classList.add('map-view');
        for (const p of this.parts) {
            p.style.display = '';
        }
        this.marker.classList.toggle('hidden', !this.aircraft);
        this.marker.classList.toggle('no-heading', this.aircraft?.headingDeg === undefined);
        this.viewVersion++;
        this.setSplit(num(q, 'split') ?? this.split);
    }

    /** Hide it and give the page back to the game; its state is read again on the next open. */
    close(): void {
        this.shown = false;
        window.clearTimeout(this.urlTimer);
        document.body.classList.remove('map-view');
        for (const p of this.parts) {
            p.style.display = 'none';
        }
        this.marker.classList.add('hidden');
        this.host.container.classList.remove('map-dragging');
        window.dispatchEvent(new Event('resize'));
    }

    /** Camera height above the ground under the centre, for this zoom. */
    cameraHeightAboveGround(): number {
        const heightPx = this.host.container.clientHeight || 1;
        return (this.mpp * heightPx) / (2 * Math.tan(THREE.MathUtils.degToRad(MAP_FOV_DEG) / 2));
    }

    get metresPerPixel(): number {
        return this.mpp;
    }

    /** Tilt from straight down, radians; the camera orbits the centre southward to look north. */
    get tiltRad(): number {
        return THREE.MathUtils.degToRad(this.tiltDeg);
    }

    tiltBy(deg: number): void {
        this.tiltDeg = clampTilt(this.tiltDeg + deg);
        this.scheduleUrl();
    }

    /** Zoom by `factor` (>1 = in), keeping the ground under (px, py) still. */
    zoomAt(factor: number, px?: number, py?: number): void {
        const c = this.host.container;
        const ox = (px ?? c.clientWidth / 2) - c.clientWidth / 2;
        const oy = (py ?? c.clientHeight / 2) - c.clientHeight / 2;
        const before = this.mpp;
        this.mpp = clampMpp(this.mpp / factor);
        this.host.pan(ox * (before - this.mpp), oy * (before - this.mpp));
        this.scheduleUrl();
    }

    panPixels(dx: number, dy: number): void {
        // Tilted, a pixel up the screen covers more ground: 1 / cos(tilt) at the centre.
        this.host.pan(-dx * this.mpp, -dy * this.mpp / Math.cos(this.tiltRad));
        this.scheduleUrl();
    }

    recentre(): void {
        if (!this.aircraft) {
            return;
        }
        const a = this.host.worldOf(this.aircraft.lat, this.aircraft.lon);
        const c = this.host.centre();
        this.host.pan(a.x - c.x, a.z - c.z);
        this.scheduleUrl();
    }

    /** True when the key was the map's; the caller then stops it going further. */
    handleKey(event: KeyboardEvent): boolean {
        const c = this.host.container;
        const step = Math.min(c.clientWidth, c.clientHeight) * KEY_PAN_FRACTION;
        switch (event.code) {
            case 'ArrowUp': case 'KeyW': this.panPixels(0, step); return true;
            case 'ArrowDown': case 'KeyS': this.panPixels(0, -step); return true;
            case 'ArrowLeft': case 'KeyA': this.panPixels(step, 0); return true;
            case 'ArrowRight': case 'KeyD': this.panPixels(-step, 0); return true;
            case 'Equal': case 'NumpadAdd': case 'PageUp': this.zoomAt(2); return true;
            case 'Minus': case 'NumpadSubtract': case 'PageDown': this.zoomAt(0.5); return true;
            case 'KeyC': case 'Home': this.recentre(); return true;
            default: return false;
        }
    }

    /** Per frame, after the camera is placed: the marker and the scale bar. */
    updateOverlay(): void {
        const c = this.host.container;
        if (this.aircraft) {
            const p = this.host.worldOf(this.aircraft.lat, this.aircraft.lon).project(this.host.camera);
            const sx = (p.x * 0.5 + 0.5) * c.clientWidth;
            const sy = (-p.y * 0.5 + 0.5) * c.clientHeight;
            // The marker is placed on the page; the map starts after the left pane.
            this.marker.style.transform =
                `translate(${sx + c.offsetLeft}px, ${sy}px) rotate(${this.aircraft.headingDeg ?? 0}deg)`;
        }
        // A round length about a sixth of the screen wide.
        const target = (c.clientWidth / 6) * this.mpp;
        const pow = Math.pow(10, Math.floor(Math.log10(target)));
        const len = [5, 2, 1].map(f => f * pow).find(v => v <= target) ?? pow;
        this.scaleBar.style.width = `${len / this.mpp}px`;
        this.scaleLabel.textContent = len >= 1000 ? `${len / 1000} km` : `${len} m`;
    }

    /** Neither side narrower than 15 %; the renderer and game resize from the container on 'resize'. */
    private setSplit(v: number): void {
        this.split = Math.max(0.15, Math.min(0.85, v));
        document.body.style.setProperty('--map-split', `${this.split * 100}%`);
        window.dispatchEvent(new Event('resize'));
    }

    /** Bumped on every pan, zoom and tilt; see Game.fitMapDetail. */
    viewVersion = 0;

    /** A double-click on the ground (the waypoint editor's); without one a double-click zooms. */
    onGroundDoubleClick: ((lat: number, lon: number) => void) | undefined;

    /**
     * Page position of a point on the ground, or undefined behind the camera.
     * `heightM` is the ground's height there: on a tilted map a point drawn at
     * 0 slides off ground that stands higher.
     */
    pageOf(lat: number, lon: number, heightM = 0): { x: number; y: number } | undefined {
        const c = this.host.container;
        const p = this.host.worldOf(lat, lon, heightM).project(this.host.camera);
        if (p.z > 1) {
            return undefined;
        }
        return { x: c.offsetLeft + (p.x * 0.5 + 0.5) * c.clientWidth, y: (-p.y * 0.5 + 0.5) * c.clientHeight };
    }

    /** The ground under a page position, or undefined above the horizon. */
    geodeticAtPage(x: number, y: number): { lat: number; lon: number } | undefined {
        const r = this.host.container.getBoundingClientRect();
        const p = this.host.groundAt(x - r.left, y - r.top);
        return p && this.host.geodeticOf(p.x, p.z);
    }

    private scheduleUrl(): void {
        this.viewVersion++;
        window.clearTimeout(this.urlTimer);
        this.urlTimer = window.setTimeout(() => {
            const c = this.host.centre();
            const g = this.host.geodeticOf(c.x, c.z);
            this.host.writeRoute(g.lat, g.lon);
            // By hand: URLSearchParams would percent-encode the route's `@lat,lon` key.
            let search = withParam(location.search, 'mpp', this.mpp.toPrecision(4));
            search = withParam(search, 'tilt', this.tiltDeg.toFixed(1));
            search = withParam(search, 'split', this.split.toFixed(2));
            history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);
        }, URL_WRITE_DELAY_MS);
    }

    private bindPointer(): void {
        const c = this.host.container;
        const pointers = new Map<number, { x: number; y: number }>();
        let pinch = 0;
        const local = (e: { clientX: number; clientY: number }): [number, number] => {
            const r = c.getBoundingClientRect();
            return [e.clientX - r.left, e.clientY - r.top];
        };
        // The right button is half of the tilt chord, not a menu.
        c.addEventListener('contextmenu', e => {
            if (this.shown) {
                e.preventDefault();
            }
        });
        c.addEventListener('pointerdown', e => {
            if (!this.shown) {
                return;
            }
            c.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            c.classList.add('map-dragging');
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                pinch = Math.hypot(a.x - b.x, a.y - b.y);
            }
        });
        c.addEventListener('pointermove', e => {
            if (!this.shown) {
                return;
            }
            this.showCursor(...local(e));
            const prev = pointers.get(e.pointerId);
            if (!prev) {
                return;
            }
            const cur = { x: e.clientX, y: e.clientY };
            pointers.set(e.pointerId, cur);
            // Left and right together tilt: up the screen tips the view toward the horizon.
            if (pointers.size === 1 && (e.buttons & 3) === 3) {
                this.tiltBy((prev.y - cur.y) * TILT_PER_PX);
            } else if (pointers.size === 1 && (e.buttons & 1) !== 0) {
                this.panPixels(cur.x - prev.x, cur.y - prev.y);
            } else if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                if (pinch > 0 && d > 0) {
                    this.zoomAt(d / pinch, ...local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }));
                }
                pinch = d;
            }
        });
        const release = (e: PointerEvent): void => {
            pointers.delete(e.pointerId);
            if (!this.shown) {
                pointers.clear();
            }
            pinch = 0;
            if (pointers.size === 0) {
                c.classList.remove('map-dragging');
            }
        };
        c.addEventListener('pointerup', release);
        c.addEventListener('pointercancel', release);
        c.addEventListener('wheel', e => {
            if (!this.shown) {
                return;
            }
            e.preventDefault();
            // Lines and pages scroll in bigger steps than pixels.
            const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 500 : 1);
            this.zoomAt(Math.pow(WHEEL_ZOOM_PER_100PX, -dy / 100), ...local(e));
        }, { passive: false });
        c.addEventListener('dblclick', e => {
            if (!this.shown) {
                return;
            }
            const at = this.onGroundDoubleClick && this.geodeticAtPage(e.clientX, e.clientY);
            if (at) {
                this.onGroundDoubleClick!(at.lat, at.lon);
            } else if (!this.onGroundDoubleClick) {
                this.zoomAt(e.shiftKey ? 0.5 : 2, ...local(e));
            }
        });
    }

    private showCursor(px: number, py: number): void {
        const p = this.host.groundAt(px, py);
        if (!p) {
            this.cursor.innerHTML = '&nbsp;';
            return;
        }
        const g = this.host.geodeticOf(p.x, p.z);
        this.cursor.textContent = `${formatDeg(g.lat, 'N', 'S')}  ${formatDeg(g.lon, 'E', 'W')}`;
    }
}

function clampMpp(v: number): number {
    return Math.max(MIN_MPP, Math.min(MAX_MPP, v));
}

function clampTilt(deg: number): number {
    return Math.max(0, Math.min(MAX_TILT_DEG, deg));
}

/** A query string with one parameter set, by hand: URLSearchParams would encode the route's `@` key. */
function withParam(search: string, key: string, value: string): string {
    const re = new RegExp(`([?&])${key}=[^&]*`);
    return re.test(search)
        ? search.replace(re, `$1${key}=${value}`)
        : `${search}${search ? '&' : '?'}${key}=${value}`;
}

function formatDeg(v: number, pos: string, neg: string): string {
    return `${Math.abs(v).toFixed(5)}°${v >= 0 ? pos : neg}`;
}

/** The map's info and help boxes in the bottom corners. */
const PANEL = 'pointer-events-none fixed bottom-3 z-5 rounded border border-[#3c5468] bg-[rgba(12,18,26,0.82)] px-2 py-1.5'
    + ' font-mono font-normal';

function el(tag: string, cls: string, parent: HTMLElement = document.body): HTMLElement {
    const e = document.createElement(tag);
    if (cls) {
        e.className = cls;
    }
    parent.appendChild(e);
    return e;
}
