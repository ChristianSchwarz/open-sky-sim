/**
 * Settings fixtures (milestone M8): the persisted settings (settingsStorage.ts)
 * read from and written to localStorage, the live settings (configService.ts)
 * with their clamping and listeners, what each settings dialog control does
 * (settingsModel.ts SettingsActions, persistSettingChanges), everything the
 * dialog shows (tabs, text, option lists, slider ranges and readouts, help
 * keys, data credits), the spawn menu's lists and quick search, and the boot
 * progress stages and streaming bar.
 *
 * localStorage is a Map-backed stand-in; nothing here touches a DOM.
 */
import {
    AiPilotModelSetting, BuildingsSetting, ColourAdjustSetting, ConfigService, DaytimeSetting,
    FarTileTexturesSetting, LanduseBlendSetting, LanduseReachSetting, LanduseRevealSetting, RENDER_SCALES,
    RenderScaleSetting, RoadsSetting, SupersamplingSetting, TerrainColourSetting, TerrainDetailSetting,
    TerrainShadingSetting, TreeDensitySetting, TriangleBudgetSetting, UnitSystemSetting, VisibleZoomSetting,
} from '../../../src/script/config/configService';
import { AppSettings, loadSettings, updateSettings } from '../../../src/script/config/settingsStorage';
import { KeyboardControlLayoutId, KeyboardPitchStickMode } from '../../../src/script/input/keyboardLayouts';
import {
    BOOT_STAGES, BOOT_TERRAIN_RANGE, RESPAWN_STAGE, STREAM_BAR_RATE_PER_S, STREAM_COUNTDOWN_FROM, STREAM_GO_SHOWN_MS,
    STREAM_HOLD_MAX_MS, STREAM_SETTLE_MS, StreamBar, bootFailedStage, bootstrapBakeStage, clampBootPercent,
    countdownTexts, streamingLabel, terrainBootStage,
} from '../../../src/script/osd/bootProgress';
import {
    ColourAdjust, ColourAdjustGroup, ColourTweak, clampColourAdjust, defaultColourAdjust,
} from '../../../src/script/scene/materials/shaders/colourAdjust';
import { FlyableAircraftDef } from '../../../src/script/scene/entities/aircraftDef';
import { groupAircraftByModel } from '../../../src/script/state/aircraftRegistry';
import {
    AiPilotModels, FlightModels, RoadsMode, TechProfiles, TerrainColours, TerrainShading, UnitSystems,
} from '../../../src/script/state/gameDefs';
import { AirfieldEntry } from '../../../src/script/state/spawnSearch';
import { PLAY_ORIGIN } from '../../../src/script/state/worldLayout';
import { DETAIL_DISTANCE_OFF } from '../../../src/script/terrain/lod';
import type { TerrainArea } from '../../../src/script/terrain/manifest';
import {
    AI_PILOT_MODEL_OPTIONS, COLOUR_CHANNEL_OPTIONS, COLOUR_GROUP_OPTIONS, DATA_SOURCES, DETAIL_OFF_KM,
    FLIGHT_MODEL_OPTIONS, KEYBOARD_LAYOUT_OPTIONS, LICENCE_URLS, PITCH_STICK_MODE_OPTIONS, RENDER_SCALE_OPTIONS,
    ROADS_OPTIONS, SETTINGS_TEXT, SLIDERS, SPAWN_ACTIONS, SPAWN_HELP, SYSTEMS_HELP, SettingsActions, TABS,
    TERRAIN_COLOUR_OPTIONS, TERRAIN_SHADING_OPTIONS, UNIT_SYSTEM_OPTIONS, VIEWS_HELP, aircraftMenu, airfieldMenu,
    areaOptions, colourSliderLabel, colourSliderValue, daytimeLabel, flightHelp, formatControlKey, joystickHelp,
    joystickName, landuseReachLabel, landuseRevealLabel, multiplierLabel, percentLabel, persistSettingChanges,
    quickSearch, spawnButtonLabel, terrainDetailFromKm, terrainDetailKm, terrainDetailLabel, triangleBudgetLabel,
    visibleZoomLabel,
} from '../../../src/script/ui/settings/settingsModel';
import { SuiteOutput } from '../lib';

const STORAGE_KEY = 'retroflightsim.settings';

/** A Map-backed localStorage for settingsStorage.ts, which reads the global. */
class MemoryStorage {
    readonly items = new Map<string, string>();
    getItem(key: string): string | null {
        return this.items.has(key) ? this.items.get(key)! : null;
    }
    setItem(key: string, value: string): void {
        this.items.set(key, String(value));
    }
    removeItem(key: string): void {
        this.items.delete(key);
    }
}

const storage = new MemoryStorage();

function setRaw(raw: string | null): void {
    if (raw === null) {
        storage.removeItem(STORAGE_KEY);
    } else {
        storage.setItem(STORAGE_KEY, raw);
    }
}

function getRaw(): string | null {
    return storage.getItem(STORAGE_KEY);
}

function loadFrom(raw: string | null): AppSettings {
    setRaw(raw);
    return loadSettings();
}

/** Every top-level field of AppSettings, in the order the stored JSON has them. */
const FIELDS: (keyof AppSettings)[] = [
    'techProfile', 'flightModel', 'keyboardLayout', 'keyboardPitchStickMode', 'aiPilotModel', 'terrainColour',
    'terrainShading', 'landuseBlend', 'treeDensity', 'colourAdjust', 'aircraftId', 'spawnMode', 'daytime',
    'terrainArea', 'terrainDetailDistanceM', 'landuseReach', 'visibleZoom', 'landuseRevealPx',
    'terrainTriangleBudget', 'farTileTextures', 'buildings', 'roads', 'renderScale', 'supersampling', 'volume',
];

