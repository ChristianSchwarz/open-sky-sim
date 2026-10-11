// The sun's glare (sunModelBuilder.ts glare program): an alpha-blended fan
// painted from the dome's sky colours, overbright toward the disc and white
// at its limb, fading out to its rim. Drawn after the scene, pinned to the far
// plane with LEqual, so it only lands on open sky - never veiling a ridge, as
// the web game's depth test against the far plane did.
Shader "Retro/SunGlare"
{
    Properties
    {
        _Overbright ("Overbright", Float) = 2.6
    }
    SubShader
    {
        Tags { "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent+100" }

        Pass
        {
            Name "Glare"
            Tags { "LightMode" = "UniversalForward" }
            Cull Off
            ZWrite Off
            ZTest LEqual
            Blend SrcAlpha OneMinusSrcAlpha

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                half _Overbright;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 color : COLOR;     // linear sky colour per vertex
                float2 uv : TEXCOORD0;    // x: falloff (1 at the limb, 0 at the rim)
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half3 color : TEXCOORD0;
                half falloff : TEXCOORD1;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                float4 cs = TransformWorldToHClip(TransformObjectToWorld(v.positionOS.xyz));
            #if UNITY_REVERSED_Z
                cs.z = cs.w * 1e-6;
            #else
                cs.z = cs.w * (1 - 1e-6);
            #endif
                o.positionCS = cs;
                o.color = v.color.rgb;
                o.falloff = v.uv.x;
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half3 c = saturate(i.color * lerp(1, _Overbright, i.falloff));
                c = lerp(c, 1, smoothstep(0.8, 1.0, i.falloff));
                return half4(c, i.falloff);
            }
            ENDHLSL
        }
    }
}
