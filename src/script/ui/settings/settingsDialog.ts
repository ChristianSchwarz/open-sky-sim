import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatSliderModule } from '@angular/material/slider';
import { MatTabsModule } from '@angular/material/tabs';
import { AudioSystem } from '../../audio/audioSystem';
import { ConfigService } from '../../config/configService';
import { loadSettings, updateSettings } from '../../config/settingsStorage';
import { JoystickControlDevice } from '../../input/devices/joystickControlDevice';
import {
    KeyboardControlAction, KeyboardControlDevice, KeyboardControlLayoutId, KeyboardControlLayouts,
} from '../../input/devices/keyboardControlDevice';
import { formatSunTime } from '../../scene/materials/shaders/sun';
import { AiPilotModels, FlightModels, ShadowQualities, TechProfiles, TerrainColours, TerrainShading, UnitSystems } from '../../state/gameDefs';
import { PLAY_ORIGIN } from '../../state/worldLayout';
import {
    DETAIL_DISTANCE_OFF, TERRAIN_DETAIL_DISTANCE_MAX_M, TERRAIN_DETAIL_DISTANCE_MIN_M,
} from '../../terrain/lod';
import { DEFAULT_TERRAIN_URL, loadTerrainManifest } from '../../terrain/manifest';
import { homeArea, terrainAreas } from '../../terrain/playArea';
import { TerrainImportTab } from './terrainImportTab';

export type SettingsTab = 'Graphics' | 'World' | 'Simulation' | 'General' | 'Help';

export interface SettingsDialogData {
    config: ConfigService;
    keyboardInput: KeyboardControlDevice;
    joystickInput: JoystickControlDevice;
    audio: AudioSystem;
    /** The tab to open on; otherwise the one last looked at. */
    initialTab?: SettingsTab;
    /** Whether the World tab offers terrain import: only the dev server can bake terrain. */
    terrainImport: boolean;
}

/** A row of the Help tab: the keys, then what they do. */
interface HelpEntry {
    keys: string[];
    action: string;
}

const SYSTEMS_HELP: HelpEntry[] = [
    { keys: ['G'], action: 'Landing gear' },
    { keys: ['F'], action: 'Flaps' },
    { keys: ['L'], action: 'FCS limiters (AoA/g) on/off' },
    { keys: ['1', '2', '3'], action: 'FCS limiter strategy (soft / predictive / smooth)' },
    { keys: ['T'], action: 'Select target' },
    { keys: ['I'], action: 'Target night view' },
    { keys: ['H'], action: 'Cycle HUD focus' },
    { keys: ['R'], action: 'Flight recorder (toggle, downloads JSON)' },
    { keys: ['Num Lock'], action: 'Telemetry graph' },
    { keys: ['F9'], action: 'Import or delete terrain areas (opens the World tab)' },
    { keys: ['F10'], action: 'Import aircraft mod (.zip)' },
];

const SPAWN_HELP: HelpEntry[] = [
    { keys: ['Esc'], action: 'Open spawn menu' },
    { keys: ['1'], action: 'Approach spawn' },
    { keys: ['2'], action: 'Runway spawn' },
    { keys: ['3'], action: 'Head-on spawn' },
    { keys: ['4'], action: 'Carrier landing spawn' },
    { keys: ['5'], action: 'Carrier takeoff spawn' },
    { keys: ['6'], action: 'High-altitude spawn (10 km)' },
    { keys: ['7'], action: 'Space spawn (400 km)' },
    { keys: ['8'], action: 'Carrier barricade spawn (50 m astern of the ramp, net rigged, flying solo)' },
];