/** JSON texts tried as the value of every field. */
const VALUE_TEXTS: string[] = [
    'null', 'true', 'false', '0', '-0', '1', '2', '3', '4', '5', '-1', '0.5', '0.7', '0.75', '0.9', '1.5', '6', '10',
    '12', '12.5', '13', '20', '20.5', '21', '23.75', '23.999', '24', '24.5', '100', '199', '200000', '600000',
    '600000.5', '4000000', '4000001', '1e400', '-1e400', '1E2', '1e-7', '"x"', '""', '"HD"', '"SD"', '"FM2"',
    '"FM3"', '"DEBUG"', '"fm2"', '"CLASSIC"', '"SHAW"', '"AGGRESSIVE"', '"ACE"', '"LANDCOVER"', '"SWATCH"',
    '"HYBRID"', '"IMAGERY"', '"SMOOTH"', '"FACETED"', '"ALL"', '"MAJOR"', '"OFF"', '"approach"', '"runway"',
    '"headon"', '"carrier"', '"carrierBarricade"', '"carrierTakeoff"', '"highAlt"', '"space"', '"closeWing"',
    '"Headon"', '"f22"', '"su33/navy"', '"0.5"', '"true"', JSON.stringify('a'.repeat(199)),
    JSON.stringify('a'.repeat(200)), '"\\u00e9t\\u00e9"', '[]', '{}', '[1]', '{"hue":10}',
];

/** Whole stored strings: garbage, JSON edge cases, and objects with stray keys. */
const RAW_CASES: (string | null)[] = [
    null, '', 'garbage', '{', 'null', '5', 'true', '"str"', '[]', '[1,2]', '{}',
    '{"volume": 01}', '{"volume": 1.}', '{"volume": .5}', '{"volume": +0.5}', '{"volume": 0x1}',
    '{"volume": 0.5,}', '{"volume": 0.5} x', ' \n{"volume": 0.5}\t ', '{"volume": 0.5, "volume": 0.2}',
    '{"volume": Infinity}', '{"volume": NaN}', '{"volume": 5e-1}', '{"volume": 0.5} // note',
    '{"aircraftId": "a\u0001b"}', '{"aircraftId": "a\\u0001b"}', '{"aircraftId": "\\ud800x"}',
    '{"aircraftId": "\\u00e9\\n\\"q\\"\\\\"}', '{"aircraftId": "\\x41"}', '{"aircraftId": "\\u12"}',
    '{"aircraftId": "tab\there"}', '{"terrainDetailDistanceM": null}', '{"terrainDetailDistanceM": 1e400}',
    '{"terrainDetailDistanceM": -5}', '{"terrainDetailDistanceM": "12000"}',
    '{"shadows": true, "legacyKey": 1, "volume": 0.3}', '{"__proto__": {"volume": 0.1}}',
    '{"colourAdjust": {"sky": {"saturation": 5, "brightness": "x", "hue": 400}, "trees": {"saturation": -1}}}',
    '{"colourAdjust": {"water": {"hue": -181, "saturation": 2.5, "brightness": -0.5}, "terrain": null, "sky": []}}',
    '{"colourAdjust": [1, 2]}', '{"colourAdjust": "x"}', '{"colourAdjust": {"trees": {"hue": 1e400}}}',
    JSON.stringify({
        techProfile: 'HD', flightModel: 'FM3', keyboardLayout: 2, keyboardPitchStickMode: 1, aiPilotModel: 'ACE',
        terrainColour: 'IMAGERY', terrainShading: 'SMOOTH', landuseBlend: 0.35, treeDensity: 3.5,
        colourAdjust: {
            trees: { hue: 15, saturation: 1.2, brightness: 0.9 }, terrain: { hue: -30, saturation: 0.8, brightness: 1.1 },
            water: { hue: 0, saturation: 1, brightness: 1 }, sky: { hue: 180, saturation: 2, brightness: 0 },
        },
        aircraftId: 'mod-su33', spawnMode: 'carrierBarricade', daytime: 19.25, terrainArea: 'DACH',
        terrainDetailDistanceM: 24000, landuseReach: 2.5, visibleZoom: 9, landuseRevealPx: 11,
        terrainTriangleBudget: 1200000, farTileTextures: false, buildings: false, roads: 'MAJOR', renderScale: 0.6,
        supersampling: true, volume: 0.25,
    }),
    // Keys in another order: they are written back in AppSettings order.
    '{"volume": 0.4, "techProfile": "HD", "aircraftId": "x"}',
];

/** Partial updates, applied in turn from a starting stored string; values are not validated on write. */
const UPDATE_SEQUENCES: { start: string | null; updates: Partial<AppSettings>[] }[] = [
    {
        start: null,
        updates: [
            { volume: 0.5 },
            { terrainDetailDistanceM: null },
            { terrainDetailDistanceM: 18000 },
            { aircraftId: 'su33', spawnMode: 'carrier' },
            { colourAdjust: { ...defaultColourAdjust(), sky: { hue: 25, saturation: 0.4, brightness: 1.35 } } },
            { volume: 5 },
            { renderScale: 0.75 },
            { daytime: 23.75 },
            { landuseBlend: 0.07, treeDensity: 0 },
            { terrainArea: 'Grüße "quoted" \\ back\nslash \u0001  ' },
            { keyboardLayout: KeyboardControlLayoutId.DVORAK, keyboardPitchStickMode: KeyboardPitchStickMode.HOLD },
            { landuseReach: 1e-7, terrainTriangleBudget: 1e21, landuseRevealPx: 123456789012345680000 },
            { daytime: 0.1 + 0.2, volume: 1 / 3 },
        ],
    },
    { start: 'garbage', updates: [{ buildings: false }] },
    { start: '{"shadows": true, "volume": 0.3}', updates: [{ roads: RoadsMode.OFF }] },
    { start: '{"volume": 7, "flightModel": "XYZ"}', updates: [{ supersampling: true }] },
    { start: '{"terrainDetailDistanceM": 1e400}', updates: [{ farTileTextures: false }] },
];

function loadCases() {
    const fields = FIELDS.filter(f => f !== 'colourAdjust').map(field => ({
        field,
        results: VALUE_TEXTS.map(text => [text, loadFrom(`{"${field}": ${text}}`)[field] as unknown]),
    }));
    const raw = RAW_CASES.map(r => {
        const settings = loadFrom(r);
        return { raw: r, settings, normalized: JSON.stringify(settings) };
    });
    return { fields, raw };
}

