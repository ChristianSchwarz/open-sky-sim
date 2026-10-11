/**
 * Everything the settings dialog shows or does that is not Angular: its tabs,
 * the text of every section, the option lists and slider ranges, how slider
 * positions turn into setting values and back into readouts, the Help tab's
 * key lists, the About tab's data credits, and the spawn menu's labels and
 * quick search.
 *
 * Kept free of Angular so it can run under node: the golden fixtures for the
 * Unity port (tools/golden/suites/settings.ts) read it, and the dialog
 * (settingsDialog.ts) and the spawn menu (osd/spawnPanel.ts) are built on it.
 */
import { ConfigService, RENDER_SCALES } from '../../config/configService';
import { AppSettings, SpawnMode, updateSettings } from '../../config/settingsStorage';
import {
    KeyboardControlAction, KeyboardControlLayoutId, KeyboardControlLayouts, KeyboardPitchStickMode,
} from '../../input/keyboardLayouts';
import {
    COLOUR_ADJUST_GROUPS, COLOUR_HUE_MAX_DEG, COLOUR_TWEAK_MAX, COLOUR_TWEAK_MIN, ColourAdjust, ColourAdjustGroup,
    ColourTweak, defaultColourAdjust,
} from '../../scene/materials/shaders/colourAdjust';
import { formatSunTime } from '../../scene/materials/shaders/sun';
import type { AircraftModelGroup } from '../../state/aircraftRegistry';
import { AiPilotModels, FlightModels, RoadsMode, TerrainColours, TerrainShading, UnitSystems } from '../../state/gameDefs';
import {
    AirfieldEntry, SpawnDestination, airfieldDestination, coordinateDestination, parseCoordinates, searchAirfields,
} from '../../state/spawnSearch';
import {
    DETAIL_DISTANCE_OFF, LANDUSE_REVEAL_MIN_PX_MAX, LANDUSE_REVEAL_MIN_PX_MIN, LEAF_REFINE_DISTANCE_SCALE_MAX,
    LEAF_REFINE_DISTANCE_SCALE_MIN, TERRAIN_DETAIL_DISTANCE_MAX_M, TERRAIN_DETAIL_DISTANCE_MIN_M,
    TERRAIN_TRIANGLE_BUDGET_MAX, TERRAIN_TRIANGLE_BUDGET_MIN, TERRAIN_VISIBLE_ZOOM_MAX, TERRAIN_VISIBLE_ZOOM_MIN,
} from '../../terrain/lod';
import type { TerrainArea } from '../../terrain/manifest';
import { Geodetic, homeArea } from '../../terrain/playArea';

export type SettingsTab = 'Flight' | 'Graphics' | 'Colours' | 'World' | 'Simulation' | 'General' | 'Help' | 'About';

/** In display order. */
export const TABS: SettingsTab[] = ['Flight', 'Graphics', 'Colours', 'World', 'Simulation', 'General', 'Help', 'About'];

