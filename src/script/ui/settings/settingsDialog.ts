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
import { AudioSystem } from '../../audio/audioSystem';
import { ConfigService } from '../../config/configService';
import { loadSettings, updateSettings } from '../../config/settingsStorage';
import { JoystickControlDevice } from '../../input/devices/joystickControlDevice';
import {
    KeyboardControlDevice, KeyboardControlLayoutId, KeyboardPitchStickMode,
} from '../../input/devices/keyboardControlDevice';
import type { SpawnPanel } from '../../osd/spawnPanel';
import type { SpawnDestination } from '../../state/spawnSearch';
import { ColourAdjustGroup } from '../../scene/materials/shaders/colourAdjust';
import { clearCameraRouteFromLocation } from '../../state/cameraRoute';
import { AiPilotModels, RoadsMode, TerrainColours, TerrainShading, UnitSystems } from '../../state/gameDefs';
import { PLAY_ORIGIN } from '../../state/worldLayout';
import { DEFAULT_TERRAIN_URL, loadTerrainManifest } from '../../terrain/manifest';
import { terrainAreas } from '../../terrain/playArea';
import {
    AI_PILOT_MODEL_OPTIONS, COLOUR_CHANNEL_OPTIONS, COLOUR_GROUP_OPTIONS, ColourChannelOption, DATA_SOURCES,
    FLIGHT_MODEL_OPTIONS, HelpEntry, KEYBOARD_LAYOUT_OPTIONS, LICENCE_URLS, Option, PITCH_STICK_MODE_OPTIONS,
    RENDER_SCALE_OPTIONS, ROADS_OPTIONS, SETTINGS_TEXT, SLIDERS, SPAWN_ACTIONS, SPAWN_HELP, SYSTEMS_HELP,
    SettingsActions, SettingsTab, TABS, TERRAIN_COLOUR_OPTIONS, TERRAIN_SHADING_OPTIONS, UNIT_SYSTEM_OPTIONS,
    VIEWS_HELP, areaOptions, colourSliderValue, daytimeLabel, flightHelp, joystickHelp, landuseReachLabel,
    spawnButtonLabel, terrainDetailKm, terrainDetailLabel, triangleBudgetLabel,
} from './settingsModel';
import { TerrainImporter } from './terrain/terrainImporter';

export type { SettingsTab } from './settingsModel';

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
 *
 * What it says and does lives in settingsModel.ts; this is the layout.
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
<h2 mat-dialog-title>{{ text.title }}</h2>

