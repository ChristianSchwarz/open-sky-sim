import { BreakpointObserver } from '@angular/cdk/layout';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleChange, MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatTabsModule } from '@angular/material/tabs';
import { map } from 'rxjs';
import { AudioSystem } from '../../audio/audioSystem';
import { ConfigService } from '../../config/configService';
import { loadSettings, updateSettings } from '../../config/settingsStorage';
import { JoystickControlDevice } from '../../input/devices/joystickControlDevice';
import {
    KeyboardControlAction, KeyboardControlDevice, KeyboardControlLayoutId, KeyboardControlLayouts,
} from '../../input/devices/keyboardControlDevice';
import { formatSunTime } from '../../scene/materials/shaders/sun';
import { AiPilotModels, FlightModels, TechProfiles, TerrainColours, TerrainShading, UnitSystems } from '../../state/gameDefs';
import { PLAY_ORIGIN } from '../../state/worldLayout';
import {
    DETAIL_DISTANCE_OFF, LANDUSE_REVEAL_MIN_PX_MAX, LANDUSE_REVEAL_MIN_PX_MIN,
    LEAF_REFINE_DISTANCE_SCALE_MAX, LEAF_REFINE_DISTANCE_SCALE_MIN,
    TERRAIN_DETAIL_DISTANCE_MAX_M, TERRAIN_DETAIL_DISTANCE_MIN_M, TERRAIN_TRIANGLE_BUDGET_MAX,
    TERRAIN_TRIANGLE_BUDGET_MIN,
} from '../../terrain/lod';
import { DEFAULT_TERRAIN_URL, loadTerrainManifest } from '../../terrain/manifest';
import { homeArea, terrainAreas } from '../../terrain/playArea';
import { TerrainImporter } from './terrain/terrainImporter';

export type SettingsTab = 'Graphics' | 'World' | 'Simulation' | 'General' | 'Help';

/** In display order. */
const TABS: SettingsTab[] = ['Graphics', 'World', 'Simulation', 'General', 'Help'];

/**
 * Below this viewport width the five tab links do not fit the dialog, and the
 * tab bar is swapped for a select rather than scrolled or wrapped.
 */
const NARROW_QUERY = '(max-width: 599.98px)';

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

/** The tab the player last looked at, so reopening lands back on it. */
let lastTab: SettingsTab = 'Graphics';

function sliderValue(event: Event): number {
    return parseFloat((event.target as HTMLInputElement).value);
}

/**
 * Styling rule for this dialog: Tailwind classes on elements this template
 * owns, and on Material components only for outer layout (width, flex,
 * margin). Material's own look is changed only through its documented
 * `--mat-*` tokens, never by reaching into its internal classes.
 */