const VIEWS_HELP: HelpEntry[] = [
    { keys: ['N'], action: 'Day/night' },
    { keys: ['F1'], action: 'Cockpit (press again with a target to toggle padlock)' },
    { keys: ['F2'], action: 'Exterior back/front' },
    { keys: ['F3'], action: 'Exterior left/right' },
    { keys: ['F6'], action: 'Exterior back/front of AI plane (looks at player)' },
    { keys: ['F12'], action: 'Aircraft showcase (black background, orbit with numpad)' },
    { keys: ['4'], action: 'To/from target' },
    { keys: ['Num 4', 'Num 6', 'Num 8', 'Num 2'], action: 'Move camera around aircraft' },
    { keys: ['Num 5'], action: 'Recenter camera' },
    { keys: ['Num *', 'Num /'], action: 'Zoom in / out (F1: padlock target, F2: lock/unlock on enemy)' },
];

function formatControlKey(key: string): string {
    switch (key) {
        case 'arrowup': return '↑';
        case 'arrowdown': return '↓';
        case 'arrowleft': return '←';
        case 'arrowright': return '→';
        case 'numpadadd': return 'Num+';
        case 'numpadsubtract': return 'Num-';
        default: return key.toUpperCase();
    }
}

/** "Logitech Extreme 3D (Vendor: 046d Product: c215)" reads as "Logitech Extreme 3D". */
function joystickName(id: string): string {
    const bracket = id.lastIndexOf('(');
    return bracket !== -1 ? id.substring(0, bracket - 1) : id;
}

interface Option<T> {
    value: T;
    label: string;
}

const TECH_PROFILE_OPTIONS: Option<string>[] = [
    { value: TechProfiles.VGA, label: '386 / VGA' },
    { value: TechProfiles.SVGA, label: '486 / SVGA' },
    { value: TechProfiles.HD, label: 'HD' },
];

const SHADOW_QUALITY_OPTIONS: Option<ShadowQualities>[] = [
    { value: ShadowQualities.OFF, label: 'Off (planform silhouette)' },
    { value: ShadowQualities.LOW, label: 'Low (2048)' },
    { value: ShadowQualities.MEDIUM, label: 'Medium (4096)' },
    { value: ShadowQualities.HIGH, label: 'High (8192)' },
    { value: ShadowQualities.ULTRA, label: 'Ultra (16384) — needs >2 GB VRAM' },
];

const TERRAIN_COLOUR_OPTIONS: Option<TerrainColours>[] = [
    { value: TerrainColours.LANDCOVER, label: 'Landcover (palette tones)' },
    { value: TerrainColours.SWATCH, label: 'Swatches (quantised imagery)' },
    { value: TerrainColours.HYBRID, label: 'Hybrid (palette hue, real shading)' },
    { value: TerrainColours.IMAGERY, label: 'Imagery (true colour)' },
];

const TERRAIN_SHADING_OPTIONS: Option<TerrainShading>[] = [
    { value: TerrainShading.FACETED, label: 'Faceted (flat)' },
    { value: TerrainShading.SMOOTH, label: 'Smooth (blended)' },
];

const FLIGHT_MODEL_OPTIONS: Option<string>[] = [
    { value: FlightModels.FM2, label: 'FM2 (Rigid body)' },
    { value: FlightModels.DEBUG, label: 'Debug (Free-fly)' },
    { value: FlightModels.JSBSIM, label: 'JSBSim (WASM, F-16)' },
];

const AI_PILOT_MODEL_OPTIONS: Option<AiPilotModels>[] = [
    { value: AiPilotModels.CLASSIC, label: 'Classic BFM' },
    { value: AiPilotModels.SHAW, label: 'Shaw (Fighter Combat)' },
    { value: AiPilotModels.AGGRESSIVE, label: 'Aggressive (Berserker)' },
    { value: AiPilotModels.ACE, label: 'Ace (vertical fight + post-stall)' },
];

const UNIT_SYSTEM_OPTIONS: Option<UnitSystems>[] = [
    { value: UnitSystems.METRIC, label: 'Metric (m, km/h)' },
    { value: UnitSystems.IMPERIAL, label: 'Imperial (ft, kt)' },
];

