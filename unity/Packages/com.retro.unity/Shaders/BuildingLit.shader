// OSM buildings (shadedVP.ts with VERTEX_TONES, HD path): flat-shaded soup with
// a colour per vertex (the palette tone, or the measured roof colour), lit per
// vertex as the web game lights them - sky-weighted ambient, N.L sun - with
// URP's main light and SH standing in for its sun uniforms, and URP fog.
// Streams: POSITION Float32x3 (metres, tile-local; the object matrix carries
// the frame fix and the z mirror), NORMAL SNorm8x4, COLOR UNorm8x4 (sRGB).
Shader "Retro/BuildingLit"
{
    Properties
    {
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry" }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }
            // Front faces are counter-clockwise in the right-handed tile axes; the
            // z mirror in the object matrix makes them back faces to Unity.
            Cull Front

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 normalOS : NORMAL;
                float4 color : COLOR;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half3 color : TEXCOORD0;
                half fog : TEXCOORD1;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
                float3 n = TransformObjectToWorldNormal(v.normalOS.xyz);
                Light sun = GetMainLight();
                half rawNdl = saturate(dot(n, sun.direction));
                // shadedVP.ts: the sky lights an upward face fully and a wall at 65 %.
                half skyView = lerp(0.65, 1.0, 0.5 + 0.5 * n.y);
                half ambientScale = lerp(0.95, 1.0, rawNdl);
                half3 light = SampleSH(n) * skyView * ambientScale + sun.color * rawNdl;
                o.color = SRGBToLinear(v.color.rgb) * light;
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                return half4(MixFog(i.color, i.fog), 1);
            }
            ENDHLSL
        }

        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode" = "DepthOnly" }
            ZWrite On
            ColorMask R
            Cull Front

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            float4 vert(float4 positionOS : POSITION) : SV_POSITION
            {
                return TransformObjectToHClip(positionOS.xyz);
            }

            half frag() : SV_Target
            {
                return 0;
            }
            ENDHLSL
        }
    }
}
