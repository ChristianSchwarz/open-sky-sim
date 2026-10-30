import { computed, signal } from '@angular/core';
import { Flight, FlightEndpoint, MAX_ALT_M, MAX_FLIGHTS, MAX_SPEED_MPS, MISSION_VERSION, Mission, Waypoint, validateMission } from './flightPlan';
import * as store from './missionStore';
import { missionUrl } from '../state/appRoute';
import { UnitSystems } from '../state/gameDefs';

/** What a click on the map does: add a waypoint to the selected flight, or set its start or landing. */
export type PickMode = 'waypoint' | 'start' | 'land';
/** A point of the selected flight: a waypoint by its index, its start or its landing. */
export type SelectedPoint = number | 'start' | 'land';

/** The selected flight's route on the map, and its selected point's card in the panel. */
export const SELECTED_COLOUR = '#4dd0e1';

export const FT = 0.3048;
export const KT = 0.514444;
const KMH = 1 / 3.6;

/** A unit altitudes or speeds are shown in: SI (m, m/s) per unit, and its label. */
export interface DisplayUnit {
    si: number;
    label: string;
}

/** Altitudes in the settings' unit system: metres or feet. */
export function altitudeUnit(units: UnitSystems): DisplayUnit {
    return units === UnitSystems.IMPERIAL ? { si: FT, label: 'ft' } : { si: 1, label: 'm' };
}

/** Speeds in the settings' unit system: km/h or knots. */
export function speedUnit(units: UnitSystems): DisplayUnit {
    return units === UnitSystems.IMPERIAL ? { si: KT, label: 'kt' } : { si: KMH, label: 'km/h' };
}

/** One end of a runway the editor can start a flight from or land it on. */
export interface RunwayEnd {
    /** activeAirfield.runwayKey of its airfield. */
    airfield: string;
    designator: string;
    /** Its middle. */
    lat: number;
    lon: number;
}

/** What the editor needs from the game page it runs in. */
export interface MissionEditorHost {
    /** Aircraft that can be picked, by FlyableAircraftDef id. */
    aircraft: ReadonlyArray<{ id: string; name: string }>;
    /** The one flown when nothing else is chosen. */
    defaultAircraftId: string;
    /** The terrain area the page shows. */
    area: string;
    /** The view centre, where a new flight starts. */
    centre(): { lat: number; lon: number };
    /** The runway end a click at (lat, lon) means, if it was on or by one. */
    runwayEndAt(lat: number, lon: number): RunwayEnd | undefined;
    /** Every runway end that can be picked from a list, both directions of each runway. */
    runwayEnds(): RunwayEnd[];
    /** Fly the saved mission `id` in this page; without it the page is reloaded onto it. */
    fly?(id: string, mission: Mission): void;
}

/**
 * The waypoint editor's state (F12 map): the mission being edited, which
 * flight is selected and what a click on the map does. Signals, so the panel
 * (ui/mission/missionPanel.ts) and the map overlay (state/missionOverlay.ts)
 * both follow it.
 */
export class MissionEditor {
    readonly mission = signal<Mission>({ version: MISSION_VERSION, name: 'New mission', flights: [] });
    readonly selected = signal(0);
    /** The selected flight's selected point: highlighted and dragged; a click adds a waypoint after it, Delete removes a waypoint. */
    readonly selectedPoint = signal<SelectedPoint | undefined>(undefined);
    readonly pick = signal<PickMode>('waypoint');
    /** Last save, load or validation message. */
    readonly status = signal('');
    readonly saved = signal<store.MissionSummary[]>([]);
    /** False on a page without the dev server: nothing can be saved or flown. */
    readonly serverAvailable = signal(false);
    readonly errors = computed(() => validateMission(this.mission()));
    /** The settings' unit system, which altitudes and speeds are shown and typed in. */
    readonly units = signal(UnitSystems.METRIC);

