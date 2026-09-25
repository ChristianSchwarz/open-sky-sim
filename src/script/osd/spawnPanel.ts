import { AircraftModelGroup } from '../state/aircraftRegistry';

/** One airfield the player can be based at. */
export interface AirfieldChoice {
    icao: string;
    name: string;
    /** Designators of its longest runway. */
    ref: string;
    lengthM: number;
}

/** HTML spawn menu with aircraft, livery and airfield selectors, plus actions. */
export class SpawnPanel {
    private readonly panel: HTMLElement;
    private readonly title: HTMLElement;
    private readonly aircraftSelect: HTMLSelectElement;
    private readonly liveryLabel: HTMLLabelElement;
    private readonly liverySelect: HTMLSelectElement;
    private readonly airfieldLabel: HTMLLabelElement;
    private readonly airfieldSelect: HTMLSelectElement;
    private airfields: AirfieldChoice[] = [];

    constructor(
        onModelSelect: (modelIndex: number) => void,
        onLiverySelect: (liveryIndex: number) => void,
        onAirfieldSelect: (icao: string) => void,
        onApproach: () => void,
        onRunway: () => void,
        onHeadOn: () => void,
        onCarrier: () => void,
        onCarrierBarricade: () => void,
        onCarrierTakeoff: () => void,
        onHighAlt: () => void,
        onSpace: () => void,
    ) {
        this.panel = document.getElementById('spawn-panel')!;
        this.title = document.getElementById('spawn-title')!;
        this.aircraftSelect = document.getElementById('aircraft-select') as HTMLSelectElement;
        this.liveryLabel = document.getElementById('livery-label') as HTMLLabelElement;
        this.liverySelect = document.getElementById('livery-select') as HTMLSelectElement;
        this.airfieldLabel = document.getElementById('airfield-label') as HTMLLabelElement;
        this.airfieldSelect = document.getElementById('airfield-select') as HTMLSelectElement;

        this.airfieldSelect.addEventListener('change', () => {
            const choice = this.airfields[this.airfieldSelect.selectedIndex];
            if (choice !== undefined) {
                onAirfieldSelect(choice.icao || choice.name);
            }
        });

        this.aircraftSelect.addEventListener('change', () => {
            onModelSelect(this.aircraftSelect.selectedIndex);
        });
        this.liverySelect.addEventListener('change', () => {
            onLiverySelect(this.liverySelect.selectedIndex);
        });

        document.getElementById('spawn-approach')!.addEventListener('click', onApproach);
        document.getElementById('spawn-runway')!.addEventListener('click', onRunway);
        document.getElementById('spawn-headon')!.addEventListener('click', onHeadOn);
        document.getElementById('spawn-carrier')!.addEventListener('click', onCarrier);
        document.getElementById('spawn-carrier-barricade')!.addEventListener('click', onCarrierBarricade);
        document.getElementById('spawn-carrier-takeoff')!.addEventListener('click', onCarrierTakeoff);
        document.getElementById('spawn-high-alt')!.addEventListener('click', onHighAlt);
        document.getElementById('spawn-space')!.addEventListener('click', onSpace);
    }

    setTitle(text: string): void {
        this.title.textContent = text;
    }

    /**
     * Offer the airfields of the area being flown.
     *
     * Hidden entirely when there is one or none: a menu whose only choice is
     * the one already made is furniture, and an area baked before airfields
     * existed has nothing to put in it.
     */
    setAirfields(choices: AirfieldChoice[], selectedIcao: string | undefined): void {
        this.airfields = choices;
        const show = choices.length > 1;
        this.airfieldLabel.classList.toggle('hidden', !show);
        this.airfieldSelect.classList.toggle('hidden', !show);
        if (!show) {
            return;
        }
        this.airfieldSelect.replaceChildren();
        for (const choice of choices) {
            const option = document.createElement('option');
            const id = choice.icao ? `${choice.icao} — ` : '';
            option.textContent = `${id}${choice.name} (${choice.ref}, `
                + `${Math.round(choice.lengthM)} m)`;
            this.airfieldSelect.appendChild(option);
        }
        const index = choices.findIndex(c => (c.icao || c.name) === selectedIcao);
        this.airfieldSelect.selectedIndex = index >= 0 ? index : 0;
    }

    setSelection(groups: AircraftModelGroup[], modelIndex: number, liveryIndex: number): void {
        this.aircraftSelect.replaceChildren();
        for (const group of groups) {
            const option = document.createElement('option');
            option.textContent = group.label;
            this.aircraftSelect.appendChild(option);
        }
        const modelRows = Math.min(Math.max(groups.length, 1), 12);
        this.aircraftSelect.size = modelRows;
        this.aircraftSelect.selectedIndex = Math.min(
            modelIndex,
            Math.max(0, groups.length - 1),
        );

        const group = groups[this.aircraftSelect.selectedIndex];
        const liveries = group?.variants ?? [];
        this.liverySelect.replaceChildren();
        for (const variant of liveries) {
            const option = document.createElement('option');
            option.textContent = variant.liveryName ?? variant.name;
            this.liverySelect.appendChild(option);
        }
        const liveryRows = Math.min(Math.max(liveries.length, 1), 12);
        this.liverySelect.size = liveryRows;
        this.liverySelect.selectedIndex = Math.min(
            liveryIndex,
            Math.max(0, liveries.length - 1),
        );

        const showLivery = liveries.length > 1;
        this.liveryLabel.classList.toggle('hidden', !showLivery);
        this.liverySelect.classList.toggle('hidden', !showLivery);
    }

    show(): void {
        this.panel.classList.remove('hidden');
    }

    hide(): void {
        this.panel.classList.add('hidden');
    }
}
