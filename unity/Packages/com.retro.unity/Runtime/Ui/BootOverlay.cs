using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.UIElements;

namespace Retro.Unity
{
    /// <summary>
    /// The boot screen and the streaming hold (bootProgress.ts, game.ts
    /// holdUntilStreamed). Until the flight boots: an opaque pane with the
    /// title, a label and a bar. After every spawn: the live view under a
    /// dimmed pane ("Streaming terrain... N%") while the flight holds still,
    /// until the tile backlog has stayed empty for 0.6 s (at most 20 s), the
    /// bar counting what drained and never sweeping faster than half its
    /// length a second; then a 3-2-1 count and "Go", the flight starting on
    /// "Go". The web game blurs the view behind the pane (backdrop-filter:
    /// blur(12px), going to 0 with the dim in the count's first second). UI
    /// Toolkit has no backdrop filter, so for that long the main camera renders
    /// into a texture, a separable Gaussian runs after it, and the pane shows
    /// the result in place of the screen (the HUD, under the pane, is not seen).
    /// </summary>
    public sealed class BootOverlay : MonoBehaviour
    {
        public PlayerFlight flight;
        public TerrainRenderer terrain;

        // game.ts STREAM_*.
        private const float SettleS = 0.6f;
        private const float HoldMaxS = 20;
        private const int CountdownFrom = 3;
        private const float GoShownS = 0.8f;
        private const float BarRatePerS = 0.5f;
        // style.css: blur(12px) and rgba(0, 0, 0, 0.35), both gone over 1 s.
        private const float BlurCssPx = 12;
        private const float DimAlpha = 0.35f;
        private const float FadeS = 1;

        private VisualElement pane, dialog, fill, countdown;
        private Label label, countdownText;
        private enum Phase { Boot, Streaming, Countdown, Done }
        private Phase phase = Phase.Boot;
        private float start, idleSince = -1, lastTick, countdownStart;
        private int prevBacklog, drained;
        private float shown;
        private bool subscribed;
        private VisualElement backdrop;
        private Camera blurred;
        private RenderTexture sharp, across, blurredTexture;
        private Material blurX, blurY;
        private float blurPx;

        private void Start()
        {
            var document = gameObject.AddComponent<UIDocument>();
            document.panelSettings = Resources.Load<PanelSettings>("RetroPanelSettings");
            document.sortingOrder = 200;
            VisualElement root = document.rootVisualElement;
            root.pickingMode = PickingMode.Ignore;

            pane = new VisualElement();
            MenuDialog.Style(pane, s =>
            {
                s.position = Position.Absolute;
                s.left = s.right = s.top = s.bottom = 0;
                s.alignItems = Align.Center;
                s.justifyContent = Justify.Center;
                s.backgroundColor = new Color(0, 0, 0, 0.85f);
            });
            root.Add(pane);
            backdrop = new VisualElement { pickingMode = PickingMode.Ignore };
            MenuDialog.Style(backdrop, s =>
            {
                s.position = Position.Absolute;
                s.left = s.right = s.top = s.bottom = 0;
                s.display = DisplayStyle.None;
            });
            pane.Add(backdrop);
            RenderPipelineManager.endCameraRendering += AfterRender;
            dialog = new VisualElement();
            MenuDialog.Style(dialog, s =>
            {
                s.minWidth = 256;
                s.paddingLeft = s.paddingRight = s.paddingTop = s.paddingBottom = 20;
                s.backgroundColor = new Color(0, 0, 0, 0.9f);
                s.borderTopWidth = s.borderBottomWidth = s.borderLeftWidth = s.borderRightWidth = 1;
                s.borderTopColor = s.borderBottomColor = s.borderLeftColor = s.borderRightColor = (Color)new Color32(138, 138, 138, 255);
                s.alignItems = Align.Center;
            });
            pane.Add(dialog);
            Label title = MenuDialog.Label("Retro Flight Sim", 20, Color.white);
            title.style.unityFontStyleAndWeight = FontStyle.Bold;
            title.style.marginBottom = 16;
            dialog.Add(title);
            label = MenuDialog.Label("Loading terrain...", 14, new Color32(184, 184, 184, 255));
            label.style.marginBottom = 12;
            dialog.Add(label);
            var track = new VisualElement();
            MenuDialog.Style(track, s =>
            {
                s.width = 200;
                s.height = 8;
                s.backgroundColor = (Color)new Color32(60, 60, 60, 255);
            });
            fill = new VisualElement();
            MenuDialog.Style(fill, s =>
            {
                s.height = 8;
                s.width = Length.Percent(0);
                s.backgroundColor = Color.white;
            });
            track.Add(fill);
            dialog.Add(track);

            countdown = new VisualElement();
            MenuDialog.Style(countdown, s =>
            {
                s.position = Position.Absolute;
                s.left = s.right = s.top = s.bottom = 0;
                s.alignItems = Align.Center;
                s.justifyContent = Justify.Center;
                s.display = DisplayStyle.None;
            });
            countdown.pickingMode = PickingMode.Ignore;
            countdownText = MenuDialog.Label("", 128, Color.white);
            countdownText.style.unityFontStyleAndWeight = FontStyle.Bold;
            countdownText.style.textShadow = new TextShadow { color = Color.black, blurRadius = 8 };
            countdown.Add(countdownText);
            root.Add(countdown);
        }

