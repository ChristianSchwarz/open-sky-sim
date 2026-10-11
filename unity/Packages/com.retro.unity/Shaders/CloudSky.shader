// Clouds (cloudModelBuilder.ts / cirrusModelBuilder.ts on shadedVP.ts,
// constantFP.ts and depthFP.ts). Pass "Solid": the cumulus body, Gouraud-lit
// per vertex like the web game's shaded meshes - a skylight term scaled by how
// much sky the normal sees, the sun's beam, and a backlit fresnel rim in the
// sun's tint - times the SKY_CLOUD tone. With _HAZE: the growth puffs and
// cirrus streaks, unlit, an ordered-dither stipple (opacity per vertex in
// uv.x) of the lit and shadow tones on a screen checkerboard, no depth write.
//
// Instanced: one draw per model and LOD level. Geometry is in scene axes under
// the z mirror, so scene-CCW front faces need Cull Front.
Shader "Retro/CloudSky"
{
    Properties
    {
        _Color ("Lit tone", Color) = (1, 1, 1, 1)
        _ColorShade ("Shadow tone", Color) = (0.8, 0.8, 0.8, 1)
        [Toggle(_HAZE)] _Haze ("Haze", Float) = 0
        [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull", Float) = 1
        [Toggle] _ZWrite ("ZWrite", Float) = 1
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry+10" }

        Pass
        {
            Name "Cloud"
            Tags { "LightMode" = "UniversalForward" }
            Cull [_Cull]
            ZWrite [_ZWrite]

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #pragma multi_compile_instancing
            #pragma shader_feature_local _HAZE
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            // shadedVP.ts constants.
            #define AMBIENT_SKY_FLOOR 0.65
            #define SHADE_AWAY_AMBIENT 0.95
            #define RIM_POWER 3.0
            #define RIM_STRENGTH 0.35

            CBUFFER_START(UnityPerMaterial)
                half4 _Color;
                half4 _ColorShade;
            CBUFFER_END
            float3 _RetroSunTint;

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS : NORMAL;
                float2 uv : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half3 light : TEXCOORD0;
                half fog : TEXCOORD1;
                float dither : TEXCOORD2;
            };

            Varyings vert(Attributes v)
            {
                UNITY_SETUP_INSTANCE_ID(v);
                Varyings o = (Varyings)0;
                float3 positionWS = TransformObjectToWorld(v.positionOS.xyz);
                o.positionCS = TransformWorldToHClip(positionWS);
                o.fog = ComputeFogFactor(o.positionCS.z);
            #if defined(_HAZE)
                o.dither = v.uv.x;
            #else
                // The mirror flips the normal's handedness with the positions'; the
                // inverse-transpose keeps it pointing out of the scene-space body.
                float3 n = normalize(TransformObjectToWorldNormal(v.normalOS));
                Light sun = GetMainLight();
                float rawNdl = saturate(dot(n, sun.direction));
                float skyView = lerp(AMBIENT_SKY_FLOOR, 1.0, 0.5 + 0.5 * n.y);
                float ambientScale = lerp(SHADE_AWAY_AMBIENT, 1.0, rawNdl);
                half3 ambient = SampleSH(float3(0, 1, 0));
                half3 light = ambient * skyView * ambientScale + sun.color * rawNdl;
                // Rim, only turned from the sun and with the sun behind the cloud.
                float3 toCamera = normalize(GetCameraPositionWS() - positionWS);
                float backlit = max(-dot(toCamera, sun.direction), 0.0);
                float fresnel = pow(1.0 - saturate(dot(n, toCamera)), RIM_POWER);
                o.light = light + _RetroSunTint * (fresnel * backlit * (1.0 - rawNdl) * RIM_STRENGTH);
            #endif
                return o;
            }

            // dither.ts bayerThreshold: the 4x4 ordered matrix, centred on zero.
            float BayerThreshold(float2 screen)
            {
                const float m[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };
                int2 p = int2(fmod(floor(screen), 4.0));
                return m[p.y * 4 + p.x] / 16.0 - 0.5;
            }

            half4 frag(Varyings i) : SV_Target
            {
            #if defined(_HAZE)
                float2 screen = i.positionCS.xy;
                if (i.dither > 0.001 && i.dither + BayerThreshold(screen) < 0.5) discard;
                bool lit = fmod(floor(screen.x + screen.y), 2.0) > 0.5;
                half3 c = lit ? _Color.rgb : _ColorShade.rgb;
            #else
                half3 c = _Color.rgb * i.light;
            #endif
                return half4(MixFog(c, i.fog), 1);
            }
            ENDHLSL
        }
    }
}
