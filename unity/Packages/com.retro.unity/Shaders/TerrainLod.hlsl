// The leaf dissolve (terrainVP.ts lodReveal, terrainFP.ts discard, logDepth
// uDepthPush) on URP. Per-draw values come from a MaterialPropertyBlock, so
// they live outside UnityPerMaterial.
//
// A new leaf fades in over its parent by a screen-space Bayer dither, in a
// band around the distance the parent refined at (_LodFadeM) and capped by a
// 600 ms time ramp (_LodFadeCap). The parent keeps drawing underneath, pushed
// back along each view ray by _DepthPush metres so leaf pixels win the depth
// test wherever they are present; the web game did this with a log-depth
// offset, camera-relative world space makes it a move along the ray.
#ifndef RETRO_TERRAIN_LOD_INCLUDED
#define RETRO_TERRAIN_LOD_INCLUDED

// lod.ts LOD_FADE_NEAR / LOD_FADE_SOFTNESS.
#define RETRO_LOD_FADE_NEAR 0.55
#define RETRO_LOD_FADE_SOFTNESS 0.08

float _LodFadeM;     // 0 = no dissolve
float _LodFadeCap;   // time ramp, 0..1
float _DepthPush;    // metres; > 0 only for an under-parent
float _LodUnder;     // 1 for an under-parent

// lodReveal: 0 still the parent, 1 this tile.
float RetroLodReveal(float d)
{
    if (_LodFadeM <= 0.0) return 1.0;
    float far = 1.0 - RETRO_LOD_FADE_SOFTNESS;
    float t = _LodFadeM * lerp(RETRO_LOD_FADE_NEAR, far, 0.5);
    float soft = t * RETRO_LOD_FADE_SOFTNESS;
    float byDistance = 1.0 - smoothstep(t - soft, t + soft, d);
    return min(byDistance, _LodFadeCap);
}

// Per vertex: reveal, camera height over the facet plane (under-parents only), height over the camera.
float3 RetroLodVertex(float3 positionWS, float3 normalWS)
{
    float d = length(positionWS);
    float cameraAbove = _LodUnder > 0.5 ? dot(normalize(normalWS), -positionWS) : 1.0;
    return float3(RetroLodReveal(d), cameraAbove, positionWS.y);
}

// Under-parent: the same pixel, farther along its view ray.
float3 RetroDepthPush(float3 positionWS)
{
    if (_DepthPush <= 0.0) return positionWS;
    float d = max(length(positionWS), 1e-3);
    return positionWS * ((d + _DepthPush) / d);
}

// dither.ts bayerThreshold: the 4x4 index matrix / 16 - 0.5.
float RetroBayerThreshold(float2 screen)
{
    uint2 m = (uint2)floor(fmod(screen, 4.0));
    static const float bayer[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };
    return bayer[m.y * 4 + m.x] / 16.0 - 0.5;
}

void RetroLodClip(float3 lod, float2 pixel)
{
    // <= so that 0 drops every fragment (the threshold bottoms out at 0 in one cell of sixteen).
    if (lod.x < 1.0 && lod.x <= RetroBayerThreshold(pixel) + 0.5) discard;
    // An under-parent seen from below: only its top may stand in for the leaves.
    if (lod.y < 0.0 && lod.z > 0.0) discard;
}

#endif