const KEYBOARD_LAYOUT_OPTIONS: Option<KeyboardControlLayoutId>[] = [
    { value: KeyboardControlLayoutId.QWERTY, label: 'QWERTY' },
    { value: KeyboardControlLayoutId.QWERTZ, label: 'QWERTZ' },
    { value: KeyboardControlLayoutId.AZERTY, label: 'AZERTY' },
    { value: KeyboardControlLayoutId.DVORAK, label: 'Dvorak' },
    { value: KeyboardControlLayoutId.ARROWS, label: 'Arrows' },
];

/**
 * The terrain detail slider is in kilometres and the setting is in metres,
 * because kilometres are what the label has to read and metres are what every
 * distance in the LOD is already in. The top step is off —
 * `DETAIL_DISTANCE_OFF` — rather than a very large number, so "off" is exact
 * instead of merely far.
 */
const DETAIL_OFF_KM = TERRAIN_DETAIL_DISTANCE_MAX_M / 1000;

/**
 * The tab the player last looked at, so reopening lands back on it. Kept by
 * name, not index, so reordering the tabs cannot land it on the wrong one.
 */
let lastTab: SettingsTab = 'Graphics';

function sliderValue(event: Event): number {
    return parseFloat((event.target as HTMLInputElement).value);
}

@Component({
    selector: 'rfs-settings-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        NgTemplateOutlet, MatButtonModule, MatDialogModule, MatFormFieldModule, MatRadioModule,
        MatSelectModule, MatSliderModule, MatTabsModule, TerrainImportTab,
    ],
    template: `
<h2 mat-dialog-title>Settings</h2>
<mat-dialog-content>
    <mat-tab-group mat-stretch-tabs="false" animationDuration="0ms" [disablePagination]="true"
        [selectedIndex]="tabIndex()" (selectedIndexChange)="selectTab($event)">

        <mat-tab label="Graphics">
            <div class="flex flex-col gap-6 pt-4">
                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Generation</h3>
                    <mat-radio-group class="grid grid-cols-1 sm:grid-cols-3"
                        [value]="techProfile()" (change)="setTechProfile($event.value)">
                        @for (option of techProfiles; track option.value) {
                            <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                        }
                    </mat-radio-group>
                </section>

                <section>
                    <h3 class="m-0 mb-1 text-base font-medium">Shadows</h3>
                    <p class="m-0 mb-2 text-sm opacity-70">
                        Resolution of the near cascade; the wide one follows it up to 8192.
                    </p>
                    <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                        [value]="shadowQuality()" (change)="setShadowQuality($event.value)">
                        @for (option of shadowQualities; track option.value) {
                            <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                        }
                    </mat-radio-group>
                </section>

                <section>
                    <h3 class="m-0 mb-1 text-base font-medium">Terrain detail distance</h3>
                    <p class="m-0 mb-2 text-sm opacity-70">
                        How far out terrain keeps full detail. Past it the far field is drawn
                        coarser, which is where most of the triangles above the horizon go —
                        lower this if the frame rate is short. The ground you are flying over
                        is never affected. Rightmost is off.
                    </p>
                    <div class="flex items-center gap-4">
                        <mat-slider class="flex-1" [min]="detailMinKm" [max]="detailMaxKm" [step]="2">
                            <input matSliderThumb [value]="terrainDetailKm()" (input)="setTerrainDetail($event)">
                        </mat-slider>
                        <output class="w-16 text-right tabular-nums">{{ terrainDetailLabel() }}</output>
                    </div>
                </section>

                <section>
                    <h3 class="m-0 mb-1 text-base font-medium">Terrain colour</h3>
                    <p class="m-0 mb-2 text-sm opacity-70">
                        Every facet is baked with both a landcover class and a satellite colour;
                        this picks which one paints it.
                    </p>
                    <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                        [value]="terrainColour()" (change)="setTerrainColour($event.value)">
                        @for (option of terrainColours; track option.value) {
                            <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                        }
                    </mat-radio-group>
                </section>

                <section>
                    <h3 class="m-0 mb-1 text-base font-medium">Terrain shading</h3>
                    <p class="m-0 mb-2 text-sm opacity-70">
                        Flat colour per facet, or smoothly blended across neighbouring facets.
                    </p>
                    <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                        [value]="terrainShading()" (change)="setTerrainShading($event.value)">
                        @for (option of terrainShadings; track option.value) {
                            <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                        }
                    </mat-radio-group>
                </section>
            </div>
        </mat-tab>

        <mat-tab label="World">
            <div class="flex flex-col gap-6 pt-4">
                @if (areas().length > 1) {
                    <section>
                        <h3 class="m-0 mb-1 text-base font-medium">Area</h3>
                        <p class="m-0 mb-2 text-sm opacity-70">
                            Where in the world to fly. Areas other than the home one are terrain
                            only — no airbase, no carrier — so you start airborne over the middle
                            of them. Changing this reloads the sim.
                        </p>
                        <div class="flex items-center gap-4">
                            <mat-form-field class="flex-1" subscriptSizing="dynamic">
                                <mat-label>Area</mat-label>
                                <mat-select [value]="area()" (selectionChange)="area.set($event.value)">
                                    @for (option of areas(); track option.value) {
                                        <mat-option [value]="option.value">{{ option.label }}</mat-option>
                                    }
                                </mat-select>
                            </mat-form-field>
                            <button mat-flat-button type="button"
                                [disabled]="area() === initialArea()" (click)="flyToArea()">Fly here</button>
                        </div>
                    </section>
                }

                @if (terrainImport) {
                    <section>
                        <h3 class="m-0 mb-1 text-base font-medium">Import terrain</h3>
                        <p class="m-0 mb-2 text-sm opacity-70">
                            Bake a new area into the terrain, or delete one. Runs on the dev server
                            and carries on if this dialog is closed.
                        </p>
                        <rfs-terrain-import-tab />
                    </section>
                }

                @if (areasLoaded() && areas().length < 2 && !terrainImport) {
                    <p class="m-0 text-sm opacity-70">
                        Only one terrain area is baked, so there is nothing to choose between.
                    </p>
                }
            </div>
        </mat-tab>

        <mat-tab label="Simulation">
            <div class="flex flex-col gap-6 pt-4">
                <section>
                    <h3 class="m-0 mb-1 text-base font-medium">Time of day</h3>
                    <p class="m-0 mb-2 text-sm opacity-70">
                        Local solar time. Moves the sun, so sky, terrain and cast shadows follow
                        it. Sunrise 06:00, sunset 18:00. N flips between afternoon and midnight.
                    </p>
                    <div class="flex items-center gap-4">
                        <mat-slider class="flex-1" [min]="0" [max]="23.75" [step]="0.25">
                            <input matSliderThumb [value]="daytime()" (input)="setDaytime($event)">
                        </mat-slider>
                        <output class="w-16 text-right tabular-nums">{{ daytimeLabel() }}</output>
                    </div>
                </section>

                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Flight model</h3>
                    <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                        [value]="flightModel()" (change)="setFlightModel($event.value)">
                        @for (option of flightModels; track option.value) {
                            <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                        }
                    </mat-radio-group>
                </section>

                <section>
                    <h3 class="m-0 mb-1 text-base font-medium">AI pilot model</h3>
                    <p class="m-0 mb-2 text-sm opacity-70">Applies on the next merge / opponent spawn.</p>
                    <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                        [value]="aiPilotModel()" (change)="setAiPilotModel($event.value)">
                        @for (option of aiPilotModels; track option.value) {
                            <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                        }
                    </mat-radio-group>
                </section>
            </div>
        </mat-tab>

        <mat-tab label="General">
            <div class="flex flex-col gap-6 pt-4">
                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Volume</h3>
                    <div class="flex items-center gap-4">
                        <mat-slider class="flex-1" [min]="0" [max]="100" [step]="1">
                            <input matSliderThumb [value]="volume()" (input)="setVolume($event)">
                        </mat-slider>
                        <output class="w-16 text-right tabular-nums">{{ volume() }}%</output>
                    </div>
                </section>

                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Units</h3>
                    <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                        [value]="unitSystem()" (change)="setUnitSystem($event.value)">
                        @for (option of unitSystems; track option.value) {
                            <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                        }
                    </mat-radio-group>
                </section>

                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Keyboard layout</h3>
                    <mat-radio-group class="grid grid-cols-2 sm:grid-cols-3"
                        [value]="keyboardLayout()" (change)="setKeyboardLayout($event.value)">
                        @for (option of keyboardLayouts; track option.value) {
                            <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                        }
                    </mat-radio-group>
                </section>
            </div>
        </mat-tab>

        <mat-tab label="Help">
            <div class="flex flex-col gap-6 pt-4">
                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Keyboard</h3>
                    <ng-container *ngTemplateOutlet="helpList; context: { $implicit: flightHelp() }" />
                </section>

                <section>
                    <h3 class="m-0 mb-1 text-base font-medium">Joystick</h3>
                    @if (joystick(); as joystick) {
                        <p class="m-0 mb-2 text-sm opacity-70">{{ joystick.name }}</p>
                        <ng-container *ngTemplateOutlet="helpList; context: { $implicit: joystick.axes }" />
                    } @else {
                        <p class="m-0 text-sm opacity-70">No device detected</p>
                    }
                </section>

                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Systems</h3>
                    <ng-container *ngTemplateOutlet="helpList; context: { $implicit: systemsHelp }" />
                </section>

                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Spawn menu</h3>
                    <ng-container *ngTemplateOutlet="helpList; context: { $implicit: spawnHelp }" />
                    <p class="m-0 mt-2 text-sm opacity-70">Aircraft list: pick from the combobox in the spawn menu.</p>
                </section>

                <section>
                    <h3 class="m-0 mb-2 text-base font-medium">Views</h3>
                    <ng-container *ngTemplateOutlet="helpList; context: { $implicit: viewsHelp }" />
                </section>
            </div>
        </mat-tab>
    </mat-tab-group>
</mat-dialog-content>

<ng-template #helpList let-entries>
    <dl class="m-0 grid grid-cols-[minmax(7rem,auto)_1fr] items-baseline gap-x-4 gap-y-1.5 text-sm">
        @for (entry of entries; track entry.action) {
            <dt class="flex flex-wrap gap-1">
                @for (key of entry.keys; track $index) {
                    <kbd class="rounded border border-white/25 bg-white/10 px-1.5 font-mono text-xs leading-5">{{ key }}</kbd>
                }
            </dt>
            <dd class="m-0">{{ entry.action }}</dd>
        }
    </dl>
</ng-template>
<mat-dialog-actions align="end">
    <button mat-button type="button" mat-dialog-close>Close</button>
</mat-dialog-actions>
`,
})
export class SettingsDialog {
    private readonly data = inject<SettingsDialogData>(MAT_DIALOG_DATA);
    private readonly config = this.data.config;

