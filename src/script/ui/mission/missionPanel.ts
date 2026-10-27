import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FlightControl, FlightEndpoint, MAX_ALT_M, MAX_FLIGHTS, MAX_SPEED_MPS } from '../../mission/flightPlan';
import { FT, KT, MissionEditor, PickMode, RunwayEnd } from '../../mission/missionEditor';

/**
 * The waypoint editor (F12 map's left pane), three levels under a breadcrumb:
 * the mission's flights; one flight's aircraft and AI or player control; that
 * flight's waypoints: its start, turning points and landing. The map
 * on the right is where points are placed (state/missionOverlay.ts).
 */
@Component({
    selector: 'rfs-mission-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule, MatSelectModule],
    // Fills the map's left pane (style.css --map-split), scrolling on its own.
    host: { class: 'fixed inset-y-0 left-0 block w-[var(--map-split)] overflow-y-auto text-white/90' },
    template: `
@let e = editor();
<div class="flex flex-col gap-3 p-3 text-sm">
    <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
            <mat-form-field class="w-full" subscriptSizing="dynamic">
                <mat-label>Mission</mat-label>
                <input matInput autocomplete="off" [value]="e.mission().name" (input)="e.setName(value($event))">
            </mat-form-field>
        </div>
        <button mat-flat-button type="button" [disabled]="!e.serverAvailable() || e.errors().length > 0"
            (click)="e.save()">Save</button>
        <button mat-flat-button type="button" [disabled]="!e.serverAvailable() || e.errors().length > 0"
            (click)="e.fly()">Fly</button>
    </div>

    @if (e.saved().length > 0) {
        <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1">
                <mat-form-field class="w-full" subscriptSizing="dynamic">
                    <mat-label>Saved missions</mat-label>
                    <mat-select #savedSelect>
                        @for (s of e.saved(); track s.id) {
                            <mat-option [value]="s.id">{{ s.name }} · {{ s.flights }} flights</mat-option>
                        }
                    </mat-select>
                </mat-form-field>
            </div>
            <button mat-stroked-button type="button" [disabled]="!savedSelect.value"
                (click)="e.load(savedSelect.value)">Load</button>
            <button mat-stroked-button type="button" [disabled]="!savedSelect.value"
                (click)="e.remove(savedSelect.value)">Delete</button>
        </div>
    }

    @if (e.status()) {
        <p class="m-0 opacity-80">{{ e.status() }}</p>
    }
    @if (e.errors().length > 0 && e.mission().flights.length > 0) {
        <p class="m-0 text-xs text-orange-300">{{ readableError(e.errors()[0]) }}</p>
    }

    <nav class="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
        <button mat-button type="button" [disabled]="view() === 'flights'" (click)="level.set('flights')">Flights</button>
        @if (view() !== 'flights') {
            <span class="opacity-50">›</span>
            <button mat-button type="button" [disabled]="view() === 'flight'" (click)="level.set('flight')">
                {{ flight()!.name }}</button>
        }
        @if (view() === 'waypoints') {
            <span class="opacity-50">›</span>
            <button mat-button type="button" disabled>Waypoints</button>
        }
    </nav>

    @if (view() === 'flights') {
        @for (f of e.mission().flights; track $index; let i = $index) {
            <div class="flex cursor-pointer items-center gap-2 rounded border p-2"
                [class]="i === e.selected() ? 'border-cyan-400/80' : 'border-white/20'"
                (click)="open(i)">
                <span class="min-w-0 flex-1 truncate">{{ f.name }}</span>
                <span class="opacity-70">{{ aircraftName(f.aircraftId) }} · {{ f.control === 'ai' ? 'AI' : 'Player' }}
                    · {{ f.waypoints.length }} wp</span>
                <span class="opacity-50">›</span>
                <button mat-icon-button type="button" aria-label="Remove flight"
                    (click)="$event.stopPropagation(); e.removeFlight(i)">✕</button>
            </div>
        }
        <button mat-stroked-button type="button" [disabled]="e.mission().flights.length >= maxFlights"
            (click)="e.addFlight(); level.set('flight')">Add flight</button>
    } @else {
        @let f = flight()!;
        @let i = e.selected();
        @if (view() === 'flight') {
            <mat-form-field class="w-full" subscriptSizing="dynamic">
                <mat-label>Flight</mat-label>
                <input matInput autocomplete="off" [value]="f.name"
                    (input)="e.updateFlight(i, { name: value($event) })">
            </mat-form-field>
            <mat-form-field class="w-full" subscriptSizing="dynamic">
                <mat-label>Aircraft</mat-label>
                <mat-select [value]="f.aircraftId" (selectionChange)="e.updateFlight(i, { aircraftId: $event.value })">
                    @for (a of e.host.aircraft; track a.id) {
                        <mat-option [value]="a.id">{{ a.name }}</mat-option>
                    }
                </mat-select>
            </mat-form-field>
            <mat-button-toggle-group [value]="f.control" hideSingleSelectionIndicator
                (change)="e.updateFlight(i, { control: $any($event.value) })">
                @for (c of controls; track c.value) {
                    <mat-button-toggle [value]="c.value">{{ c.label }}</mat-button-toggle>
                }
            </mat-button-toggle-group>

            <button mat-stroked-button type="button" (click)="e.pick.set('waypoint'); level.set('waypoints')">
                Enter waypoints ({{ f.waypoints.length + 1 + (f.land ? 1 : 0) }}) ›</button>
        } @else {
            @let last = f.waypoints.length - 1;
            <div class="flex flex-col gap-2 rounded border border-white/20 p-2"
                [class.bg-cyan-400/15]="e.selectedPoint() === 'start'" (click)="e.selectPoint(i, 'start')">
                <div class="flex items-center gap-2">
                    <span class="w-6 text-center font-mono">0</span>
                    <mat-form-field class="min-w-0 flex-1" subscriptSizing="dynamic">
                        <mat-label>Type</mat-label>
                        <mat-select [value]="f.start.kind === 'runway' ? 'start' : 'turn'"
                            (selectionChange)="$event.value === 'start' ? setAirport(i, 'start', airports(f.start)[0]) : e.setAirStart(i)">
                            <mat-option value="start" [disabled]="airports(f.start).length === 0">Start</mat-option>
                            <mat-option value="turn">Turning point</mat-option>
                        </mat-select>
                    </mat-form-field>
                    <button mat-stroked-button type="button" (click)="pickOn('start')">
                        {{ e.pick() === 'start' ? 'Click the map…' : 'Pick on map' }}</button>
                </div>
                @if (f.start.kind === 'runway') {
                    <div class="grid grid-cols-2 gap-2">
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Airport</mat-label>
                            <mat-select [value]="f.start.airfield" (selectionChange)="setAirport(i, 'start', $event.value)">
                                @for (a of airports(f.start); track a) {
                                    <mat-option [value]="a">{{ a }}</mat-option>
                                }
                            </mat-select>
                        </mat-form-field>
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Runway</mat-label>
                            <mat-select [value]="f.start.designator"
                                (selectionChange)="setRunway(i, 'start', f.start.airfield, $event.value)">
                                @for (r of runways(f.start.airfield, f.start); track r.designator) {
                                    <mat-option [value]="r.designator">{{ r.designator }}</mat-option>
                                }
                            </mat-select>
                        </mat-form-field>
                    </div>
                } @else {
                    <div class="grid grid-cols-2 gap-2">
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Alt ft</mat-label>
                            <input matInput type="number" [value]="ft(f.start.altM)"
                                (change)="e.updateAirStart(i, { altM: num($event) * FT })">
                        </mat-form-field>
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Speed kt</mat-label>
                            <input matInput type="number" [value]="kt(f.start.speedMps)"
                                (change)="e.updateAirStart(i, { speedMps: num($event) * KT })">
                        </mat-form-field>
                    </div>
                }
            </div>

            @for (w of f.waypoints; track $index; let j = $index) {
                <div class="flex flex-col gap-2 rounded border border-white/20 p-2"
                    [class.bg-cyan-400/15]="j === e.selectedPoint()" (click)="e.selectPoint(i, j)">
                    <div class="flex items-center gap-2">
                        <span class="w-6 text-center font-mono">{{ j + 1 }}</span>
                        <mat-form-field class="min-w-0 flex-1" subscriptSizing="dynamic">
                            <mat-label>Type</mat-label>
                            <mat-select value="turn" [disabled]="j !== last || !!f.land"
                                (selectionChange)="$event.value === 'land' && lastToLanding(i)">
                                <mat-option value="turn">Turning point</mat-option>
                                <mat-option value="land" [disabled]="airports(w).length === 0">Landing</mat-option>
                            </mat-select>
                        </mat-form-field>
                        <button mat-icon-button type="button" aria-label="Remove waypoint"
                            (click)="e.removeWaypoint(i, j)">✕</button>
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Alt ft</mat-label>
                            <input matInput type="number" [value]="ft(w.altM)"
                                (change)="e.updateWaypoint(i, j, { altM: num($event) * FT })">
                        </mat-form-field>
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Speed kt</mat-label>
                            <input matInput type="number" [value]="kt(w.speedMps)"
                                (change)="e.updateWaypoint(i, j, { speedMps: num($event) * KT })">
                        </mat-form-field>
                    </div>
                </div>
            }

            @if (f.land?.kind === 'runway') {
                @let land = $any(f.land);
                <div class="flex flex-col gap-2 rounded border border-white/20 p-2"
                    [class.bg-cyan-400/15]="e.selectedPoint() === 'land'" (click)="e.selectPoint(i, 'land')">
                    <div class="flex items-center gap-2">
                        <span class="w-6 text-center font-mono">{{ f.waypoints.length + 1 }}</span>
                        <mat-form-field class="min-w-0 flex-1" subscriptSizing="dynamic">
                            <mat-label>Type</mat-label>
                            <mat-select value="land" (selectionChange)="$event.value === 'turn' && e.landingToTurningPoint(i)">
                                <mat-option value="turn">Turning point</mat-option>
                                <mat-option value="land">Landing</mat-option>
                            </mat-select>
                        </mat-form-field>
                        <button mat-stroked-button type="button" (click)="pickOn('land')">
                            {{ e.pick() === 'land' ? 'Click the map…' : 'Pick on map' }}</button>
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Airport</mat-label>
                            <mat-select [value]="land.airfield" (selectionChange)="setAirport(i, 'land', $event.value)">
                                @for (a of airports(land); track a) {
                                    <mat-option [value]="a">{{ a }}</mat-option>
                                }
                            </mat-select>
                        </mat-form-field>
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Runway</mat-label>
                            <mat-select [value]="land.designator"
                                (selectionChange)="setRunway(i, 'land', land.airfield, $event.value)">
                                @for (r of runways(land.airfield, land); track r.designator) {
                                    <mat-option [value]="r.designator">{{ r.designator }}</mat-option>
                                }
                            </mat-select>
                        </mat-form-field>
                    </div>
                </div>
            }
        }
    }
</div>
`,
})
export class MissionPanel {
    readonly editor = input.required<MissionEditor>();
    readonly maxFlights = MAX_FLIGHTS;
    // The template sees only members: a bare imported FT there is undefined and every typed value NaN.
    readonly FT = FT;
    readonly KT = KT;
    readonly controls: ReadonlyArray<{ value: FlightControl; label: string }> = [
        { value: 'ai', label: 'AI' }, { value: 'player', label: 'Player' },
    ];
    /** Breadcrumb level: the flight list, one flight, or its waypoints. */
    readonly level = signal<'flights' | 'flight' | 'waypoints'>('flights');
    readonly flight = computed(() => this.editor().mission().flights[this.editor().selected()]);
    /** The level shown: back to the list when the selected flight is gone (removed, another mission loaded). */
    readonly view = computed(() => this.flight() ? this.level() : 'flights');

