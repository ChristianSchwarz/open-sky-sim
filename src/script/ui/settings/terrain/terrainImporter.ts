import {
    ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, inject, viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AreaImportService } from './areaImportService';
import { ConfirmDeleteArea, ConfirmDeleteAreaData } from './confirmDeleteArea';
import { describeBox } from './importMath';
import { TerrainMap } from './terrainMap';

/**
 * The World tab's terrain importer (F9): pick an area on the map and bake it
 * into the terrain, or delete one already baked. Only shown on the dev server.
 */
@Component({
    selector: 'rfs-terrain-importer',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatButtonModule, MatCheckboxModule, MatChipsModule, MatFormFieldModule, MatInputModule,
        MatProgressBarModule, TerrainMap,
    ],
    host: { class: 'block' },
    template: `
<div class="flex min-w-0 flex-col gap-3">
    <rfs-terrain-map />

    <p class="m-0 font-mono text-xs opacity-70">{{ readout() }}</p>

    @if (service.areas().length > 0) {
        <mat-chip-set aria-label="Baked areas">
            @for (area of service.areas(); track area.name) {
                <mat-chip [removable]="canDelete()" [disabled]="service.running()"
                    (removed)="confirmDelete(area.name)">
                    {{ area.name }}
                    @if (canDelete()) {
                        <button matChipRemove type="button" [attr.aria-label]="'Delete ' + area.name">×</button>
                    }
                </mat-chip>
            }
        </mat-chip-set>
    } @else {
        <p class="m-0 text-sm opacity-70">Nothing baked yet.</p>
    }

    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <!-- Flex sizing sits on a wrapper: Material's own form-field styles
             outrank Tailwind's layered utilities on the component itself. -->
        <div class="min-w-40 flex-1">
            <mat-form-field class="w-full" subscriptSizing="dynamic">
                <mat-label>Name</mat-label>
                <input matInput placeholder="alps" autocomplete="off"
                    [value]="service.name()" (input)="setName($event)">
            </mat-form-field>
        </div>
        <mat-checkbox [checked]="service.withCover()" (change)="service.withCover.set($event.checked)">
            Satellite colour (adds ~30 min)
        </mat-checkbox>
        <button mat-flat-button type="button"
            [disabled]="service.blocked() !== undefined" (click)="startImport()">Import</button>
    </div>

    @if (service.progress(); as progress) {
        <div class="flex flex-col gap-1">
            <p class="m-0 font-mono text-xs">{{ progress.label }}</p>
            <mat-progress-bar mode="determinate" [value]="progress.value"
                [style.--mat-progress-bar-active-indicator-color]="progress.failed ? 'var(--mat-sys-error)' : null" />
        </div>
    }

    @if (service.log()) {
        <pre #log
            class="m-0 max-h-[22vh] overflow-auto whitespace-pre-wrap wrap-anywhere rounded border border-white/10 bg-black/60 p-2 font-mono text-xs text-green-200">{{ service.log() }}</pre>
    }
</div>
`,
})
export class TerrainImporter {
    readonly service = inject(AreaImportService);
    private readonly dialog = inject(MatDialog);
    private readonly logRef = viewChild<ElementRef<HTMLElement>>('log');

    /** Deleting the last area would leave nothing to fly over. */
    readonly canDelete = computed(() => this.service.areas().length > 1);

    readonly readout = computed(() => {
        const selection = this.service.selection();
        if (!selection) {
            return 'Shift-drag on the map to choose an area. Drag to pan, wheel to zoom.';
        }
        const blocked = this.service.blocked();
        return `${describeBox(selection)}  —  ${blocked ?? 'ready to import'}`;
    });

    constructor() {
        void this.service.loadAreas();
        // Follow the newest line of the bake log.
        afterRenderEffect(() => {
            this.service.log();
            const log = this.logRef()?.nativeElement;
            if (log) {
                log.scrollTop = log.scrollHeight;
            }
        });
    }

    setName(event: Event): void {
        this.service.name.set((event.target as HTMLInputElement).value);
    }

    startImport(): void {
        void this.service.startImport();
    }

    confirmDelete(name: string): void {
        this.dialog.open<ConfirmDeleteArea, ConfirmDeleteAreaData, boolean>(ConfirmDeleteArea, {
            data: { name },
            autoFocus: 'dialog',
        }).afterClosed().subscribe(confirmed => {
            if (confirmed) {
                void this.service.deleteArea(name);
            }
        });
    }
}