    /** A new point's altitude and speed: round numbers in the units shown. */
    private get defaultAltM(): number {
        return this.units() === UnitSystems.IMPERIAL ? 10_000 * FT : 3_000;
    }

    private get defaultSpeedMps(): number {
        return this.units() === UnitSystems.IMPERIAL ? 350 * KT : 650 * KMH;
    }

    constructor(readonly host: MissionEditorHost) {
        this.mission.update(m => ({ ...m, area: host.area }));
        void store.missionsAvailable().then(ok => {
            this.serverAvailable.set(ok);
            if (ok) {
                void this.refreshSaved();
            } else {
                this.status.set('Missions are saved on the dev server (npm start); this page has none.');
            }
        });
    }

    /** Replace the mission with `fn` applied to a copy, so every change is a new value for the signals. */
    private edit(fn: (m: Mission) => void): void {
        const m = structuredClone(this.mission());
        fn(m);
        this.mission.set(m);
    }

    setName(name: string): void {
        this.edit(m => { m.name = name; });
    }

    addFlight(): void {
        if (this.mission().flights.length >= MAX_FLIGHTS) {
            return;
        }
        const c = this.host.centre();
        this.edit(m => m.flights.push({
            name: `Flight ${m.flights.length + 1}`,
            aircraftId: this.host.defaultAircraftId,
            control: m.flights.some(f => f.control === 'player') ? 'ai' : 'player',
            start: { kind: 'air', lat: c.lat, lon: c.lon, altM: this.defaultAltM, speedMps: this.defaultSpeedMps, headingDeg: 0 },
            waypoints: [],
        }));
        this.selectFlight(this.mission().flights.length - 1);
        this.pick.set('waypoint');
    }

    selectFlight(i: number): void {
        if (i !== this.selected()) {
            this.selected.set(i);
            this.selectedPoint.set(undefined);
        }
    }

    selectPoint(i: number, j: SelectedPoint | undefined): void {
        this.selectFlight(i);
        this.selectedPoint.set(j);
    }

    removeFlight(i: number): void {
        this.edit(m => { m.flights.splice(i, 1); });
        this.selected.set(Math.max(0, Math.min(this.selected(), this.mission().flights.length - 1)));
        this.selectedPoint.set(undefined);
    }

    updateFlight(i: number, patch: Partial<Flight>): void {
        this.edit(m => {
            Object.assign(m.flights[i], patch);
            // One player flight: choosing one hands the others to the AI.
            if (patch.control === 'player') {
                m.flights.forEach((f, j) => { if (j !== i) f.control = 'ai'; });
            }
        });
    }

    updateWaypoint(i: number, j: number, patch: Partial<Waypoint>): void {
        this.edit(m => { Object.assign(m.flights[i].waypoints[j], clampFlight(patch)); });
    }

    removeWaypoint(i: number, j: number): void {
        this.edit(m => { m.flights[i].waypoints.splice(j, 1); });
        const sel = this.selectedPoint();
        if (i === this.selected() && typeof sel === 'number' && sel >= j) {
            // The one before takes its place, so Delete can be pressed again down the route.
            this.selectedPoint.set(sel > j || j > 0 ? sel - 1 : undefined);
        }
    }

    /** Patch the selected flight's airborne start (its altitude, speed or heading). */
    updateAirStart(i: number, patch: Partial<Extract<FlightEndpoint, { kind: 'air' }>>): void {
        this.edit(m => {
            const s = m.flights[i].start;
            if (s.kind === 'air') {
                Object.assign(s, clampFlight(patch));
            }
        });
    }

    /** Put flight i's start or landing on a runway end picked from a list. */
    setRunway(i: number, which: 'start' | 'land', end: RunwayEnd): void {
        this.edit(m => { m.flights[i][which] = { kind: 'runway', ...end }; });
    }

