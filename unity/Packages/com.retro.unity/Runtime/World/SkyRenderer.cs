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
    /// </summary>
    [DefaultExecutionOrder(-200)]
    public sealed class SkyRenderer : MonoBehaviour
    {
        [Range(0, 23.75f)] public float hours = (float)SunClock.DefaultSunHours;
        public Light sun;
        public FlyCamera viewer;

        [Header("State (read only)")]
        public float sunElevationDeg;
        public float nightMix;
        public string clock;

        private static readonly int SunTintId = Shader.PropertyToID("_RetroSunTint");
        private float appliedHours = float.NaN;
        private SkyDomeGeometry domeGeometry;
        private SunGlareGeometry glareGeometry;
        private Mesh dome, disc, glare;
        private Material domeMaterial, discMaterial, glareMaterial;
        private SunState state;
        private readonly double[] sunPosition = new double[3];
        private readonly double[] sunRotation = new double[4];

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
            RenderSettings.fogDensity = (float)(fogDensity * Math.Log(2));
            if (viewer != null && viewer.UnityCamera != null)
            {
                viewer.UnityCamera.clearFlags = CameraClearFlags.SolidColor;
                viewer.UnityCamera.backgroundColor = ScenePalette.Tone(PaletteCategory.BACKGROUND);
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

        private void Draw()
        {
            if (dome == null) return;
            var none = new RenderParams(domeMaterial) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            // Camera-centred: the dome sits on the camera (scene axes mirrored into Unity's).
            Matrix4x4 mirror = SceneFrame.TileMatrix(Vec3d.Zero, Vec3d.Zero, Quatd.Identity, 1);
            Graphics.RenderMesh(none, dome, 0, mirror);
            if (!SunDisc.IsVisible(state.ElevationDeg)) return;
            var sunPose = new Quatd(sunRotation[0], sunRotation[1], sunRotation[2], sunRotation[3]);
            Matrix4x4 at = SceneFrame.TileMatrix(new Vec3d(sunPosition[0], sunPosition[1], sunPosition[2]), Vec3d.Zero, sunPose, 1);
            Graphics.RenderMesh(new RenderParams(discMaterial) { shadowCastingMode = ShadowCastingMode.Off }, disc, 0, at);
            Graphics.RenderMesh(new RenderParams(glareMaterial) { shadowCastingMode = ShadowCastingMode.Off }, glare, 0, at);
        }

        private void OnDestroy()
        {
            foreach (UnityEngine.Object o in new UnityEngine.Object[] { dome, disc, glare, domeMaterial, discMaterial, glareMaterial })
            {
                if (o != null) Destroy(o);
            }
        }
    }
}