function updateCases() {
    return UPDATE_SEQUENCES.map(seq => {
        setRaw(seq.start);
        const steps = seq.updates.map(partial => {
            const returned = updateSettings(partial);
            return { partial, written: getRaw(), returned, reloaded: loadSettings() };
        });
        return { start: seq.start, steps };
    });
}

/** A ConfigService the way index.ts builds one from loaded settings. */
function configFrom(settings: AppSettings): ConfigService {
    const stub = {} as never;
    return new ConfigService(
        { [TechProfiles.HD]: stub },
        { [FlightModels.FM2]: stub, [FlightModels.FM3]: stub, [FlightModels.DEBUG]: stub },
        settings.techProfile,
        settings.flightModel,
        settings.aiPilotModel,
        settings.daytime,
        settings.terrainColour,
        settings.terrainDetailDistanceM ?? DETAIL_DISTANCE_OFF,
        settings.terrainShading,
        settings.landuseBlend,
        settings.landuseReach,
        settings.terrainTriangleBudget,
        settings.landuseRevealPx,
        settings.farTileTextures,
        settings.renderScale,
        settings.supersampling,
        settings.roads,
        settings.treeDensity,
        settings.visibleZoom,
        settings.colourAdjust,
        settings.buildings,
    );
}

function snapshot(config: ConfigService) {
    return {
        techProfile: config.techProfiles.getActiveKey(),
        flightModel: config.flightModels.getActiveKey(),
        unitSystem: config.unitSystem.getActive(),
        aiPilotModel: config.aiPilotModels.getActive(),
        terrainColour: config.terrainColour.getActive(),
        terrainShading: config.terrainShading.getActive(),
        landuseBlend: config.landuseBlend.getActive(),
        treeDensity: config.treeDensity.getActive(),
        terrainDetail: config.terrainDetail.getActive(),
        landuseReach: config.landuseReach.getActive(),
        visibleZoom: config.visibleZoom.getActive(),
        landuseReveal: config.landuseReveal.getActive(),
        triangleBudget: config.triangleBudget.getActive(),
        farTileTextures: config.farTileTextures.getActive(),
        buildings: config.buildings.getActive(),
        roads: config.roads.getActive(),
        renderScale: config.renderScale.getActive(),
        supersampling: config.supersampling.getActive(),
        daytime: config.daytime.getActive(),
        colourAdjust: config.colourAdjust.getActive(),
    };
}

/** Numbers tried on every numeric setting, constructor and setActive alike. */
const NUMBERS: number[] = [
    NaN, Infinity, -Infinity, -1e9, -24.5, -1, -0.5, 0, 0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.25, 1.5, 4.5, 5,
    5.5, 6, 6.5, 11.5, 12, 12.4, 12.5, 13, 20, 20.5, 21, 23.99, 24, 25, 48.5, 1000, 1999, 2000, 12000, 39999,
    40000, 100000, 199999.5, 200000, 600000.4, 600000.5, 4000000, 5e6, 0.5, 0.5,
];

interface NumericSetting {
    getActive(): number;
    setActive(v: number): void;
    addChangeListener(l: (v: number) => void): void;
}

const NUMERIC_SETTINGS: { name: string; make: (initial?: number) => NumericSetting }[] = [
    { name: 'daytime', make: v => new DaytimeSetting(v) },
    { name: 'terrainDetail', make: v => new TerrainDetailSetting(v) },
    { name: 'landuseReach', make: v => new LanduseReachSetting(v) },
    { name: 'visibleZoom', make: v => new VisibleZoomSetting(v) },
    { name: 'landuseReveal', make: v => new LanduseRevealSetting(v) },
    { name: 'triangleBudget', make: v => new TriangleBudgetSetting(v) },
    { name: 'landuseBlend', make: v => new LanduseBlendSetting(v) },
    { name: 'treeDensity', make: v => new TreeDensitySetting(v) },
    { name: 'renderScale', make: v => new RenderScaleSetting(v) },
];

function numericCases() {
    return NUMERIC_SETTINGS.map(({ name, make }) => {
        const setting = make();
        const calls: number[] = [];
        setting.addChangeListener(v => calls.push(v));
        const steps = NUMBERS.map(input => {
            calls.length = 0;
            setting.setActive(input);
            return [input, setting.getActive(), calls.length];
        });
        return {
            name,
            default: make().getActive(),
            initial: NUMBERS.map(input => [input, make(input).getActive()]),
            steps,
        };
    });
}

interface ValueSetting<T> {
    getActive(): T;
    setActive(v: T): void;
    addChangeListener(l: (v: T) => void): void;
}

function sequence<T>(name: string, make: () => ValueSetting<T>, values: T[]) {
    const setting = make();
    const calls: T[] = [];
    setting.addChangeListener(v => calls.push(v));
    return {
        name,
        default: make().getActive(),
        steps: values.map(v => {
            calls.length = 0;
            setting.setActive(v);
            return [v, setting.getActive(), calls.length];
        }),
    };
}

function enumCases() {
    return [
        sequence('unitSystem', () => new UnitSystemSetting(),
            [UnitSystems.METRIC, UnitSystems.IMPERIAL, UnitSystems.IMPERIAL, UnitSystems.METRIC]),
        sequence('aiPilotModel', () => new AiPilotModelSetting(),
            [AiPilotModels.CLASSIC, AiPilotModels.ACE, AiPilotModels.SHAW, AiPilotModels.SHAW, AiPilotModels.AGGRESSIVE]),
        sequence('terrainColour', () => new TerrainColourSetting(),
            [TerrainColours.HYBRID, TerrainColours.IMAGERY, TerrainColours.LANDCOVER, TerrainColours.SWATCH, TerrainColours.SWATCH]),
        sequence('terrainShading', () => new TerrainShadingSetting(),
            [TerrainShading.FACETED, TerrainShading.SMOOTH, TerrainShading.SMOOTH, TerrainShading.FACETED]),
        sequence('roads', () => new RoadsSetting(), [RoadsMode.ALL, RoadsMode.MAJOR, RoadsMode.OFF, RoadsMode.OFF, RoadsMode.ALL]),
        sequence('farTileTextures', () => new FarTileTexturesSetting(), [true, false, false, true]),
        sequence('buildings', () => new BuildingsSetting(), [true, false, false, true]),
        sequence('supersampling', () => new SupersamplingSetting(), [false, true, true, false]),
    ];
}

