import { BreakpointObserver } from '@angular/cdk/layout';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatAutocompleteModule, MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleChange, MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatTabsModule } from '@angular/material/tabs';
import { map } from 'rxjs';
import { SpawnMode } from '../../config/settingsStorage';
import { AudioSystem } from '../../audio/audioSystem';
import { ConfigService, RENDER_SCALES } from '../../config/configService';
import { loadSettings, updateSettings } from '../../config/settingsStorage';
import { JoystickControlDevice } from '../../input/devices/joystickControlDevice';
import {
    KeyboardControlAction, KeyboardControlDevice, KeyboardControlLayoutId, KeyboardControlLayouts,
    KeyboardPitchStickMode,
} from '../../input/devices/keyboardControlDevice';
import type { SpawnPanel } from '../../osd/spawnPanel';
import type { SpawnDestination } from '../../state/spawnSearch';
import {
    COLOUR_ADJUST_GROUPS, COLOUR_HUE_MAX_DEG, COLOUR_TWEAK_MAX, COLOUR_TWEAK_MIN, ColourAdjustGroup, ColourTweak,
    defaultColourAdjust,
} from '../../scene/materials/shaders/colourAdjust';
import { formatSunTime } from '../../scene/materials/shaders/sun';
import { clearCameraRouteFromLocation } from '../../state/cameraRoute';
import { AiPilotModels, FlightModels, RoadsMode, TerrainColours, TerrainShading, UnitSystems } from '../../state/gameDefs';
import { PLAY_ORIGIN } from '../../state/worldLayout';
import {
    DETAIL_DISTANCE_OFF, LANDUSE_REVEAL_MIN_PX_MAX, LANDUSE_REVEAL_MIN_PX_MIN,
    LEAF_REFINE_DISTANCE_SCALE_MAX, LEAF_REFINE_DISTANCE_SCALE_MIN,
    TERRAIN_DETAIL_DISTANCE_MAX_M, TERRAIN_DETAIL_DISTANCE_MIN_M, TERRAIN_TRIANGLE_BUDGET_MAX,
    TERRAIN_TRIANGLE_BUDGET_MIN, TERRAIN_VISIBLE_ZOOM_MAX, TERRAIN_VISIBLE_ZOOM_MIN,
} from '../../terrain/lod';
import { DEFAULT_TERRAIN_URL, loadTerrainManifest } from '../../terrain/manifest';
import { homeArea, terrainAreas } from '../../terrain/playArea';
import { TerrainImporter } from './terrain/terrainImporter';

export type SettingsTab = 'Flight' | 'Graphics' | 'Colours' | 'World' | 'Simulation' | 'General' | 'Help' | 'About';

/** In display order. */
const TABS: SettingsTab[] = ['Flight', 'Graphics', 'Colours', 'World', 'Simulation', 'General', 'Help', 'About'];

/**
 * Below this viewport width the eight tab links do not fit the dialog, and the
 * tab bar is swapped for a select rather than scrolled or wrapped. The links
 * take 756px (each at least Material's 90px); the dialog is 820px or 94vw,
 * less its 48px of padding, which only clears that from about 855px up.
 */
const NARROW_QUERY = '(max-width: 879.98px)';

export interface SettingsDialogData {
    config: ConfigService;
    keyboardInput: KeyboardControlDevice;
    joystickInput: JoystickControlDevice;
    audio: AudioSystem;
    /** The aircraft, livery and airfield choices and spawn actions the Flight tab shows. */
    spawnMenu: SpawnPanel;
    /** The tab to open on; otherwise the one last looked at. */
    initialTab?: SettingsTab;
    /** Whether the World tab offers terrain import: only the dev server can bake terrain. */
    terrainImport: boolean;
}

/** The Flight tab's spawn buttons, in display order, with the key that also starts each. */
const SPAWN_ACTIONS: { mode: SpawnMode; label: string; key: string }[] = [
    { mode: 'approach', label: 'Approach', key: '1' },
    { mode: 'runway', label: 'Runway', key: '2' },
    { mode: 'headon', label: 'Head-on', key: '3' },
    { mode: 'carrier', label: 'Carrier land', key: '4' },
    { mode: 'carrierTakeoff', label: 'Carrier TO', key: '5' },
    { mode: 'carrierBarricade', label: 'Carrier barricade', key: '8' },
    { mode: 'highAlt', label: '10 km', key: '6' },
    { mode: 'space', label: 'Space', key: '7' },
    { mode: 'closeWing', label: 'Wingtip', key: '9' },
];

/** A row of the Help tab: the keys, then what they do. */
interface HelpEntry {
    keys: string[];
    action: string;
}

