// Road and railway-bed strokes (riverVP.ts riverVert, depthFP.ts flat). The
// .ptr streams go up as they are: two vertices per centreline point at the
// same position, each with a unit offset across the road and its half width.
// The vertex shader widens in view space and projects once, holding every
// stroke at least _MinHalfPixels half-pixels wide (up to _MaxStretch times
// its real width) so a lane stays a line however far away it is.
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
            // The web game draws them over coplanar land by order alone; a hair of
            // offset keeps the depth test from flickering where they meet.
            Offset -1, -1

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                half4 _Color;
                float _MinHalfPixels;
                float _MaxStretch;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 dir : TEXCOORD0;
                float2 halfAlong : TEXCOORD1;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half fog : TEXCOORD0;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
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
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                return half4(MixFog(_Color.rgb, i.fog), 1);
            }
            ENDHLSL
        }
    }
}