    /** Start flight i in the air where its start is now (a runway start keeps its position). */
    setAirStart(i: number): void {
        this.edit(m => {
            const s = m.flights[i].start;
            if (s.kind !== 'air') {
                m.flights[i].start = {
                    kind: 'air', lat: s.lat, lon: s.lon, altM: this.defaultAltM, speedMps: this.defaultSpeedMps, headingDeg: 0,
                };
            }
        });
    }

    /** Flight i's last turning point becomes its landing on `end`. */
    lastToLanding(i: number, end: RunwayEnd): void {
        this.edit(m => {
            m.flights[i].waypoints.pop();
            m.flights[i].land = { kind: 'runway', ...end };
        });
        if (i === this.selected() && typeof this.selectedPoint() === 'number') {
            this.selectedPoint.set('land');
        }
    }

    /** Flight i's landing becomes a turning point where it was; the flight then circles there. */
    landingToTurningPoint(i: number): void {
        this.edit(m => {
            const f = m.flights[i];
            if (f.land) {
                f.waypoints.push({ lat: f.land.lat, lon: f.land.lon, altM: this.defaultAltM, speedMps: this.defaultSpeedMps });
                delete f.land;
            }
        });
        if (i === this.selected() && this.selectedPoint() === 'land') {
            this.selectedPoint.set(this.mission().flights[i].waypoints.length - 1);
        }
    }

    clearLanding(i: number): void {
        this.edit(m => { delete m.flights[i].land; });
        if (i === this.selected() && this.selectedPoint() === 'land') {
            this.selectedPoint.set(undefined);
        }
    }

