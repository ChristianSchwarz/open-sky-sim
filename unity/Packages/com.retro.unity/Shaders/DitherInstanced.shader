// Instanced, unlit, screen-dithered particles and decals (damageSmokeField.ts
// and impactMarks.ts materials on depthFP.ts): each instance carries its two
// tones and its ordered-dither opacity; a pixel is kept where level + the 4x4
// Bayer threshold reaches 0.5 (a level of 0 or less keeps every pixel), and
// kept pixels alternate the two tones on a screen checkerboard. No depth
// write, depth test on, both faces.
Shader "Retro/DitherInstanced"
{
    Properties
    {
        _ToneA ("Tone A", Color) = (1, 1, 1, 1)
        _ToneB ("Tone B", Color) = (1, 1, 1, 1)
        _Level ("Dither level", Float) = 0
        [Toggle] _ZWrite ("ZWrite", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry+40" }

        Pass
        {
            Name "Dither"
            Tags { "LightMode" = "UniversalForward" }
            Cull Off
            ZWrite [_ZWrite]

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #pragma multi_compile_instancing
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float4, _ToneA)
                UNITY_DEFINE_INSTANCED_PROP(float4, _ToneB)
                UNITY_DEFINE_INSTANCED_PROP(float, _Level)
            UNITY_INSTANCING_BUFFER_END(Props)

            struct Attributes
            {
                float4 positionOS : POSITION;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half fog : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            Varyings vert(Attributes v)
            {
                UNITY_SETUP_INSTANCE_ID(v);
                Varyings o = (Varyings)0;
                UNITY_TRANSFER_INSTANCE_ID(v, o);
                o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            float BayerThreshold(float2 screen)
            {
                const float m[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };
                int2 p = int2(fmod(floor(screen), 4.0));
                return m[p.y * 4 + p.x] / 16.0 - 0.5;
            }

            half4 frag(Varyings i) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(i);
                float level = UNITY_ACCESS_INSTANCED_PROP(Props, _Level);
                float2 screen = i.positionCS.xy;
                if (level > 0.001 && level + BayerThreshold(screen) < 0.5) discard;
                bool a = fmod(floor(screen.x + screen.y), 2.0) > 0.5;
                float3 c = a ? UNITY_ACCESS_INSTANCED_PROP(Props, _ToneA).rgb : UNITY_ACCESS_INSTANCED_PROP(Props, _ToneB).rgb;
                return half4(MixFog(c, i.fog), 1);
            }
            ENDHLSL
        }
    }
}
