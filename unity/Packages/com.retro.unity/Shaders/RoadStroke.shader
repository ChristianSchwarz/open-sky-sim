// Road and railway strokes (riverVP.ts riverVert/RailVert, depthFP.ts flat and
// RAIL_FRAGMENT). The .ptr streams go up as they are: two vertices per
// centreline point at the same position, each with a unit offset across the
// road and its half width. The vertex shader widens in view space and
// projects once, holding every stroke at least _MinHalfPixels half-pixels
// wide (up to _MaxStretch times its real width).
//
// With _RAIL the stroke is a railway: pass 0 is the ballast bed (switch zones
// and level crossings cut out), pass 1 the sleepers and pass 2 the rails,
// both analytic and box-filtered by the pixel footprint, fading in only where
// a pixel is under RAIL_DETAIL_FADE_M of ground.
//
// Streams: POSITION SNorm16x4 (xyz, pad; the object matrix carries the
// quantisation scale and the z mirror), TEXCOORD0 SNorm8x4 (offset xyz, class
// byte / 127), TEXCOORD1 UNorm16x2 (half width dm, along 0.05 m) / 65535,
// TEXCOORD2 UNorm8x4 (flags, 0, 0, 0) / 255.
Shader "Retro/RoadStroke"
{
    Properties
    {
        _Color ("Color", Color) = (0.33, 0.33, 0.33, 1)
        _MinHalfPixels ("Min half width (px)", Float) = 0.9
        _MaxStretch ("Max stretch", Float) = 8
        _RailPass ("Rail pass (0 bed, 1 sleepers, 2 rails)", Float) = 0
        [Toggle(_RAIL)] _Rail ("Railway", Float) = 0
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src blend", Float) = 1
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst blend", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry+1" }

        Pass
        {
            Name "ForwardUnlit"
            Tags { "LightMode" = "UniversalForward" }
            // Strokes lie on the land: no depth write, both faces (depthFP.ts flat strokes).
            Cull Off
            ZWrite Off
            Blend [_SrcBlend] [_DstBlend]
            // The web game draws them over coplanar land by order alone; a hair of
            // offset keeps the depth test from flickering where they meet.
            Offset -1, -1

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #pragma shader_feature_local _RAIL
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            // roadStrokes.ts / ptr.ts constants.
            #define ALONG_STEP_M 0.05
            #define RAIL_DETAIL_FADE_START 0.8
            #define RAIL_DETAIL_FADE_END 2.4
            #define RAIL_TRACK_PITCH_M 5.0
            #define LONG_TIMBER_EXTRA_M 2.9
            #define LONG_TIMBER_STEP_M 1.5
            #define SLEEPER_HALF_LENGTH_M 1.3
            #define SLEEPER_PITCH_M 0.64
            #define SLEEPER_HALF_WIDTH_M 0.13
            #define RAIL_HEAD_HALF_M 0.0375
            #define RAIL_HEAD_OFFSET_M 0.7175
            #define RAIL_MIN_STRENGTH 0.45

            CBUFFER_START(UnityPerMaterial)
                half4 _Color;
                float _MinHalfPixels;
                float _MaxStretch;
                float _RailPass;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 dir : TEXCOORD0;
                float2 halfAlong : TEXCOORD1;
                float4 flags : TEXCOORD2;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half fog : TEXCOORD0;
            #if defined(_RAIL)
                float3 rail : TEXCOORD1;  // across (m, signed by bank), along (m), half width (m)
                float4 track : TEXCOORD2; // no sleepers, long +, long -, level crossing
                float reach : TEXCOORD3;
            #endif
            };

            Varyings vert(Attributes v)
            {
                Varyings o = (Varyings)0;
                float3 positionWS = TransformObjectToWorld(v.positionOS.xyz);
                float3 centreView = TransformWorldToView(positionWS);
                float3 offsetView = TransformWorldToViewDir(TransformObjectToWorldDir(v.dir.xyz, false), false);
                float offsetLen = length(offsetView);
                offsetView = offsetLen > 1.0e-6 ? offsetView / offsetLen : float3(1, 0, 0);

                float halfM = v.halfAlong.x * 65535.0 * 0.1; // decimetres on the wire
                float4 centreClip = TransformWViewToHClip(centreView);
                float4 edgeClip = TransformWViewToHClip(centreView + offsetView * halfM);
                float stretch = 1.0;
                if (centreClip.w > 1.0e-4 && edgeClip.w > 1.0e-4)
                {
                    float2 halfSize = floor(_ScreenParams.xy * 0.5);
                    float2 centrePx = centreClip.xy / centreClip.w * halfSize;
                    float2 edgePx = edgeClip.xy / edgeClip.w * halfSize;
                    float px = length(edgePx - centrePx);
                    if (px > 1.0e-4 && px < _MinHalfPixels) stretch = min(_MaxStretch, _MinHalfPixels / px);
                }
                o.positionCS = TransformWViewToHClip(centreView + offsetView * (halfM * stretch));
                o.fog = ComputeFogFactor(o.positionCS.z);
            #if defined(_RAIL)
                float meta = round(v.dir.w * 127.0);
                float side = meta >= 64.0 ? -1.0 : 1.0;
                o.rail = float3(side * halfM * stretch, round(v.halfAlong.y * 65535.0) * ALONG_STEP_M, halfM);
                float f = round(v.flags.x * 255.0);
                o.track = float4(fmod(f, 2), fmod(floor(f / 2), 2), fmod(floor(f / 4), 2), fmod(floor(f / 8), 2));
                o.reach = fmod(floor(f / 16), 4);
            #endif
                return o;
            }

            float BoxCoverage(float d, float h, float fp)
            {
                float overlap = min(d + fp * 0.5, h) - max(d - fp * 0.5, -h);
                return saturate(overlap / fp);
            }

            float PulseIntegral(float t, float d) { return floor(t) * d + min(frac(t), d); }

            float SleeperCoverage(float alongM, float pitch, float halfWidth, float fp)
            {
                float d = 2.0 * halfWidth / pitch;
                float t = alongM / pitch - 0.5 + 0.5 * d;
                float h = 0.5 * fp / pitch;
                return saturate((PulseIntegral(t + h, d) - PulseIntegral(t - h, d)) / (2.0 * h));
            }

            half4 frag(Varyings i) : SV_Target
            {
                half3 c = _Color.rgb;
                half alpha = 1;
            #if defined(_RAIL)
                float levelCrossing = step(0.5, i.track.w);
                if (_RailPass < 0.5)
                {
                    if (levelCrossing > 0.5) discard;
                    float bedHalf = RAIL_TRACK_PITCH_M / 2;
                    if ((i.track.y > 0.5 && i.rail.x < -bedHalf) || (i.track.z > 0.5 && i.rail.x > bedHalf)) discard;
                }
                else
                {
                    float acrossM = i.rail.x, alongM = i.rail.y, halfM = i.rail.z;
                    float fpA = max(fwidth(acrossM), 1.0e-4);
                    float fpL = max(fwidth(alongM), 1.0e-4);
                    float detail = 1.0 - smoothstep(RAIL_DETAIL_FADE_START, RAIL_DETAIL_FADE_END, max(fpA, fpL));
                    float noSleeper = max(step(0.5, i.track.x), levelCrossing);
                    float longPos = step(0.5, i.track.y);
                    float longNeg = step(0.5, i.track.z);
                    float zone = max(longPos, longNeg);
                    float width = 2.0 * halfM;
                    float tracks = zone > 0.5 ? 1.0 : max(1.0, floor(width / RAIL_TRACK_PITCH_M + 0.5));
                    float pitch = width / tracks;
                    float local = acrossM + halfM;
                    float off = local - (floor(local / pitch) + 0.5) * pitch;
                    float reach = LONG_TIMBER_EXTRA_M + LONG_TIMBER_STEP_M * floor(i.reach + 0.5);
                    float lo = -SLEEPER_HALF_LENGTH_M - reach * longNeg;
                    float hi = SLEEPER_HALF_LENGTH_M + reach * longPos;
                    float sleeper = SleeperCoverage(alongM, SLEEPER_PITCH_M, SLEEPER_HALF_WIDTH_M, fpL)
                        * BoxCoverage(off - 0.5 * (lo + hi), 0.5 * (hi - lo), fpA) * (1.0 - noSleeper);
                    float railHalf = max(RAIL_HEAD_HALF_M, 0.25 * fpA);
                    float rail = BoxCoverage(abs(abs(off) - RAIL_HEAD_OFFSET_M), railHalf, fpA)
                        * max(RAIL_HEAD_HALF_M / railHalf, RAIL_MIN_STRENGTH);
                    bool rails = _RailPass > 1.5;
                    alpha = (rails ? rail : sleeper) * detail;
                    if (alpha < 0.004) discard;
                    // Shades of the bed colour: concrete paler than the ballast, the rail head brightest.
                    c = rails ? min(c * 2.4 + 0.08, 1) : min(c * 1.6, 1);
                }
            #endif
                return half4(MixFog(c, i.fog), alpha);
            }
            ENDHLSL
        }
    }
}
