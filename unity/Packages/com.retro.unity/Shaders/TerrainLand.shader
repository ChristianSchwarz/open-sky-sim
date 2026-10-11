// Baked terrain land for URP.
//
// Vertex streams are the PTM wire formats: POSITION SNorm16x4 (xyz, pad; the
// object matrix carries quantScale * 32767 and the z mirror into Unity axes),
// NORMAL SNorm8x4 (xyz, pad), COLOR UNorm8x4 (sRGB rgb, TerrainClass / 255).
// Colour from the four modes of terrainCover.ts (TerrainCover.hlsl); faceted
// light from the URP main light (N.L^2.2) plus SH ambient and URP fog; the
// leaf dissolve of terrainVP/FP.ts (TerrainLod.hlsl) in both passes.
Shader "Retro/TerrainLand"
{
    Properties
    {
        _Brightness ("Brightness", Range(0, 2)) = 1
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry" }

        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

        CBUFFER_START(UnityPerMaterial)
            half _Brightness;
        CBUFFER_END

        #include "TerrainLod.hlsl"
        ENDHLSL

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }
            // Land is drawn double-sided, as in the web game: skirts and walls face both ways.
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "TerrainCover.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 normalOS : NORMAL;
                float4 color : COLOR;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                nointerpolation float3 normalWS : TEXCOORD1;
                nointerpolation half3 albedo : TEXCOORD2;
                half fog : TEXCOORD3;
                // x: reveal (1 = opaque), y: camera height over the facet plane, z: height over camera.
                float3 lod : TEXCOORD4;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                // World space is camera-relative (the camera sits at the origin).
                float3 positionWS = TransformObjectToWorld(v.positionOS.xyz);
                float3 normalWS = TransformObjectToWorldNormal(v.normalOS.xyz);
                o.lod = RetroLodVertex(positionWS, normalWS);
                positionWS = RetroDepthPush(positionWS);
                o.positionWS = positionWS;
                o.positionCS = TransformWorldToHClip(positionWS);
                o.normalWS = normalWS;
                // The colour mode decides per vertex (constant over a facet); land-use
                // size reveal is not wired yet, so every region shows fully.
                o.albedo = RetroFacetColor(v.color.rgb, v.color.a * 255.0, 1.0);
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                RetroLodClip(i.lod, i.positionCS.xy);
                float3 n = normalize(i.normalWS);
                Light sun = GetMainLight(TransformWorldToShadowCoord(i.positionWS));
                // terrainVP.ts: N.L raised to SHADOW_CONTRAST_POWER (2.2) so slope relief reads
                // from shading alone; the URP light and ambient carry the 45/55 split (SunModel).
                half ndl = pow(saturate(dot(n, sun.direction)), 2.2) * sun.shadowAttenuation;
                half3 ambient = SampleSH(n);
                half3 c = i.albedo * _Brightness * (sun.color * ndl + ambient);
                c = MixFog(c, i.fog);
                return half4(c, 1);
            }
            ENDHLSL
        }

        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode" = "DepthOnly" }
            ZWrite On
            ColorMask R
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 normalOS : NORMAL;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 lod : TEXCOORD0;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                float3 positionWS = TransformObjectToWorld(v.positionOS.xyz);
                o.lod = RetroLodVertex(positionWS, TransformObjectToWorldNormal(v.normalOS.xyz));
                o.positionCS = TransformWorldToHClip(RetroDepthPush(positionWS));
                return o;
            }

            half frag(Varyings i) : SV_Target
            {
                RetroLodClip(i.lod, i.positionCS.xy);
                return 0;
            }
            ENDHLSL
        }
    }
}
