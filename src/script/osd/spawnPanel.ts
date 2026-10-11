import { SpawnMode } from '../config/settingsStorage';
import { AircraftModelGroup } from '../state/aircraftRegistry';
import { AirfieldEntry, SpawnDestination, searchPlaces } from '../state/spawnSearch';
import type { TerrainArea } from '../terrain/manifest';
import { closeSettingsDialog, openSettingsDialog, registerSpawnMenu } from '../ui/settings/settingsLauncher';
import {
    AirfieldChoice, SpawnMenuState, aircraftMenu, airfieldMenu, quickSearch,
} from '../ui/settings/settingsModel';

export type { AirfieldChoice, SpawnMenuState } from '../ui/settings/settingsModel';

/**
 * The spawn menu: aircraft, livery and airfield choices plus the spawn
 * actions. It has no DOM of its own; it is the first tab of the settings
 * dialog, which reads this state and reports choices back through it.
 */
export class SpawnPanel {
    private airfieldChoices: AirfieldChoice[] = [];
    private searchEntries: readonly AirfieldEntry[] = [];
    private searchAreas: readonly TerrainArea[] = [];
    private currentArea = '';
    private state: SpawnMenuState = {
        aircraft: [], aircraftIndex: 0, liveries: [], liveryIndex: 0, airfields: [], airfieldIndex: 0,
    };
    private readonly listeners = new Set<(state: SpawnMenuState) => void>();

    constructor(
        private readonly onModelSelect: (modelIndex: number) => void,
        private readonly onLiverySelect: (liveryIndex: number) => void,
        private readonly onAirfieldSelect: (icao: string) => void,
        private readonly onSpawn: (mode: SpawnMode) => void,
        private readonly onDestination: (destination: SpawnDestination) => void,
        private readonly onOpened: () => void,
        private readonly onClosed: () => void,
    ) {
        registerSpawnMenu(this);
    }

    getState(): SpawnMenuState {
        return this.state;
    }

    /** Calls `listener` on every change; returns the unsubscribe. */
    subscribe(listener: (state: SpawnMenuState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    selectModel(index: number): void {
        this.onModelSelect(index);
    }

    selectLivery(index: number): void {
        this.onLiverySelect(index);
    }

    selectAirfield(index: number): void {
        const choice = this.airfieldChoices[index];
        if (choice !== undefined) {
            this.update({ airfieldIndex: index });
            this.onAirfieldSelect(choice.icao || choice.name);
        }
    }

    spawn(mode: SpawnMode): void {
        this.onSpawn(mode);
    }

    /** What the search box searches: every baked area's airfields, and the areas themselves. */
    setSearchIndex(entries: readonly AirfieldEntry[], areas: readonly TerrainArea[], currentArea: string): void {
        this.searchEntries = entries;
        this.searchAreas = areas;
        this.currentArea = currentArea;
    }

    /**
     * Matches that need no network, as the player types: a coordinate pair,
     * and airfields of every baked area.
     */
    quickSearch(query: string): SpawnDestination[] {
        return quickSearch(query, this.searchEntries, this.searchAreas, this.currentArea);
    }

    /** Places by name, from the geocoder; only on an explicit search. */
    searchPlaces(query: string): Promise<SpawnDestination[]> {
        return searchPlaces(query, this.searchAreas, this.currentArea);
    }

    /**
     * Go to a search result: an airfield becomes the base the start buttons
     * use, a place starts an airborne flight over it. Either may reload into
     * another area first. Nothing happens for one with no terrain.
     */
    goTo(destination: SpawnDestination): void {
        if (destination.area !== undefined) {
            this.onDestination(destination);
        }
    }

    /**
     * Offer the airfields of the area being flown.
     *
     * The dialog shows the list whenever there is at least one, so the field
     * being flown from is always visible; an area baked before airfields
     * existed has nothing to put in it, and then the list is hidden.
     */
    setAirfields(choices: AirfieldChoice[], selectedIcao: string | undefined): void {
        this.airfieldChoices = choices;
        this.update(airfieldMenu(choices, selectedIcao));
    }

    setSelection(groups: AircraftModelGroup[], modelIndex: number, liveryIndex: number): void {
        this.update(aircraftMenu(groups, modelIndex, liveryIndex));
    }

    /** Open the settings dialog on the Flight tab. */
    show(): void {
        void openSettingsDialog('Flight');
    }

    /** Close the settings dialog: a flight is starting. */
    hide(): void {
        closeSettingsDialog();
    }

    /** The settings dialog opened, whichever way. */
    notifyOpened(): void {
        this.onOpened();
    }

    /** The settings dialog closed, whether by a spawn or not. */
    notifyClosed(): void {
        this.onClosed();
    }

    private update(change: Partial<SpawnMenuState>): void {
        this.state = { ...this.state, ...change };
        for (const listener of this.listeners) {
            listener(this.state);
        }
    }
}
