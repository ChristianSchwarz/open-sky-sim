import { ApplicationRef, DOCUMENT } from '@angular/core';
import { MediaMatcher } from '@angular/cdk/layout';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { createApplication } from '@angular/platform-browser';
import type { SpawnPanel } from '../../osd/spawnPanel';
import { isAreaImporterAvailable } from './terrain/areaImportService';
import { SettingsDialog, SettingsDialogData, SettingsTab } from './settingsDialog';

/**
 * The settings are the only Angular in the sim's own page. They open in a
 * window of their own: a same-origin popup whose document Angular is handed
 * as DOCUMENT, so the dialog renders there while still editing the game's
 * live config and input devices. A fresh application is created per window
 * (the popup's document is baked into its injector) and destroyed with it.
 */
let openDialog: MatDialogRef<SettingsDialog> | undefined;
let openWindow: Window | undefined;
let opening = false;

type HostData = Omit<SettingsDialogData, 'initialTab' | 'terrainImport' | 'spawnMenu'>;
let host: { data: HostData; onOpenChange: (open: boolean) => void } | undefined;
let spawnMenu: SpawnPanel | undefined;

/**
 * Whether the server can bake terrain. A yes is kept for the session; a no
 * is asked again next time, because the dev server may simply not have been
 * up yet when the settings were first opened.
 */
let importerProbe: Promise<boolean> | undefined;

/** Wide enough for the eight tab links (see NARROW_QUERY). */
const WINDOW_FEATURES = 'popup,width=900,height=800';

/**
 * Hands over what the settings edit. Called once the game is built, so the
 * settings button and the F9 key can open them without holding the config
 * and input devices themselves.
 */
export function registerSettingsDialog(data: HostData, onOpenChange: (open: boolean) => void): void {
    host = { data, onOpenChange };
}

/** Hands over the spawn menu the Flight tab shows. Called once the game is built. */
export function registerSpawnMenu(menu: SpawnPanel): void {
    spawnMenu = menu;
}

/** Closes the settings window if it is open. */
export function closeSettingsDialog(): void {
    openDialog?.close();
}

/** Opens the settings window, or closes it if it is already open. */
export async function toggleSettingsDialog(): Promise<void> {
    if (openDialog) {
        openDialog.close();
        return;
    }
    await openSettingsDialog();
}

/** Builds the popup's page: the game's stylesheets and the html/body classes the theme hangs off. */
function prepareWindow(win: Window): void {
    const doc = win.document;
    doc.open();
    doc.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Settings - Retro Flight Sim</title></head><body></body></html>');
    doc.close();
    for (const el of Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'))) {
        const copy = doc.importNode(el, true) as HTMLElement;
        if (el instanceof HTMLLinkElement) {
            (copy as HTMLLinkElement).href = el.href;
        }
        doc.head.appendChild(copy);
    }
    doc.documentElement.className = document.documentElement.className;
    doc.body.className = document.body.className;
    // The game's style.css styles the body for a full-screen canvas; the
    // settings page wants a plain background behind the dialog surface.
    doc.body.style.margin = '0';
    doc.body.style.overflow = 'hidden';
}

/** Opens the settings window, on `initialTab` if given; an open window just switches to that tab and comes forward. */
export async function openSettingsDialog(initialTab?: SettingsTab): Promise<void> {
    if (openDialog) {
        if (initialTab) {
            openDialog.componentInstance.selectTab(initialTab);
        }
        openWindow?.focus();
        return;
    }
    if (!host || !spawnMenu || opening) {
        return;
    }
    // Opened before any await, so the popup still counts as the click's.
    const win = window.open('', 'retroflightsim-settings', WINDOW_FEATURES);
    if (!win) {
        console.error('Settings window was blocked');
        return;
    }
    const { data, onOpenChange } = host;
    const menu = spawnMenu;
    opening = true;
    onOpenChange(true);
    menu.notifyOpened();
    let appRef: ApplicationRef | undefined;
    const closed = () => {
        if (openWindow !== win) {
            return;
        }
        openDialog = undefined;
        openWindow = undefined;
        window.removeEventListener('pagehide', closeWindow);
        appRef?.destroy();
        if (!win.closed) {
            win.close();
        }
        onOpenChange(false);
        menu.notifyClosed();
    };
    const closeWindow = () => win.close();
    try {
        prepareWindow(win);
        openWindow = win;
        win.addEventListener('pagehide', closed);
        // The game going away takes its settings with it.
        window.addEventListener('pagehide', closeWindow);
        importerProbe ??= isAreaImporterAvailable();
        const [app, terrainImport] = await Promise.all([
            createApplication({
                providers: [
                    { provide: DOCUMENT, useValue: win.document },
                    // Breakpoints are the popup's width, not the game's.
                    { provide: MediaMatcher, useValue: { matchMedia: (q: string) => win.matchMedia(q) } },
                ],
            }),
            importerProbe,
        ]);
        appRef = app;
        if (!terrainImport) {
            importerProbe = undefined;
        }
        if (win.closed) {
            closed();
            return;
        }
        const ref = app.injector.get(MatDialog).open(SettingsDialog, {
            data: { ...data, initialTab, terrainImport, spawnMenu: menu },
            // The dialog is the whole window.
            width: '100vw',
            height: '100vh',
            maxWidth: '100vw',
            maxHeight: '100vh',
            hasBackdrop: false,
            autoFocus: 'dialog',
        });
        openDialog = ref;
        ref.afterClosed().subscribe(closed);
        win.focus();
    } catch (err) {
        console.error('Settings window failed to open', err);
        win.close();
        closed();
        if (openWindow !== win) {
            onOpenChange(false);
            menu.notifyClosed();
        }
    } finally {
        opening = false;
    }
}
