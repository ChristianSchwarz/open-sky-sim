using System;
using Retro.Core;
using Retro.Game;
using UnityEngine;
using UnityEngine.Rendering;
#if RETRO_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace Retro.Unity
{
    /// <summary>
    /// Time of day and everything it decides (sun.ts, daytimePalette.ts,
    /// skyDomeModelBuilder.ts, sunModelBuilder.ts on the ported sky model):
    /// the blended palette every layer draws in, the sun light and ambient, URP
    /// fog, the vertex-painted sky dome, the sun disc and its glare. Repainted
    /// when the hour changes, not every frame. N flips between night and 14:00
    /// as in the web game.
    ///
    /// Climbing out of the air (game.ts updateAtmosphereShell, applySpaceSkyState,
    /// applySpaceClearColor): from 30 km the atmosphere shell fades in over the
    /// scene and the fog thins with it; from 100 km the dome goes, the clear
    /// colour turns black and the stars show. Each few frames the terrain along
    /// the sun's bearing decides how much of the sun the clouds are lit by
    /// (updateSunVisibility).
    /// </summary>
    [DefaultExecutionOrder(-200)]
    public sealed class SkyRenderer : MonoBehaviour
    {
        [Range(0, 23.75f)] public float hours = (float)SunClock.DefaultSunHours;
        public Light sun;
        public FlyCamera viewer;
        public PlayerFlight player;

        [Header("State (read only)")]
        public float sunElevationDeg;
        public float nightMix;
        public string clock;
        public float shellWeight;
        public float sunVisibility = 1;

        private static readonly int SunTintId = Shader.PropertyToID("_RetroSunTint");
        private float appliedHours = float.NaN;
        private SkyDomeGeometry domeGeometry;
        private SunGlareGeometry glareGeometry;
        private Mesh dome, disc, glare;
        private Material domeMaterial, discMaterial, glareMaterial;
        private SunState state;
        private readonly double[] sunPosition = new double[3];
        private readonly double[] sunRotation = new double[4];

        /// <summary>game.ts ATMOSPHERE_SHELL_FADE_IN_M: the shell starts to show at this camera y.</summary>
        public const double ShellFadeInM = 30000;
        /// <summary>game.ts SUN_SKYLINE_EVERY_FRAMES / SUN_SKYLINE_RANGE_M.</summary>
        private const int SkylineEveryFrames = 4;
        private const double SkylineRangeM = 100000;
        private static readonly int SunHiddenId = Shader.PropertyToID("_RetroSunHidden");
        private Mesh shellQuad;
        private Material shellMaterial;
        private float baseFogDensity;
        private Color baseBackground;
        private int skylineFrame;

        private void Start()
        {
            domeGeometry = SkyDome.BuildGeometry();
            dome = BuildMesh("sky dome", domeGeometry.Positions, domeGeometry.Indices);
            SunDiscGeometry discGeometry = SunDisc.BuildDisc();
            disc = BuildMesh("sun disc", discGeometry.Positions, discGeometry.Indices);
            glareGeometry = SunDisc.BuildGlare();
            glare = BuildMesh("sun glare", glareGeometry.Positions, glareGeometry.Indices);
            var falloff = new Vector2[glareGeometry.VertexCount];
            for (int i = 0; i < falloff.Length; i++) falloff[i] = new Vector2(glareGeometry.Falloff[i], glareGeometry.Cap[i]);
            glare.SetUVs(0, falloff);

            domeMaterial = new Material(Shader.Find("Retro/SkyDome")) { name = "sky dome" };
            discMaterial = new Material(Shader.Find("Retro/SkyDome")) { name = "sun disc", renderQueue = 1001 };
            discMaterial.SetFloat("_UseVertexColor", 0);
            glareMaterial = new Material(Shader.Find("Retro/SunGlare")) { name = "sun glare" };
            glareMaterial.SetFloat("_Overbright", (float)SunDisc.GlareOverbright);

            // The shell: a clip-space quad (the vertex shader ignores every matrix).
            shellQuad = new Mesh { name = "atmosphere shell" };
            shellQuad.SetVertices(new[] { new Vector3(-1, -1, 0), new Vector3(1, -1, 0), new Vector3(1, 1, 0), new Vector3(-1, 1, 0) });
            shellQuad.SetTriangles(new[] { 0, 1, 2, 0, 2, 3 }, 0);
            shellQuad.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);
            shellMaterial = new Material(Shader.Find("Retro/AtmosphereShell")) { name = "atmosphere shell" };
        }

        /// <summary>
        /// The shell's constants. Set with the per-frame uniforms: values set on a
        /// fresh material whose shader declares no Properties did not survive to
        /// its first draw.
        /// </summary>
        private void SetShellConstants()
        {
            AtmosphereParams air = Atmosphere.Earth;
            // atmosphereShellModelBuilder.ts: Mie at a fifth of the sky's turbidity, the haze seen from orbit.
            const float turbidityScale = 0.2f;
            shellMaterial.SetVector("_BetaR", new Vector4((float)air.RayleighScattering[0], (float)air.RayleighScattering[1], (float)air.RayleighScattering[2]));
            shellMaterial.SetFloat("_HR", (float)air.RayleighScaleHeight);
            shellMaterial.SetFloat("_BetaM", (float)air.MieScattering * turbidityScale);
            shellMaterial.SetFloat("_BetaMExt", (float)air.MieExtinction * turbidityScale);
            shellMaterial.SetFloat("_HM", (float)air.MieScaleHeight);
            shellMaterial.SetFloat("_MieG", (float)air.MieG);
            shellMaterial.SetVector("_BetaO", new Vector4((float)air.OzoneAbsorption[0], (float)air.OzoneAbsorption[1], (float)air.OzoneAbsorption[2]));
            shellMaterial.SetFloat("_OzC", (float)air.OzoneCentre);
            shellMaterial.SetFloat("_OzW", (float)air.OzoneHalfWidth);
            shellMaterial.SetFloat("_ShellExposure", 4);
            shellMaterial.SetFloat("_ShellClouds", 1);
            shellMaterial.SetVector("_ShellSurface", new Vector4(0.03f, 0.09f, 0.22f));
        }

        private static Mesh BuildMesh(string name, float[] positions, int[] indices)
        {
            int n = positions.Length / 3;
            var v = new Vector3[n];
            for (int i = 0; i < n; i++) v[i] = new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
            var mesh = new Mesh { name = name, indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.SetVertices(v);
            mesh.SetTriangles(indices, 0);
            // Pinned to the far plane in the shader; the bounds must never cull.
            mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);
            return mesh;
        }

        private void Update()
        {
#if RETRO_INPUT_SYSTEM
            Keyboard k = Keyboard.current;
            // sun.ts toggleDayNight: past half daylight goes to midnight, else back to 14:00.
            if (k != null && k.nKey.wasPressedThisFrame && state != null) hours = (float)SunClock.ToggleDayNight(state);
#endif
            if (hours != appliedHours) Apply();
            Draw();
        }

        private void Apply()
        {
            appliedHours = hours;
            state = SunClock.SetSunTime(hours);
            sunElevationDeg = (float)state.ElevationDeg;
            nightMix = (float)state.NightMix;
            clock = SunClock.FormatSunTime(state.Hours);

            Palette active = DaytimePalette.ForElevation(Palettes.HdNoon, Palettes.HdMidnight, state.ElevationDeg);
            double[] light = active.Light ?? new double[] { 1, 1, 1 };
            ScenePalette.Set(active, new Color((float)light[0], (float)light[1], (float)light[2]));

            // The sun: travels from the sun along -dir; direct and ambient are linear factors.
            Vector3 dir = SceneFrame.ToUnity(new Vec3d(state.DirX, state.DirY, state.DirZ));
            if (sun != null)
            {
                sun.transform.rotation = Quaternion.LookRotation(-dir, Vector3.up);
                sun.color = Linear(state.Direct).gamma;
                sun.intensity = 1;
                sun.shadowStrength = (float)state.ShadowStrength;
            }
            // The sun's own colour, for rims and glints (shaders/sun.ts uSunTint).
            Shader.SetGlobalVector(SunTintId, (Vector4)Linear(state.Tint));
            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = Linear(state.Ambient).gamma;

            // URP fog in the terrain category's colour and density. The web fog is
            // exp2(-density * d); URP's exponential mode is exp(-density * d).
            DaytimePalette.FogFor(active, PaletteCategory.FOG_TERRAIN, out double[] fogColour, out double fogDensity);
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Exponential;
            RenderSettings.fogColor = Linear(fogColour).gamma;
            baseFogDensity = (float)(fogDensity * Math.Log(2));
            RenderSettings.fogDensity = baseFogDensity;
            baseBackground = ScenePalette.Tone(PaletteCategory.BACKGROUND);
            if (viewer != null && viewer.UnityCamera != null)
            {
                viewer.UnityCamera.clearFlags = CameraClearFlags.SolidColor;
                viewer.UnityCamera.backgroundColor = baseBackground;
            }

            // The dome and the glare, painted from the authored noon and midnight palettes.
            float[] domeColours = SkyDome.Paint(domeGeometry, Palettes.HdNoon, Palettes.HdMidnight, state.NightMix,
                state.DirX, state.DirY, state.DirZ);
            dome.SetColors(ToColors(domeColours, domeGeometry.VertexCount));
            float[] glareColours = SunDisc.PaintGlare(glareGeometry, Palettes.HdNoon, Palettes.HdMidnight, state.NightMix,
                state.DirX, state.DirY, state.DirZ);
            glare.SetColors(ToColors(glareColours, glareGeometry.VertexCount));
            Color sunColour = ScenePalette.Tone(PaletteCategory.SKY_SUN).linear * (float)SunDisc.DiscOverbright;
            // HDR: bloom makes the overbright disc glow where the web game let it clip.
            discMaterial.SetColor("_Color", sunColour);
            SunDisc.PlaceSun(state.DirX, state.DirY, state.DirZ, sunPosition, sunRotation);
        }

        private static Color Linear(double[] c) => new Color((float)c[0], (float)c[1], (float)c[2]);

        private static Color[] ToColors(float[] rgb, int count)
        {
            var colours = new Color[count];
            for (int i = 0; i < count; i++) colours[i] = new Color(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 1);
            return colours;
        }

        /// <summary>
        /// updateAtmosphereShell and the space sky state: the shell's weight and
        /// uniforms, the fog thinned by it, and above 100 km no dome and a black
        /// clear. Returns whether the dome draws.
        /// </summary>
        private bool UpdateSpace()
        {
            bool showcase = player != null && player.InShowcase;
            Camera cam = viewer != null ? viewer.UnityCamera : null;
            EnuBasis basis = viewer != null ? viewer.Basis : null;
            double altitude = viewer != null ? viewer.ScenePosition.Y : 0;
            double x = Math.Max(0, Math.Min(1, (altitude - ShellFadeInM) / (SkyFields.SpaceSkyAltitudeM - ShellFadeInM)));
            double weight = x * x * (3 - 2 * x);
            bool show = weight > 0 && !showcase && basis != null && cam != null;
            shellWeight = show ? (float)weight : 0;
            bool inSpace = altitude >= SkyFields.SpaceSkyAltitudeM && !showcase;
            if (!showcase)
            {
                RenderSettings.fogDensity = baseFogDensity * (1 - shellWeight);
                if (cam != null) cam.backgroundColor = inSpace ? Color.black : baseBackground;
            }
            if (show)
            {
                Mat3d m = basis.EcefToEnu;
                Enu c = Geodesy.EcefToEnu(basis, Vec3d.Zero);
                var centre = new Vec3d(c.E, c.U, -c.N);
                // The polar axis (ECEF z) in ENU is the third column of ecef->enu.
                var axis = new Vec3d(m.M13, m.M33, -m.M23);
                double axisLength = Math.Sqrt(axis.X * axis.X + axis.Y * axis.Y + axis.Z * axis.Z);
                axis = new Vec3d(axis.X / axisLength, axis.Y / axisLength, axis.Z / axisLength);
                // Height above the ellipsoid in doubles: the polar component stretched by a / b.
                Vec3d eye = viewer.ScenePosition;
                double rx = eye.X - centre.X, ry = eye.Y - centre.Y, rz = eye.Z - centre.Z;
                double along = (rx * axis.X + ry * axis.Y + rz * axis.Z) * (Geodesy.Wgs84A / Geodesy.Wgs84B - 1);
                double sx = rx + axis.X * along, sy = ry + axis.Y * along, sz = rz + axis.Z * along;
                double height = Math.Sqrt(sx * sx + sy * sy + sz * sz) - Geodesy.Wgs84A;
                shellMaterial.SetVector("_ShellCentre", new Vector4((float)-rx, (float)-ry, (float)-rz));
                shellMaterial.SetVector("_ShellAxis", new Vector4((float)axis.X, (float)axis.Y, (float)axis.Z));
                shellMaterial.SetVector("_ShellSun", new Vector4((float)state.DirX, (float)state.DirY, (float)state.DirZ));
                shellMaterial.SetFloat("_ShellCamHeight", (float)height);
                shellMaterial.SetFloat("_ShellWeight", shellWeight);
                SetShellConstants();
                Graphics.RenderMesh(new RenderParams(shellMaterial) { camera = cam, shadowCastingMode = ShadowCastingMode.Off },
                    shellQuad, 0, Matrix4x4.identity);
            }
            return !inSpace;
        }

        /// <summary>
        /// updateSunVisibility: the steepest ground angle along the sun's
        /// horizontal bearing out to 100 km (the step widening with range) is the
        /// skyline the sun has to clear; how much of the disc does, the clouds are lit by.
        /// </summary>
        private void UpdateSunVisibility()
        {
            if (skylineFrame++ % SkylineEveryFrames != 0) return;
            DemHeightField ground = player != null ? player.HeightField : null;
            if (ground == null || viewer == null || state == null) return;
            Vec3d cam = viewer.ScenePosition;
            double horizontal = Math.Sqrt(state.DirX * state.DirX + state.DirZ * state.DirZ);
            double skylineDeg = -90;
            if (horizontal > 1e-4)
            {
                double dx = state.DirX / horizontal, dz = state.DirZ / horizontal;
                double steepest = double.NegativeInfinity;
                for (double t = 20; t <= SkylineRangeM; t += Math.Max(20, t * 0.03))
                {
                    double h = ground.HeightAtWorld(cam.X + dx * t, cam.Z + dz * t);
                    steepest = Math.Max(steepest, (h - cam.Y) / t);
                }
                skylineDeg = Math.Atan(steepest) * 180 / Math.PI;
            }
            sunVisibility = (float)SunClock.SunVisibilityFor(state.ElevationDeg, skylineDeg, SunDisc.DiscDiameterDeg);
            Shader.SetGlobalFloat(SunHiddenId, 1 - sunVisibility);
        }

        private void Draw()
        {
            if (dome == null) return;
            UpdateSunVisibility();
            bool domeOn = UpdateSpace();
            var none = new RenderParams(domeMaterial) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            // Camera-centred: the dome sits on the camera (scene axes mirrored into Unity's).
            Matrix4x4 mirror = SceneFrame.TileMatrix(Vec3d.Zero, Vec3d.Zero, Quatd.Identity, 1);
            if (domeOn) Graphics.RenderMesh(none, dome, 0, mirror);
            if (!SunDisc.IsVisible(state.ElevationDeg)) return;
            var sunPose = new Quatd(sunRotation[0], sunRotation[1], sunRotation[2], sunRotation[3]);
            Matrix4x4 at = SceneFrame.TileMatrix(new Vec3d(sunPosition[0], sunPosition[1], sunPosition[2]), Vec3d.Zero, sunPose, 1);
            Graphics.RenderMesh(new RenderParams(discMaterial) { shadowCastingMode = ShadowCastingMode.Off }, disc, 0, at);
            Graphics.RenderMesh(new RenderParams(glareMaterial) { shadowCastingMode = ShadowCastingMode.Off }, glare, 0, at);
        }

        private void OnDestroy()
        {
            Shader.SetGlobalFloat(SunHiddenId, 0);
            foreach (UnityEngine.Object o in new UnityEngine.Object[] { dome, disc, glare, domeMaterial, discMaterial, glareMaterial, shellQuad, shellMaterial })
            {
                if (o != null) Destroy(o);
            }
        }
    }
}
