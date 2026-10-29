/**
 * The waypoint editor's routes on the F12 map: per flight a line from its
 * start through its waypoints to its runway, the waypoints numbered. A
 * waypoint drags to move and right-clicks away; everything else lets the
 * pointer through to the map, whose clicks the editor turns into waypoints.
 *
 * Redrawn when the view or the mission changes, from {@link MapView.pageOf}.
 */

import * as THREE from 'three';
import { Flight, FlightEndpoint } from '../mission/flightPlan';
import { FT, MissionEditor, SelectedPoint } from '../mission/missionEditor';
import { Airfield } from '../terrain/airfields';
import { airfieldSymbolsSvg } from './airfieldSymbols';
import { MapView } from './mapView';

const SVG = 'http://www.w3.org/2000/svg';
const SELECTED = '#4dd0e1';
const PLAYER = '#ffcc33';
const OTHER = '#d8e4ee';
/** A press on a waypoint moving less than this (px) selects it without moving it. */
const DRAG_SLOP_PX = 3;

export class MissionOverlay {
    private readonly svg: SVGSVGElement;
    private drawn: unknown[] = [];
    private drag: { flight: number; point: SelectedPoint; x: number; y: number; moving: boolean } | undefined;

    constructor(
        private readonly map: MapView, private readonly editor: MissionEditor,
        private readonly camera: THREE.Camera,
        /** Airfields drawn under the routes as chart symbols (every area's); a new array when they load. */
        private readonly airfields: () => ReadonlyArray<{ airfield: Airfield }> = () => [],
    ) {
        this.svg = document.createElementNS(SVG, 'svg');
        this.svg.classList.add('mission-overlay');
        document.body.appendChild(this.svg);
        map.onGroundClick = (lat, lon) => editor.clickMap(lat, lon);
        this.svg.addEventListener('pointerdown', e => {
            const at = pointOf(e.target);
            if (!at || e.button !== 0) {
                return;
            }
            this.drag = { ...at, x: e.clientX, y: e.clientY, moving: false };
            editor.selectPoint(at.flight, at.point);
            e.preventDefault();
        });
        window.addEventListener('pointermove', e => {
            const d = this.drag;
            if (!d || !(d.moving ||= Math.hypot(e.clientX - d.x, e.clientY - d.y) >= DRAG_SLOP_PX)) {
                return;
            }
            const g = map.geodeticAtPage(e.clientX, e.clientY);
            if (!g) {
                return;
            }
            if (d.point === 'start') {
                editor.moveStart(d.flight, g.lat, g.lon);
            } else if (d.point === 'land') {
                editor.moveLand(d.flight, g.lat, g.lon);
            } else {
                editor.moveWaypoint(d.flight, d.point, g.lat, g.lon);
            }
        });
        window.addEventListener('pointerup', () => { this.drag = undefined; });
        // Delete or Backspace removes the selected waypoint or landing, unless a field of the panel has the keys.
        window.addEventListener('keydown', e => {
            const j = editor.selectedPoint();
            if (!this.map.isOpen || (e.key !== 'Delete' && e.key !== 'Backspace') || j === undefined || j === 'start'
                || (e.target as Element | null)?.closest?.('input, textarea, mat-select')) {
                return;
            }
            if (j === 'land') {
                editor.clearLanding(editor.selected());
            } else {
                editor.removeWaypoint(editor.selected(), j);
            }
            e.preventDefault();
        });
        this.svg.addEventListener('contextmenu', e => {
            const at = pointOf(e.target);
            e.preventDefault();
            if (at && typeof at.point === 'number') {
                editor.removeWaypoint(at.flight, at.point);
            }
        });
    }

    /** Shown with the map, hidden while the game flies; the editor keeps its mission meanwhile. */
    setShown(on: boolean): void {
        this.svg.style.display = on ? '' : 'none';
        this.drag = undefined;
        this.drawn = [];
    }

    /** Per frame, after the map camera is placed. */
    update(): void {
        // The mission is replaced, never changed in place, so its identity says when it changed.
        const m = this.camera.matrixWorld.elements;
        const key = [this.map.viewVersion, m[12], m[13], m[14], m[8], m[10], window.innerWidth, window.innerHeight,
            document.body.style.getPropertyValue('--map-split'), this.editor.mission(), this.editor.selected(),
            this.editor.selectedPoint(), this.airfields()];
        if (key.every((v, i) => v === this.drawn[i])) {
            return;
        }
        this.drawn = key;
        // Placed over the map only, so routes off its left edge do not run over the panel.
        const box = this.svg.getBoundingClientRect();
        const parts = [airfieldSymbolsSvg(this.airfields().map(a => a.airfield), (lat, lon, h) => this.map.pageOf(lat, lon, h),
            this.map.metresPerPixel, box.left, box.width, box.height)];
        this.editor.mission().flights.forEach((f, i) => parts.push(this.flightSvg(f, i)));
        this.svg.innerHTML = `<g transform="translate(${-box.left},0)">${parts.join('')}</g>`;
    }