    /**
     * A turning point after flight i's point `after` (before the landing when
     * that is the point), selected: halfway to the next point, or past the end
     * as far again as the leg before it.
     */
    addWaypointAfter(i: number, after: SelectedPoint): void {
        const f = this.mission().flights[i];
        if (!f) {
            return;
        }
        const route = [f.start, ...f.waypoints, ...(f.land ? [f.land] : [])];
        // Index in the route of the point the new one follows.
        const k = after === 'start' ? 0 : after === 'land' ? route.length - 2 : after + 1;
        const a = route[k];
        const b = route[k + 1];
        const prev = route[k - 1];
        const at = b ? { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
            // About 5 km north with no leg to go by.
            : prev ? { lat: 2 * a.lat - prev.lat, lon: 2 * a.lon - prev.lon } : { lat: a.lat + 0.05, lon: a.lon };
        const like = 'altM' in a ? a : f.waypoints[k - 1];
        const j = k;
        this.edit(m => m.flights[i].waypoints.splice(j, 0, {
            ...at, altM: like?.altM ?? this.defaultAltM, speedMps: like?.speedMps ?? this.defaultSpeedMps,
        }));
        this.selectPoint(i, j);
    }

    /** Flight i's point removed: a turning point, or the landing; the start stays. */
    deletePoint(i: number, point: SelectedPoint): void {
        if (point === 'land') {
            this.clearLanding(i);
        } else if (point !== 'start') {
            this.removeWaypoint(i, point);
        }
    }

    /** A double-click on the map at (lat, lon), as {@link pick} says. */
    clickMap(lat: number, lon: number): void {
        const i = this.selected();
        const f = this.mission().flights[i];
        if (!f) {
            return;
        }
        const mode = this.pick();
        if (mode === 'waypoint') {
            // After the selected waypoint, else at the end; the new one is then selected.
            const sel = this.selectedPoint();
            const at = sel === 'start' ? 0 : sel === 'land' || sel === undefined ? f.waypoints.length : sel + 1;
            const prev = f.waypoints[at - 1] ?? (f.start.kind === 'air' ? f.start : undefined);
            this.edit(m => m.flights[i].waypoints.splice(at, 0, {
                lat, lon, altM: prev?.altM ?? this.defaultAltM, speedMps: prev?.speedMps ?? this.defaultSpeedMps,
            }));
            this.selectedPoint.set(at);
            return;
        }
        const end = this.host.runwayEndAt(lat, lon);
        this.edit(m => {
            const flight = m.flights[i];
            if (end) {
                flight[mode] = { kind: 'runway', ...end };
            } else if (mode === 'start') {
                const old = flight.start.kind === 'air' ? flight.start : undefined;
                flight.start = {
                    kind: 'air', lat, lon, altM: old?.altM ?? this.defaultAltM,
                    speedMps: old?.speedMps ?? this.defaultSpeedMps, headingDeg: old?.headingDeg ?? 0,
                };
            }
        });
        if (!end && mode === 'land') {
            this.status.set('A flight lands on a runway: click on or beside one.');
            return;
        }
        this.pick.set('waypoint');
    }

    moveWaypoint(i: number, j: number, lat: number, lon: number): void {
        this.updateWaypoint(i, j, { lat, lon });
    }

    /**
     * Drag a flight's start: onto a runway end it takes off from there,
     * anywhere else it starts in the air, at the altitude, speed and heading
     * it last had in the air.
     */
    /** Drag a flight's landing: it lands on a runway, so it moves only onto another runway end. */
    moveLand(i: number, lat: number, lon: number): void {
        const end = this.host.runwayEndAt(lat, lon);
        if (end) {
            this.edit(m => { m.flights[i].land = { kind: 'runway', ...end }; });
        }
    }

    moveStart(i: number, lat: number, lon: number): void {
        const end = this.host.runwayEndAt(lat, lon);
        this.edit(m => {
            const f = m.flights[i];
            const old = f.start.kind === 'air' ? f.start : undefined;
            f.start = end ? { kind: 'runway', ...end } : {
                kind: 'air', lat, lon, altM: old?.altM ?? this.defaultAltM,
                speedMps: old?.speedMps ?? this.defaultSpeedMps, headingDeg: old?.headingDeg ?? 0,
            };
        });
    }

    async refreshSaved(): Promise<void> {
        try {
            this.saved.set(await store.listMissions());
        } catch (err) {
            this.status.set((err as Error).message);
        }
    }

    /** Saves to the dev server; the mission's id, or undefined when it did not save. */
    async save(): Promise<string | undefined> {
        try {
            const id = await store.saveMission(this.mission());
            this.status.set(`Saved as ${id}.`);
            await this.refreshSaved();
            return id;
        } catch (err) {
            this.status.set((err as Error).message);
            return undefined;
        }
    }

    async load(id: string): Promise<void> {
        try {
            this.mission.set(await store.loadMission(id));
            this.selected.set(0);
            this.selectedPoint.set(undefined);
            this.pick.set('waypoint');
            this.status.set(`Loaded ${id}.`);
        } catch (err) {
            this.status.set((err as Error).message);
        }
    }

    async remove(id: string): Promise<void> {
        try {
            await store.deleteMission(id);
            this.status.set(`Deleted ${id}.`);
            await this.refreshSaved();
        } catch (err) {
            this.status.set((err as Error).message);
        }
    }

    /** Save, then open the game on this mission (game.ts startMission). */
    async fly(): Promise<void> {
        const id = await this.save();
        if (!id) {
            return;
        }
        if (this.host.fly) {
            this.host.fly(id, this.mission());
        } else {
            location.href = missionUrl(id);
        }
    }
}

/** Altitude and speed held to what {@link validateMission} accepts, so a typed value cannot make the mission unsaveable. */
function clampFlight<T extends { altM?: number; speedMps?: number }>(patch: T): T {
    const out = { ...patch };
    // Not a number at all is left alone for validation to report.
    if (out.altM !== undefined && Number.isFinite(out.altM)) {
        out.altM = Math.min(MAX_ALT_M, Math.max(0, out.altM));
    }
    if (out.speedMps !== undefined && Number.isFinite(out.speedMps)) {
        out.speedMps = Math.min(MAX_SPEED_MPS, Math.max(1, out.speedMps));
    }
    return out;
}
