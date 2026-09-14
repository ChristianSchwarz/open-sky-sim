import { TerrainColourMode } from '../terrain/tones';

export enum TechProfiles {
    VGA = 'VGA',
    SVGA = 'SVGA',
    HD = 'HD',
}

/**
 * Every aircraft flies the single FM2 rigid-body "parts" model; handling
 * differences (fly-by-wire vs mechanical, etc.) are expressed purely as
 * per-aircraft config. FM2 is the full 6-DOF aerodynamic model; DEBUG selects the
 * same model's no-aerodynamics "free-fly" mode (stick rotates the airframe
 * directly) for inspecting scenery and models.
 */
export enum FlightModels {
    FM2 = 'FM2',
    DEBUG = 'DEBUG',
}

export enum UnitSystems {
    METRIC = 'METRIC',
    IMPERIAL = 'IMPERIAL',
}

/**
 * Selectable in-worker AI pilot models. CLASSIC is the existing BFM AiPilot;
 * SHAW is the Robert L. Shaw Fighter Combat tactical FSM + FCC; AGGRESSIVE is
 * a "Berserker" doctrine that never disengages/breaks defensively, always
 * pressing the attack; ACE is an elite dogfighter that fights in the vertical,
 * manages energy deliberately and flies post-stall maneuvers (Cobra, Kulbit).
 * Applied on the next opponent spawn/enable (not mid-dogfight).
 *
 * Note this is the AI *model* — orthogonal to `AiSkillLevel.ACE`, which is the
 * difficulty tier the classic pilot's reaction/discipline tuning reads.
 */
export enum AiPilotModels {
    CLASSIC = 'CLASSIC',
    SHAW = 'SHAW',
    AGGRESSIVE = 'AGGRESSIVE',
    ACE = 'ACE',
}

/**
 * How a terrain facet turns its two baked observations - the landcover class
 * and the satellite colour - into a colour on screen.
 *
 * The setting; the numbering the shader branches on is TerrainColourMode in
 * terrain/tones, which both this and the vertex program read.
 */
export enum TerrainColours {
    /** Landcover class picks a palette tone. The most retro of the four. */
    LANDCOVER = 'LANDCOVER',
    /** Satellite colour, snapped to the small colour table the bake derived. */
    SWATCH = 'SWATCH',
    /** Palette tone for the hue, satellite luminance for a banded shade. */
    HYBRID = 'HYBRID',
    /** The satellite colour itself. */
    IMAGERY = 'IMAGERY',
}

/** uTerrainMode value per setting. */
export const TERRAIN_COLOUR_MODE_INDEX: Readonly<Record<TerrainColours, TerrainColourMode>> = {
    [TerrainColours.LANDCOVER]: TerrainColourMode.Landcover,
    [TerrainColours.SWATCH]: TerrainColourMode.Swatch,
    [TerrainColours.HYBRID]: TerrainColourMode.Hybrid,
    [TerrainColours.IMAGERY]: TerrainColourMode.Imagery,
};

/**
 * How land geometry hands facet colour to the rasteriser. FACETED keeps the
 * baked per-triangle replication, so every facet is one flat colour and edges
 * between facets are hard. SMOOTH welds a tile's vertices and averages the
 * cover colour (and normal) each one carries, so the same shader that resolves
 * facetColor() per vertex instead interpolates it across a triangle.
 */
export enum TerrainShading {
    FACETED = 'FACETED',
    SMOOTH = 'SMOOTH',
}

export enum HUDFocusMode {
    DISABLED,
    PARTIAL,
    FULL,
    _LENGTH
}
