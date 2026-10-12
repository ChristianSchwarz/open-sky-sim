// Trees, shrubs and rocks as camera-facing billboards (treeBillboardVP.ts /
// treeBillboardFP.ts), drawn procedurally: one quad mesh, one instance per
// StructuredBuffer entry. Instances arrive shuffled, so a prefix is an even
// thinning; the vertex shader fades the tail of that prefix out by pixel
// spacing, as the web game does, and grows the survivors to keep the cover.
//
// _TileMatrix places tile-local metres camera-relative (frame fix, z mirror).
Shader "Retro/VegetationBillboard"
{
    Properties
    {
        [NoScaleOffset] _MainTex ("Atlas", 2D) = "white" {}
        _Palette ("Palette colour (forest / bare)", Color) = (0.18, 0.42, 0.24, 1)
        _NoonForest ("Noon forest", Color) = (0.184, 0.42, 0.235, 1)
        _SpacingM ("Tree spacing (m), 0 = stones", Float) = 0
        _InvCount ("1 / instance count", Float) = 1
    }
    SubShader
    {
        Tags { "RenderType" = "TransparentCutout" "RenderPipeline" = "UniversalPipeline" "Queue" = "AlphaTest" }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #pragma target 4.5
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "ColourAdjust.hlsl"

            struct Instance
            {
                float3 position;
                float scale;
                float3 normal;
                float kind;
                float4 shade;
            };

            StructuredBuffer<Instance> _Instances;
            float4x4 _TileMatrix;
            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            CBUFFER_START(UnityPerMaterial)
                half4 _Palette;
                half4 _NoonForest;
                float _SpacingM;
                float _InvCount;
            CBUFFER_END

            struct Attributes
            {
                float3 positionOS : POSITION;
                float2 uv : TEXCOORD0;
                uint instanceID : SV_InstanceID;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                half3 leaf : TEXCOORD1;
                half3 trunk : TEXCOORD2;
                half fog : TEXCOORD3;
            };

            half Luma(half3 c) { return dot(c, half3(0.299, 0.587, 0.114)); }

            Varyings vert(Attributes v)
            {
                Varyings o = (Varyings)0;
                Instance inst = _Instances[v.instanceID];
                // Camera-relative world: the camera is at the origin.
                float3 base = mul(_TileMatrix, float4(inst.position, 1)).xyz;
                float3 n = normalize(mul((float3x3)_TileMatrix, inst.normal));
                float s = inst.scale;
                float3 toCam = -base;
                float dist = max(length(toCam), 1e-3);

                if (_SpacingM > 0)
                {
                    float halfHeight = max(_ScreenParams.y * 0.5, 1);
                    float pixelM = dist / (UNITY_MATRIX_P[1][1] * halfHeight);
                    float spacingPx = _SpacingM / max(pixelM, 1e-6);
                    float keep = min(1.0, spacingPx * spacingPx / 9.0);
                    float h = (v.instanceID + 0.5) * _InvCount;
                    float fade = saturate((keep - h) / (0.25 * keep));
                    if (fade <= 0)
                    {
                        o.positionCS = float4(2, 2, 2, 1); // outside the clip volume
                        return o;
                    }
                    s *= fade * min(1.6, rsqrt(max(keep, 1e-4)));
                }

                // Upright about world up, tilted back to face the camera (left-handed world).
                float3 flat = float3(toCam.x, 0, toCam.z);
                float3 right = dot(flat, flat) > 1e-8
                    ? normalize(cross(flat, float3(0, 1, 0)))
                    : normalize(float3(UNITY_MATRIX_V[0].x, 0, UNITY_MATRIX_V[0].z));
                float3 upW = normalize(cross(right, toCam / dist));
                float3 world = base + (right * v.positionOS.x + upW * v.positionOS.y) * s;
                float3 view = TransformWorldToView(world);
                // Push toward the camera by how far down it looks, so terrain behind a tree does not slice its top.
                view.z += v.positionOS.y * s * saturate((-base.y) / dist);
                o.positionCS = TransformWViewToHClip(view);

                // The view band: which of the four elevations of the sprite to show.
                float elevTan = max(-base.y, 0) / max(length(flat), 0.001);
                float col = elevTan < 0.5774 ? 0 : elevTan < 1.4281 ? 1 : elevTan < 5.6713 ? 0 : 1;
                float row = elevTan < 1.4281 ? 0 : 1;
                float kind = inst.kind;
                float u = v.uv.x * 0.25 + fmod(kind, 2) * 0.5 + col * 0.25;
                float vDown = v.uv.y / 6.0 + floor(kind / 2) / 3.0 + row / 6.0;
                o.uv = float2(u, 1 - vDown); // the atlas rows count from the top

                // Leaf tint from the ground colour under the instance (shade.rgb is raw sRGB).
                half3 ratio = clamp(inst.shade.rgb / 0.25, 0.3, 2.0);
                half3 leaf = _Palette.rgb * lerp(1, ratio, 0.5) * inst.shade.a;
                leaf = max(lerp(Luma(leaf).xxx, leaf, 1.6), 0);
                // The player's tree sliders, before the light (treeBillboardVP.ts).
                leaf = RetroAdjustColour(leaf, _AdjTrees);
                Light sun = GetMainLight();
                half3 lit = SampleSH(float3(0, 1, 0)) * lerp(0.4, 1.0, 0.5 + 0.5 * n.y)
                    + sun.color * pow(saturate(dot(n, sun.direction)), 1.69);
                o.leaf = leaf * lit;
                o.trunk = lit * clamp(Luma(_Palette.rgb) / Luma(_NoonForest.rgb), 0.03, 1);
                o.fog = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half4 texel = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
                clip(texel.a - 0.5);
                half canopy = step(max(texel.r, max(texel.g, texel.b)) - min(texel.r, min(texel.g, texel.b)), 0.12);
                half3 c = lerp(texel.rgb * i.trunk * 0.7, i.leaf * texel.r, canopy);
                return half4(MixFog(c, i.fog), 1);
            }
            ENDHLSL
        }
    }
}
