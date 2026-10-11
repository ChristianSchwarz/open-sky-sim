using System;
using System.Collections.Generic;
using System.IO;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using Retro.Terrain;
using UnityEngine;
using UnityEngine.UIElements;

namespace Retro.Unity
{
    /// <summary>
    /// The cover-texture sidecars (.ptx) as the moving map asks for them
    /// (coverTextures.ts sidecar): decoded off the main thread by a tile
    /// cache, fetched on request with the map's priority, peeked otherwise.
    /// </summary>
    public sealed class PtxMapSource : IMapTileSource
    {
        private readonly TileIndex index;
        private readonly TileCache<PtxTile> cache;
        private readonly List<(TileKey, double)> wants = new List<(TileKey, double)>();
        private readonly int nearZoom, size, nearSize;

        public int ZoomMin { get; }
        public int ZoomMax { get; }

        public PtxMapSource(string root, int zoomMin, int zoomMax, int size, int nearSize, int nearZoom)
        {
            string indexPath = Path.Combine(root, "index_tex.bin");
            index = File.Exists(indexPath) ? TileIndex.Decode(File.ReadAllBytes(indexPath)) : null;
            ZoomMin = index != null ? zoomMin : 1;
            ZoomMax = index != null ? zoomMax : 0;
            this.size = size;
            this.nearSize = nearSize;
            this.nearZoom = nearZoom;
            cache = new TileCache<PtxTile>(
                k => Path.Combine(root, k.Z.ToString(), k.X.ToString(), k.Y + ".ptx"),
                TileFile.Ptx,
                t => (t.Texels?.Length ?? 0) + 64,
                64L << 20);
        }

        public int TexelsAt(int z) => z >= nearZoom ? nearSize : size;

        public PtxTile Sidecar(TileKey id, double priority)
        {
            if (index == null || !index.Has(id)) return null;
            PtxTile t = cache.Get(id);
            if (t == null && priority > 0) wants.Add((id, priority));
            return t;
        }

        /// <summary>Once a frame, after the map asked: fetch what it wanted.</summary>
        public void Pump()
        {
            cache.NextGeneration();
            cache.SetWants(wants);
            wants.Clear();
            cache.Pump();
        }
    }

    /// <summary>Map tiles as nearest-filtered textures, rows flipped so v = 1 is north (movingMap.ts putImageData).</summary>
    public sealed class TextureRasterFactory : IMapRasterFactory
    {
        public object Create(TileKey id, int size, byte[] rgba)
        {
            var flipped = new byte[rgba.Length];
            int row = size * 4;
            for (int y = 0; y < size; y++) Buffer.BlockCopy(rgba, y * row, flipped, (size - 1 - y) * row, row);
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "map " + id };
            tex.SetPixelData(flipped, 0);
            tex.Apply(false, true);
            return tex;
        }