/** The Flight tab's spawn buttons, in display order, with the key that also starts each. */
export const SPAWN_ACTIONS: { mode: SpawnMode; label: string; key: string }[] = [
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

/** What a start button reads: "Approach (1)". */
export function spawnButtonLabel(action: { label: string; key: string }): string {
    return `${action.label} (${action.key})`;
}

/** A row of the Help tab: the keys, then what they do. */
export interface HelpEntry {
    keys: string[];
    action: string;
}

export const SYSTEMS_HELP: HelpEntry[] = [
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

export const SPAWN_HELP: HelpEntry[] = [
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

export const VIEWS_HELP: HelpEntry[] = [
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

/** A key name from a keyboard layout as the Help tab prints it. */
export function formatControlKey(key: string): string {
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

/** The Help tab's flight control keys for a keyboard layout; empty for an unknown one. */
export function flightHelp(layoutId: KeyboardControlLayoutId): HelpEntry[] {
    const layout = KeyboardControlLayouts.get(layoutId);
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
}

/** "Logitech Extreme 3D (Vendor: 046d Product: c215)" reads as "Logitech Extreme 3D". */
export function joystickName(id: string): string {
    const bracket = id.lastIndexOf('(');
    return bracket !== -1 ? id.substring(0, bracket - 1) : id;
}

/** The Help tab's joystick entry: the device name and only the axes it actually has. */
export function joystickHelp(deviceId: string, axisCount: number): { name: string; axes: HelpEntry[] } {
    const axes = [
        { axis: 1, action: 'Pitch' },
        { axis: 0, action: 'Roll' },
        { axis: 3, action: 'Yaw' },
        { axis: 2, action: 'Throttle' },
    ];
    return {
        name: joystickName(deviceId),
        axes: axes
            .filter(({ axis }) => axis < axisCount)
            .map(({ axis, action }) => ({ keys: [`Axis ${axis}`], action })),
    };
}

/** A dataset the world is built from, as the About tab credits it. */
export interface DataSource {
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

export interface DataSourceGroup {
    title: string;
    /** What in the game the group's data ends up as. */
    feeds: string;
    sources: DataSource[];
}

export const LICENCE_URLS: Record<string, string> = {
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
export const DATA_SOURCES: DataSourceGroup[] = [
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
                name: 'Sentinel-2 L2A true colour', scope: 'Imagery and Hybrid terrain colours; roof colours of larger buildings outside the orthophoto areas',
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

export interface Option<T> {
    value: T;
    label: string;
}

export const TERRAIN_COLOUR_OPTIONS: Option<TerrainColours>[] = [
    { value: TerrainColours.LANDCOVER, label: 'Landcover (palette tones)' },
    { value: TerrainColours.SWATCH, label: 'Swatches (quantised imagery)' },
    { value: TerrainColours.HYBRID, label: 'Hybrid (palette hue, real shading)' },
    { value: TerrainColours.IMAGERY, label: 'Imagery (true colour)' },
];

export const ROADS_OPTIONS: Option<RoadsMode>[] = [
    { value: RoadsMode.ALL, label: 'All roads' },
    { value: RoadsMode.MAJOR, label: 'Major roads only' },
    { value: RoadsMode.OFF, label: 'Off' },
];

export const TERRAIN_SHADING_OPTIONS: Option<TerrainShading>[] = [
    { value: TerrainShading.FACETED, label: 'Faceted (flat)' },
    { value: TerrainShading.SMOOTH, label: 'Smooth (blended)' },
];

export const COLOUR_GROUP_OPTIONS: { key: ColourAdjustGroup; label: string }[] = [
    { key: 'trees', label: 'Trees and shrubs' },
    { key: 'terrain', label: 'Terrain' },
    { key: 'water', label: 'Water' },
    { key: 'sky', label: 'Sky' },
];

export interface ColourChannelOption {
    key: keyof ColourTweak;
    label: string;
    min: number;
    max: number;
    step: number;
    scale: number;
    unit: string;
}

/**
 * One slider per channel. `scale` turns the stored value into what the slider
 * and its label show: percent for saturation and brightness, degrees as they
 * are for hue.
 */
export const COLOUR_CHANNEL_OPTIONS: ColourChannelOption[] = [
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

export const FLIGHT_MODEL_OPTIONS: Option<string>[] = [
    { value: FlightModels.FM2, label: 'FM2 (Rigid body)' },
    { value: FlightModels.FM3, label: 'FM3 (Physical, post-stall)' },
    { value: FlightModels.DEBUG, label: 'Debug (Free-fly)' },
];

export const AI_PILOT_MODEL_OPTIONS: Option<AiPilotModels>[] = [
    { value: AiPilotModels.CLASSIC, label: 'Classic BFM' },
    { value: AiPilotModels.SHAW, label: 'Shaw (Fighter Combat)' },
    { value: AiPilotModels.AGGRESSIVE, label: 'Aggressive (Berserker)' },
    { value: AiPilotModels.ACE, label: 'Ace (vertical fight + post-stall)' },
];

export const UNIT_SYSTEM_OPTIONS: Option<UnitSystems>[] = [
    { value: UnitSystems.METRIC, label: 'Metric (m, km/h)' },
    { value: UnitSystems.IMPERIAL, label: 'Imperial (ft, kt)' },
];

export const KEYBOARD_LAYOUT_OPTIONS: Option<KeyboardControlLayoutId>[] = [
    { value: KeyboardControlLayoutId.QWERTY, label: 'QWERTY' },
    { value: KeyboardControlLayoutId.QWERTZ, label: 'QWERTZ' },
    { value: KeyboardControlLayoutId.AZERTY, label: 'AZERTY' },
    { value: KeyboardControlLayoutId.DVORAK, label: 'Dvorak' },
    { value: KeyboardControlLayoutId.ARROWS, label: 'Arrows' },
];

export const PITCH_STICK_MODE_OPTIONS: Option<KeyboardPitchStickMode>[] = [
    { value: KeyboardPitchStickMode.LAYOUT_DEFAULT, label: 'Layout default' },
    { value: KeyboardPitchStickMode.HOLD, label: 'Hold: full while pressed' },
];

export const RENDER_SCALE_OPTIONS: Option<number>[] = RENDER_SCALES.map(scale => ({
    value: scale,
    label: scale >= 1 ? '100% (off)' : `${Math.round(scale * 100)}%`,
}));

/**
 * The text of the dialog, by section: headings, the explanation under each,
 * and the labels of its controls. The template reads it from here, so the
 * Unity port's fixtures see exactly what the dialog shows.
 */
export const SETTINGS_TEXT = {
    title: 'Settings',
    sectionPicker: 'Section',
    close: 'Close',
    aircraft: { title: 'Aircraft' },
    livery: { label: 'Livery' },
    search: {
        label: 'Find an airfield or place',
        placeholder: 'ICAO, name, town, or lat, lon',
        hint: 'Airfields match as you type; Enter also looks up places.',
        button: 'Search',
        airfieldsGroup: 'Airfields',
        placesGroup: 'Places',
        idle: 'Press Enter to look up places',
        searching: 'Searching…',
        none: 'No places found',
        error: 'Place search failed, check the connection',
    },
    airfield: { label: 'Airfield' },
    start: { title: 'Start' },
    renderScale: {
        title: 'Render scale',
        help: 'Draws the 3D view at this fraction of the screen and stretches it to full size; the HUD and '
            + 'cockpit displays stay sharp on top. Lower it if the frame rate is short on a large screen. 100% '
            + 'is off and draws at native size, supersampled for anti-aliasing where the resolution affords it '
            + 'unless that is switched off here.',
        select: '3D resolution',
        supersampling: 'Supersampling (SSAA) at 100%',
    },
    terrainDetail: {
        title: 'Terrain detail distance',
        help: 'How far out terrain keeps full detail. Past it the far field is drawn coarser, which is where '
            + 'most of the triangles above the horizon go — lower this if the frame rate is short. The ground '
            + 'you are flying over is never affected. Rightmost is off.',
    },
    landuseReach: {
        title: 'Land-use detail reach',
        help: 'Only the finest terrain tiles carry the exact field, wood and town outlines. This brings those '
            + 'tiles in that many times further out than the terrain detail alone would, at the cost of more '
            + 'triangles around the aircraft. 1x is no bias.',
    },
    visibleZoom: {
        title: 'Finest terrain level',
        help: 'The deepest zoom level of terrain tiles drawn. Each level down halves the tile resolution and '
            + 'drops the land-use outlines the finer tiles carry, for fewer triangles and fewer tile fetches. '
            + '12 is full detail.',
    },
    landuseReveal: {
        title: 'Land-use region size',
        help: 'How large a field, wood or town has to be on screen before it is drawn, in pixels across. Big '
            + 'regions show from far away and small ones fill in as you close; lower brings the small ones in '
            + 'from further out, higher keeps the distance cleaner.',
    },
    triangleBudget: {
        title: 'Terrain triangle cap',
        help: 'Ceiling on terrain triangles drawn per frame. When the view asks for more, the farthest tiles '
            + 'are folded into coarser ones until it fits, so a low cap shows as a coarser far field rather '
            + 'than coarser ground nearby. Raise it if the distance looks blocky; lower it if the frame rate '
            + 'is short.',
    },
    farTileTextures: {
        title: 'Far tile textures',
        help: 'Distant ground is drawn as large facets, one colour each. With this on, those facets are '
            + 'painted with an image of the fields, woods and towns the detailed tiles hold, so the far view '
            + 'keeps its detail instead of switching it on as you close. Off shows the plain facets.',
        toggle: 'Paint far tiles from the detailed ground',
    },
    buildings: {
        title: 'Buildings',
        help: 'Houses and other buildings from OpenStreetMap, with their roofs, where the terrain was baked '
            + 'with them. Far off only the larger ones are drawn, and a busy view thins them out to hold the '
            + 'frame rate. Where roofs were measured in aerial photos they show their real colour with the '
            + 'Imagery and Hybrid terrain colours.',
        note: 'Data sources and licences: see the About tab.',
        toggle: 'Draw buildings',
    },
    roads: {
        title: 'Roads',
        help: 'Roads are drawn as lines over the ground where the terrain was baked with them. Major keeps '
            + 'motorways and main roads, the ones you can see from altitude, and drops the streets, which are '
            + 'most of the cost over a city.',
    },
    terrainColour: {
        title: 'Terrain colour',
        help: 'Every facet is baked with both a landcover class and a satellite colour; this picks which one '
            + 'paints it.',
    },
    landuseBlend: {
        title: 'Land-use colour',
        help: 'In Hybrid colour, how much of a field, wood or town is its land type\'s colour, and how much '
            + 'the terrain colour sampled from imagery.',
        minLabel: 'Sampled',
        maxLabel: 'Land type',
    },
    treeDensity: {
        title: 'Tree density',
        help: 'How many trees are placed in each wood, as a multiplier on the default spacing - 0 turns trees '
            + 'off. Re-grows forest already loaded, so it takes a moment to catch up over a large area.',
        minLabel: '0x',
        maxLabel: '20x',
    },
    terrainShading: {
        title: 'Terrain shading',
        help: 'Flat colour per facet, or smoothly blended across neighbouring facets.',
    },
    colours: {
        help: 'Hue, saturation and brightness of the trees and shrubs, the ground, water and the sky, on top '
            + 'of whichever terrain colour is picked. 0° and 100% are the look as drawn; 0% saturation is '
            + 'grey, and hue turns every colour round the colour wheel by that many degrees.',
        reset: 'Reset colours',
    },
    area: {
        title: 'Area',
        help: 'Where in the world to fly. Areas other than the home one are terrain only — no airbase, no '
            + 'carrier — so you start airborne over the middle of them. Changing this reloads the sim.',
        select: 'Area',
        button: 'Fly here',
    },
    importTerrain: {
        title: 'Import terrain',
        help: 'Bake a new area into the terrain, or delete one. Runs on the dev server and carries on if this '
            + 'dialog is closed.',
    },
    singleArea: 'Only one terrain area is baked, so there is nothing to choose between.',
    daytime: {
        title: 'Time of day',
        help: 'Local solar time. Moves the sun, so sky, terrain and aircraft silhouettes follow it. Sunrise '
            + '06:00, sunset 18:00. N flips between afternoon and midnight.',
    },
    flightModel: { title: 'Flight model' },
    aiPilotModel: { title: 'AI pilot model', help: 'Applies on the next merge / opponent spawn.' },
    volume: { title: 'Volume' },
    units: { title: 'Units' },
    keyboardLayout: { title: 'Keyboard layout' },
    pitchStick: { title: 'Pitch stick' },
    help: {
        keyboard: 'Keyboard',
        joystick: 'Joystick',
        noJoystick: 'No device detected',
        systems: 'Systems',
        spawnMenu: 'Spawn menu',
        spawnMenuNote: 'Aircraft list: pick from the combobox in the spawn menu.',
        views: 'Views',
    },
    about: {
        title: 'Data sources',
        help: 'The world is built from open data. Each source is clipped, resampled, measured and combined '
            + 'with the others when the terrain is baked, so none of it appears as published, and no '
            + 'publisher endorses this game.',
    },
} as const;

/**
 * The terrain detail slider is in kilometres and the setting is in metres,
 * because kilometres are what the label has to read and metres are what every
 * distance in the LOD is already in. The top step is off —
 * `DETAIL_DISTANCE_OFF` — rather than a very large number, so "off" is exact
 * instead of merely far.
 */
export const DETAIL_OFF_KM = TERRAIN_DETAIL_DISTANCE_MAX_M / 1000;

/** Every slider of the dialog: its range in slider units (what the thumb moves through). */
export const SLIDERS = {
    terrainDetailKm: { min: TERRAIN_DETAIL_DISTANCE_MIN_M / 1000, max: DETAIL_OFF_KM + 2, step: 2 },
    landuseReach: { min: LEAF_REFINE_DISTANCE_SCALE_MIN, max: LEAF_REFINE_DISTANCE_SCALE_MAX, step: 0.5 },
    visibleZoom: { min: TERRAIN_VISIBLE_ZOOM_MIN, max: TERRAIN_VISIBLE_ZOOM_MAX, step: 1 },
    landuseRevealPx: { min: LANDUSE_REVEAL_MIN_PX_MIN, max: LANDUSE_REVEAL_MIN_PX_MAX, step: 1 },
    triangleBudgetK: { min: TERRAIN_TRIANGLE_BUDGET_MIN / 1000, max: TERRAIN_TRIANGLE_BUDGET_MAX / 1000, step: 100 },
    landuseBlendPercent: { min: 0, max: 100, step: 5 },
    treeDensity: { min: 0, max: 20, step: 1 },
    daytimeHours: { min: 0, max: 23.75, step: 0.25 },
    volumePercent: { min: 0, max: 100, step: 1 },
} as const;

/** Where the terrain detail slider sits for a distance (metres, or off). */
export function terrainDetailKm(distanceM: number): number {
    return Number.isFinite(distanceM) ? distanceM / 1000 : SLIDERS.terrainDetailKm.max;
}

export function terrainDetailLabel(distanceM: number): string {
    return Number.isFinite(distanceM) ? `${Math.round(distanceM / 1000)} km` : 'Off';
}

/** The setting a terrain detail slider position asks for: past the last step is off. */
export function terrainDetailFromKm(km: number): number {
    return km > DETAIL_OFF_KM ? DETAIL_DISTANCE_OFF : km * 1000;
}

export function landuseReachLabel(scale: number): string {
    return `${scale.toFixed(2)}x`;
}

export function visibleZoomLabel(zoom: number): string {
    return `z${zoom}`;
}

export function landuseRevealLabel(px: number): string {
    return `${px} px`;
}

export function triangleBudgetLabel(n: number): string {
    return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

export function percentLabel(percent: number): string {
    return `${percent}%`;
}

export function multiplierLabel(multiplier: number): string {
    return `${multiplier}x`;
}

export function daytimeLabel(hours: number): string {
    return formatSunTime(hours);
}

/** A colour slider's position: the stored value in the channel's display units, rounded. */
export function colourSliderValue(adjust: ColourAdjust, group: ColourAdjustGroup, channel: ColourChannelOption): number {
    return Math.round(adjust[group][channel.key] * channel.scale);
}

export function colourSliderLabel(adjust: ColourAdjust, group: ColourAdjustGroup, channel: ColourChannelOption): string {
    return `${colourSliderValue(adjust, group, channel)}${channel.unit}`;
}

/**
 * The area picker of the World tab: every baked area, the home one marked,
 * and which one is selected - the saved one if it is still baked, otherwise
 * home, otherwise the first.
 */
export function areaOptions(
    areas: readonly TerrainArea[], home: Geodetic, saved: string,
): { options: Option<string>[]; selected: string } {
    const homeAt = homeArea(areas, home);
    const selected = areas.some(a => a.name === saved)
        ? saved
        : (homeAt?.name ?? areas[0]?.name ?? '');
    return {
        selected,
        options: areas.map(area => ({
            value: area.name,
            label: homeAt !== undefined && area.name === homeAt.name ? `${area.name} (home)` : area.name,
        })),
    };
}

/** The devices the dialog's General tab drives besides the config. */
export interface SettingsDevices {
    setMasterVolume(volume: number): void;
    setKeyboardLayout(layout: KeyboardControlLayoutId): void;
    setKeyboardPitchStickMode(mode: KeyboardPitchStickMode): void;
}

/**
 * What each control of the dialog does when moved: the setting it changes,
 * how the slider position becomes that setting's value, and what is saved.
 * Slider arguments are the raw thumb value. Not every change is saved here:
 * the time of day and the terrain detail distance are saved by
 * {@link persistSettingChanges}, and the unit system is never saved.
 */
export class SettingsActions {
    constructor(
        private readonly config: ConfigService,
        private readonly devices: SettingsDevices,
        private readonly save: (partial: Partial<AppSettings>) => void = partial => { updateSettings(partial); },
    ) { }

    setTerrainDetail(km: number) {
        this.config.terrainDetail.setActive(terrainDetailFromKm(km));
    }

    setTerrainColour(mode: TerrainColours) {
        this.config.terrainColour.setActive(mode);
        this.save({ terrainColour: mode });
    }

    setTerrainShading(mode: TerrainShading) {
        this.config.terrainShading.setActive(mode);
        this.save({ terrainShading: mode });
    }

    setLanduseReach(value: number) {
        this.config.landuseReach.setActive(value);
        this.save({ landuseReach: this.config.landuseReach.getActive() });
    }

    setVisibleZoom(value: number) {
        this.config.visibleZoom.setActive(value);
        this.save({ visibleZoom: this.config.visibleZoom.getActive() });
    }

    setLanduseReveal(value: number) {
        this.config.landuseReveal.setActive(value);
        this.save({ landuseRevealPx: this.config.landuseReveal.getActive() });
    }

    setFarTileTextures(enabled: boolean) {
        this.config.farTileTextures.setActive(enabled);
        this.save({ farTileTextures: enabled });
    }

    setBuildings(enabled: boolean) {
        this.config.buildings.setActive(enabled);
        this.save({ buildings: enabled });
    }

    setRoads(mode: RoadsMode) {
        this.config.roads.setActive(mode);
        this.save({ roads: mode });
    }

    setRenderScale(scale: number) {
        this.config.renderScale.setActive(scale);
        this.save({ renderScale: scale });
    }

    setSupersampling(enabled: boolean) {
        this.config.supersampling.setActive(enabled);
        this.save({ supersampling: enabled });
    }

    /** `thousands` is the slider's K. */
    setTriangleBudget(thousands: number) {
        this.config.triangleBudget.setActive(thousands * 1000);
        this.save({ terrainTriangleBudget: this.config.triangleBudget.getActive() });
    }

    /** Returns the percent the slider shows. */
    setLanduseBlend(value: number): number {
        const percent = Math.round(value);
        this.config.landuseBlend.setActive(percent / 100);
        this.save({ landuseBlend: percent / 100 });
        return percent;
    }

    /** Returns the multiplier the slider shows. */
    setTreeDensity(value: number): number {
        const multiplier = Math.round(value);
        this.config.treeDensity.setActive(multiplier);
        this.save({ treeDensity: multiplier });
        return multiplier;
    }

    /** `current` is the adjust the sliders were showing. */
    setColourTweak(current: ColourAdjust, group: ColourAdjustGroup, channel: ColourChannelOption, value: number) {
        const scaled = Math.round(value) / channel.scale;
        this.config.colourAdjust.setTweak(group, { ...current[group], [channel.key]: scaled });
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
        this.save({ colourAdjust: this.config.colourAdjust.getActive() });
    }

    setDaytime(hours: number) {
        this.config.daytime.setActive(hours);
    }

    setFlightModel(id: string) {
        this.config.flightModels.setActive(id);
        this.save({ flightModel: id });
    }

    setAiPilotModel(model: AiPilotModels) {
        this.config.aiPilotModels.setActive(model);
        this.save({ aiPilotModel: model });
    }

    setUnitSystem(system: UnitSystems) {
        this.config.unitSystem.setActive(system);
    }

    /** Returns the percent the slider shows. */
    setVolume(value: number): number {
        const percent = Math.round(value);
        this.devices.setMasterVolume(percent / 100);
        this.save({ volume: percent / 100 });
        return percent;
    }

    setKeyboardLayout(layout: KeyboardControlLayoutId) {
        this.devices.setKeyboardLayout(layout);
        this.save({ keyboardLayout: layout });
    }

    setPitchStickMode(mode: KeyboardPitchStickMode) {
        this.devices.setKeyboardPitchStickMode(mode);
        this.save({ keyboardPitchStickMode: mode });
    }
}

/**
 * Time of day and terrain detail can change from outside the settings dialog
 * — the in-game `N` day/night key writes the time of day — so they are saved
 * from the setting's change listener, whichever end drove the change, and for
 * the whole session rather than only while the dialog is open.
 */
export function persistSettingChanges(
    config: ConfigService,
    save: (partial: Partial<AppSettings>) => void = partial => { updateSettings(partial); },
) {
    config.daytime.addChangeListener(hours => {
        save({ daytime: hours });
    });
    config.terrainDetail.addChangeListener(distanceM => {
        save({
            terrainDetailDistanceM: Number.isFinite(distanceM) ? distanceM : null,
        });
    });
}

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

/** "GCLP — Gran Canaria (03L/21R, 3100 m)"; a field without an ICAO code has no prefix. */
export function airfieldLabel(choice: AirfieldChoice): string {
    const id = choice.icao ? `${choice.icao} — ` : '';
    return `${id}${choice.name} (${choice.ref}, ${Math.round(choice.lengthM)} m)`;
}

/** The airfield list's labels and the index of the selected one (`icao || name`); 0 when it is not there. */
export function airfieldMenu(
    choices: readonly AirfieldChoice[], selectedKey: string | undefined,
): Pick<SpawnMenuState, 'airfields' | 'airfieldIndex'> {
    const index = choices.findIndex(c => (c.icao || c.name) === selectedKey);
    return {
        airfields: choices.map(airfieldLabel),
        airfieldIndex: index >= 0 ? index : 0,
    };
}

/** The aircraft and livery lists for a selection, both indices clamped into their lists. */
export function aircraftMenu(
    groups: readonly AircraftModelGroup[], modelIndex: number, liveryIndex: number,
): Pick<SpawnMenuState, 'aircraft' | 'aircraftIndex' | 'liveries' | 'liveryIndex'> {
    const aircraftIndex = Math.min(modelIndex, Math.max(0, groups.length - 1));
    const liveries = (groups[aircraftIndex]?.variants ?? [])
        .map(variant => variant.liveryName ?? variant.name);
    return {
        aircraft: groups.map(group => group.label),
        aircraftIndex,
        liveries,
        liveryIndex: Math.min(liveryIndex, Math.max(0, liveries.length - 1)),
    };
}

/**
 * Matches that need no network, as the player types: a coordinate pair,
 * and airfields of every baked area.
 */
export function quickSearch(
    query: string, entries: readonly AirfieldEntry[], areas: readonly TerrainArea[], currentArea: string,
): SpawnDestination[] {
    const out: SpawnDestination[] = [];
    const coords = parseCoordinates(query);
    if (coords !== undefined) {
        out.push(coordinateDestination(coords.lat, coords.lon, areas, currentArea));
    }
    for (const entry of searchAirfields(entries, query)) {
        out.push(airfieldDestination(entry, currentArea));
    }
    return out;
}
