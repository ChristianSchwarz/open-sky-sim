import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';

export interface ConfirmDeleteAreaData {
    name: string;
}

/** Closes with `true` when the player confirms deleting the area. */
@Component({
    selector: 'rfs-confirm-delete-area',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatButtonModule, MatDialogModule],
    host: { class: 'block font-normal [text-shadow:none]' },
    template: `
<h2 mat-dialog-title>Delete “{{ data.name }}”?</h2>
<mat-dialog-content>
    <p class="m-0">
        Its terrain is removed from the baked pyramids and the coarse tiles around it
        are rebaked. Getting it back means importing it again.
    </p>
</mat-dialog-content>
<mat-dialog-actions align="end">
    <button mat-button type="button" [mat-dialog-close]="false">Cancel</button>
    <button mat-flat-button type="button" [mat-dialog-close]="true">Delete</button>
</mat-dialog-actions>
`,
})
export class ConfirmDeleteArea {
    readonly data = inject<ConfirmDeleteAreaData>(MAT_DIALOG_DATA);
}
