// The target camera's night view (the I key; game.ts gives the target MFD
// the hd-nightvision palette). That palette paints the scene in flat greys,
// hot airframes bright (~0.8) over dark terrain (~0.25), sky and water darker
// still; per-camera palettes do not fit Unity's draw submission, so the
// rendered image is turned into that kind of greyscale instead: luminance,
// pushed apart around the terrain's grey so airframes stand out.
Shader "Hidden/Retro/NightVision"
{
    Properties
    {
        _MainTex ("Source", 2D) = "black" {}
    }
    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            ZTest Always ZWrite Off Cull Off
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; };

            Varyings vert(Attributes v)
            {
                Varyings o;
                o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
                o.uv = v.uv;
                return o;
            }

            half4 frag(Varyings i) : SV_Target
            {
                half3 c = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv).rgb;
                half l = dot(c, half3(0.2126, 0.7152, 0.0722));
                // Terrain-ish greys around 0.25, brighter surfaces pushed toward 0.8.
                half g = saturate(0.06 + l * 0.55 + smoothstep(0.35, 0.75, l) * 0.35);
                return half4(g, g, g, 1);
            }
            ENDHLSL
        }
    }
}