function configSetCases() {
    const stub = {} as never;
    const make = (initial?: string) => new ConfigService(
        { [TechProfiles.HD]: stub },
        { [FlightModels.FM2]: stub, [FlightModels.FM3]: stub, [FlightModels.DEBUG]: stub },
        undefined, initial,
    );
    const initial = [undefined, 'FM2', 'FM3', 'DEBUG', 'fm3', '', 'XYZ'].map(id => [id ?? null, make(id).flightModels.getActiveKey()]);
    const config = make();
    const log: unknown[] = [];
    config.flightModels.addChangeListener((_item, id, old) => log.push(['change', id, old]));
    for (const id of ['FM3', 'FM3', 'DEBUG', 'BOGUS', 'FM2']) {
        try {
            config.flightModels.setActive(id);
            log.push(['set', id, config.flightModels.getActiveKey()]);
        } catch {
            log.push(['throws', id, config.flightModels.getActiveKey()]);
        }
    }
    config.flightModels.notifyActive();
    log.push(['notified', config.flightModels.getActiveKey()]);
    return { initial, log };
}

/** Set semantics: insertion order, no duplicates, adds during a notify are called, removes are not. */
function listenerCases() {
    const setting = new DaytimeSetting();
    const log: string[] = [];
    const c = (h: number) => log.push(`C${h}`);
    const b = (h: number) => log.push(`B${h}`);
    const d = (h: number) => log.push(`D${h}`);
    const a = (h: number) => {
        log.push(`A${h}`);
        if (h === 1) {
            setting.removeChangeListener(b);
            setting.addChangeListener(c);
        }
        if (h === 2) {
            // Removed and re-added: it moves to the end and is visited again
            // in this same pass (so only once, or it never ends).
            setting.removeChangeListener(d);
            setting.addChangeListener(d);
            setting.addChangeListener(b);
        }
        if (h === 3) {
            setting.removeChangeListener(a);
        }
    };
    setting.addChangeListener(a);
    setting.addChangeListener(b);
    setting.addChangeListener(a);
    setting.addChangeListener(d);
    const steps: { action: string; log: string[] }[] = [];
    const run = (action: string, f: () => void) => {
        log.length = 0;
        f();
        steps.push({ action, log: [...log] });
    };
    run('set 1', () => setting.setActive(1));
    run('set 2', () => setting.setActive(2));
    run('set 2 again', () => setting.setActive(2));
    run('notify', () => setting.notifyActive());
    run('set 3', () => setting.setActive(3));
    run('remove d, add b, set 4', () => {
        setting.removeChangeListener(d);
        setting.addChangeListener(b);
        setting.setActive(4);
    });
    return steps;
}

function colourCases() {
    const clamp = [
        undefined, null, 5, 'x', [], {},
        { sky: { saturation: 5, brightness: 'x', hue: 400 }, trees: { saturation: -1 } },
        { water: { hue: -181, saturation: 2.5, brightness: -0.5 }, terrain: null, sky: [] },
        { trees: { hue: NaN, saturation: Infinity, brightness: -Infinity } },
        { terrain: { hue: 179.5, saturation: 0.05, brightness: 1.95 }, extra: { hue: 5 } },
    ].map(input => ({ input: input === undefined ? '(undefined)' : input, output: clampColourAdjust(input) }));
    const setting = new ColourAdjustSetting(clampColourAdjust({ sky: { hue: 10, saturation: 1, brightness: 1 } }));
    let calls = 0;
    setting.addChangeListener(() => calls++);
    const tweaks: [ColourAdjustGroup, ColourTweak][] = [
        ['sky', { hue: 10, saturation: 1, brightness: 1 }],
        ['sky', { hue: 20, saturation: 1, brightness: 1 }],
        ['trees', { hue: 0, saturation: 3, brightness: 1 }],
        ['trees', { hue: 0, saturation: 2, brightness: 1 }],
        ['water', { hue: -500, saturation: -1, brightness: NaN }],
        ['water', { hue: -180, saturation: 0, brightness: 1 }],
        ['terrain', { hue: 45, saturation: 0.5, brightness: 1.5 }],
    ];
    const steps = tweaks.map(([group, tweak]) => {
        calls = 0;
        setting.setTweak(group, tweak);
        return { group, tweak, active: setting.getActive(), notified: calls };
    });
    return { defaults: defaultColourAdjust(), clamp, steps };
}

type Action = [string, ...unknown[]];

const ACTIONS: Action[] = [
    ['setTerrainDetail', 2], ['setTerrainDetail', 10], ['setTerrainDetail', 40], ['setTerrainDetail', 42],
    ['setTerrainDetail', 0], ['setTerrainDetail', 12],
    ['setTerrainColour', TerrainColours.IMAGERY], ['setTerrainShading', TerrainShading.SMOOTH],
    ['setLanduseReach', 3.5], ['setLanduseReach', 0], ['setLanduseReach', 11],
    ['setVisibleZoom', 7], ['setVisibleZoom', 12.6], ['setVisibleZoom', 4],
    ['setLanduseReveal', 0.5], ['setLanduseReveal', 30], ['setLanduseReveal', 7],
    ['setFarTileTextures', false], ['setBuildings', false], ['setBuildings', false], ['setRoads', RoadsMode.MAJOR],
    ['setRenderScale', 0.7], ['setRenderScale', 0.75], ['setRenderScale', 1],
    ['setSupersampling', true],
    ['setTriangleBudget', 100], ['setTriangleBudget', 1200], ['setTriangleBudget', 4100], ['setTriangleBudget', 600.0004],
    ['setLanduseBlend', 37.4], ['setLanduseBlend', 62.5], ['setLanduseBlend', 150],
    ['setTreeDensity', 2.5], ['setTreeDensity', -3], ['setTreeDensity', 7],
    ['setColourTweak', 'sky', 'hue', 47], ['setColourTweak', 'sky', 'saturation', 37.5],
    ['setColourTweak', 'trees', 'brightness', 250], ['setColourTweak', 'water', 'hue', -190],
    ['setColourTweak', 'terrain', 'saturation', 100],
    ['resetColourAdjust'],
    ['setDaytime', 6.25], ['setDaytime', 24], ['setDaytime', 23.75], ['setDaytime', 23.75],
    ['setFlightModel', FlightModels.FM3], ['setAiPilotModel', AiPilotModels.ACE],
    ['setUnitSystem', UnitSystems.IMPERIAL],
    ['setVolume', 42.5], ['setVolume', 101], ['setVolume', 0.4],
    ['setKeyboardLayout', KeyboardControlLayoutId.QWERTZ], ['setPitchStickMode', KeyboardPitchStickMode.HOLD],
];

