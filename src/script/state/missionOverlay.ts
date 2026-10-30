/**
 * The waypoint editor's routes on the F12 map: per flight a line from its
 * start through its waypoints to its runway, the waypoints numbered. A
 * waypoint drags to move, and a click on the selected
 * one opens a menu beside it to add a waypoint after it or delete it;
 * everything else lets the pointer through to the map, whose double-clicks
 * the editor turns into waypoints.
 *
 * Redrawn when the view or the mission changes, from {@link MapView.pageOf}.
 */

import * as THREE from 'three';
import { Flight, FlightEndpoint } from '../mission/flightPlan';
import { MissionEditor, SELECTED_COLOUR, SelectedPoint, altitudeUnit, speedUnit } from '../mission/missionEditor';
import { Airfield } from '../terrain/airfields';
import { airfieldSymbolsSvg } from './airfieldSymbols';
import { MapView } from './mapView';

const SVG = 'http://www.w3.org/2000/svg';
const SELECTED = SELECTED_COLOUR;
const PLAYER = '#ffcc33';
const OTHER = '#d8e4ee';
/** A press on a waypoint moving less than this (px) selects it without moving it. */
const DRAG_SLOP_PX = 3;

/** A draggable waypoint, start or landing. */
const WP = 'mission-wp pointer-events-auto cursor-move';
/** A label outlined in the map's background so it reads over routes. */
const LABEL = 'mission-wp-label stroke-[#0d1a26] stroke-3 [paint-order:stroke]';
const MENU_ITEM = 'block w-full cursor-pointer border-0 bg-transparent px-3 py-1.5 text-left text-inherit hover:bg-white/10'
    + ' disabled:cursor-default'
    + ' disabled:opacity-40 disabled:hover:bg-transparent';

export class MissionOverlay {
    private readonly svg: SVGSVGElement;
    private drawn: unknown[] = [];
    private drag: {
        flight: number; point: SelectedPoint; x: number; y: number; moving: boolean;
        /** Already selected when pressed: a click (no drag) then opens the menu. */
        wasSelected: boolean;
    } | undefined;
    /** The selected point's menu, while open. */
    private menu: HTMLElement | undefined;

