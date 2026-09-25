import { SpawnMode } from '../config/settingsStorage';
import { AircraftModelGroup } from '../state/aircraftRegistry';
import { closeSettingsDialog, openSettingsDialog, registerSpawnMenu } from '../ui/settings/settingsLauncher';

/** One airfield the player can be based at. */
export interface AirfieldChoice {
    icao: string;
    name: string;
    /** Designators of its longest runway. */
    ref: string;
    lengthM: number;
}

/** What the settings dialog's Flight tab shows: labels plus the selected index of each list. */
export interface SpawnMenuState {
    aircraft: string[];
    aircraftIndex: number;
    liveries: string[];
    liveryIndex: number;
    airfields: string[];
    airfieldIndex: number;
}

/**
 * The spawn menu: aircraft, livery and airfield choices plus the spawn
 * actions. It has no DOM of its own; it is the first tab of the settings
 * dialog, which reads this state and reports choices back through it.
 */
export class SpawnPanel {
    private airfieldChoices: AirfieldChoice[] = [];
    private state: SpawnMenuState = {
        aircraft: [], aircraftIndex: 0, liveries: [], liveryIndex: 0, airfields: [], airfieldIndex: 0,
    };
    private readonly listeners = new Set<(state: SpawnMenuState) => void>();

    constructor(
        private readonly onModelSelect: (modelIndex: number) => void,
        private readonly onLiverySelect: (liveryIndex: number) => void,
        private readonly onAirfieldSelect: (icao: string) => void,
        private readonly onSpawn: (mode: SpawnMode) => void,
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

    /**
     * Offer the airfields of the area being flown.
     *
     * The dialog hides the list entirely when there is one or none: a menu
     * whose only choice is the one already made is furniture, and an area
     * baked before airfields existed has nothing to put in it.
     */
    setAirfields(choices: AirfieldChoice[], selectedIcao: string | undefined): void {
        this.airfieldChoices = choices;
        const index = choices.findIndex(c => (c.icao || c.name) === selectedIcao);
        this.update({
            airfields: choices.map(choice => {
                const id = choice.icao ? `${choice.icao} — ` : '';
                return `${id}${choice.name} (${choice.ref}, ${Math.round(choice.lengthM)} m)`;
            }),
            airfieldIndex: index >= 0 ? index : 0,
        });
    }

    setSelection(groups: AircraftModelGroup[], modelIndex: number, liveryIndex: number): void {
        const aircraftIndex = Math.min(modelIndex, Math.max(0, groups.length - 1));
        const liveries = (groups[aircraftIndex]?.variants ?? [])
            .map(variant => variant.liveryName ?? variant.name);
        this.update({
            aircraft: groups.map(group => group.label),
            aircraftIndex,
            liveries,
            liveryIndex: Math.min(liveryIndex, Math.max(0, liveries.length - 1)),
        });
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