    readonly techProfiles = TECH_PROFILE_OPTIONS;
    readonly shadowQualities = SHADOW_QUALITY_OPTIONS;
    readonly terrainColours = TERRAIN_COLOUR_OPTIONS;
    readonly terrainShadings = TERRAIN_SHADING_OPTIONS;
    readonly flightModels = FLIGHT_MODEL_OPTIONS;
    readonly aiPilotModels = AI_PILOT_MODEL_OPTIONS;
    readonly unitSystems = UNIT_SYSTEM_OPTIONS;
    readonly keyboardLayouts = KEYBOARD_LAYOUT_OPTIONS;

    readonly detailMinKm = TERRAIN_DETAIL_DISTANCE_MIN_M / 1000;
    readonly detailMaxKm = DETAIL_OFF_KM + 2;

    readonly terrainImport = this.data.terrainImport;
    /** In template order; must match the mat-tab labels. */
    private readonly tabs: SettingsTab[] = [
        'Graphics', 'World', 'Simulation', 'General', 'Help',
    ];
    readonly tab = signal<SettingsTab>(this.data.initialTab ?? lastTab);
    readonly tabIndex = computed(() => Math.max(0, this.tabs.indexOf(this.tab())));
    readonly techProfile = signal(this.config.techProfiles.getActiveKey());
    readonly shadowQuality = signal(this.config.shadowQuality.getActive());
    readonly terrainColour = signal(this.config.terrainColour.getActive());
    readonly terrainShading = signal(this.config.terrainShading.getActive());
    readonly flightModel = signal(this.config.flightModels.getActiveKey());
    readonly aiPilotModel = signal(this.config.aiPilotModels.getActive());
    readonly unitSystem = signal(this.config.unitSystem.getActive());
    readonly keyboardLayout = signal(this.data.keyboardInput.getKeyboardLayoutId());
    readonly volume = signal(Math.round(loadSettings().volume * 100));