    constructor(
        private readonly map: MapView, private readonly editor: MissionEditor,
        private readonly camera: THREE.Camera,
        /** Airfields drawn under the routes as chart symbols (every area's); a new array when they load. */
        private readonly airfields: () => ReadonlyArray<{ airfield: Airfield }> = () => [],
    ) {
        this.svg = document.createElementNS(SVG, 'svg');
        this.svg.setAttribute('class', 'mission-overlay pointer-events-none fixed top-0 left-(--map-split) z-4 h-full'
            + ' w-[calc(100%-var(--map-split))] font-mono text-[11px] font-bold');
        document.body.appendChild(this.svg);
        map.onGroundDoubleClick = (lat, lon) => editor.clickMap(lat, lon);
        this.svg.addEventListener('pointerdown', e => {
            const at = pointOf(e.target);
            if (!at || e.button !== 0) {
                return;
            }
            const wasSelected = at.flight === editor.selected() && at.point === editor.selectedPoint();
            this.drag = { ...at, x: e.clientX, y: e.clientY, moving: false, wasSelected };
            this.closeMenu();
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
        window.addEventListener('pointerup', e => {
            const d = this.drag;
            this.drag = undefined;
            const marker = (e.target as Element | null)?.closest?.('[data-wp]');
            if (d && !d.moving && d.wasSelected && marker) {
                // Beside the symbol, not its label: the ring when selected, else the circle or square.
                const symbol = marker.querySelector('circle, rect') ?? marker;
                this.openMenu(d.flight, d.point, symbol.getBoundingClientRect());
            }
        });
        // A press anywhere but the menu closes it; so does Escape.
        window.addEventListener('pointerdown', e => {
            if (this.menu && !this.menu.contains(e.target as Node)) {
                this.closeMenu();
            }
        }, true);
        window.addEventListener('keydown', e => {
            if (this.menu && e.key === 'Escape') {
                this.closeMenu();
                e.stopPropagation();
            }
        }, true);
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
        // No browser menu over the markers; a right-click does nothing to a waypoint.
        this.svg.addEventListener('contextmenu', e => e.preventDefault());
    }

    /** Shown with the map, hidden while the game flies; the editor keeps its mission meanwhile. */
    setShown(on: boolean): void {
        this.svg.style.display = on ? '' : 'none';
        this.drag = undefined;
        this.closeMenu();
        this.drawn = [];
    }

    /** Per frame, after the map camera is placed. */
    update(): void {
        // The mission is replaced, never changed in place, so its identity says when it changed.
        const m = this.camera.matrixWorld.elements;
        const key = [this.map.viewVersion, m[12], m[13], m[14], m[8], m[10], window.innerWidth, window.innerHeight,
            document.body.style.getPropertyValue('--map-split'), this.editor.mission(), this.editor.selected(),
            this.editor.selectedPoint(), this.airfields(), this.editor.units()];
        if (key.every((v, i) => v === this.drawn[i])) {
            return;
        }
        // The menu belongs where the point was: gone once the view or the route moves.
        this.closeMenu();
        this.drawn = key;
        // Placed over the map only, so routes off its left edge do not run over the panel.
        const box = this.svg.getBoundingClientRect();
        const parts = [airfieldSymbolsSvg(this.airfields().map(a => a.airfield), (lat, lon, h) => this.map.pageOf(lat, lon, h),
            this.map.metresPerPixel, box.left, box.width, box.height)];
        this.editor.mission().flights.forEach((f, i) => parts.push(this.flightSvg(f, i)));
        this.svg.innerHTML = `<g transform="translate(${-box.left},0)">${parts.join('')}</g>`;
    }

    /** The menu of flight's `point` beside its marker at `box` (page px). */
    private openMenu(flight: number, point: SelectedPoint, box: DOMRect): void {
        this.closeMenu();
        const menu = this.menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        menu.className = 'fixed z-5 min-w-36 rounded border border-white/20 bg-[#0d1a26] py-1 text-sm text-white/90 shadow-lg';
        menu.style.left = `${box.right + 6}px`;
        menu.style.top = `${box.top}px`;
        const item = (label: string, enabled: boolean, run: () => void) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'menuitem');
            b.className = MENU_ITEM;
            b.textContent = label;
            b.disabled = !enabled;
            b.addEventListener('click', () => {
                this.closeMenu();
                run();
            });
            menu.appendChild(b);
        };
        item('Add waypoint', true, () => this.editor.addWaypointAfter(flight, point));
        // The takeoff is the flight's start: it can be moved, not deleted.
        item('Delete waypoint', point !== 'start', () => this.editor.deletePoint(flight, point));
        document.body.appendChild(menu);
        // On the left of the point instead where the right would run off the page.
        const width = menu.getBoundingClientRect().width;
        if (box.right + 6 + width > window.innerWidth) {
            menu.style.left = `${box.left - 6 - width}px`;
        }
    }

    private closeMenu(): void {
        this.menu?.remove();
        this.menu = undefined;
    }

    private flightSvg(f: Flight, i: number): string {
        const selected = i === this.editor.selected();
        const colour = selected ? SELECTED : f.control === 'player' ? PLAYER : OTHER;
        const at = (p: { lat: number; lon: number }) => this.map.pageOf(p.lat, p.lon);
        const alt = altitudeUnit(this.editor.units());
        const spd = speedUnit(this.editor.units());
        // Feet to the hundred, metres to the ten.
        const altStep = alt.label === 'ft' ? 100 : 10;
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
            out += `<g data-wp="${i},${j}" class="${WP}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">`
                + (picked ? `<circle r="14" fill="none" stroke="#ffffff" stroke-width="2"/>` : '')
                + `<circle r="9" fill="${picked ? colour : '#0d1a26'}" stroke="${colour}" stroke-width="2"/>`
                + `<text text-anchor="middle" dy="4" fill="${picked ? '#0d1a26' : colour}">${j + 2}</text>`
                + (selected ? `<text x="13" dy="4" class="${LABEL}" fill="${colour}">`
                    + `${Math.round(w.altM / alt.si / altStep) * altStep} ${alt.label} · `
                    + `${Math.round(w.speedMps / spd.si)} ${spd.label}</text>` : '')
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
        const drag = flight === undefined ? '' : ` data-wp="${flight},${kind}" class="${WP}"`;
        return `<g${drag} transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">`
            + (picked ? `<circle r="${r + 5}" fill="none" stroke="#ffffff" stroke-width="2"/>` : '')
            + `${shape} fill="${fill}" stroke="${colour}" stroke-width="${onRunway ? 3 : 2}"/>`
            // Numbered 1 like the panel's list; on a runway the chart symbol is inside instead.
            + (kind === 'start' && !onRunway
                ? `<text text-anchor="middle" dy="4" fill="${picked ? '#0d1a26' : colour}">1</text>` : '')
            + `<text x="${r + 4}" dy="4" class="${LABEL}" fill="${colour}">${escapeXml(text)}</text></g>`;
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
