// The sky dome and the sun disc (skyDomeModelBuilder.ts, sunModelBuilder.ts):
// unlit vertex colours painted on the CPU from the sky model (linear), or a
// flat HDR colour for the disc (SKY_SUN times its overbright, which bloom
// turns into the glow the web game got from clipping). Drawn first, at the
// far plane, without depth write, so everything else covers it.
Shader "Retro/SkyDome"
{
    Properties
    {
        _Color ("Tint (disc)", Color) = (1, 1, 1, 1)
        _UseVertexColor ("Use vertex colour", Float) = 1
    }
    SubShader
    {
        Tags { "RenderType" = "Background" "RenderPipeline" = "UniversalPipeline" "Queue" = "Background" "PreviewType" = "Skybox" }

        Pass
        {
            Name "Sky"
            Tags { "LightMode" = "UniversalForward" }
            Cull Off
            ZWrite Off
            ZTest LEqual

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                half4 _Color;
                half _UseVertexColor;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 color : COLOR;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half3 color : TEXCOORD0;
            };

            Varyings vert(Attributes v)
            {
                Varyings o;
                // Camera-centred: only the view's rotation matters; then pinned to the far plane.
                float3 positionWS = TransformObjectToWorld(v.positionOS.xyz);
                float4 cs = TransformWorldToHClip(positionWS);
            #if UNITY_REVERSED_Z
                cs.z = cs.w * 1e-6;
            #else
                cs.z = cs.w * (1 - 1e-6);
            #endif
                o.positionCS = cs;
                o.color = _UseVertexColor > 0.5 ? v.color.rgb : _Color.rgb;
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                return half4(i.color, 1);
            }
            ENDHLSL
        }
    }
}
