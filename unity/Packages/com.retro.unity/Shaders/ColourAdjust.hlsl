// The player's hue, saturation and brightness per kind of scenery (colourAdjust.ts
// COLOUR_ADJUST_PARS): hue turns the colour about the grey axis, saturation pulls
// toward or pushes away from its own grey, brightness scales it. Linear colour in
// and out. The globals hold each tweak as (saturation - 1, brightness - 1, hue in
// radians), so a shader drawn before the settings arrive (all zero) is unchanged.
#ifndef RETRO_COLOUR_ADJUST
#define RETRO_COLOUR_ADJUST

float4 _AdjTrees;
float4 _AdjTerrain;
float4 _AdjSky;

float3 RetroAdjustColour(float3 c, float4 tweak)
{
    float cosH = cos(tweak.z);
    float sinH = sin(tweak.z);
    float3 turned = c * cosH
        + float3(c.b - c.g, c.r - c.b, c.g - c.r) * (0.5773502691896258 * sinH)
        + ((c.r + c.g + c.b) / 3.0 * (1.0 - cosH)).xxx;
    float l = dot(turned, float3(0.2126, 0.7152, 0.0722));
    return max(lerp(l.xxx, turned, tweak.x + 1.0), 0.0) * (tweak.y + 1.0);
}

#endif
