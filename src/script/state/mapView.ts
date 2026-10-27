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
/** A press that moves less than this (px) is a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** A click waits this long (ms) for a second one: a double-click zooms and is no click. */
const CLICK_DELAY_MS = 250;

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

/** Whether this page was opened as the map; read once, at boot. */
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
    /** Scene position of a geodetic point on the ellipsoid. */
    worldOf(lat: number, lon: number): THREE.Vector3;
    /** Geodetic of a scene point on the ground straight below it. */
    geodeticOf(x: number, z: number): { lat: number; lon: number };
    /** Rewrite the page's camera route to this centre. */
    writeRoute(lat: number, lon: number): void;
    /** Ground point under a CSS pixel of the container, or undefined above the horizon. */
    groundAt(px: number, py: number): THREE.Vector3 | undefined;
}

export class MapView {
    private mpp: number;
    private tiltDeg: number;
    readonly aircraft?: MapAircraft;
    private readonly marker: HTMLElement;
    private readonly scaleBar: HTMLElement;
    private readonly scaleLabel: HTMLElement;
    private readonly cursor: HTMLElement;
    /** Share of the page's width the empty left pane takes. */
    private split = 0.5;
    private urlTimer = 0;
    private readonly _p = new THREE.Vector3();

    constructor(private readonly host: MapViewHost, search: string = location.search) {
        const q = new URLSearchParams(search);
        this.mpp = clampMpp(num(q, 'mpp') ?? DEFAULT_MPP);
        this.tiltDeg = clampTilt(num(q, 'tilt') ?? 0);
        const alat = num(q, 'alat');
        const alon = num(q, 'alon');
        if (alat !== undefined && alon !== undefined) {
            this.aircraft = { lat: alat, lon: alon, headingDeg: num(q, 'ahdg') };
        }
        document.body.classList.add('map-view');
        this.marker = el('div', 'map-aircraft');
        this.marker.innerHTML = '<svg width="20" height="24" viewBox="0 0 20 24">'
            + '<path d="M10 1 L18 22 L10 17 L2 22 Z" fill="#ffcc33" stroke="#000" stroke-width="1.5" '
            + 'stroke-linejoin="round" /></svg>';
        this.marker.classList.toggle('hidden', !this.aircraft);
        this.marker.classList.toggle('no-heading', this.aircraft?.headingDeg === undefined);
        const info = el('div', 'map-info');
        const scale = el('div', 'map-scale', info);
        this.scaleBar = el('div', 'map-scale-bar', scale);
        this.scaleLabel = el('span', '', scale);
        this.cursor = el('div', 'map-cursor', info);
        this.cursor.innerHTML = '&nbsp;';
        el('div', 'map-help').textContent =
            'drag to move · wheel or double-click to zoom · left+right drag to tilt · arrows / WASD · +/- · C centres the aircraft';
        this.setSplit(num(q, 'split') ?? this.split);
        this.bindPointer();
        const divider = el('div', 'map-divider');
        divider.addEventListener('pointerdown', e => divider.setPointerCapture(e.pointerId));
        divider.addEventListener('pointermove', e => {
            if (e.buttons & 1) {
                this.setSplit(e.clientX / window.innerWidth);
            }
        });
        divider.addEventListener('pointerup', () => this.scheduleUrl());
        // Dev aid, alongside __terrain: the map's camera and state.
        (globalThis as Record<string, unknown>).__mapView = this;
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

    /** A left click on the ground, not a drag or a double-click (the waypoint editor's). */
    onGroundClick: ((lat: number, lon: number) => void) | undefined;

    /** Page position of a point on the ground, or undefined behind the camera. */
    pageOf(lat: number, lon: number): { x: number; y: number } | undefined {
        const c = this.host.container;
        const p = this.host.worldOf(lat, lon).project(this.host.camera);
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
        let press: { x: number; y: number } | undefined;
        let clickTimer = 0;
        const local = (e: { clientX: number; clientY: number }): [number, number] => {
            const r = c.getBoundingClientRect();
            return [e.clientX - r.left, e.clientY - r.top];
        };
        // The right button is half of the tilt chord, not a menu.
        c.addEventListener('contextmenu', e => e.preventDefault());
        c.addEventListener('pointerdown', e => {
            c.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            press = pointers.size === 1 && e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined;
            c.classList.add('map-dragging');
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                pinch = Math.hypot(a.x - b.x, a.y - b.y);
            }
        });
        c.addEventListener('pointermove', e => {
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
            if (press && e.type === 'pointerup'
                && Math.hypot(e.clientX - press.x, e.clientY - press.y) < CLICK_SLOP_PX) {
                const at = this.geodeticAtPage(e.clientX, e.clientY);
                window.clearTimeout(clickTimer);
                clickTimer = window.setTimeout(() => at && this.onGroundClick?.(at.lat, at.lon), CLICK_DELAY_MS);
            }
            press = undefined;
            pointers.delete(e.pointerId);
            pinch = 0;
            if (pointers.size === 0) {
                c.classList.remove('map-dragging');
            }
        };
        c.addEventListener('pointerup', release);
        c.addEventListener('pointercancel', release);
        c.addEventListener('wheel', e => {
            e.preventDefault();
            // Lines and pages scroll in bigger steps than pixels.
            const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 500 : 1);
            this.zoomAt(Math.pow(WHEEL_ZOOM_PER_100PX, -dy / 100), ...local(e));
        }, { passive: false });
        c.addEventListener('dblclick', e => {
            window.clearTimeout(clickTimer);
            this.zoomAt(e.shiftKey ? 0.5 : 2, ...local(e));
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

function el(tag: string, cls: string, parent: HTMLElement = document.body): HTMLElement {
    const e = document.createElement(tag);
    if (cls) {
        e.className = cls;
    }
    parent.appendChild(e);
    return e;
}