    /**
     * A validation message in the panel's terms: `flights[0].waypoints[0].altM: 0-20000 m`
     * becomes `Flight 1, waypoint 1: altitude 0-65617 ft`, numbered as the list is.
     */
    readableError(err: string): string {
        const m = /^flights\[(\d+)\]\.(?:(start|land)|waypoints\[(\d+)\])\.?(\w*): (.*)$/.exec(err);
        if (!m) {
            return err;
        }
        const f = this.editor().mission().flights[Number(m[1])];
        const point = m[2] === 'start' ? 'waypoint 0' : m[2] === 'land'
            ? `waypoint ${(f?.waypoints.length ?? 0) + 1}` : `waypoint ${Number(m[3]) + 1}`;
        const what = ({
            altM: () => `altitude 0-${Math.round(MAX_ALT_M / FT)} ft`,
            speedMps: () => `speed 1-${Math.round(MAX_SPEED_MPS / KT)} kt`,
        } as Record<string, () => string>)[m[4]]?.() ?? `${m[4]} ${m[5]}`;
        return `${f?.name ?? `Flight ${Number(m[1]) + 1}`}, ${point}: ${what}`;
    }

    open(i: number): void {
        this.editor().selectFlight(i);
        this.level.set('flight');
    }

    aircraftName(id: string): string {
        return this.editor().host.aircraft.find(a => a.id === id)?.name ?? id;
    }