        public void Release(object raster)
        {
            if (raster is Texture2D t) UnityEngine.Object.Destroy(t);
        }
    }

    /// <summary>
    /// The 2D overlay (game.ts's HD overlay layers): one canvas the size of the
    /// screen, painted every frame through the ported
    /// <see cref="CanvasCommandPainter"/> - the cockpit MFDs, attitude ball,
    /// device stack and moving map in the cockpit view - and drawn by an
    /// <see cref="OverlayCanvas"/> over the 3D view. The target camera's
    /// texture sits under the canvas at MFD2, where the cockpit clears it.
    /// </summary>
    [DefaultExecutionOrder(200)]
    public sealed class OverlayHost : MonoBehaviour
    {
        public PlayerFlight flight;
        public TerrainRenderer terrain;
        public FlyCamera viewer;
        public TargetCameraView targetView;

        [Header("Stats (read only)")]
        public int commands;
        public int primitives;

        private UIDocument document;
        private OverlayCanvas canvas;
        private Image targetImage;
        private CanvasCommandPainter painter;
        private int painterWidth, painterHeight;
        private CockpitRenderer cockpit;
        private PtxMapSource mapSource;
        private readonly Dictionary<string, Texture2D> atlases = new Dictionary<string, Texture2D>();
        private readonly CockpitInputs inputs = new CockpitInputs();
        private CockpitFrame frame;

        /// <summary>The M key: the tactical MFD's map page.</summary>
        public void ToggleMovingMap() => cockpit?.SetMovingMapEnabled(!cockpit.MovingMapEnabled);

        private void Start()
        {
            document = gameObject.AddComponent<UIDocument>();
            document.panelSettings = Resources.Load<PanelSettings>("RetroHudPanelSettings");
            VisualElement root = document.rootVisualElement;
            root.pickingMode = PickingMode.Ignore;
            targetImage = new Image { scaleMode = ScaleMode.StretchToFill, pickingMode = PickingMode.Ignore };
            targetImage.style.position = Position.Absolute;
            root.Add(targetImage);
            canvas = new OverlayCanvas(Atlas);
            root.Add(canvas);
        }

        /// <summary>A HUD font's atlas, from assets/ beside the terrain (point-sampled, never mipmapped).</summary>
        private Texture Atlas(HudFont font)
        {
            if (atlases.TryGetValue(font.Id, out Texture2D t)) return t;
            string assets = Path.GetDirectoryName(Path.GetDirectoryName(terrain.Root));
            string path = Path.Combine(assets, font.Atlas.Replace('/', Path.DirectorySeparatorChar));
            t = null;
            if (File.Exists(path))
            {
                t = new Texture2D(2, 2, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = font.Id };
                t.LoadImage(File.ReadAllBytes(path));
            }
            atlases[font.Id] = t;
            return t;
        }

        private bool Boot()
        {
            if (flight == null || flight.Sim == null || terrain == null || terrain.Root == null) return false;
            if (cockpit != null) return true;
            TerrainManifestTexture tex = terrain.TextureInfo;
            mapSource = tex != null
                ? new PtxMapSource(terrain.Root, tex.minZoom, tex.maxZoom, tex.size, tex.nearSize, tex.nearZoom)
                : null;
            cockpit = new CockpitRenderer(mapSource == null ? null : new MovingMapSource
            {
                Basis = flight.HeightField.Basis,
                Tiles = mapSource,
                Rasters = new TextureRasterFactory(),
            });
            return true;
        }

        private void Update()
        {
#if RETRO_INPUT_SYSTEM
            UnityEngine.InputSystem.Keyboard k = UnityEngine.InputSystem.Keyboard.current;
            // game.ts KeyM: the tactical MFD's map page.
            if (k != null && k.mKey.wasPressedThisFrame && flight != null && !flight.menuOpen) ToggleMovingMap();
#endif
        }

        private void LateUpdate()
        {
            if (canvas == null || !Boot()) return;
            int w = Screen.width, h = Screen.height;
            if (painter == null || w != painterWidth || h != painterHeight)
            {
                painter = new CanvasCommandPainter(w, h);
                painterWidth = w;
                painterHeight = h;
            }
            painter.BeginFrame();
            painter.Clear();
            bool cockpitView = flight.flightView == FlightView.Cockpit && !flight.Aircraft.IsCrashed() && !flight.menuOpen;
            Texture target = null;
            if (cockpitView)
            {
                FillInputs();
                frame = cockpit.Render(w, h, inputs, painter, frame);
                mapSource?.Pump();
                if (inputs.Target != null && targetView != null)
                {
                    // The window the cockpit cleared at MFD2: the zoomed target view under the canvas.
                    targetView.Resize((int)(frame.Mfd2.Size / 2), (int)(frame.Mfd2.Size / 2));
                    target = targetView.Texture;
                    targetImage.style.left = (float)frame.Mfd2.X;
                    targetImage.style.top = (float)frame.Mfd2.Y;
                    targetImage.style.width = (float)frame.Mfd2.Size;
                    targetImage.style.height = (float)frame.Mfd2.Size;
                }
            }
            targetImage.image = target;
            targetImage.style.display = target != null ? DisplayStyle.Flex : DisplayStyle.None;
            canvas.SetCommands(painter.Commands);
            commands = painter.Commands.Count;
            primitives = canvas.PrimitiveCount;
        }

        private static CockpitDeviceState Device(double unit, bool commanded) =>
            commanded
                ? (unit >= 1 ? CockpitDeviceState.Extended : CockpitDeviceState.Extending)
                : (unit <= 0 ? CockpitDeviceState.Retracted : CockpitDeviceState.Retracting);

        /// <summary>The cockpit's snapshot of the player, its target and the palette for this frame.</summary>
        private void FillInputs()
        {
            SimAircraft a = flight.Aircraft;
            inputs.DisplayPosition = a.GetPosition();
            inputs.DisplayQuaternion = a.GetQuaternion();
            (double gear, double flaps, double airbrakes) = flight.DeviceUnits;
            inputs.LandingGear = Device(gear, a.IsGearDeployed());
            inputs.Flaps = Device(flaps, a.IsFlapsExtended());
            inputs.Airbrakes = Device(airbrakes, a.IsAirbrakesExtended());
            inputs.Tailhook = Device(flight.HookUnit, a.IsHookDeployed());
            inputs.WheelBrakesApplied = a.IsWheelBrakesApplied();
            inputs.BarricadeStatus = null;
            inputs.Target = flight.CockpitTarget();
            inputs.Contacts = inputs.Target != null ? new[] { inputs.Target } : Array.Empty<CockpitTarget>();
            Camera cam = viewer.UnityCamera;
            inputs.MainCamera.Fov = cam.fieldOfView;
            inputs.MainCamera.Aspect = cam.aspect;
            inputs.Colors = CockpitColors.FromPalette(ScenePalette.Current);
        }
    }
}