function actionCases() {
    setRaw(null);
    const config = configFrom(loadSettings());
    persistSettingChanges(config);
    const devices: unknown[] = [];
    const actions = new SettingsActions(config, {
        setMasterVolume: v => devices.push(['volume', v]),
        setKeyboardLayout: l => devices.push(['keyboardLayout', l]),
        setKeyboardPitchStickMode: m => devices.push(['pitchStickMode', m]),
    });
    const channelByKey = new Map(COLOUR_CHANNEL_OPTIONS.map(c => [c.key, c]));
    const steps = ACTIONS.map(([name, ...args]) => {
        devices.length = 0;
        let returned: unknown = null;
        const a = actions as unknown as Record<string, (...x: unknown[]) => unknown>;
        if (name === 'setColourTweak') {
            const [group, key, value] = args as [ColourAdjustGroup, keyof ColourTweak, number];
            actions.setColourTweak(config.colourAdjust.getActive(), group, channelByKey.get(key)!, value);
        } else {
            returned = a[name].apply(actions, args) ?? null;
        }
        return {
            action: name, args, returned, devices: [...devices], stored: getRaw(), config: snapshot(config),
        };
    });
    return { initial: snapshot(configFrom(loadFrom(null))), steps };
}

function bootFromSettingsCases() {
    const raws = RAW_CASES.filter((_, i) => i === 0 || i === 3 || i >= RAW_CASES.length - 8);
    return raws.map(raw => ({ raw, config: snapshot(configFrom(loadFrom(raw))) }));
}

/**
 * The dialog's layout, tab by tab, in display order. The template in
 * settingsDialog.ts is the authority; this mirrors it so the Unity model can be
 * checked control by control. Texts are referenced by their SETTINGS_TEXT path.
 */