    readonly daytime = signal(this.config.daytime.getActive());
    readonly daytimeLabel = computed(() => formatSunTime(this.daytime()));

    /** Metres, or `DETAIL_DISTANCE_OFF`. */
    readonly terrainDetail = signal(this.config.terrainDetail.getActive());
    readonly terrainDetailKm = computed(() => {
        const m = this.terrainDetail();
        return Number.isFinite(m) ? m / 1000 : this.detailMaxKm;
    });
    readonly terrainDetailLabel = computed(() => {
        const m = this.terrainDetail();
        return Number.isFinite(m) ? `${Math.round(m / 1000)} km` : 'Off';
    });

    readonly areas = signal<Option<string>[]>([]);
    readonly area = signal('');
    readonly initialArea = signal('');
    /** Set once the manifest has answered, so "nothing to choose" never flashes up while loading. */
    readonly areasLoaded = signal(false);

    readonly systemsHelp = SYSTEMS_HELP;
    readonly spawnHelp = SPAWN_HELP;
    readonly viewsHelp = VIEWS_HELP;

    /** Flight control keys, relabelled whenever the keyboard layout changes. */
    readonly flightHelp = computed<HelpEntry[]>(() => {
        const layout = KeyboardControlLayouts.get(this.keyboardLayout());
        if (!layout) {
            return [];
        }
        const keys = (...actions: KeyboardControlAction[]) => actions.map(a => formatControlKey(layout[a]));
        return [
            { keys: keys(KeyboardControlAction.PITCH_NEG, KeyboardControlAction.PITCH_POS), action: 'Pitch' },
            { keys: keys(KeyboardControlAction.ROLL_NEG, KeyboardControlAction.ROLL_POS), action: 'Roll' },
            { keys: keys(KeyboardControlAction.YAW_NEG, KeyboardControlAction.YAW_POS), action: 'Yaw' },
            { keys: keys(KeyboardControlAction.THROTTLE_POS, KeyboardControlAction.THROTTLE_NEG), action: 'Throttle' },
        ];
    });