@Component({
    selector: 'rfs-settings-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        NgTemplateOutlet, MatButtonModule, MatDialogModule, MatFormFieldModule, MatRadioModule,
        MatSelectModule, MatSlideToggleModule, MatSliderModule, MatTabsModule, TerrainImporter,
    ],
    // The page body is bold with a text shadow for legibility over the 3D
    // view; the dialog sits on its own opaque surface and wants neither.
    host: { class: 'block font-normal [text-shadow:none]' },
    template: `
<h2 mat-dialog-title>Settings</h2>

<div class="px-6">
    @if (narrow()) {
        <mat-form-field class="w-full" subscriptSizing="dynamic">
            <mat-label>Section</mat-label>
            <mat-select [value]="tab()" (selectionChange)="selectTab($event.value)">
                @for (name of tabs; track name) {
                    <mat-option [value]="name">{{ name }}</mat-option>
                }
            </mat-select>
        </mat-form-field>
    } @else {
        <nav mat-tab-nav-bar mat-stretch-tabs="false" [tabPanel]="panel" [disablePagination]="true">
            @for (name of tabs; track name) {
                <a mat-tab-link [active]="tab() === name" (click)="selectTab(name)">{{ name }}</a>
            }
        </nav>
    }
</div>

<mat-dialog-content>
    <mat-tab-nav-panel #panel>
        <!-- One fixed-height scroller, vertical only. Sized to stay inside the
             dialog content's own maximum height so that never scrolls too, and
             to leave room for the title, section picker and buttons (16rem) so
             the whole dialog fits on short windows. -->
        <div class="box-border h-[min(55vh,480px,calc(100dvh-16rem))] overflow-x-hidden overflow-y-auto pt-4 pr-2 wrap-anywhere">
            @switch (tab()) {
                @case ('Graphics') {
                    <div class="flex flex-col gap-6">
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
                            <h3 class="m-0 mb-1 text-base font-medium">Land-use detail reach</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                Only the finest terrain tiles carry the exact field, wood and town
                                outlines. This brings those tiles in that many times further out
                                than the terrain detail alone would, at the cost of more triangles
                                around the aircraft. 1x is no bias.
                            </p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="reachMin" [max]="reachMax" [step]="0.5">
                                    <input matSliderThumb [value]="landuseReach()" (input)="setLanduseReach($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ landuseReach().toFixed(2) }}x</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">Land-use region size</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                How large a field, wood or town has to be on screen before it is
                                drawn, in pixels across. Big regions show from far away and small
                                ones fill in as you close; lower brings the small ones in from
                                further out, higher keeps the distance cleaner.
                            </p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="revealMin" [max]="revealMax" [step]="1">
                                    <input matSliderThumb [value]="landuseReveal()" (input)="setLanduseReveal($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ landuseReveal() }} px</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">Terrain triangle cap</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                Hard ceiling on terrain triangles drawn per frame. When it is reached
                                the farthest tiles are dropped, so a low cap shows as missing distant
                                ground rather than coarser ground nearby. Raise it if the far field
                                cuts off; lower it if the frame rate is short.
                            </p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="triangleMinK" [max]="triangleMaxK" [step]="100">
                                    <input matSliderThumb [value]="triangleBudgetK()" (input)="setTriangleBudget($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ triangleBudgetLabel() }}</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">Far tile textures</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                Distant ground is drawn as large facets, one colour each. With this
                                on, those facets are painted with an image of the fields, woods and
                                towns the detailed tiles hold, so the far view keeps its detail
                                instead of switching it on as you close. Off shows the plain facets.
                            </p>
                            <mat-slide-toggle [checked]="farTileTextures()" (change)="setFarTileTextures($event)">
                                Paint far tiles from the detailed ground
                            </mat-slide-toggle>
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
                            <h3 class="m-0 mb-1 text-base font-medium">Land-use colour</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                In Hybrid colour, how much of a field, wood or town is its land type's
                                colour, and how much the terrain colour sampled from imagery.
                            </p>
                            <div class="flex items-center gap-4">
                                <span class="text-sm opacity-70">Sampled</span>
                                <mat-slider class="flex-1" [min]="0" [max]="100" [step]="5">
                                    <input matSliderThumb [value]="landuseBlend()" (input)="setLanduseBlend($event)">
                                </mat-slider>
                                <span class="text-sm opacity-70">Land type</span>
                                <output class="w-16 text-right tabular-nums">{{ landuseBlend() }}%</output>
                            </div>
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
                }

                @case ('World') {
                    <div class="flex flex-col gap-6">
                        @if (areas().length > 1) {
                            <section>
                                <h3 class="m-0 mb-1 text-base font-medium">Area</h3>
                                <p class="m-0 mb-2 text-sm opacity-70">
                                    Where in the world to fly. Areas other than the home one are terrain
                                    only — no airbase, no carrier — so you start airborne over the middle
                                    of them. Changing this reloads the sim.
                                </p>
                                <div class="flex flex-wrap items-center gap-4">
                                    <div class="min-w-40 flex-1">
                                        <mat-form-field class="w-full" subscriptSizing="dynamic">
                                            <mat-label>Area</mat-label>
                                            <mat-select [value]="area()" (selectionChange)="area.set($event.value)">
                                                @for (option of areas(); track option.value) {
                                                    <mat-option [value]="option.value">{{ option.label }}</mat-option>
                                                }
                                            </mat-select>
                                        </mat-form-field>
                                    </div>
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
                                <rfs-terrain-importer />
                            </section>
                        }

                        @if (areasLoaded() && areas().length < 2 && !terrainImport) {
                            <p class="m-0 text-sm opacity-70">
                                Only one terrain area is baked, so there is nothing to choose between.
                            </p>
                        }
                    </div>
                }

                @case ('Simulation') {
                    <div class="flex flex-col gap-6">
                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">Time of day</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                Local solar time. Moves the sun, so sky, terrain and aircraft silhouettes follow
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
                }

                @case ('General') {
                    <div class="flex flex-col gap-6">
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
                }

                @case ('Help') {
                    <div class="flex flex-col gap-6">
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
                }
            }
        </div>
    </mat-tab-nav-panel>
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

    readonly tabs = TABS;
    readonly narrow = toSignal(
        inject(BreakpointObserver).observe(NARROW_QUERY).pipe(map(state => state.matches)),
        { initialValue: inject(BreakpointObserver).isMatched(NARROW_QUERY) },
    );

    readonly techProfiles = TECH_PROFILE_OPTIONS;
    readonly terrainColours = TERRAIN_COLOUR_OPTIONS;
    readonly terrainShadings = TERRAIN_SHADING_OPTIONS;
    readonly flightModels = FLIGHT_MODEL_OPTIONS;
    readonly aiPilotModels = AI_PILOT_MODEL_OPTIONS;
    readonly unitSystems = UNIT_SYSTEM_OPTIONS;
    readonly keyboardLayouts = KEYBOARD_LAYOUT_OPTIONS;

    readonly detailMinKm = TERRAIN_DETAIL_DISTANCE_MIN_M / 1000;
    readonly detailMaxKm = DETAIL_OFF_KM + 2;

    readonly terrainImport = this.data.terrainImport;
    readonly tab = signal<SettingsTab>(this.data.initialTab ?? lastTab);
    readonly techProfile = signal(this.config.techProfiles.getActiveKey());
    readonly terrainColour = signal(this.config.terrainColour.getActive());
    readonly terrainShading = signal(this.config.terrainShading.getActive());
    /** Percent of a land-use facet's colour taken from its land type's tone. */
    readonly landuseBlend = signal(Math.round(this.config.landuseBlend.getActive() * 100));
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

    readonly reachMin = LEAF_REFINE_DISTANCE_SCALE_MIN;
    readonly reachMax = LEAF_REFINE_DISTANCE_SCALE_MAX;
    readonly landuseReach = signal(this.config.landuseReach.getActive());

    readonly revealMin = LANDUSE_REVEAL_MIN_PX_MIN;
    readonly revealMax = LANDUSE_REVEAL_MIN_PX_MAX;
    readonly landuseReveal = signal(this.config.landuseReveal.getActive());

    readonly triangleMinK = TERRAIN_TRIANGLE_BUDGET_MIN / 1000;
    readonly triangleMaxK = TERRAIN_TRIANGLE_BUDGET_MAX / 1000;
    readonly triangleBudget = signal(this.config.triangleBudget.getActive());

    readonly farTileTextures = signal(this.config.farTileTextures.getActive());
    readonly triangleBudgetK = computed(() => this.triangleBudget() / 1000);
    readonly triangleBudgetLabel = computed(() => {
        const n = this.triangleBudget();
        return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
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

    selectTab(tab: SettingsTab) {
        lastTab = tab;
        this.tab.set(tab);
    }

    setTechProfile(id: string) {
        this.config.techProfiles.setActive(id);
        updateSettings({ techProfile: id });
        this.techProfile.set(id);
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

    setLanduseReach(event: Event) {
        this.config.landuseReach.setActive(sliderValue(event));
        const scale = this.config.landuseReach.getActive();
        updateSettings({ landuseReach: scale });
        this.landuseReach.set(scale);
    }

    setLanduseReveal(event: Event) {
        this.config.landuseReveal.setActive(sliderValue(event));
        const px = this.config.landuseReveal.getActive();
        updateSettings({ landuseRevealPx: px });
        this.landuseReveal.set(px);
    }

    setFarTileTextures(event: MatSlideToggleChange) {
        this.config.farTileTextures.setActive(event.checked);
        updateSettings({ farTileTextures: event.checked });
        this.farTileTextures.set(event.checked);
    }

    setTriangleBudget(event: Event) {
        this.config.triangleBudget.setActive(sliderValue(event) * 1000);
        const n = this.config.triangleBudget.getActive();
        updateSettings({ terrainTriangleBudget: n });
        this.triangleBudget.set(n);
    }

    setLanduseBlend(event: Event) {
        const percent = Math.round(sliderValue(event));
        this.config.landuseBlend.setActive(percent / 100);
        updateSettings({ landuseBlend: percent / 100 });
        this.landuseBlend.set(percent);
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