const SYSTEMS_HELP: HelpEntry[] = [
    { keys: ['G'], action: 'Landing gear' },
    { keys: ['F'], action: 'Flaps' },
    { keys: ['L'], action: 'FCS limiters (AoA/g) on/off' },
    { keys: ['1', '2', '3'], action: 'FCS limiter strategy (soft / predictive / smooth; FM2 only)' },
    { keys: ['T'], action: 'Select target' },
    { keys: ['I'], action: 'Target night view' },
    { keys: ['H'], action: 'Tailhook' },
    { keys: ['U'], action: 'Cycle HUD focus' },
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
    { keys: ['F4'], action: 'Replay the flight so far (Space pause, arrows seek and speed, or move the camera in the Free view; F4/Esc exit)' },
    { keys: ['4'], action: 'To/from target' },
    { keys: ['Num 4', 'Num 6', 'Num 8', 'Num 2'], action: 'Move camera around aircraft' },
    { keys: ['Num 5'], action: 'Recenter camera' },
    { keys: ['Num *', 'Num /'], action: 'Zoom in / out (F1: padlock target, F2: lock/unlock on enemy)' },
];

/** A dataset the world is built from, as the About tab credits it. */
interface DataSource {
    /** The dataset, as its publisher names it. */
    name: string;
    /** Where or what it covers, when that is narrower than its group. */
    scope?: string;
    /** The attribution its licence asks for. */
    credit: string;
    /** Where the credit links to, when the publisher asks for a link. */
    creditUrl?: string;
    /** A key of LICENCE_URLS where the licence has a canonical text. */
    licence: string;
}

interface DataSourceGroup {
    title: string;
    /** What in the game the group's data ends up as. */
    feeds: string;
    sources: DataSource[];
}

const LICENCE_URLS: Record<string, string> = {
    'ODbL 1.0': 'https://opendatacommons.org/licenses/odbl/1-0/',
    'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'CC BY-NC-SA 4.0': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    'dl-de/by-2-0': 'https://www.govdata.de/dl-de/by-2-0',
    'dl-de/zero-2-0': 'https://www.govdata.de/dl-de/zero-2-0',
};

const BAVARIA_CREDIT = 'Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de';

/**
 * Every dataset the terrain bake reads, grouped by what it feeds. The sources
 * and licences are the ones the bake tools name: tools/fetch_planet_dem.py,
 * prep_global_dem.py, prep_global_imagery.py, fetch_cover_sources.py, the
 * Source classes of measure_lidar.py and measure_buildings.py, and the
 * OpenStreetMap bakes. A new source there belongs here too.
 */
