import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FlightControl, FlightEndpoint, MAX_FLIGHTS } from '../../mission/flightPlan';
import { FT, KT, MissionEditor, PickMode } from '../../mission/missionEditor';

/**
 * The waypoint editor (F12 map's left pane): the mission's flights, each with
 * its aircraft, AI or player control, start, landing and waypoints. The map
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
        <p class="m-0 text-xs text-orange-300">{{ e.errors()[0] }}</p>
    }

    @for (f of e.mission().flights; track $index; let i = $index) {
        <div class="flex flex-col gap-2 rounded border p-2"
            [class]="i === e.selected() ? 'border-cyan-400/80' : 'border-white/20 cursor-pointer'"
            (click)="e.selectFlight(i)">
            <div class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                    <mat-form-field class="w-full" subscriptSizing="dynamic">
                        <mat-label>Flight</mat-label>
                        <input matInput autocomplete="off" [value]="f.name"
                            (input)="e.updateFlight(i, { name: value($event) })">
                    </mat-form-field>
                </div>
                <mat-button-toggle-group [value]="f.control" hideSingleSelectionIndicator
                    (change)="e.updateFlight(i, { control: $any($event.value) })">
                    @for (c of controls; track c.value) {
                        <mat-button-toggle [value]="c.value">{{ c.label }}</mat-button-toggle>
                    }
                </mat-button-toggle-group>
                <button mat-icon-button type="button" aria-label="Remove flight" (click)="e.removeFlight(i)">✕</button>
            </div>

            @if (i === e.selected()) {
                <mat-form-field class="w-full" subscriptSizing="dynamic">
                    <mat-label>Aircraft</mat-label>
                    <mat-select [value]="f.aircraftId" (selectionChange)="e.updateFlight(i, { aircraftId: $event.value })">
                        @for (a of e.host.aircraft; track a.id) {
                            <mat-option [value]="a.id">{{ a.name }}</mat-option>
                        }
                    </mat-select>
                </mat-form-field>

                <div class="flex items-center gap-2 rounded" [class.bg-cyan-400/15]="e.selectedPoint() === 'start'"
                    (click)="e.selectPoint(i, 'start')">
                    <span class="w-12 opacity-70">Start</span>
                    <span class="min-w-0 flex-1 truncate">{{ describe(f.start) }}</span>
                    <button mat-stroked-button type="button" (click)="pickOn('start')">
                        {{ e.pick() === 'start' ? 'Click the map…' : 'Pick on map' }}</button>
                </div>
                @if (f.start.kind === 'air') {
                    <div class="grid grid-cols-3 gap-2">
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
                        <mat-form-field subscriptSizing="dynamic">
                            <mat-label>Heading °</mat-label>
                            <input matInput type="number" [value]="f.start.headingDeg"
                                (change)="e.updateAirStart(i, { headingDeg: (num($event) % 360 + 360) % 360 })">
                        </mat-form-field>
                    </div>
                }

                <div class="flex items-center gap-2 rounded" [class.bg-cyan-400/15]="e.selectedPoint() === 'land'"
                    (click)="f.land && e.selectPoint(i, 'land')">
                    <span class="w-12 opacity-70">Land</span>
                    <span class="min-w-0 flex-1 truncate">{{ f.land ? describe(f.land) : 'circle the last waypoint' }}</span>
                    @if (f.land) {
                        <button mat-button type="button" (click)="e.clearLanding(i)">Clear</button>
                    }
                    <button mat-stroked-button type="button" (click)="pickOn('land')">
                        {{ e.pick() === 'land' ? 'Click the map…' : 'Pick on map' }}</button>
                </div>

                <p class="m-0 opacity-70">
                    {{ pickHint() }}
                </p>
                @if (e.selectedPoint() === 'start') {
                    <p class="m-0 opacity-70">Start selected: drag it on the map, onto a runway end or into the air;
                        new waypoints go first.</p>
                } @else if (e.selectedPoint() === 'land') {
                    <p class="m-0 opacity-70">Landing selected: drag it onto another runway end; Delete clears it.</p>
                } @else if (e.selectedPoint() !== undefined) {
                    <p class="m-0 opacity-70">Waypoint {{ $any(e.selectedPoint()) + 1 }} selected: new ones go after it,
                        Delete removes it.</p>
                }
                @for (w of f.waypoints; track $index; let j = $index) {
                    <div class="grid grid-cols-[2rem_1fr_1fr_2.5rem] items-center gap-2 rounded"
                        [class.bg-cyan-400/15]="j === e.selectedPoint()" (click)="e.selectPoint(i, j)">
                        <span class="text-center font-mono">{{ j + 1 }}</span>
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
                        <button mat-icon-button type="button" aria-label="Remove waypoint"
                            (click)="e.removeWaypoint(i, j)">✕</button>
                    </div>
                }
            }
        </div>
    }

    <button mat-stroked-button type="button" [disabled]="e.mission().flights.length >= maxFlights"
        (click)="e.addFlight()">Add flight</button>
</div>
`,
})
export class MissionPanel {
    readonly editor = input.required<MissionEditor>();
    readonly maxFlights = MAX_FLIGHTS;
    readonly controls: ReadonlyArray<{ value: FlightControl; label: string }> = [
        { value: 'ai', label: 'AI' }, { value: 'player', label: 'Player' },
    ];
    readonly pickHint = computed(() => ({
        waypoint: 'Click the map to add a waypoint; drag one to move it, right-click to delete it.',
        start: 'Click a runway end to take off from it, or anywhere else to start in the air there.',
        land: 'Click the runway end to land on.',
    })[this.editor().pick()]);

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