    private flightSvg(f: Flight, i: number): string {
        const selected = i === this.editor.selected();
        const colour = selected ? SELECTED : f.control === 'player' ? PLAYER : OTHER;
        const at = (p: { lat: number; lon: number }) => this.map.pageOf(p.lat, p.lon);
        const line = [f.start, ...f.waypoints, ...(f.land ? [f.land] : [])].map(at)
            .filter((p): p is { x: number; y: number } => p !== undefined);
        let out = `<g opacity="${selected ? 1 : 0.6}">`;
        if (line.length > 1) {
            out += `<polyline points="${line.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" `
                + `fill="none" stroke="${colour}" stroke-width="2" stroke-dasharray="${selected ? '' : '6 4'}"/>`;
        }
        out += this.endpointSvg(f.start, colour, 'start', f.name, i, selected && this.editor.selectedPoint() === 'start');
        if (f.land) {
            out += this.endpointSvg(f.land, colour, 'land', undefined, i, selected && this.editor.selectedPoint() === 'land');
        }
        f.waypoints.forEach((w, j) => {
            const p = at(w);
            if (!p) {
                return;
            }
            // The selected one filled in, and a ring round it.
            const picked = selected && j === this.editor.selectedPoint();
            out += `<g data-wp="${i},${j}" class="mission-wp" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">`
                + (picked ? `<circle r="14" fill="none" stroke="#ffffff" stroke-width="2"/>` : '')
                + `<circle r="9" fill="${picked ? colour : '#0d1a26'}" stroke="${colour}" stroke-width="2"/>`
                + `<text text-anchor="middle" dy="4" fill="${picked ? '#0d1a26' : colour}">${j + 1}</text>`
                + (selected ? `<text x="13" dy="4" class="mission-wp-label" fill="${colour}">`
                    + `${Math.round(w.altM / FT / 100) * 100} ft · ${Math.round(w.speedMps / 0.514444)} kt</text>` : '')
                + '</g>';
        });
        return `${out}</g>`;
    }

    /** A start or a landing, draggable when `flight` (its index) is given. */
    private endpointSvg(
        e: FlightEndpoint, colour: string, kind: 'start' | 'land', name?: string, flight?: number, picked = false,
    ): string {
        const p = this.map.pageOf(e.lat, e.lon);
        if (!p) {
            return '';
        }
        // On a runway: a hollow ring round the airfield's chart symbol, which a
        // filled marker would hide. In the air the start is drawn like any waypoint.
        const onRunway = e.kind === 'runway';
        const r = onRunway ? 17 : 9;
        const shape = onRunway || kind === 'start'
            ? `<circle r="${r}"`
            : '<rect x="-7" y="-7" width="14" height="14"';
        // Transparent, not none: the inside still grabs the pointer for dragging.
        const fill = onRunway ? 'transparent' : picked ? colour : '#0d1a26';
        const label = kind === 'start' ? name ?? '' : onRunway ? e.designator : '';
        const text = kind === 'start' && onRunway ? `${label} · ${e.airfield} ${e.designator}` : label;
        const drag = flight === undefined ? '' : ` data-wp="${flight},${kind}" class="mission-wp"`;
        return `<g${drag} transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">`
            + (picked ? `<circle r="${r + 5}" fill="none" stroke="#ffffff" stroke-width="2"/>` : '')
            + `${shape} fill="${fill}" stroke="${colour}" stroke-width="${onRunway ? 3 : 2}"/>`
            // Numbered 0 like the panel's list; on a runway the chart symbol is inside instead.
            + (kind === 'start' && !onRunway
                ? `<text text-anchor="middle" dy="4" fill="${picked ? '#0d1a26' : colour}">0</text>` : '')
            + `<text x="${r + 4}" dy="4" class="mission-wp-label" fill="${colour}">${escapeXml(text)}</text></g>`;
    }
}

/** The flight and point a marker under the pointer stands for (`data-wp="flight,index|start"`). */
function pointOf(target: EventTarget | null): { flight: number; point: SelectedPoint } | undefined {
    const [flight, point] = (target as Element | null)?.closest?.('[data-wp]')?.getAttribute('data-wp')?.split(',') ?? [];
    return flight === undefined ? undefined
        : { flight: Number(flight), point: point === 'start' || point === 'land' ? point : Number(point) };
}

function escapeXml(s: string): string {
    return s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}
