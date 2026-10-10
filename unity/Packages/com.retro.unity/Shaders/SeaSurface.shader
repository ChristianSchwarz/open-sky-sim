// Open sea: a camera-centred grid (object space = camera-relative Unity
// metres) lowered by the earth's curvature, seaLevelSceneY in geodesy.ts:
// y = -(x^2 + z^2) / (2 R) in scene coordinates, minus the camera height.
Shader "Retro/SeaSurface"
{
    Properties
    {
        _Color ("Color", Color) = (0.05, 0.16, 0.30, 1)
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry+2" }

        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

        CBUFFER_START(UnityPerMaterial)
            half4 _Color;
            // xyz: camera scene position (x east, y up, z south); w: sink below sea level (m).
            float4 _CameraScene;
            float _EarthRadius;
        CBUFFER_END

        float3 SeaPosition(float3 positionOS)
        {
            // Unity z is north; scene z is south.
            float sx = _CameraScene.x + positionOS.x;
            float sz = _CameraScene.z - positionOS.z;
            float y = -(sx * sx + sz * sz) / (2.0 * _EarthRadius) - _CameraScene.y - _CameraScene.w;
            return float3(positionOS.x, y, positionOS.z);
        }
        ENDHLSL

        Pass
        {
            Name "ForwardUnlit"
            Tags { "LightMode" = "UniversalForward" }
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half fog : TEXCOORD0;
            };

            Varyings vert(float4 positionOS : POSITION)
            {
                Varyings o;
                o.positionCS = TransformObjectToHClip(SeaPosition(positionOS.xyz));
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                return half4(MixFog(_Color.rgb, i.fog), 1);
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

            float4 vert(float4 positionOS : POSITION) : SV_POSITION
            {
                return TransformObjectToHClip(SeaPosition(positionOS.xyz));
            }

            half frag() : SV_Target
            {
                return 0;
            }
            ENDHLSL
        }
    }
}