function layout() {
    const t = SETTINGS_TEXT;
    const slider = (id: string, range: keyof typeof SLIDERS, extra: Record<string, unknown> = {}) =>
        ({ id, kind: 'slider', ...SLIDERS[range], ...extra });
    const choice = (id: string, kind: 'radio' | 'select', options: { value: unknown; label: string }[], extra: Record<string, unknown> = {}) =>
        ({ id, kind, label: (extra.label as string | undefined) ?? null, options: options.map(o => [String(o.value), o.label]), ...extra });
    const toggle = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'toggle', label, ...extra });
    const section = (id: string, title: string | null, help: string | null, controls: unknown[], extra: Record<string, unknown> = {}) =>
        ({ id, title, help, ...extra, controls });
    return [
        {
            tab: 'Flight',
            sections: [
                section('aircraft', t.aircraft.title, null, [{ id: 'aircraft', kind: 'list' }]),
                section('livery', null, null, [{ id: 'livery', kind: 'select', label: t.livery.label, visibleWhen: 'liveries > 1' }]),
                section('search', null, null, [
                    { id: 'search', kind: 'search', label: t.search.label, placeholder: t.search.placeholder, hint: t.search.hint },
                    { id: 'searchButton', kind: 'button', label: t.search.button, enabledWhen: 'query.trim() != "" && status != searching' },
                ]),
                section('airfield', null, null, [{ id: 'airfield', kind: 'select', label: t.airfield.label, visibleWhen: 'airfields > 0' }]),
                section('start', t.start.title, null, SPAWN_ACTIONS.map(a => ({
                    id: `spawn.${a.mode}`, kind: 'button', label: spawnButtonLabel(a), key: a.key, mode: a.mode,
                }))),
            ],
        },
        {
            tab: 'Graphics',
            sections: [
                section('renderScale', t.renderScale.title, t.renderScale.help, [
                    choice('renderScale', 'select', RENDER_SCALE_OPTIONS, { label: t.renderScale.select }),
                    toggle('supersampling', t.renderScale.supersampling, { enabledWhen: 'renderScale >= 1' }),
                ]),
                section('terrainDetail', t.terrainDetail.title, t.terrainDetail.help, [slider('terrainDetail', 'terrainDetailKm')]),
                section('landuseReach', t.landuseReach.title, t.landuseReach.help, [slider('landuseReach', 'landuseReach')]),
                section('visibleZoom', t.visibleZoom.title, t.visibleZoom.help, [slider('visibleZoom', 'visibleZoom')]),
                section('landuseReveal', t.landuseReveal.title, t.landuseReveal.help, [slider('landuseReveal', 'landuseRevealPx')]),
                section('triangleBudget', t.triangleBudget.title, t.triangleBudget.help, [slider('triangleBudget', 'triangleBudgetK')]),
                section('farTileTextures', t.farTileTextures.title, t.farTileTextures.help, [toggle('farTileTextures', t.farTileTextures.toggle)]),
                section('buildings', t.buildings.title, t.buildings.help, [toggle('buildings', t.buildings.toggle)], { note: t.buildings.note }),
                section('roads', t.roads.title, t.roads.help, [choice('roads', 'radio', ROADS_OPTIONS, { columns: 3 })]),
                section('terrainColour', t.terrainColour.title, t.terrainColour.help, [choice('terrainColour', 'radio', TERRAIN_COLOUR_OPTIONS, { columns: 2 })]),
                section('landuseBlend', t.landuseBlend.title, t.landuseBlend.help, [
                    slider('landuseBlend', 'landuseBlendPercent', { minLabel: t.landuseBlend.minLabel, maxLabel: t.landuseBlend.maxLabel }),
                ]),
                section('treeDensity', t.treeDensity.title, t.treeDensity.help, [
                    slider('treeDensity', 'treeDensity', { minLabel: t.treeDensity.minLabel, maxLabel: t.treeDensity.maxLabel }),
                ]),
                section('terrainShading', t.terrainShading.title, t.terrainShading.help, [choice('terrainShading', 'radio', TERRAIN_SHADING_OPTIONS, { columns: 2 })]),
            ],
        },
        {
            tab: 'Colours',
            sections: [
                section('colours', null, t.colours.help, []),
                ...COLOUR_GROUP_OPTIONS.map(g => section(`colour.${g.key}`, g.label, null, COLOUR_CHANNEL_OPTIONS.map(c => ({
                    id: `colour.${g.key}.${c.key}`, kind: 'slider', label: c.label, min: c.min, max: c.max, step: c.step,
                })))),
                section('colourReset', null, null, [{ id: 'colourReset', kind: 'button', label: t.colours.reset }]),
            ],
        },
        {
            tab: 'World',
            sections: [
                section('area', t.area.title, t.area.help, [
                    { id: 'area', kind: 'select', label: t.area.select },
                    { id: 'flyHere', kind: 'button', label: t.area.button, enabledWhen: 'area != initialArea' },
                ], { visibleWhen: 'areas > 1' }),
                section('importTerrain', t.importTerrain.title, t.importTerrain.help, [], { visibleWhen: 'terrainImport' }),
                section('singleArea', null, t.singleArea, [], { visibleWhen: 'areasLoaded && areas < 2 && !terrainImport' }),
            ],
        },
        {
            tab: 'Simulation',
            sections: [
                section('daytime', t.daytime.title, t.daytime.help, [slider('daytime', 'daytimeHours')]),
                section('flightModel', t.flightModel.title, null, [choice('flightModel', 'radio', FLIGHT_MODEL_OPTIONS, { columns: 2 })]),
                section('aiPilotModel', t.aiPilotModel.title, t.aiPilotModel.help, [choice('aiPilotModel', 'radio', AI_PILOT_MODEL_OPTIONS, { columns: 2 })]),
            ],
        },
        {
            tab: 'General',
            sections: [
                section('volume', t.volume.title, null, [slider('volume', 'volumePercent')]),
                section('units', t.units.title, null, [choice('units', 'radio', UNIT_SYSTEM_OPTIONS, { columns: 2 })]),
                section('keyboardLayout', t.keyboardLayout.title, null, [choice('keyboardLayout', 'radio', KEYBOARD_LAYOUT_OPTIONS, { columns: 3 })]),
                section('pitchStick', t.pitchStick.title, null, [choice('pitchStick', 'radio', PITCH_STICK_MODE_OPTIONS, { columns: 2 })]),
            ],
        },
        {
            tab: 'Help',
            sections: [
                section('help.keyboard', t.help.keyboard, null, [{ id: 'help.keyboard', kind: 'keys' }]),
                section('help.joystick', t.help.joystick, null, [{ id: 'help.joystick', kind: 'keys' }]),
                section('help.systems', t.help.systems, null, [{ id: 'help.systems', kind: 'keys' }]),
                section('help.spawnMenu', t.help.spawnMenu, null, [{ id: 'help.spawnMenu', kind: 'keys' }], { note: t.help.spawnMenuNote }),
                section('help.views', t.help.views, null, [{ id: 'help.views', kind: 'keys' }]),
            ],
        },
        {
            tab: 'About',
            sections: [
                section('about', t.about.title, t.about.help, []),
                ...DATA_SOURCES.map((g, i) => section(`about.${i}`, g.title, g.feeds, [{ id: `about.${i}`, kind: 'credits' }])),
            ],
        },
    ];
}