    readonly joystick = signal(this.readJoystick());

    constructor() {
        this.loadAreas();

        // The device keeps a single status listener, and nothing else uses it,
        // so the dialog takes it while open and hands back a no-op on close.
        this.data.joystickInput.setListener(() => this.joystick.set(this.readJoystick()));
        inject(DestroyRef).onDestroy(() => this.data.joystickInput.setListener(() => { }));
    }

    selectTab(index: number) {
        const tab = this.tabs[index] ?? 'Graphics';
        lastTab = tab;
        this.tab.set(tab);
    }

    setTechProfile(id: string) {
        this.config.techProfiles.setActive(id);
        updateSettings({ techProfile: id });
        this.techProfile.set(id);
    }

    setShadowQuality(quality: ShadowQualities) {
        this.config.shadowQuality.setActive(quality);
        updateSettings({ shadowQuality: quality });
        this.shadowQuality.set(quality);
    }

    setTerrainDetail(event: Event) {
        const km = sliderValue(event);
        this.config.terrainDetail.setActive(km > DETAIL_OFF_KM ? DETAIL_DISTANCE_OFF : km * 1000);
        this.terrainDetail.set(this.config.terrainDetail.getActive());
    }

    setTerrainColour(mode: TerrainColours) {
        this.config.terrainColour.setActive(mode);
        updateSettings({ terrainColour: mode });
        this.terrainColour.set(mode);
    }

