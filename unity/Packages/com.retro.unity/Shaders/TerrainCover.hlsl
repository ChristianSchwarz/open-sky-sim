// The land colour decision, port of terrainCover.ts facetColor: every facet
// carries what the landcover raster said it is (a TerrainClass) and what the
// satellite said it looks like (sRGB bytes); the mode picks how to paint it.
#ifndef RETRO_TERRAIN_COVER_INCLUDED
#define RETRO_TERRAIN_COVER_INCLUDED

#define RETRO_TONE_COUNT 9
#define RETRO_CLASS_COUNT 16
#define RETRO_SWATCH_COUNT 24
#define RETRO_MODE_LANDCOVER 0
#define RETRO_MODE_SWATCH 1
#define RETRO_MODE_HYBRID 2
#define RETRO_MODE_IMAGERY 3
#define RETRO_CLASS_GROUND 13

// Arrays live outside UnityPerMaterial: ShaderLab cannot declare them as properties.
float4 _ToneColor[RETRO_TONE_COUNT];   // linear
float _ClassTone[RETRO_CLASS_COUNT];   // land tone index per class
float4 _Swatch[RETRO_SWATCH_COUNT];    // sRGB, matched in sRGB like the bake
// Floats, not ints: Unity material properties are floats, and an HLSL int
// would read the float's bits.
float _SwatchCount;
float _TerrainMode;
float _ShadeSteps;
float _ShadeRange;
float4 _ShadeWindow;                   // x: mid luminance, y: spread
float4 _RawLight;
float _LanduseBlend;

static const float3 COVER_LUMA = float3(0.2126, 0.7152, 0.0722);

// The same piecewise curve THREE.Color uses (the toe matters for dark lava and cliffs).
float3 RetroSrgbToLinear(float3 c)
{
    float3 lo = c * 0.0773993808;
    float3 hi = pow(c * 0.9478672986 + 0.0521327014, 2.4);
    return lerp(hi, lo, step(c, 0.04045));
}

float3 RetroNearestSwatch(float3 c)
{
    float3 best = c;
    float bestD = 1.0e9;
    for (int i = 0; i < RETRO_SWATCH_COUNT; i++)
    {
        if (i >= (int)_SwatchCount) break;
        float3 d = _Swatch[i].rgb - c;
        float dist = dot(d, d);
        if (dist < bestD)
        {
            bestD = dist;
            best = _Swatch[i].rgb;
        }
    }
    return best;
}

#include "ColourAdjust.hlsl"

// coverColor: sRGB 0..1; coverClass: 0..15; shown: land-use reveal (1 = fully shown).
float3 RetroFacetColorAuthored(float3 coverColor, float coverClass, float shown)
{
    if (abs(_TerrainMode - RETRO_MODE_IMAGERY) < 0.5)
    {
        return RetroSrgbToLinear(coverColor) * _RawLight.rgb;
    }
    if (abs(_TerrainMode - RETRO_MODE_SWATCH) < 0.5)
    {
        if (_SwatchCount < 0.5) return RetroSrgbToLinear(coverColor) * _RawLight.rgb;
        return RetroSrgbToLinear(RetroNearestSwatch(coverColor)) * _RawLight.rgb;
    }
    // Unmapped ground: already a smoothly blended regional colour, paint it as it is.
    if (abs(coverClass - RETRO_CLASS_GROUND) < 0.5)
    {
        return RetroSrgbToLinear(coverColor) * _RawLight.rgb;
    }
    int cls = clamp((int)round(coverClass), 0, RETRO_CLASS_COUNT - 1);
    int toneIndex = clamp((int)round(_ClassTone[cls]), 0, RETRO_TONE_COUNT - 1);
    float3 tone = _ToneColor[toneIndex].rgb;
    if (abs(_TerrainMode - RETRO_MODE_HYBRID) < 0.5)
    {
        // Palette hue, imagery lightness in bands, against this bake's average (in sRGB).
        float lum = dot(coverColor, COVER_LUMA);
        float d = clamp((lum - _ShadeWindow.x) / max(_ShadeWindow.y, 0.001), -1.0, 1.0);
        float band = floor(d * _ShadeSteps + 0.5) / max(_ShadeSteps, 1.0);
        float3 toned = tone * (1.0 + band * _ShadeRange);
        return lerp(RetroSrgbToLinear(coverColor) * _RawLight.rgb, toned, _LanduseBlend * shown);
    }
    return lerp(RetroSrgbToLinear(coverColor) * _RawLight.rgb, tone, shown);
}

// The colour every mode picked, leaned on by the player's sliders (terrainCover.ts facetColor).
float3 RetroFacetColor(float3 coverColor, float coverClass, float shown)
{
    return RetroAdjustColour(RetroFacetColorAuthored(coverColor, coverClass, shown), _AdjTerrain);
}

#endif