function dialogCases() {
    const adjust: ColourAdjust = clampColourAdjust({
        trees: { hue: 12.5, saturation: 1.234, brightness: 0.005 },
        sky: { hue: -179.5, saturation: 0.125, brightness: 1.995 },
    });
    const areas: TerrainArea[] = [
        { name: 'gc', west: -18, south: 27, east: -13, north: 29.5 },
        { name: 'DACH', west: 5.8, south: 45.8, east: 17.2, north: 55.1 },
        { name: 'Krim', west: 32, south: 44, east: 37, north: 46.5 },
    ];
    return {
        tabs: TABS,
        text: SETTINGS_TEXT,
        sliders: SLIDERS,
        detailOffKm: DETAIL_OFF_KM,
        options: {
            terrainColour: TERRAIN_COLOUR_OPTIONS,
            roads: ROADS_OPTIONS,
            terrainShading: TERRAIN_SHADING_OPTIONS,
            flightModel: FLIGHT_MODEL_OPTIONS,
            aiPilotModel: AI_PILOT_MODEL_OPTIONS,
            unitSystem: UNIT_SYSTEM_OPTIONS,
            keyboardLayout: KEYBOARD_LAYOUT_OPTIONS,
            pitchStickMode: PITCH_STICK_MODE_OPTIONS,
            renderScale: RENDER_SCALE_OPTIONS,
        },
        renderScales: RENDER_SCALES,
        colourGroups: COLOUR_GROUP_OPTIONS,
        colourChannels: COLOUR_CHANNEL_OPTIONS,
        spawnActions: SPAWN_ACTIONS.map(a => ({ ...a, button: spawnButtonLabel(a) })),
        help: {
            systems: SYSTEMS_HELP,
            spawn: SPAWN_HELP,
            views: VIEWS_HELP,
            flight: [0, 1, 2, 3, 4, 7].map(id => ({ layout: id, entries: flightHelp(id) })),
            controlKeys: ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'numpadadd', 'numpadsubtract', 'w', ',', '\'', 'ß', 'x']
                .map(k => [k, formatControlKey(k)]),
            joystickNames: [
                'Logitech Extreme 3D (Vendor: 046d Product: c215)', 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
                'NoBracket', '(leading)', 'a(b', 'Two (x) (y)', '',
            ].map(id => [id, joystickName(id)]),
            joystick: [0, 1, 2, 3, 4, 6].map(n => ({ axisCount: n, ...joystickHelp('Stick (Vendor: 1)', n) })),
        },
        dataSources: DATA_SOURCES.map(g => ({
            ...g,
            sources: g.sources.map(s => ({
                name: s.name, scope: s.scope ?? null, credit: s.credit, creditUrl: s.creditUrl ?? null, licence: s.licence,
                licenceUrl: LICENCE_URLS[s.licence] ?? null,
            })),
        })),
        licenceUrls: LICENCE_URLS,
        readouts: {
            terrainDetail: [2000, 2500, 3499, 3500, 12000, 39999, Infinity].map(m => [m, terrainDetailKm(m), terrainDetailLabel(m)]),
            terrainDetailFromKm: [0, 2, 39.9, 40, 40.0001, 42].map(km => [km, terrainDetailFromKm(km)]),
            landuseReach: [1, 1.5, 2.345, 2.355, 10].map(v => [v, landuseReachLabel(v)]),
            visibleZoom: [5, 12].map(v => [v, visibleZoomLabel(v)]),
            landuseReveal: [1, 6, 7.5, 24].map(v => [v, landuseRevealLabel(v)]),
            triangleBudget: [200000, 600000, 600499, 600500, 999499, 999500, 999999, 1000000, 1050000, 1250000, 4000000]
                .map(v => [v, triangleBudgetLabel(v)]),
            percent: [0, 5, 50, 100].map(v => [v, percentLabel(v)]),
            multiplier: [0, 1, 20].map(v => [v, multiplierLabel(v)]),
            daytime: [0, 6.25, 14, 23.75, 23.999, 24].map(v => [v, daytimeLabel(v)]),
            colour: COLOUR_GROUP_OPTIONS.flatMap(g => COLOUR_CHANNEL_OPTIONS.map(c => [
                g.key, c.key, colourSliderValue(adjust, g.key, c), colourSliderLabel(adjust, g.key, c),
            ])),
        },
        colourAdjustForReadouts: adjust,
        areaOptions: [
            { areas, saved: '' }, { areas, saved: 'DACH' }, { areas, saved: 'gone' },
            { areas: areas.slice(1), saved: 'gone' }, { areas: [], saved: 'x' }, { areas: areas.slice(0, 1), saved: 'gc' },
        ].map(c => ({ ...c, home: PLAY_ORIGIN, ...areaOptions(c.areas, PLAY_ORIGIN, c.saved) })),
        layout: layout(),
    };
}

function def(id: string, name: string, extra: Partial<FlyableAircraftDef> = {}): FlyableAircraftDef {
    return { id, name, ...extra } as FlyableAircraftDef;
}

function spawnCases() {
    const defs = [
        def('f22', 'F-22 Raptor'),
        def('su33-a', 'Su-33 (Navy)', { canonicalName: 'Su-33', modelName: 'Su-33', liveryName: 'Navy' }),
        def('su33-b', 'Su-33 (Akula)', { canonicalName: 'Su-33', modelName: 'Su-33', liveryName: 'Akula' }),
        def('su33-c', 'Su-33 (blue)', { canonicalName: 'Su-33', modelName: 'Su-33', liveryName: 'blue' }),
        def('f14', 'F-14A Tomcat', { canonicalName: 'F-14A', modelName: 'F-14A Tomcat' }),
        def('e3', 'E-3 Sentry', { canonicalName: 'E-3', modelName: 'e-3 Sentry', liveryName: 'NATO' }),
        def('m2k', 'Mirage 2000-5F', { canonicalName: 'Mirage', modelName: 'Mirage 2000-5F' }),
        def('a10', 'A-10 Thunderbolt II'),
        def('a10b', 'A-10 Thunderbolt II (grey)', { canonicalName: 'a10', modelName: 'A-10 Thunderbolt II', liveryName: 'grey' }),
        def('mig', 'MiG-29 (Fulcrum)', { canonicalName: 'MiG-29', modelName: 'MiG-29' }),
    ];
    const groups = groupAircraftByModel(defs);
    const menus = [[0, 0], [1, 0], [1, 2], [1, 9], [9, 0], [99, 99], [3, 1], [-1, 0], [0, -1]].map(([m, l]) => ({
        modelIndex: m, liveryIndex: l, menu: aircraftMenu(groups, m, l),
    }));
    const choices = [
        { icao: 'GCLP', name: 'Gran Canaria', ref: '03L/21R', lengthM: 3100.4 },
        { icao: '', name: 'Segelfluggelände Hornberg', ref: '07/25', lengthM: 600.5 },
        { icao: 'GCXO', name: 'Tenerife Norte', ref: '12/30', lengthM: 3399.5 },
        { icao: 'GCXO', name: 'Duplicate', ref: '01/19', lengthM: 1000 },
    ];
    const airfields = [undefined, 'GCLP', 'Segelfluggelände Hornberg', 'GCXO', 'nope', ''].map(key => ({
        selected: key ?? null, menu: airfieldMenu(choices, key),
    }));
    const areas: TerrainArea[] = [
        { name: 'gc', west: -18, south: 27, east: -13, north: 29.5 },
        { name: 'DACH', west: 5.8, south: 45.8, east: 17.2, north: 55.1 },
    ];
    const entries: AirfieldEntry[] = [
        { icao: 'GCLP', iata: 'LPA', name: 'Gran Canaria Airport', area: 'gc', lat: 27.93, lon: -15.39, lengthM: 3100 },
        { icao: 'GCXO', iata: 'TFN', name: 'Tenerife Norte', area: 'gc', lat: 28.48, lon: -16.34, lengthM: 3400 },
        { icao: 'EDDF', iata: 'FRA', name: 'Frankfurt am Main', area: 'DACH', lat: 50.03, lon: 8.57, lengthM: 4000 },
        { icao: '', iata: '', name: 'Segelfluggelände Hornberg', area: 'DACH', lat: 48.7, lon: 9.86, lengthM: 600 },
    ];
    const queries = ['', 'gclp', 'frank', '28.1, -15.4', '50 8', '91, 0', 'hornberg', 'zzz', '  LPA  '];
    return {
        defs: defs.map(d => ({
            id: d.id, name: d.name, canonicalName: d.canonicalName ?? null, modelName: d.modelName ?? null,
            liveryName: d.liveryName ?? null,
        })),
        groups: groups.map(g => ({ key: g.key, label: g.label, variants: g.variants.map(v => v.id) })),
        menus,
        airfieldChoices: choices,
        airfields,
        search: {
            areas, entries,
            results: [['gc', 'gc'], ['DACH', 'DACH']].flatMap(([current]) =>
                queries.map(q => ({ query: q, currentArea: current, results: quickSearch(q, entries, areas, current) }))),
        },
    };
}