<div class="px-6">
    @if (narrow()) {
        <mat-form-field class="w-full" subscriptSizing="dynamic">
            <mat-label>{{ text.sectionPicker }}</mat-label>
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
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.aircraft.title }}</h3>
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
                                <mat-label>{{ text.livery.label }}</mat-label>
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
                                    <mat-label>{{ text.search.label }}</mat-label>
                                    <input matInput type="search" autocomplete="off" [value]="searchQuery()"
                                        [placeholder]="text.search.placeholder"
                                        [matAutocomplete]="destinations"
                                        (input)="onSearchInput($any($event.target).value)"
                                        (keydown.enter)="onSearchEnter($event)">
                                    <mat-hint>{{ text.search.hint }}</mat-hint>
                                </mat-form-field>
                            </div>
                            <button mat-stroked-button type="button" class="mt-2"
                                [disabled]="searchQuery().trim() === '' || placeStatus() === 'searching'"
                                (click)="searchPlaces()">{{ text.search.button }}</button>
                        </div>
                        <mat-autocomplete #destinations="matAutocomplete" [displayWith]="clearOnPick"
                                (optionSelected)="goTo($event.option.value)">
                            @if (quickResults().length > 0) {
                                <mat-optgroup [label]="text.search.airfieldsGroup">
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
                                <mat-optgroup [label]="text.search.placesGroup">
                                    @for (d of placeResults(); track $index) {
                                        <mat-option [value]="d" [disabled]="d.area === undefined">
                                            <span class="flex flex-col py-1 leading-tight">
                                                <span>{{ d.label }}</span>
                                                <span class="text-xs opacity-70">{{ d.detail }}</span>
                                            </span>
                                        </mat-option>
                                    }
                                    @switch (placeStatus()) {
                                        @case ('idle') { <mat-option disabled>{{ text.search.idle }}</mat-option> }
                                        @case ('searching') { <mat-option disabled>{{ text.search.searching }}</mat-option> }
                                        @case ('none') { <mat-option disabled>{{ text.search.none }}</mat-option> }
                                        @case ('error') { <mat-option disabled>{{ text.search.error }}</mat-option> }
                                    }
                                </mat-optgroup>
                            }
                        </mat-autocomplete>
                        @if (spawn().airfields.length > 0) {
                            <mat-form-field class="w-full" subscriptSizing="dynamic">
                                <mat-label>{{ text.airfield.label }}</mat-label>
                                <mat-select [value]="spawn().airfieldIndex" (selectionChange)="spawnMenu.selectAirfield($event.value)">
                                    @for (label of spawn().airfields; track $index) {
                                        <mat-option [value]="$index">{{ label }}</mat-option>
                                    }
                                </mat-select>
                            </mat-form-field>
                        }
                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.start.title }}</h3>
                            <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                @for (action of spawnActions; track action.mode) {
                                    <button mat-flat-button type="button" (click)="spawnMenu.spawn(action.mode)">
                                        {{ spawnButtonLabel(action) }}
                                    </button>
                                }
                            </div>
                        </section>
                    </div>
                }
                @case ('Graphics') {
                    <div class="flex flex-col gap-6">
                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.renderScale.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.renderScale.help }}</p>
                            <div class="flex flex-wrap items-center gap-6">
                                <mat-form-field class="w-48" subscriptSizing="dynamic">
                                    <mat-label>{{ text.renderScale.select }}</mat-label>
                                    <mat-select [value]="renderScale()" (selectionChange)="setRenderScale($event.value)">
                                        @for (option of renderScales; track option.value) {
                                            <mat-option [value]="option.value">{{ option.label }}</mat-option>
                                        }
                                    </mat-select>
                                </mat-form-field>
                                <mat-slide-toggle [checked]="supersampling()" [disabled]="renderScale() < 1"
                                    (change)="setSupersampling($event)">
                                    {{ text.renderScale.supersampling }}
                                </mat-slide-toggle>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.terrainDetail.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.terrainDetail.help }}</p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="sliders.terrainDetailKm.min" [max]="sliders.terrainDetailKm.max" [step]="sliders.terrainDetailKm.step">
                                    <input matSliderThumb [value]="terrainDetailKm()" (input)="setTerrainDetail($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ terrainDetailLabel() }}</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.landuseReach.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.landuseReach.help }}</p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="sliders.landuseReach.min" [max]="sliders.landuseReach.max" [step]="sliders.landuseReach.step">
                                    <input matSliderThumb [value]="landuseReach()" (input)="setLanduseReach($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ landuseReachLabel(landuseReach()) }}</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.visibleZoom.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.visibleZoom.help }}</p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="sliders.visibleZoom.min" [max]="sliders.visibleZoom.max" [step]="sliders.visibleZoom.step">
                                    <input matSliderThumb [value]="visibleZoom()" (input)="setVisibleZoom($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">z{{ visibleZoom() }}</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.landuseReveal.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.landuseReveal.help }}</p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="sliders.landuseRevealPx.min" [max]="sliders.landuseRevealPx.max" [step]="sliders.landuseRevealPx.step">
                                    <input matSliderThumb [value]="landuseReveal()" (input)="setLanduseReveal($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ landuseReveal() }} px</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.triangleBudget.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.triangleBudget.help }}</p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="sliders.triangleBudgetK.min" [max]="sliders.triangleBudgetK.max" [step]="sliders.triangleBudgetK.step">
                                    <input matSliderThumb [value]="triangleBudgetK()" (input)="setTriangleBudget($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ triangleBudgetLabel() }}</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.farTileTextures.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.farTileTextures.help }}</p>
                            <mat-slide-toggle [checked]="farTileTextures()" (change)="setFarTileTextures($event)">
                                {{ text.farTileTextures.toggle }}
                            </mat-slide-toggle>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.buildings.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.buildings.help }}</p>
                            <p class="m-0 mb-2 text-xs opacity-60">{{ text.buildings.note }}</p>
                            <mat-slide-toggle [checked]="buildings()" (change)="setBuildings($event)">
                                {{ text.buildings.toggle }}
                            </mat-slide-toggle>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.roads.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.roads.help }}</p>
                            <mat-radio-group class="grid grid-cols-1 sm:grid-cols-3"
                                [value]="roads()" (change)="setRoads($event.value)">
                                @for (option of roadsOptions; track option.value) {
                                    <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                                }
                            </mat-radio-group>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.terrainColour.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.terrainColour.help }}</p>
                            <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                                [value]="terrainColour()" (change)="setTerrainColour($event.value)">
                                @for (option of terrainColours; track option.value) {
                                    <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                                }
                            </mat-radio-group>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.landuseBlend.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.landuseBlend.help }}</p>
                            <div class="flex items-center gap-4">
                                <span class="text-sm opacity-70">{{ text.landuseBlend.minLabel }}</span>
                                <mat-slider class="flex-1" [min]="sliders.landuseBlendPercent.min" [max]="sliders.landuseBlendPercent.max" [step]="sliders.landuseBlendPercent.step">
                                    <input matSliderThumb [value]="landuseBlend()" (input)="setLanduseBlend($event)">
                                </mat-slider>
                                <span class="text-sm opacity-70">{{ text.landuseBlend.maxLabel }}</span>
                                <output class="w-16 text-right tabular-nums">{{ landuseBlend() }}%</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.treeDensity.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.treeDensity.help }}</p>
                            <div class="flex items-center gap-4">
                                <span class="text-sm opacity-70">{{ text.treeDensity.minLabel }}</span>
                                <mat-slider class="flex-1" [min]="sliders.treeDensity.min" [max]="sliders.treeDensity.max" [step]="sliders.treeDensity.step">
                                    <input matSliderThumb [value]="treeDensity()" (input)="setTreeDensity($event)">
                                </mat-slider>
                                <span class="text-sm opacity-70">{{ text.treeDensity.maxLabel }}</span>
                                <output class="w-16 text-right tabular-nums">{{ treeDensity() }}x</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.terrainShading.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.terrainShading.help }}</p>
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
                        <p class="m-0 text-sm opacity-70">{{ text.colours.help }}</p>
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
                            <button mat-button type="button" (click)="resetColourAdjust()">{{ text.colours.reset }}</button>
                        </div>
                    </div>
                }

                @case ('World') {
                    <div class="flex flex-col gap-6">
                        @if (areas().length > 1) {
                            <section>
                                <h3 class="m-0 mb-1 text-base font-medium">{{ text.area.title }}</h3>
                                <p class="m-0 mb-2 text-sm opacity-70">{{ text.area.help }}</p>
                                <div class="flex flex-wrap items-center gap-4">
                                    <div class="min-w-40 flex-1">
                                        <mat-form-field class="w-full" subscriptSizing="dynamic">
                                            <mat-label>{{ text.area.select }}</mat-label>
                                            <mat-select [value]="area()" (selectionChange)="area.set($event.value)">
                                                @for (option of areas(); track option.value) {
                                                    <mat-option [value]="option.value">{{ option.label }}</mat-option>
                                                }
                                            </mat-select>
                                        </mat-form-field>
                                    </div>
                                    <button mat-flat-button type="button"
                                        [disabled]="area() === initialArea()" (click)="flyToArea()">{{ text.area.button }}</button>
                                </div>
                            </section>
                        }

                        @if (terrainImport) {
                            <section>
                                <h3 class="m-0 mb-1 text-base font-medium">{{ text.importTerrain.title }}</h3>
                                <p class="m-0 mb-2 text-sm opacity-70">{{ text.importTerrain.help }}</p>
                                <rfs-terrain-importer />
                            </section>
                        }

                        @if (areasLoaded() && areas().length < 2 && !terrainImport) {
                            <p class="m-0 text-sm opacity-70">{{ text.singleArea }}</p>
                        }
                    </div>
                }

                @case ('Simulation') {
                    <div class="flex flex-col gap-6">
                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.daytime.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.daytime.help }}</p>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="sliders.daytimeHours.min" [max]="sliders.daytimeHours.max" [step]="sliders.daytimeHours.step">
                                    <input matSliderThumb [value]="daytime()" (input)="setDaytime($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ daytimeLabel() }}</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.flightModel.title }}</h3>
                            <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                                [value]="flightModel()" (change)="setFlightModel($event.value)">
                                @for (option of flightModels; track option.value) {
                                    <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                                }
                            </mat-radio-group>
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.aiPilotModel.title }}</h3>
                            <p class="m-0 mb-2 text-sm opacity-70">{{ text.aiPilotModel.help }}</p>
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
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.volume.title }}</h3>
                            <div class="flex items-center gap-4">
                                <mat-slider class="flex-1" [min]="sliders.volumePercent.min" [max]="sliders.volumePercent.max" [step]="sliders.volumePercent.step">
                                    <input matSliderThumb [value]="volume()" (input)="setVolume($event)">
                                </mat-slider>
                                <output class="w-16 text-right tabular-nums">{{ volume() }}%</output>
                            </div>
                        </section>

                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.units.title }}</h3>
                            <mat-radio-group class="grid grid-cols-1 sm:grid-cols-2"
                                [value]="unitSystem()" (change)="setUnitSystem($event.value)">
                                @for (option of unitSystems; track option.value) {
                                    <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                                }
                            </mat-radio-group>
                        </section>

                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.keyboardLayout.title }}</h3>
                            <mat-radio-group class="grid grid-cols-2 sm:grid-cols-3"
                                [value]="keyboardLayout()" (change)="setKeyboardLayout($event.value)">
                                @for (option of keyboardLayouts; track option.value) {
                                    <mat-radio-button [value]="option.value">{{ option.label }}</mat-radio-button>
                                }
                            </mat-radio-group>
                        </section>

                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.pitchStick.title }}</h3>
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
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.help.keyboard }}</h3>
                            <ng-container *ngTemplateOutlet="helpList; context: { $implicit: flightHelp() }" />
                        </section>

                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.help.joystick }}</h3>
                            @if (joystick(); as joystick) {
                                <p class="m-0 mb-2 text-sm opacity-70">{{ joystick.name }}</p>
                                <ng-container *ngTemplateOutlet="helpList; context: { $implicit: joystick.axes }" />
                            } @else {
                                <p class="m-0 text-sm opacity-70">{{ text.help.noJoystick }}</p>
                            }
                        </section>

                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.help.systems }}</h3>
                            <ng-container *ngTemplateOutlet="helpList; context: { $implicit: systemsHelp }" />
                        </section>

                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.help.spawnMenu }}</h3>
                            <ng-container *ngTemplateOutlet="helpList; context: { $implicit: spawnHelp }" />
                            <p class="m-0 mt-2 text-sm opacity-70">{{ text.help.spawnMenuNote }}</p>
                        </section>

                        <section>
                            <h3 class="m-0 mb-2 text-base font-medium">{{ text.help.views }}</h3>
                            <ng-container *ngTemplateOutlet="helpList; context: { $implicit: viewsHelp }" />
                        </section>
                    </div>
                }

                @case ('About') {
                    <div class="flex flex-col gap-6">
                        <section>
                            <h3 class="m-0 mb-1 text-base font-medium">{{ text.about.title }}</h3>
                            <p class="m-0 text-sm opacity-70">{{ text.about.help }}</p>
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
    <button mat-button type="button" mat-dialog-close>{{ text.close }}</button>
</mat-dialog-actions>
`,
})
export class SettingsDialog {
    private readonly data = inject<SettingsDialogData>(MAT_DIALOG_DATA);
    private readonly config = this.data.config;
    private readonly actions = new SettingsActions(this.config, {
        setMasterVolume: volume => this.data.audio.setMasterVolume(volume),
        setKeyboardLayout: layout => this.data.keyboardInput.setKeyboardLayout(layout),
        setKeyboardPitchStickMode: mode => this.data.keyboardInput.setKeyboardPitchStickMode(mode),
    });

    readonly text = SETTINGS_TEXT;
    readonly sliders = SLIDERS;
    readonly tabs = TABS;
    readonly spawnMenu = this.data.spawnMenu;
    readonly spawnActions = SPAWN_ACTIONS;
    readonly spawnButtonLabel = spawnButtonLabel;
    readonly landuseReachLabel = landuseReachLabel;
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
    readonly daytimeLabel = computed(() => daytimeLabel(this.daytime()));

    /** Metres, or `DETAIL_DISTANCE_OFF`. */
    readonly terrainDetail = signal(this.config.terrainDetail.getActive());
    readonly terrainDetailKm = computed(() => terrainDetailKm(this.terrainDetail()));
    readonly terrainDetailLabel = computed(() => terrainDetailLabel(this.terrainDetail()));

    readonly landuseReach = signal(this.config.landuseReach.getActive());
    readonly visibleZoom = signal(this.config.visibleZoom.getActive());
    readonly landuseReveal = signal(this.config.landuseReveal.getActive());
    readonly triangleBudget = signal(this.config.triangleBudget.getActive());

    readonly farTileTextures = signal(this.config.farTileTextures.getActive());
    readonly buildings = signal(this.config.buildings.getActive());
    readonly roadsOptions = ROADS_OPTIONS;
    readonly roads = signal(this.config.roads.getActive());
    readonly renderScales: Option<number>[] = RENDER_SCALE_OPTIONS;
    readonly renderScale = signal(this.config.renderScale.getActive());
    readonly supersampling = signal(this.config.supersampling.getActive());
    readonly triangleBudgetK = computed(() => this.triangleBudget() / 1000);
    readonly triangleBudgetLabel = computed(() => triangleBudgetLabel(this.triangleBudget()));

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
    readonly flightHelp = computed<HelpEntry[]>(() => flightHelp(this.keyboardLayout()));

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
        this.actions.setTerrainDetail(sliderValue(event));
        this.terrainDetail.set(this.config.terrainDetail.getActive());
    }

    setTerrainColour(mode: TerrainColours) {
        this.actions.setTerrainColour(mode);
        this.terrainColour.set(mode);
    }

    setTerrainShading(mode: TerrainShading) {
        this.actions.setTerrainShading(mode);
        this.terrainShading.set(mode);
    }

    setLanduseReach(event: Event) {
        this.actions.setLanduseReach(sliderValue(event));
        this.landuseReach.set(this.config.landuseReach.getActive());
    }

    setVisibleZoom(event: Event) {
        this.actions.setVisibleZoom(sliderValue(event));
        this.visibleZoom.set(this.config.visibleZoom.getActive());
    }

    setLanduseReveal(event: Event) {
        this.actions.setLanduseReveal(sliderValue(event));
        this.landuseReveal.set(this.config.landuseReveal.getActive());
    }

    setFarTileTextures(event: MatSlideToggleChange) {
        this.actions.setFarTileTextures(event.checked);
        this.farTileTextures.set(event.checked);
    }

    setBuildings(event: MatSlideToggleChange) {
        this.actions.setBuildings(event.checked);
        this.buildings.set(event.checked);
    }

    setRoads(mode: RoadsMode) {
        this.actions.setRoads(mode);
        this.roads.set(mode);
    }

    setRenderScale(scale: number) {
        this.actions.setRenderScale(scale);
        this.renderScale.set(scale);
    }

    setSupersampling(event: MatSlideToggleChange) {
        this.actions.setSupersampling(event.checked);
        this.supersampling.set(event.checked);
    }

    setTriangleBudget(event: Event) {
        this.actions.setTriangleBudget(sliderValue(event));
        this.triangleBudget.set(this.config.triangleBudget.getActive());
    }

    setLanduseBlend(event: Event) {
        this.landuseBlend.set(this.actions.setLanduseBlend(sliderValue(event)));
    }

    setTreeDensity(event: Event) {
        this.treeDensity.set(this.actions.setTreeDensity(sliderValue(event)));
    }

    colourSliderValue(group: ColourAdjustGroup, channel: ColourChannelOption): number {
        return colourSliderValue(this.colourAdjust(), group, channel);
    }

    setColourTweak(group: ColourAdjustGroup, channel: ColourChannelOption, event: Event) {
        this.actions.setColourTweak(this.colourAdjust(), group, channel, sliderValue(event));
        this.colourAdjust.set(this.config.colourAdjust.getActive());
    }

    resetColourAdjust() {
        this.actions.resetColourAdjust();
        this.colourAdjust.set(this.config.colourAdjust.getActive());
    }

    setDaytime(event: Event) {
        this.actions.setDaytime(sliderValue(event));
        this.daytime.set(this.config.daytime.getActive());
    }

    setFlightModel(id: string) {
        this.actions.setFlightModel(id);
        this.flightModel.set(id);
    }

    setAiPilotModel(model: AiPilotModels) {
        this.actions.setAiPilotModel(model);
        this.aiPilotModel.set(model);
    }

    setUnitSystem(system: UnitSystems) {
        this.actions.setUnitSystem(system);
        this.unitSystem.set(system);
    }

    setVolume(event: Event) {
        this.volume.set(this.actions.setVolume(sliderValue(event)));
    }

    setKeyboardLayout(layout: KeyboardControlLayoutId) {
        this.actions.setKeyboardLayout(layout);
        this.keyboardLayout.set(layout);
    }

    setPitchStickMode(mode: KeyboardPitchStickMode) {
        this.actions.setPitchStickMode(mode);
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
        return joystickHelp(device.getDeviceId(), device.getAxisCount());
    }

    /**
     * Populated from the terrain manifest rather than from a fixed list,
     * because what is baked differs per clone — a fresh one has whatever areas
     * its owner imported, and possibly only the shipped one. With fewer than
     * two there is nothing to choose between, and the section stays hidden.
     */
    private loadAreas() {
        loadTerrainManifest(DEFAULT_TERRAIN_URL).then(manifest => {
            const { options, selected } = areaOptions(terrainAreas(manifest), PLAY_ORIGIN, loadSettings().terrainArea);
            this.area.set(selected);
            this.initialArea.set(selected);
            this.areas.set(options);
        }).catch(() => {
            // No manifest, no picker: the section is simply not shown.
        }).finally(() => this.areasLoaded.set(true));
    }
}
