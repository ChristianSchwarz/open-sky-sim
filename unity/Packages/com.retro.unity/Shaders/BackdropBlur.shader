// The streaming hold's backdrop (style.css #boot-progress.streaming,
// backdrop-filter: blur(12px)): one direction of a separable Gaussian,
// _Step the texel offset between taps (sigma / 4 along x, then along y).
Shader "Hidden/Retro/BackdropBlur"
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
            float2 _Step;

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
                // Taps out to 3 sigma (12 steps of sigma / 4) with Gaussian weights.
                half3 sum = 0;
                half total = 0;
                [unroll] for (int k = -12; k <= 12; k++)
                {
                    half w = exp(-0.5 * (k / 4.0) * (k / 4.0));
                    sum += SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv + _Step * k).rgb * w;
                    total += w;
                }
                return half4(sum / total, 1);
            }
            ENDHLSL
        }
    }
}