    /**
     * Airports with runway ends loaded, nearest to `near` first; a runway
     * point's own airport is listed even if it is out of range.
     */
    airports(near: { lat: number; lon: number } | FlightEndpoint): string[] {
        const dist = new Map<string, number>();
        const ends: Array<{ airfield: string; lat: number; lon: number }> = this.editor().host.runwayEnds();
        for (const r of 'kind' in near && near.kind === 'runway' ? [...ends, near] : ends) {
            // Equirectangular is plenty for ranking airfields around one map.
            const dx = (r.lon - near.lon) * Math.cos(near.lat * Math.PI / 180);
            const d = dx * dx + (r.lat - near.lat) ** 2;
            dist.set(r.airfield, Math.min(d, dist.get(r.airfield) ?? Infinity));
        }
        return [...dist.keys()].sort((a, b) => dist.get(a)! - dist.get(b)!);
    }

    runways(airfield: string, current?: FlightEndpoint): RunwayEnd[] {
        const ends = this.editor().host.runwayEnds().filter(r => r.airfield === airfield);
        if (current?.kind === 'runway' && current.airfield === airfield
            && !ends.some(r => r.designator === current.designator)) {
            ends.push(current);
        }
        return ends.sort((a, b) => a.designator.localeCompare(b.designator));
    }

