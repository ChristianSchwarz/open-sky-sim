import { ApplicationRef } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { createApplication } from '@angular/platform-browser';
import type { SpawnPanel } from '../../osd/spawnPanel';
import { isAreaImporterAvailable } from './terrain/areaImportService';
import { SettingsDialog, SettingsDialogData, SettingsTab } from './settingsDialog';

/**
 * The settings dialog is the only Angular in the sim. Rather than bootstrap a
 * root component into the page, a bare application is created the first time
 * the dialog is asked for and the dialog is opened from its injector, so the
 * game's own boot path is untouched and Angular only starts when it is needed.
 */
let app: Promise<ApplicationRef> | undefined;
let openDialog: MatDialogRef<SettingsDialog> | undefined;
let opening = false;

type HostData = Omit<SettingsDialogData, 'initialTab' | 'terrainImport' | 'spawnMenu'>;
let host: { data: HostData; onOpenChange: (open: boolean) => void } | undefined;
let spawnMenu: SpawnPanel | undefined;

/**
 * Whether the server can bake terrain. A yes is kept for the session; a no
 * is asked again next time, because the dev server may simply not have been
 * up yet when the dialog was first opened.
 */
let importerProbe: Promise<boolean> | undefined;

/**
 * Hands over what the dialog edits. Called once the game is built, so the
 * settings button and the F9 key can open the dialog without holding the
 * config and input devices themselves.
 */
export function registerSettingsDialog(data: HostData, onOpenChange: (open: boolean) => void): void {
    host = { data, onOpenChange };
}

/** Hands over the spawn menu the Flight tab shows. Called once the game is built. */
export function registerSpawnMenu(menu: SpawnPanel): void {
    spawnMenu = menu;
}

/** Closes the settings dialog if it is open. */
export function closeSettingsDialog(): void {
    openDialog?.close();
}

/** Opens the settings dialog, or closes it if it is already open. */
export async function toggleSettingsDialog(): Promise<void> {
    if (openDialog) {
        openDialog.close();
        return;
    }
    await openSettingsDialog();
}

/** Opens the settings dialog, on `initialTab` if given; an open dialog just switches to that tab. */
export async function openSettingsDialog(initialTab?: SettingsTab): Promise<void> {
    if (openDialog) {
        if (initialTab) {
            openDialog.componentInstance.selectTab(initialTab);
        }
        return;
    }
    if (!host || !spawnMenu || opening) {
        return;
    }
    const { data, onOpenChange } = host;
    const menu = spawnMenu;
    opening = true;
    onOpenChange(true);
    menu.notifyOpened();
    try {
        app ??= createApplication();
        importerProbe ??= isAreaImporterAvailable();
        const [appRef, terrainImport] = await Promise.all([app, importerProbe]);
        if (!terrainImport) {
            importerProbe = undefined;
        }
        const ref = appRef.injector.get(MatDialog).open(SettingsDialog, {
            data: { ...data, initialTab, terrainImport, spawnMenu: menu },
            width: '760px',
            maxWidth: '94vw',
            // Focus the dialog itself so the keyboard belongs to it, not the
            // game, from the moment it opens (see isOverlayKeyEvent).
            autoFocus: 'dialog',
        });
        openDialog = ref;
        ref.afterClosed().subscribe(() => {
            openDialog = undefined;
            onOpenChange(false);
            menu.notifyClosed();
        });
    } catch (err) {
        console.error('Settings dialog failed to open', err);
        onOpenChange(false);
        menu.notifyClosed();
    } finally {
        opening = false;
    }
}