function bootCases() {
    const traces = [
        { name: 'quick', frames: [[16, 10], [33, 8], [50, 4], [66, 0], [83, 0], [100, 0], [1000, 0], [2500, 0], [3200, 0], [3300, 0]] },
        { name: 'growing backlog', frames: [[16, 5], [32, 20], [48, 18], [64, 40], [500, 10], [1000, 0], [1500, 3], [2000, 0], [4000, 0], [4700, 0]] },
        { name: 'never quiet', frames: [[16, 50], [5000, 40], [10000, 30], [19999, 20], [20000, 10], [20001, 5]] },
        { name: 'zero at once', frames: [[0, 0], [600, 0], [1999, 0], [2000, 0], [2600, 0]] },
    ].map(trace => {
        const bar = new StreamBar(0);
        return {
            name: trace.name,
            frames: trace.frames.map(([t, backlog]) => {
                const done = bar.tick(t, backlog);
                return [t, backlog, bar.shown, done, 100 * bar.shown, streamingLabel(bar.shown)];
            }),
        };
    });
    return {
        stages: BOOT_STAGES,
        terrainRange: BOOT_TERRAIN_RANGE,
        respawn: RESPAWN_STAGE,
        stream: {
            settleMs: STREAM_SETTLE_MS, holdMaxMs: STREAM_HOLD_MAX_MS, countdownFrom: STREAM_COUNTDOWN_FROM,
            goShownMs: STREAM_GO_SHOWN_MS, barRatePerS: STREAM_BAR_RATE_PER_S,
        },
        countdown: countdownTexts(),
        terrain: [[0, 0], [0, 12], [5, 12], [12, 12], [3, 7]].map(([m, t]) => ({
            meshed: m, total: t, ...terrainBootStage(m, t, BOOT_TERRAIN_RANGE.min, BOOT_TERRAIN_RANGE.max),
        })),
        bake: [
            ['gc', 'mesh', 0, 5, 0], ['gc', 'mesh', 2, 5, 50], ['DACH', 'cover', 4, 5, 100], [null, null, null, null, null],
            ['x', 'y', 0, 0, 30], ['x', 'y', 9, 3, 0],
        ].map(([name, step, index, count, percent]) => ({
            name, step, stepIndex: index, stepCount: count, percent,
            ...bootstrapBakeStage(
                (name ?? undefined) as string | undefined, (step ?? undefined) as string | undefined,
                (index ?? undefined) as number | undefined, (count ?? undefined) as number | undefined,
                (percent ?? undefined) as number | undefined,
            ),
        })),
        failed: bootFailedStage('Unsupported terrain manifest scheme: x'),
        streamingLabels: [0, 0.004, 0.5, 0.999, 1].map(s => [s, streamingLabel(s)]),
        clamp: [-5, 0, 42.5, 100, 140, NaN].map(p => [p, clampBootPercent(p)]),
        traces,
    };
}

export function settingsSuite(): SuiteOutput {
    const saved = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    try {
        setRaw(null);
        const data = {
            suite: 'settings',
            version: 1,
            source: [
                'src/script/config/settingsStorage.ts', 'src/script/config/configService.ts',
                'src/script/ui/settings/settingsModel.ts', 'src/script/ui/settings/settingsDialog.ts',
                'src/script/osd/spawnPanel.ts', 'src/script/osd/bootProgress.ts',
                'src/script/scene/materials/shaders/colourAdjust.ts', 'src/script/state/aircraftRegistry.ts',
            ],
            notes: 'localStorage holds one key, storageKey, whose value is JSON.stringify(AppSettings) with the '
                + 'fields in `fields` order. load.fields: the value read back for {"<field>": <text>}. '
                + 'Numbers in the fixture that are not finite are written "NaN"/"Infinity"/"-Infinity". '
                + 'Action steps run in order on one ConfigService built as index.ts builds it, with '
                + 'persistSettingChanges registered. layout mirrors the settingsDialog.ts template.',
            tolerances: { exact: true },
            storageKey: STORAGE_KEY,
            fields: FIELDS,
            defaults: loadFrom(null),
            defaultsJson: JSON.stringify(loadFrom(null)),
            enums: {
                techProfiles: Object.values(TechProfiles),
                flightModels: Object.values(FlightModels),
                aiPilotModels: Object.values(AiPilotModels),
                terrainColours: Object.values(TerrainColours),
                terrainShading: Object.values(TerrainShading),
                roads: Object.values(RoadsMode),
                unitSystems: Object.values(UnitSystems),
                spawnModes: ['approach', 'runway', 'headon', 'carrier', 'carrierBarricade', 'carrierTakeoff', 'highAlt', 'space', 'closeWing'],
            },
            load: loadCases(),
            update: updateCases(),
            numeric: numericCases(),
            enumSettings: enumCases(),
            configSet: configSetCases(),
            listeners: listenerCases(),
            colourAdjust: colourCases(),
            actions: actionCases(),
            bootFromSettings: bootFromSettingsCases(),
            dialog: dialogCases(),
            spawn: spawnCases(),
            boot: bootCases(),
        };
        return { files: [{ file: 'settings.json', data }] };
    } finally {
        (globalThis as { localStorage?: unknown }).localStorage = saved;
    }
}