const DATA_SOURCES: DataSourceGroup[] = [
    {
        title: 'Terrain heights',
        feeds: 'The shape of the ground, from the whole planet down to the detailed areas.',
        sources: [
            {
                name: 'FABDEM (Forest And Buildings removed Copernicus DEM)', scope: 'Detailed areas, 30 m',
                credit: 'University of Bristol', licence: 'CC BY-NC-SA 4.0',
            },
            {
                name: 'Copernicus DEM GLO-30', scope: 'Detailed areas, 30 m; the model FABDEM corrects',
                credit: '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
                licence: 'Copernicus DEM licence',
            },
            {
                name: 'ETOPO 2022, 60 arc-second', scope: 'The whole planet, 1.85 km',
                credit: 'NOAA National Centers for Environmental Information', licence: 'Public domain',
            },
        ],
    },
    {
        title: 'Road and railway earthworks',
        feeds: 'Embankments, cuttings and bridge ends, measured along each road and railway in lidar terrain models.',
        sources: [
            { name: 'DGM1', scope: 'Bavaria', credit: BAVARIA_CREDIT, licence: 'CC BY 4.0' },
            {
                name: 'ALS DTM 1 m (2025)', scope: 'Austria',
                credit: 'BEV – Bundesamt für Eich- und Vermessungswesen', licence: 'CC BY 4.0',
            },
            { name: 'swissALTI3D', scope: 'Switzerland', credit: '© Data: swisstopo', licence: 'swisstopo OGD' },
            {
                name: 'DGM1', scope: 'Niedersachsen',
                credit: 'LGLN – Landesamt für Geoinformation und Landesvermessung Niedersachsen', licence: 'CC BY 4.0',
            },
            {
                name: 'DGM1', scope: 'Baden-Württemberg',
                credit: 'LGL – Landesamt für Geoinformation und Landentwicklung Baden-Württemberg', licence: 'dl-de/by-2-0',
            },
            {
                name: 'DGM1', scope: 'Brandenburg and Berlin',
                credit: 'LGB – Landesvermessung und Geobasisinformation Brandenburg; Berlin: Geoportal Berlin',
                licence: 'dl-de/by-2-0',
            },
            {
                name: 'DGM1', scope: 'Hessen',
                credit: 'HVBG – Hessische Verwaltung für Bodenmanagement und Geoinformation', licence: 'dl-de/zero-2-0',
            },
            { name: 'DGM1', scope: 'Nordrhein-Westfalen', credit: 'Geobasis NRW', licence: 'dl-de/zero-2-0' },
            {
                name: 'DGM1', scope: 'Rheinland-Pfalz',
                credit: 'LVermGeo RLP – Landesamt für Vermessung und Geobasisinformation Rheinland-Pfalz',
                licence: 'dl-de/by-2-0',
            },
            {
                name: 'DGM1', scope: 'Mecklenburg-Vorpommern',
                credit: 'LAiV MV – Landesamt für innere Verwaltung Mecklenburg-Vorpommern', licence: 'CC BY 4.0',
            },
            {
                name: 'DGM1 2020–2025', scope: 'Thüringen',
                credit: 'TLBG – Thüringer Landesamt für Bodenmanagement und Geoinformation', licence: 'dl-de/by-2-0',
            },
            { name: 'MDT 5 m', scope: 'Canary Islands', credit: 'IGN – Instituto Geográfico Nacional', licence: 'CC BY 4.0' },
        ],
    },
    {
        title: 'Land cover',
        feeds: 'The colour of the ground: land-cover classes, true-colour imagery, and the planet seen from far off.',
        sources: [
            {
                name: 'ESA WorldCover 2021 v200', scope: 'Land-cover classes, 10 m',
                credit: '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
                licence: 'CC BY 4.0',
            },
            {
                name: 'Sentinel-2 L2A true colour', scope: 'Imagery and Hybrid terrain colours',
                credit: 'Contains modified Copernicus Sentinel data', licence: 'Copernicus Sentinel data terms',
            },
            {
                name: 'Blue Marble Next Generation', scope: 'The whole planet, 500 m',
                credit: 'NASA Earth Observatory', licence: 'Public domain',
            },
        ],
    },
    {
        title: 'Roads, buildings and map features',
        feeds: 'Coastlines, lakes and rivers, land use, roads, railways, bridges, airfields and buildings, and the place search on the Flight tab.',
        sources: [
            {
                name: 'OpenStreetMap', credit: '© OpenStreetMap contributors',
                creditUrl: 'https://www.openstreetmap.org/copyright', licence: 'ODbL 1.0',
            },
        ],
    },
    {
        title: 'Buildings',
        feeds: 'Roof colours measured in aerial photos (with the Imagery and Hybrid terrain colours), building '
            + 'heights and ridges fitted to a surface model, and official roof shapes and heights - plus the '
            + 'buildings only the official models have.',
        sources: [
            { name: 'DOP40 digital orthophotos, 40 cm', scope: 'Bavaria', credit: BAVARIA_CREDIT, licence: 'CC BY 4.0' },
            {
                name: 'DOP20 digital orthophotos, 20 cm', scope: 'Brandenburg, Berlin',
                credit: '© GeoBasis-DE/LGB; © Geoportal Berlin (data changed)', licence: 'dl-de/by-2-0',
            },
            { name: 'DOM20 digital surface model, 20 cm', scope: 'Bavaria', credit: BAVARIA_CREDIT, licence: 'CC BY 4.0' },
            { name: 'DGM1 digital terrain model, 1 m (ground under the buildings)', scope: 'Bavaria', credit: BAVARIA_CREDIT, licence: 'CC BY 4.0' },
            { name: 'LoD2 3D building models', scope: 'Bavaria', credit: BAVARIA_CREDIT, licence: 'CC BY 4.0' },
            {
                name: 'bDOM digital surface model, 20 cm, over DGM1, 1 m', scope: 'Brandenburg',
                credit: '© GeoBasis-DE/LGB (data changed)', licence: 'dl-de/by-2-0',
            },
            {
                name: 'LoD2 3D building models', scope: 'Brandenburg',
                credit: '© GeoBasis-DE/LGB (data changed)', licence: 'dl-de/by-2-0',
            },
            { name: 'LoD2 3D building models', scope: 'Berlin', credit: 'Geoportal Berlin', licence: 'dl-de/zero-2-0' },
        ],
    },
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

const TERRAIN_COLOUR_OPTIONS: Option<TerrainColours>[] = [
    { value: TerrainColours.LANDCOVER, label: 'Landcover (palette tones)' },
    { value: TerrainColours.SWATCH, label: 'Swatches (quantised imagery)' },
    { value: TerrainColours.HYBRID, label: 'Hybrid (palette hue, real shading)' },
    { value: TerrainColours.IMAGERY, label: 'Imagery (true colour)' },
];

const ROADS_OPTIONS: Option<RoadsMode>[] = [
    { value: RoadsMode.ALL, label: 'All roads' },
    { value: RoadsMode.MAJOR, label: 'Major roads only' },
    { value: RoadsMode.OFF, label: 'Off' },
];

const TERRAIN_SHADING_OPTIONS: Option<TerrainShading>[] = [
    { value: TerrainShading.FACETED, label: 'Faceted (flat)' },
    { value: TerrainShading.SMOOTH, label: 'Smooth (blended)' },
];

const COLOUR_GROUP_OPTIONS: { key: ColourAdjustGroup; label: string }[] = [
    { key: 'trees', label: 'Trees and shrubs' },
    { key: 'terrain', label: 'Terrain' },
    { key: 'water', label: 'Water' },
    { key: 'sky', label: 'Sky' },
];

/**
 * One slider per channel. `scale` turns the stored value into what the slider
 * and its label show: percent for saturation and brightness, degrees as they
 * are for hue.
 */
const COLOUR_CHANNEL_OPTIONS: {
    key: keyof ColourTweak; label: string; min: number; max: number; step: number; scale: number; unit: string;
}[] = [
    {
        key: 'hue', label: 'Hue', min: -COLOUR_HUE_MAX_DEG, max: COLOUR_HUE_MAX_DEG, step: 5, scale: 1, unit: '°',
    },
    {
        key: 'saturation', label: 'Saturation', min: COLOUR_TWEAK_MIN * 100, max: COLOUR_TWEAK_MAX * 100,
        step: 5, scale: 100, unit: '%',
    },
    {
        key: 'brightness', label: 'Brightness', min: COLOUR_TWEAK_MIN * 100, max: COLOUR_TWEAK_MAX * 100,
        step: 5, scale: 100, unit: '%',
    },
];

type ColourChannelOption = typeof COLOUR_CHANNEL_OPTIONS[number];

const FLIGHT_MODEL_OPTIONS: Option<string>[] = [
    { value: FlightModels.FM2, label: 'FM2 (Rigid body)' },
    { value: FlightModels.FM3, label: 'FM3 (Physical, post-stall)' },
    { value: FlightModels.DEBUG, label: 'Debug (Free-fly)' },
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

const PITCH_STICK_MODE_OPTIONS: Option<KeyboardPitchStickMode>[] = [
    { value: KeyboardPitchStickMode.LAYOUT_DEFAULT, label: 'Layout default' },
    { value: KeyboardPitchStickMode.HOLD, label: 'Hold: full while pressed' },
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
let lastTab: SettingsTab = 'Flight';

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
        NgTemplateOutlet, MatAutocompleteModule, MatButtonModule, MatDialogModule, MatFormFieldModule,
        MatInputModule, MatListModule, MatRadioModule, MatSelectModule, MatSlideToggleModule, MatSliderModule, MatTabsModule, TerrainImporter,
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
                @case ('Flight') {
                    <!-- Fills the tab exactly: the aircraft list takes what the
                         other fields and the buttons leave, and scrolls itself. -->
                    <div class="flex h-full flex-col gap-4 overflow-hidden">
                        <section class="flex min-h-0 flex-1 flex-col">
                            <h3 class="m-0 mb-1 text-base font-medium">Aircraft</h3>
                            <mat-selection-list #aircraftList [multiple]="false" class="min-h-0 flex-1 overflow-y-auto"
                                    (selectionChange)="spawnMenu.selectModel($event.options[0].value)">
                                @for (label of spawn().aircraft; track $index) {
                                    <mat-list-option [value]="$index" [selected]="$index === spawn().aircraftIndex">
                                        {{ label }}
                                    </mat-list-option>
                                }
                            </mat-selection-list>
                        </section>
                        @if (spawn().liveries.length > 1) {
                            <mat-form-field class="w-full" subscriptSizing="dynamic">
                                <mat-label>Livery</mat-label>
                                <mat-select [value]="spawn().liveryIndex" (selectionChange)="spawnMenu.selectLivery($event.value)">
                                    @for (label of spawn().liveries; track $index) {
                                        <mat-option [value]="$index">{{ label }}</mat-option>
                                    }
                                </mat-select>
                            </mat-form-field>
                        }
                        <div class="flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                                <mat-form-field class="w-full" subscriptSizing="dynamic">
                                    <mat-label>Find an airfield or place</mat-label>
                                    <input matInput type="search" autocomplete="off" [value]="searchQuery()"
                                        placeholder="ICAO, name, town, or lat, lon"
                                        [matAutocomplete]="destinations"
                                        (input)="onSearchInput($any($event.target).value)"
                                        (keydown.enter)="onSearchEnter($event)">
                                    <mat-hint>Airfields match as you type; Enter also looks up places.</mat-hint>
                                </mat-form-field>
                            </div>
                            <button mat-stroked-button type="button" class="mt-2"
                                [disabled]="searchQuery().trim() === '' || placeStatus() === 'searching'"
                                (click)="searchPlaces()">Search</button>
                        </div>
                        <mat-autocomplete #destinations="matAutocomplete" [displayWith]="clearOnPick"
                                (optionSelected)="goTo($event.option.value)">
                            @if (quickResults().length > 0) {
                                <mat-optgroup label="Airfields">
                                    @for (d of quickResults(); track $index) {
                                        <mat-option [value]="d" [disabled]="d.area === undefined">
                                            <span class="flex flex-col py-1 leading-tight">
                                                <span>{{ d.label }}</span>
                                                <span class="text-xs opacity-70">{{ d.detail }}</span>
                                            </span>
                                        </mat-option>
                                    }
                                </mat-optgroup>
                            }
                            @if (searchQuery().trim() !== '') {
                                <mat-optgroup label="Places">
                                    @for (d of placeResults(); track $index) {
                                        <mat-option [value]="d" [disabled]="d.area === undefined">
                                            <span class="flex flex-col py-1 leading-tight">
                                                <span>{{ d.label }}</span>
                                                <span class="text-xs opacity-70">{{ d.detail }}</span>
                                            </span>
                                        </mat-option>
                                    }
                                    @switch (placeStatus()) {
                                        @case ('idle') { <mat-option disabled>Press Enter to look up places</mat-option> }
                                        @case ('searching') { <mat-option disabled>Searching…</mat-option> }
                                        @case ('none') { <mat-option disabled>No places found</mat-option> }
                                        @case ('error') { <mat-option disabled>Place search failed, check the connection</mat-option> }
                                    }
                                </mat-optgroup>
                            }
                        </mat-autocomplete>
                        @if (spawn().airfields.length > 0) {
                            <mat-form-field class="w-full" subscriptSizing="dynamic">
                                <mat-label>Airfield</mat-label>
                                <mat-select [value]="spawn().airfieldIndex" (selectionChange)="spawnMenu.selectAirfield($event.value)">
                                    @for (label of spawn().airfields; track $index) {
                                        <mat-option [value]="$index">{{ label }}</mat-option>
                                    }
                                </mat-select>
                            </mat-form-field>
                        }
                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">Start</h3>
                            <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                @for (action of spawnActions; track action.mode) {
                                    <button mat-flat-button type="button" (click)="spawnMenu.spawn(action.mode)">
                                        {{ action.label }} ({{ action.key }})
                                    </button>
                                }
                            </div>
                        </section>
                    </div>
                }
                @case ('Graphics') {
                    <div class="flex flex-col gap-6">
                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">Render scale</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                Draws the 3D view at this fraction of the screen and stretches it to
                                full size; the HUD and cockpit displays stay sharp on top. Lower it
                                if the frame rate is short on a large screen. 100% is off and draws
                                at native size, supersampled for anti-aliasing where the resolution
                                affords it unless that is switched off here.
                            </p>
                            <div class="flex flex-wrap items-center gap-6">
                                <mat-form-field class="w-48" subscriptSizing="dynamic">
                                    <mat-label>3D resolution</mat-label>
                                    <mat-select [value]="renderScale()" (selectionChange)="setRenderScale($event.value)">
                                        @for (option of renderScales; track option.value) {
                                            <mat-option [value]="option.value">{{ option.label }}</mat-option>
                                        }
                                    </mat-select>
                                </mat-form-field>
                                <mat-slide-toggle [checked]="supersampling()" [disabled]="renderScale() < 1"
                                    (change)="setSupersampling($event)">
                                    Supersampling (SSAA) at 100%
                                </mat-slide-toggle>
                            </div>
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
                            <h3 class="m-0 mb-1 text-base font-medium">Finest terrain level</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                The deepest zoom level of terrain tiles drawn. Each level down halves
                                the tile resolution and drops the land-use outlines the finer tiles
                                carry, for fewer triangles and fewer tile fetches. 12 is full detail.
                            </p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="visibleZoomMin" [max]="visibleZoomMax" [step]="1">
                                    <input matSliderThumb [value]="visibleZoom()" (input)="setVisibleZoom($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">z{{ visibleZoom() }}</output>
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
                                Ceiling on terrain triangles drawn per frame. When the view asks for
                                more, the farthest tiles are folded into coarser ones until it fits,
                                so a low cap shows as a coarser far field rather than coarser ground
                                nearby. Raise it if the distance looks blocky; lower it if the frame
                                rate is short.
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
                            <h3 class="m-0 mb-1 text-base font-medium">Buildings</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                Houses and other buildings from OpenStreetMap, with their roofs, where
                                the terrain was baked with them. Far off only the larger ones are
                                drawn, and a busy view thins them out to hold the frame rate. Where
                                roofs were measured in aerial photos they show their real colour with
                                the Imagery and Hybrid terrain colours.
                            </p>
                            <p class="m-0 mb-2 text-xs opacity-60">Data sources and licences: see the About tab.</p>
                            <mat-slide-toggle [checked]="buildings()" (change)="setBuildings($event)">
                                Draw buildings
                            </mat-slide-toggle>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">Roads</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                Roads are drawn as lines over the ground where the terrain was baked
                                with them. Major keeps motorways and main roads, the ones you can
                                see from altitude, and drops the streets, which are most of the
                                cost over a city.
                            </p>
                            <mat-radio-group class="grid grid-cols-1 sm:grid-cols-3"
                                [value]="roads()" (change)="setRoads($event.value)">
                                @for (option of roadsOptions; track option.value) {
                                    <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                                }
                            </mat-radio-group>
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
                            <h3 class="m-0 mb-1 text-base font-medium">Tree density</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">
                                How many trees are placed in each wood, as a multiplier on the default
                                spacing - 0 turns trees off. Re-grows forest already loaded, so it
                                takes a moment to catch up over a large area.
                            </p>
                            <div class="flex items-center gap-4">
                                <span class="text-sm opacity-70">0x</span>
                                <mat-slider class="flex-1" [min]="0" [max]="20" [step]="1">
                                    <input matSliderThumb [value]="treeDensity()" (input)="setTreeDensity($event)">
                                </mat-slider>
                                <span class="text-sm opacity-70">20x</span>
                                <output class="w-16 text-right tabular-nums">{{ treeDensity() }}x</output>
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

                @case ('Colours') {
                    <div class="flex flex-col gap-6">
                        <p class="m-0 text-sm opacity-70">
                            Hue, saturation and brightness of the trees and shrubs, the ground, water
                            and the sky, on top of whichever terrain colour is picked. 0° and 100% are
                            the look as drawn; 0% saturation is grey, and hue turns every colour round
                            the colour wheel by that many degrees.
                        </p>
                        @for (group of colourGroups; track group.key) {
                            <section>
                                <h3 class="m-0 mb-1 text-base font-medium">{{ group.label }}</h3>
                                @for (channel of colourChannels; track channel.key) {
                                    <div class="flex items-center gap-4">
                                        <span class="w-20 text-sm opacity-70">{{ channel.label }}</span>
                                        <mat-slider class="flex-1" [min]="channel.min" [max]="channel.max" [step]="channel.step">
                                            <input matSliderThumb [value]="colourSliderValue(group.key, channel)"
                                                (input)="setColourTweak(group.key, channel, $event)">
                                        </mat-slider>
                                        <output class="w-16 text-right tabular-nums">{{ colourSliderValue(group.key, channel) }}{{ channel.unit }}</output>
                                    </div>
                                }
                            </section>
                        }
                        <div>
                            <button mat-button type="button" (click)="resetColourAdjust()">Reset colours</button>
                        </div>
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

                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">Pitch stick</h3>
                            <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                                [value]="pitchStickMode()" (change)="setPitchStickMode($event.value)">
                                @for (option of pitchStickModes; track option.value) {
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

                @case ('About') {
                    <div class="flex flex-col gap-6">
                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">Data sources</h3>
                            <p class="m-0 text-sm opacity-70">
                                The world is built from open data. Each source is clipped, resampled,
                                measured and combined with the others when the terrain is baked, so
                                none of it appears as published, and no publisher endorses this game.
                            </p>
                        </section>

                        @for (group of dataSources; track group.title) {
                            <section>
                                <h3 class="m-0 mb-1 text-base font-medium">{{ group.title }}</h3>
                                <p class="m-0 mb-2 text-sm opacity-70">{{ group.feeds }}</p>
                                <ul class="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                                    @for (source of group.sources; track $index) {
                                        <li>
                                            <div>
                                                <span class="font-medium">{{ source.name }}</span>
                                                @if (source.scope) {
                                                    <span class="opacity-70"> · {{ source.scope }}</span>
                                                }
                                            </div>
                                            <div class="text-xs opacity-80">
                                                @if (source.creditUrl) {
                                                    <a [href]="source.creditUrl" target="_blank" rel="noopener">{{ source.credit }}</a>
                                                } @else {
                                                    {{ source.credit }}
                                                }
                                                ·
                                                @if (licenceUrls[source.licence]; as url) {
                                                    <a [href]="url" target="_blank" rel="noopener">{{ source.licence }}</a>
                                                } @else {
                                                    {{ source.licence }}
                                                }
                                            </div>
                                        </li>
                                    }
                                </ul>
                            </section>
                        }
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
    readonly spawnMenu = this.data.spawnMenu;
    readonly spawnActions = SPAWN_ACTIONS;
    readonly spawn = signal(this.spawnMenu.getState());

    readonly searchQuery = signal('');
    readonly quickResults = signal<SpawnDestination[]>([]);
    readonly placeResults = signal<SpawnDestination[]>([]);
    readonly placeStatus = signal<'idle' | 'searching' | 'done' | 'none' | 'error'>('idle');
    private readonly searchTrigger = viewChild(MatAutocompleteTrigger);
    /** Bumped per query, so a slow answer to an old one cannot land on a new one. */
    private placeSearchToken = 0;
    /** The input is emptied once a result is picked. */
    readonly clearOnPick = () => '';
    private readonly aircraftList = viewChild('aircraftList', { read: ElementRef });
    readonly narrow = toSignal(
        inject(BreakpointObserver).observe(NARROW_QUERY).pipe(map(state => state.matches)),
        { initialValue: inject(BreakpointObserver).isMatched(NARROW_QUERY) },
    );

    readonly terrainColours = TERRAIN_COLOUR_OPTIONS;
    readonly terrainShadings = TERRAIN_SHADING_OPTIONS;
    readonly flightModels = FLIGHT_MODEL_OPTIONS;
    readonly aiPilotModels = AI_PILOT_MODEL_OPTIONS;
    readonly unitSystems = UNIT_SYSTEM_OPTIONS;
    readonly keyboardLayouts = KEYBOARD_LAYOUT_OPTIONS;
    readonly pitchStickModes = PITCH_STICK_MODE_OPTIONS;

    readonly detailMinKm = TERRAIN_DETAIL_DISTANCE_MIN_M / 1000;
    readonly detailMaxKm = DETAIL_OFF_KM + 2;

    readonly terrainImport = this.data.terrainImport;
    readonly tab = signal<SettingsTab>(this.data.initialTab ?? lastTab);
    readonly terrainColour = signal(this.config.terrainColour.getActive());
    readonly terrainShading = signal(this.config.terrainShading.getActive());
    /** Percent of a land-use facet's colour taken from its land type's tone. */
    readonly landuseBlend = signal(Math.round(this.config.landuseBlend.getActive() * 100));
    readonly treeDensity = signal(Math.round(this.config.treeDensity.getActive()));
    readonly colourGroups = COLOUR_GROUP_OPTIONS;
    readonly colourChannels = COLOUR_CHANNEL_OPTIONS;
    readonly colourAdjust = signal(this.config.colourAdjust.getActive());
    readonly flightModel = signal(this.config.flightModels.getActiveKey());
    readonly aiPilotModel = signal(this.config.aiPilotModels.getActive());
    readonly unitSystem = signal(this.config.unitSystem.getActive());
    readonly keyboardLayout = signal(this.data.keyboardInput.getKeyboardLayoutId());
    readonly pitchStickMode = signal(this.data.keyboardInput.getKeyboardPitchStickMode());
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

    readonly visibleZoomMin = TERRAIN_VISIBLE_ZOOM_MIN;
    readonly visibleZoomMax = TERRAIN_VISIBLE_ZOOM_MAX;
    readonly visibleZoom = signal(this.config.visibleZoom.getActive());

    readonly revealMin = LANDUSE_REVEAL_MIN_PX_MIN;
    readonly revealMax = LANDUSE_REVEAL_MIN_PX_MAX;
    readonly landuseReveal = signal(this.config.landuseReveal.getActive());

    readonly triangleMinK = TERRAIN_TRIANGLE_BUDGET_MIN / 1000;
    readonly triangleMaxK = TERRAIN_TRIANGLE_BUDGET_MAX / 1000;
    readonly triangleBudget = signal(this.config.triangleBudget.getActive());

    readonly farTileTextures = signal(this.config.farTileTextures.getActive());
    readonly buildings = signal(this.config.buildings.getActive());
    readonly roadsOptions = ROADS_OPTIONS;
    readonly roads = signal(this.config.roads.getActive());
    readonly renderScales: Option<number>[] = RENDER_SCALES.map(scale => ({
        value: scale,
        label: scale >= 1 ? '100% (off)' : `${Math.round(scale * 100)}%`,
    }));
    readonly renderScale = signal(this.config.renderScale.getActive());
    readonly supersampling = signal(this.config.supersampling.getActive());
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
    readonly dataSources = DATA_SOURCES;
    readonly licenceUrls = LICENCE_URLS;

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
        inject(DestroyRef).onDestroy(this.spawnMenu.subscribe(state => this.spawn.set(state)));
        // The list is long; open it with the current aircraft in view.
        afterNextRender(() => this.aircraftList()?.nativeElement
            .querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' }));
    }

    selectTab(tab: SettingsTab) {
        lastTab = tab;
        this.tab.set(tab);
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

    setVisibleZoom(event: Event) {
        this.config.visibleZoom.setActive(sliderValue(event));
        const zoom = this.config.visibleZoom.getActive();
        updateSettings({ visibleZoom: zoom });
        this.visibleZoom.set(zoom);
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

    setBuildings(event: MatSlideToggleChange) {
        this.config.buildings.setActive(event.checked);
        updateSettings({ buildings: event.checked });
        this.buildings.set(event.checked);
    }

    setRoads(mode: RoadsMode) {
        this.config.roads.setActive(mode);
        updateSettings({ roads: mode });
        this.roads.set(mode);
    }

    setRenderScale(scale: number) {
        this.config.renderScale.setActive(scale);
        updateSettings({ renderScale: scale });
        this.renderScale.set(scale);
    }

    setSupersampling(event: MatSlideToggleChange) {
        this.config.supersampling.setActive(event.checked);
        updateSettings({ supersampling: event.checked });
        this.supersampling.set(event.checked);
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

    setTreeDensity(event: Event) {
        const multiplier = Math.round(sliderValue(event));
        this.config.treeDensity.setActive(multiplier);
        updateSettings({ treeDensity: multiplier });
        this.treeDensity.set(multiplier);
    }

    colourSliderValue(group: ColourAdjustGroup, channel: ColourChannelOption): number {
        return Math.round(this.colourAdjust()[group][channel.key] * channel.scale);
    }

    setColourTweak(group: ColourAdjustGroup, channel: ColourChannelOption, event: Event) {
        const value = Math.round(sliderValue(event)) / channel.scale;
        this.config.colourAdjust.setTweak(group, { ...this.colourAdjust()[group], [channel.key]: value });
        this.saveColourAdjust();
    }

    resetColourAdjust() {
        const defaults = defaultColourAdjust();
        for (const group of COLOUR_ADJUST_GROUPS) {
            this.config.colourAdjust.setTweak(group, defaults[group]);
        }
        this.saveColourAdjust();
    }

    private saveColourAdjust() {
        const adjust = this.config.colourAdjust.getActive();
        updateSettings({ colourAdjust: adjust });
        this.colourAdjust.set(adjust);
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

    setPitchStickMode(mode: KeyboardPitchStickMode) {
        this.data.keyboardInput.setKeyboardPitchStickMode(mode);
        updateSettings({ keyboardPitchStickMode: mode });
        this.pitchStickMode.set(mode);
    }

    onSearchInput(query: string) {
        this.searchQuery.set(query);
        this.quickResults.set(this.spawnMenu.quickSearch(query));
        this.placeResults.set([]);
        this.placeStatus.set('idle');
        this.placeSearchToken++;
    }

    /** Enter picks the highlighted result if there is one, and otherwise looks up places. */
    onSearchEnter(event: Event) {
        if (event.defaultPrevented || this.searchTrigger()?.activeOption) {
            return;
        }
        this.searchPlaces();
    }

    searchPlaces() {
        const query = this.searchQuery().trim();
        if (query === '') {
            return;
        }
        const token = ++this.placeSearchToken;
        this.placeStatus.set('searching');
        this.searchTrigger()?.openPanel();
        this.spawnMenu.searchPlaces(query).then(places => {
            if (token === this.placeSearchToken) {
                this.placeResults.set(places);
                this.placeStatus.set(places.length > 0 ? 'done' : 'none');
            }
        }).catch(() => {
            if (token === this.placeSearchToken) {
                this.placeStatus.set('error');
            }
        });
    }

    goTo(destination: SpawnDestination) {
        this.onSearchInput('');
        this.spawnMenu.goTo(destination);
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
        // A previous spawn or fixed-camera view may have left lat/lng in the
        // URL; left alone it would out-rank this pick on boot (see
        // clearCameraRouteFromLocation) and the reload would land back where
        // it already was instead of the chosen area.
        clearCameraRouteFromLocation();
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