    setTerrainShading(mode: TerrainShading) {
        this.config.terrainShading.setActive(mode);
        updateSettings({ terrainShading: mode });
        this.terrainShading.set(mode);
    }

    setDaytime(event: Event) {
        this.config.daytime.setActive(sliderValue(event));
        this.daytime.set(this.config.daytime.getActive());
    }

    setFlightModel(id: string) {
        this.config.flightModels.setActive(id);
        updateSettings({ flightModel: id });
        this.flightModel.set(id);
    }

    setAiPilotModel(model: AiPilotModels) {
        this.config.aiPilotModels.setActive(model);
        updateSettings({ aiPilotModel: model });
        this.aiPilotModel.set(model);
    }

    setUnitSystem(system: UnitSystems) {
        this.config.unitSystem.setActive(system);
        this.unitSystem.set(system);
    }

    setVolume(event: Event) {
        const percent = Math.round(sliderValue(event));
        this.data.audio.setMasterVolume(percent / 100);
        updateSettings({ volume: percent / 100 });
        this.volume.set(percent);
    }

    setKeyboardLayout(layout: KeyboardControlLayoutId) {
        this.data.keyboardInput.setKeyboardLayout(layout);
        updateSettings({ keyboardLayout: layout });
        this.keyboardLayout.set(layout);
    }

    /**
     * Switching reloads the page. The ENU origin is chosen once when the world
     * is built and everything from scenery placement to the physics worker's
     * terrain mirror is positioned against it, so moving it in a live session
     * would mean tearing all of that down; a reload runs the boot path that
     * already does it correctly.
     */
    flyToArea() {
        updateSettings({ terrainArea: this.area() });
        window.location.reload();
    }

    /** Only the axes the device actually has are listed. */
    private readJoystick(): { name: string; axes: HelpEntry[] } | undefined {
        const device = this.data.joystickInput;
        if (!device.isConnected()) {
            return undefined;
        }
        const axes = [
            { axis: 1, action: 'Pitch' },
            { axis: 0, action: 'Roll' },
            { axis: 3, action: 'Yaw' },
            { axis: 2, action: 'Throttle' },
        ];
        return {
            name: joystickName(device.getDeviceId()),
            axes: axes
                .filter(({ axis }) => axis < device.getAxisCount())
                .map(({ axis, action }) => ({ keys: [`Axis ${axis}`], action })),
        };
    }

    /**
     * Populated from the terrain manifest rather than from a fixed list,
     * because what is baked differs per clone — a fresh one has whatever areas
     * its owner imported, and possibly only the shipped one. With fewer than
     * two there is nothing to choose between, and the section stays hidden.
     */
    private loadAreas() {
        loadTerrainManifest(DEFAULT_TERRAIN_URL).then(manifest => {
            const areas = terrainAreas(manifest);
            const home = homeArea(areas, PLAY_ORIGIN);
            const saved = loadSettings().terrainArea;
            const selected = areas.some(a => a.name === saved)
                ? saved
                : (home?.name ?? areas[0]?.name ?? '');
            this.area.set(selected);
            this.initialArea.set(selected);
            this.areas.set(areas.map(area => ({
                value: area.name,
                label: home !== undefined && area.name === home.name ? `${area.name} (home)` : area.name,
            })));
        }).catch(() => {
            // No manifest, no picker: the section is simply not shown.
        }).finally(() => this.areasLoaded.set(true));
    }
}