        private void Set(float percent, string text)
        {
            fill.style.width = Length.Percent(Mathf.Clamp(percent, 0, 100));
            label.text = text;
        }

        /// <summary>holdUntilStreamed: a new spawn restarts the hold.</summary>
        private void BeginHold()
        {
            phase = Phase.Streaming;
            start = lastTick = Time.realtimeSinceStartup;
            idleSince = -1;
            prevBacklog = drained = 0;
            shown = 0;
            flight.held = true;
            pane.style.display = DisplayStyle.Flex;
            pane.style.backgroundColor = new Color(0, 0, 0, DimAlpha);
            dialog.style.visibility = Visibility.Visible;
            countdown.style.display = DisplayStyle.None;
            Set(0, "Streaming terrain... 0%");
            Blur(1);
        }

        /// <summary>
        /// The blurred backdrop at `amount` of its full strength (blur and dim
        /// together); 0 hands the camera back to the screen.
        /// </summary>
        private void Blur(float amount)
        {
            Camera cam = flight != null && flight.view != null ? flight.view.UnityCamera : null;
            if (amount <= 0 || cam == null)
            {
                if (blurred != null) blurred.targetTexture = null;
                blurred = null;
                backdrop.style.display = DisplayStyle.None;
                return;
            }
            int w = Mathf.Max(16, Screen.width), h = Mathf.Max(16, Screen.height);
            if (sharp == null || sharp.width != w || sharp.height != h)
            {
                if (blurred != null) blurred.targetTexture = null;
                Release();
                sharp = new RenderTexture(w, h, 24) { name = "streaming backdrop" };
                across = new RenderTexture(w, h, 0) { name = "streaming backdrop blur x" };
                blurredTexture = new RenderTexture(w, h, 0) { name = "streaming backdrop blur" };
                backdrop.style.backgroundImage = Background.FromRenderTexture(blurredTexture);
            }
            if (blurX == null)
            {
                Shader shader = Shader.Find("Hidden/Retro/BackdropBlur");
                blurX = new Material(shader);
                blurY = new Material(shader);
            }
            blurred = cam;
            cam.targetTexture = sharp;
            // CSS pixels on the web's 1080-line reference.
            blurPx = BlurCssPx * amount * h / 1080f;
            blurX.SetVector("_Step", new Vector4(blurPx / 4 / w, 0));
            blurY.SetVector("_Step", new Vector4(0, blurPx / 4 / h));
            // The dim, as a tint: black at 0.35 over the image is the image at 0.65.
            float keep = 1 - DimAlpha * amount;
            backdrop.style.unityBackgroundImageTintColor = new Color(keep, keep, keep, 1);
            backdrop.style.display = DisplayStyle.Flex;
        }

