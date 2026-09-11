import { ApplicationRef } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { createApplication } from '@angular/platform-browser';
import { SettingsDialog, SettingsDialogData } from './settingsDialog';

/**
 * The settings dialog is the only Angular in the sim. Rather than bootstrap a
 * root component into the page, a bare application is created the first time
 * the dialog is asked for and the dialog is opened from its injector, so the
 * game's own boot path is untouched and Angular only starts when it is needed.
 */
let app: Promise<ApplicationRef> | undefined;
let openDialog: MatDialogRef<SettingsDialog> | undefined;
let opening = false;

/** Opens the settings dialog, or closes it if it is already open. */
export async function toggleSettingsDialog(data: SettingsDialogData, onClosed: () => void): Promise<void> {
    if (openDialog) {
        openDialog.close();
        return;
    }
    if (opening) {
        return;
    }
    opening = true;
    try {
        app ??= createApplication();
        const dialog = (await app).injector.get(MatDialog);
        const ref = dialog.open(SettingsDialog, {
            data,
            panelClass: 'rfs-settings-panel',
            width: '640px',
            maxWidth: '92vw',
            // Focus the dialog itself so the keyboard belongs to it, not the
            // game, from the moment it opens (see isOverlayKeyEvent).
            autoFocus: 'dialog',
        });
        openDialog = ref;
        ref.afterClosed().subscribe(() => {
            openDialog = undefined;
            onClosed();
        });
    } catch (err) {
        console.error('Settings dialog failed to open', err);
        onClosed();
    } finally {
        opening = false;
    }
}
