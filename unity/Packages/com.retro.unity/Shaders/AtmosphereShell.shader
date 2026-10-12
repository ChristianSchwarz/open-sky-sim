// The atmosphere seen from outside (atmosphereShellModelBuilder.ts): a
// full-screen pass over the finished scene. Per pixel it intersects the view
// ray with the WGS84 ellipsoid and a 100 km shell round it and single-scatters
// along the part between the eye and whatever ends it (the terrain, from the
// scene depth, or the bare ellipsoid where nothing is drawn), composited with
// premultiplied alpha: dst * transmittance + inscatter. That puts aerial
// perspective on the terrain and the glowing limb round it in one pass, with a
// procedural cloud deck, the ocean's sun glint and the stars behind.
//
// Directions are in scene axes (x east, y up, z south); Unity's world is the
// same camera-relative space with z mirrored. The planet's centre comes in
// camera-relative and the camera's height above the ellipsoid from doubles on
// the CPU: floats cannot difference two 6.4 Mm numbers.
Shader "Retro/AtmosphereShell"
{
    SubShader
    {
        Tags { "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent+90" }
        Pass
        {
            Name "Shell"
            Tags { "LightMode" = "UniversalForward" }
            ZTest Always
            ZWrite Off
            Cull Off
            Blend One OneMinusSrcAlpha

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

            float3 _ShellCentre;   // ellipsoid centre minus camera, scene axes, m
            float3 _ShellAxis;     // unit polar axis, scene axes
            float3 _ShellSun;      // unit direction to the sun, scene axes
            float _ShellCamHeight; // camera height above the ellipsoid, m
            float _ShellWeight;    // 0 off .. 1 full
            float _ShellExposure;
            float _ShellClouds;
            float3 _ShellSurface;
            // atmosphere.ts EARTH_ATMOSPHERE (Mie at the shell's turbidity).
            float3 _BetaR;
            float _HR;
            float _BetaM;
            float _BetaMExt;
            float _HM;
            float _MieG;
            float3 _BetaO;
            float _OzC;
            float _OzW;

            #define A 6378137.0
            #define SQUASH 0.003364
            #define TOP 100000.0
            #define CLOUD_H 8000.0
            #define VIEW_STEPS 12
            #define SUN_STEPS 5
            #define SKY_CUT 0.99

            struct Attributes { float4 positionOS : POSITION; };
            struct Varyings { float4 positionCS : SV_POSITION; };

            Varyings vert(Attributes v)
            {
                Varyings o;
                // A quad already in clip space; no camera involved.
                o.positionCS = float4(v.positionOS.xy, UNITY_NEAR_CLIP_VALUE, 1.0);
                return o;
            }

            float3 toSphere(float3 v) { return v + SQUASH * dot(v, _ShellAxis) * _ShellAxis; }

            float3 extinctionAt(float h)
            {
                float dR = exp(-h / _HR);
                float dM = exp(-h / _HM);
                float dO = max(0.0, 1.0 - abs(h - _OzC) / _OzW);
                return _BetaR * dR + _BetaMExt * dM + _BetaO * dO;
            }

            float3 sunDepth(float3 p, float3 s)
            {
                float r = length(p);
                float b = dot(p, s);
                float rt = A + TOP;
                float reach = -b + sqrt(max(0.0, b * b - (r - rt) * (r + rt)));
                float3 tau = 0;
                float prev = 0;
                [unroll] for (int i = 0; i < SUN_STEPS; i++)
                {
                    float u = (i + 1.0) / SUN_STEPS;
                    float edge = reach * u * u;
                    float mid = 0.5 * (prev + edge);
                    float3 q = p + s * mid;
                    tau += extinctionAt(max(0.0, length(q) - A)) * (edge - prev);
                    prev = edge;
                }
                return tau;
            }

            float hash(float3 p)
            {
                p = frac(p * 0.3183099 + 0.1);
                p *= 17.0;
                return frac(p.x * p.y * p.z * (p.x + p.y + p.z));
            }

            float stars(float3 dir)
            {
                float total = 0;
                [unroll] for (int layer = 0; layer < 2; layer++)
                {
                    float density = layer == 0 ? 90.0 : 200.0;
                    float3 p = dir * density;
                    float3 id = floor(p);
                    float3 f = frac(p) - 0.5;
                    float h = hash(id + layer * 31.7);
                    float3 jitter = float3(hash(id + 3.1), hash(id + 7.9), hash(id + 13.3)) - 0.5;
                    float d = length(f - jitter * 0.6);
                    float brightness = h > 0.965 ? (h - 0.965) / 0.035 : 0.0;
                    total += brightness * smoothstep(0.16, 0.0, d);
                }
                return total;
            }

            float vnoise(float3 p)
            {
                float3 i = floor(p);
                float3 f = frac(p);
                f = f * f * (3.0 - 2.0 * f);
                return lerp(
                    lerp(lerp(hash(i), hash(i + float3(1, 0, 0)), f.x),
                         lerp(hash(i + float3(0, 1, 0)), hash(i + float3(1, 1, 0)), f.x), f.y),
                    lerp(lerp(hash(i + float3(0, 0, 1)), hash(i + float3(1, 0, 1)), f.x),
                         lerp(hash(i + float3(0, 1, 1)), hash(i + float3(1, 1, 1)), f.x), f.y),
                    f.z);
            }

            float cloudDensity(float3 n)
            {
                float f = 0;
                float amp = 0.5;
                float3 q = n * 5.0 + float3(3.7, 1.3, 9.1);
                [unroll] for (int i = 0; i < 6; i++)
                {
                    f += amp * vnoise(q);
                    q = q * 2.03 + float3(5.2, 1.7, 3.3);
                    amp *= 0.5;
                }
                float lat = abs(dot(n, normalize(_ShellAxis)));
                float storm = (lat - 0.77) * 4.0;
                float dry = (lat - 0.42) * 5.0;
                float band = 0.14 * exp(-storm * storm) + 0.10 * exp(-lat * lat * 30.0) - 0.16 * exp(-dry * dry);
                return smoothstep(0.50, 0.68, f + band);
            }

            half4 frag(Varyings i) : SV_Target
            {
                if (_ShellWeight <= 0.0) discard;
                float2 uv = i.positionCS.xy / _ScreenParams.xy;
                // The view ray in Unity's (camera-relative) world, then in scene axes.
                float3 farWS = ComputeWorldSpacePosition(uv, UNITY_RAW_FAR_CLIP_VALUE, UNITY_MATRIX_I_VP);
                float3 rayWS = normalize(farWS - _WorldSpaceCameraPos);
                float3 dir = float3(rayWS.x, rayWS.y, -rayWS.z);
                float3 camForward = -UNITY_MATRIX_V[2].xyz;

                float3 o = toSphere(-_ShellCentre);
                float3 d = toSphere(dir);
                float3 sun = normalize(toSphere(_ShellSun));
                float a = dot(d, d);
                float b = dot(o, d);
                float cTop = _ShellCamHeight > TOP
                    ? (_ShellCamHeight - TOP) * (2.0 * A + _ShellCamHeight + TOP)
                    : -(TOP - _ShellCamHeight) * (2.0 * A + _ShellCamHeight + TOP);
                float cGround = _ShellCamHeight * (2.0 * A + _ShellCamHeight);
                float discTop = b * b - a * cTop;
                float discGround = b * b - a * cGround;

                float raw = SampleSceneDepth(uv);
                float eye = LinearEyeDepth(raw, _ZBufferParams);
                bool terrain = eye < _ProjectionParams.z * SKY_CUT;
                float terrainT = eye / max(1e-4, dot(rayWS, camForward));

                // Only once the dome has all but gone: no stars through a daylit sky.
                float3 star = stars(dir) * smoothstep(0.9, 1.0, _ShellWeight);

                if (discTop <= 0.0) return half4(terrain ? 0 : star, 0);
                float sq = sqrt(discTop);
                float tNear = max(0.0, (-b - sq) / a);
                float tFar = (-b + sq) / a;
                if (tFar <= 0.0) return half4(terrain ? 0 : star, 0);

                bool fallback = false;
                float tEnd = tFar;
                if (terrain) tEnd = min(tEnd, terrainT);
                else if (discGround > 0.0)
                {
                    float tg = (-b - sqrt(discGround)) / a;
                    if (tg > 0.0)
                    {
                        tEnd = min(tEnd, tg);
                        fallback = true;
                    }
                }
                if (tEnd <= tNear) return 0;

                float tc = clamp(-b / a, tNear, tEnd);
                float cosTheta = dot(normalize(d), sun);
                float phaseR = 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
                float g2 = _MieG * _MieG;
                float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + cosTheta * cosTheta))
                    / ((2.0 + g2) * pow(abs(1.0 + g2 - 2.0 * _MieG * cosTheta), 1.5));

                float3 tau = 0;
                float3 radiance = 0;
                [unroll] for (int half_ = 0; half_ < 2; half_++)
                {
                    float span = half_ == 0 ? tc - tNear : tEnd - tc;
                    if (span <= 0.0) continue;
                    [unroll] for (int s = 0; s < VIEW_STEPS; s++)
                    {
                        int k = half_ == 0 ? VIEW_STEPS - 1 - s : s;
                        float u0 = (float)k / VIEW_STEPS;
                        float u1 = (float)(k + 1) / VIEW_STEPS;
                        float e0 = u0 * u0 * span;
                        float e1 = u1 * u1 * span;
                        float t0 = half_ == 0 ? tc - e1 : tc + e0;
                        float t1 = half_ == 0 ? tc - e0 : tc + e1;
                        float dt = t1 - t0;
                        float tm = 0.5 * (t0 + t1);
                        float3 p = o + d * tm;
                        float r = length(p);
                        float h = max(0.0, r - A);
                        float3 stepTau = extinctionAt(h) * dt;
                        float3 view = exp(-(tau + 0.5 * stepTau));
                        float bs = dot(p, sun);
                        bool lit = !(bs < 0.0 && bs * bs - (r - A) * (r + A) > 0.0);
                        if (lit)
                        {
                            float3 sunT = exp(-sunDepth(p, sun));
                            float dR = exp(-h / _HR);
                            float dM = exp(-h / _HM);
                            float3 scatter = _BetaR * dR * (phaseR + 0.25 / (4.0 * PI)) + _BetaM * dM * phaseM;
                            radiance += view * sunT * scatter * dt;
                        }
                        tau += stepTau;
                    }
                }

                float3 transmittance = exp(-tau);
                float3 emission = radiance;
                float alpha;

                // The cloud deck at CLOUD_H, seen from above.
                float dens = 0;
                float3 cloudLight = 0;
                if (_ShellCamHeight > CLOUD_H + 4000.0)
                {
                    float cC = (_ShellCamHeight - CLOUD_H) * (2.0 * A + _ShellCamHeight + CLOUD_H);
                    float dC = b * b - a * cC;
                    if (dC > 0.0)
                    {
                        float tcl = (-b - sqrt(dC)) / a;
                        if (tcl > 0.0 && tcl < tEnd)
                        {
                            float3 pc = o + d * tcl;
                            float3 n = normalize(pc);
                            dens = cloudDensity(n) * _ShellClouds;
                            if (dens > 0.0)
                            {
                                float mu = dot(n, sun);
                                float3 sunT = exp(-sunDepth(pc, sun));
                                cloudLight = sunT * (max(mu, 0.0) * 0.95 + 0.02) + 0.04 * smoothstep(-0.25, 0.1, mu);
                                cloudLight *= 1.0 - 0.3 * dens;
                            }
                        }
                    }
                }
                if (terrain)
                {
                    // Night on the far side of the terminator: the scene was lit for one sun everywhere.
                    float3 hit = o + d * tEnd;
                    float mu = dot(normalize(hit), sun);
                    float day = lerp(0.06, 1.0, smoothstep(-0.08, 0.18, mu));
                    float shell = lerp(1.0, day, _ShellWeight);
                    float mean = dot(transmittance, 1.0 / 3.0) * shell * (1.0 - dens);
                    alpha = 1.0 - mean;
                }
                else if (fallback)
                {
                    float3 hit = o + d * tEnd;
                    float mu = dot(normalize(hit), sun);
                    float3 sunT = exp(-sunDepth(hit, sun));
                    float direct = max(0.0, mu) * (1.0 / PI);
                    float3 toEye = normalize(-d);
                    float3 nrm = normalize(hit);
                    float glint = pow(max(dot(nrm, normalize(sun + toEye)), 0.0), 4000.0) * 60.0;
                    emission += (transmittance * (_ShellSurface * (sunT * direct * 3.0 + 0.02) + sunT * glint * step(0.0, mu))) * (1.0 - dens);
                    alpha = 1.0;
                }
                else
                {
                    emission += star * transmittance;
                    alpha = 1.0 - dot(transmittance, 1.0 / 3.0) * (1.0 - dens);
                }
                float3 toned = 1.0 - exp(-emission * _ShellExposure);
                toned += cloudLight * dens * transmittance;
                if (dens > 0.0) alpha = max(alpha, dens * dot(transmittance, 1.0 / 3.0));
                return half4(toned * _ShellWeight, alpha * _ShellWeight);
            }
            ENDHLSL
        }
    }
}