        private void AfterRender(ScriptableRenderContext context, Camera rendered)
        {
            if (rendered != blurred || sharp == null) return;
            var cmd = new CommandBuffer { name = "streaming backdrop blur" };
            if (blurPx < 0.5f) cmd.Blit(sharp, blurredTexture);
            else
            {
                cmd.Blit(sharp, across, blurX);
                cmd.Blit(across, blurredTexture, blurY);
            }
            context.ExecuteCommandBuffer(cmd);
            cmd.Release();
            context.Submit();
        }

        private void Release()
        {
            foreach (RenderTexture t in new[] { sharp, across, blurredTexture })
            {
                if (t == null) continue;
                t.Release();
                Destroy(t);
            }
            sharp = across = blurredTexture = null;
        }

        private void OnDestroy()
        {
            RenderPipelineManager.endCameraRendering -= AfterRender;
            if (blurred != null) blurred.targetTexture = null;
            Release();
            if (blurX != null) Destroy(blurX);
            if (blurY != null) Destroy(blurY);
        }

        /// <summary>What the LOD pass still waits for: terrain tiles and fine ground under the aircraft.</summary>
        private int Backlog() => terrain.pendingLoads + (flight.HeightField?.FineInFlight ?? 0);

        private void Update()
        {
            if (flight == null || terrain == null) return;
            if (!subscribed)
            {
                flight.FlightBegan += BeginHold;
                subscribed = true;
            }
            float now = Time.realtimeSinceStartup;
            switch (phase)
            {
                case Phase.Boot:
                    // Until the flight boots: the terrain's first tiles.
                    Set(Mathf.Min(90, 10 + terrain.uploadedTiles), terrain.uploadedTiles > 0
                        ? $"Loading terrain ({terrain.uploadedTiles})..."
                        : "Loading terrain...");
                    break;
                case Phase.Streaming:
                {
                    int backlog = Backlog();
                    drained += Mathf.Max(0, prevBacklog - backlog);
                    prevBacklog = backlog;
                    float target = backlog > 0 ? (float)drained / (drained + backlog) : 1;
                    float step = BarRatePerS * (now - lastTick);
                    lastTick = now;
                    shown = Mathf.Min(Mathf.Max(shown, target), shown + step);
                    Set(100 * shown, $"Streaming terrain... {Mathf.FloorToInt(100 * shown)}%");
                    Blur(1);
                    if (backlog > 0) idleSince = -1;
                    else if (idleSince < 0) idleSince = now;
                    bool settled = idleSince >= 0 && now - idleSince >= SettleS && shown >= 1;
                    if (settled || now - start >= HoldMaxS)
                    {
                        // The pane fades under the count; the flight starts on "Go".
                        phase = Phase.Countdown;
                        countdownStart = now;
                        dialog.style.visibility = Visibility.Hidden;
                        countdown.style.display = DisplayStyle.Flex;
                    }
                    break;
                }
                case Phase.Countdown:
                {
                    float t = now - countdownStart;
                    pane.style.backgroundColor = new Color(0, 0, 0, DimAlpha * Mathf.Clamp01(1 - t / FadeS));
                    Blur(Mathf.Clamp01(1 - t / FadeS));
                    int n = CountdownFrom - Mathf.FloorToInt(t);
                    if (n > 0)
                    {
                        countdownText.text = n.ToString();
                        // The pop: each number starts large and settles.
                        float k = t - Mathf.Floor(t);
                        countdownText.style.scale = new Scale(Vector3.one * Mathf.Lerp(1.4f, 1, k));
                        countdownText.style.opacity = Mathf.Lerp(1, 0.6f, k);
                    }
                    else
                    {
                        if (flight.held)
                        {
                            flight.held = false;
                            pane.style.display = DisplayStyle.None;
                        }
                        countdownText.text = "Go";
                        if (t - CountdownFrom >= GoShownS)
                        {
                            countdown.style.display = DisplayStyle.None;
                            phase = Phase.Done;
                        }
                    }
                    break;
                }
            }
        }
    }
}