    setAirport(i: number, which: 'start' | 'land', airfield: string): void {
        const end = this.runways(airfield)[0];
        if (end) {
            this.editor().setRunway(i, which, end);
        }
    }

    /** The last turning point becomes the landing, on the first runway end of the first airport. */
    lastToLanding(i: number): void {
        const f = this.editor().mission().flights[i];
        const end = this.runways(this.airports(f.waypoints[f.waypoints.length - 1] ?? f.start)[0] ?? '')[0];
        if (end) {
            this.editor().lastToLanding(i, end);
        }
    }

    setRunway(i: number, which: 'start' | 'land', airfield: string, designator: string): void {
        const end = this.runways(airfield).find(r => r.designator === designator);
        if (end) {
            this.editor().setRunway(i, which, end);
        }
    }

    pickOn(mode: PickMode): void {
        const e = this.editor();
        e.pick.set(e.pick() === mode ? 'waypoint' : mode);
    }

    describe(p: FlightEndpoint): string {
        return p.kind === 'runway'
            ? `${p.airfield} runway ${p.designator}`
            : `in the air, ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
    }

    ft(m: number): number {
        return Math.round(m / FT);
    }

    kt(mps: number): number {
        return Math.round(mps / KT);
    }

    value(e: Event): string {
        return (e.target as HTMLInputElement).value;
    }

    num(e: Event): number {
        return Number((e.target as HTMLInputElement).value) || 0;
    }
}
