import { computed, signal } from '@angular/core';
import { Flight, FlightEndpoint, MAX_FLIGHTS, MISSION_VERSION, Mission, Waypoint, validateMission } from './flightPlan';
import * as store from './missionStore';

/** What a click on the map does: add a waypoint to the selected flight, or set its start or landing. */
export type PickMode = 'waypoint' | 'start' | 'land';
/** A point of the selected flight: a waypoint by its index, its start or its landing. */
export type SelectedPoint = number | 'start' | 'land';

export const FT = 0.3048;
export const KT = 0.514444;
const DEFAULT_ALT_M = 10_000 * FT;
const DEFAULT_SPEED_MPS = 350 * KT;

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
            start: { kind: 'air', lat: c.lat, lon: c.lon, altM: DEFAULT_ALT_M, speedMps: DEFAULT_SPEED_MPS, headingDeg: 0 },
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
        this.edit(m => { Object.assign(m.flights[i].waypoints[j], patch); });
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
                Object.assign(s, patch);
            }
        });
    }

    clearLanding(i: number): void {
        this.edit(m => { delete m.flights[i].land; });
        if (i === this.selected() && this.selectedPoint() === 'land') {
            this.selectedPoint.set(undefined);
        }
    }

    /** A click on the map at (lat, lon), as {@link pick} says. */
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
            const at = sel === 'start' ? 0
                : sel === 'land' || sel === undefined ? f.waypoints.length : sel + 1;
            const prev = f.waypoints[at - 1] ?? (f.start.kind === 'air' ? f.start : undefined);
            this.edit(m => m.flights[i].waypoints.splice(at, 0, {
                lat, lon, altM: prev?.altM ?? DEFAULT_ALT_M, speedMps: prev?.speedMps ?? DEFAULT_SPEED_MPS,
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
                    kind: 'air', lat, lon, altM: old?.altM ?? DEFAULT_ALT_M,
                    speedMps: old?.speedMps ?? DEFAULT_SPEED_MPS, headingDeg: old?.headingDeg ?? 0,
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
                kind: 'air', lat, lon, altM: old?.altM ?? DEFAULT_ALT_M,
                speedMps: old?.speedMps ?? DEFAULT_SPEED_MPS, headingDeg: old?.headingDeg ?? 0,
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
        if (id) {
            location.href = `index.html?mission=${encodeURIComponent(id)}`;
        }
    }
}
