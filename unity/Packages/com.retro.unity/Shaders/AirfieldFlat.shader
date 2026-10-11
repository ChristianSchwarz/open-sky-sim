// Unlit ground paint for airfields (depthFP.ts, flat MESH materials): a palette
// tone times overbright, URP fog, no depth write - the paint is lifted
// AIRFIELD_SURFACE_EPS_M over the terrain and drawn in list order by render
// queue. Runway pavement can carry its paint as a two-channel coverage mask
// that fades in with the pixel footprint; paint drawn as geometry discards
// once a pixel is wider than _MaxFootprint metres of ground.
Shader "Retro/AirfieldFlat"
{
    Properties
    {
        _Color ("Color", Color) = (0.36, 0.36, 0.36, 1)
        _Overbright ("Overbright", Float) = 1
        [NoScaleOffset] _MarkMap ("Marking coverage (RG)", 2D) = "black" {}
        _Markings ("Has markings", Float) = 0
        _MarkColorA ("Threshold tone", Color) = (0.82, 0.82, 0.82, 1)
        _MarkColorB ("Line tone", Color) = (0.82, 0.82, 0.82, 1)
        _MarkFade ("Mark fade (out m, in m)", Vector) = (0.15, 1.2, 0, 0)
        _MaxFootprint ("Max footprint (m, 0 = none)", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry+10" }

        Pass
        {
            Name "ForwardUnlit"
            Tags { "LightMode" = "UniversalForward" }
            // Front faces are counter-clockwise in the right-handed scene axes; the z
            // mirror in the object matrix turns them clockwise-from-behind, and
            // Graphics.RenderMesh does not flip winding for a mirrored matrix.
            Cull Front
            ZWrite Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                half4 _Color;
                half _Overbright;
                half _Markings;
                half4 _MarkColorA;
                half4 _MarkColorB;
                float4 _MarkFade;
                float _MaxFootprint;
            CBUFFER_END
            TEXTURE2D(_MarkMap);
            SAMPLER(sampler_MarkMap);

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                float2 uv : TEXCOORD1;
                half fog : TEXCOORD2;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                o.positionWS = TransformObjectToWorld(v.positionOS.xyz);
                o.positionCS = TransformWorldToHClip(o.positionWS);
                o.uv = v.uv;
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                // The larger ground axis, so a grazing view hands over first.
                float2 footprint = fwidth(i.positionWS.xz);
                float worst = max(footprint.x, footprint.y);
                if (_MaxFootprint > 0 && worst > _MaxFootprint) discard;
                half3 c = _Color.rgb;
                if (_Markings > 0.5)
                {
                    half weight = smoothstep(_MarkFade.x, _MarkFade.y, worst);
                    half2 paint = SAMPLE_TEXTURE2D(_MarkMap, sampler_MarkMap, i.uv).rg * weight;
                    c = lerp(c, _MarkColorA.rgb, paint.r);
                    c = lerp(c, _MarkColorB.rgb, paint.g);
                }
                c *= _Overbright;
                return half4(MixFog(c, i.fog), 1);
            }
            ENDHLSL
        }
    }
}
