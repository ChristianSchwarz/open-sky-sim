using Retro.Core;
using Retro.Game;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Retro.Unity
{
    /// <summary>
    /// The cockpit's zoomed target view (game.ts targetCamera, scene/utils.ts
    /// updateTargetCamera on the ported <see cref="TargetCamera"/>): a second
    /// camera at the player, no lower than 15 m, aimed at the weapons target
    /// and zoomed by powers of two so it fills a useful part of the view,
    /// rendered into a texture the target MFD shows. Placed camera-relative
    /// like everything else: its Unity position is its scene offset from the
    /// main camera, so the world draws for it unchanged.
    /// </summary>
    [DefaultExecutionOrder(150)]
    public sealed class TargetCameraView : MonoBehaviour
    {
        public PlayerFlight flight;
        public FlyCamera viewer;

        [Header("State (read only)")]
        public double zoomFactor;

        private Camera cam;
        private RenderTexture texture;
        private readonly CameraPose main = new CameraPose();
        private readonly CameraPose pose = new CameraPose();

        /// <summary>The target view, or null while there is no target (in night vision, its greyscale).</summary>
        public Texture Texture => cam != null && cam.enabled ? (flight != null && flight.nightVision && night != null ? night : texture) : null;

        private RenderTexture night;
        private Material nightMaterial;

        private void Start()
        {
            cam = new GameObject("Target camera").AddComponent<Camera>();
            cam.transform.SetParent(transform, false);
            cam.clearFlags = CameraClearFlags.SolidColor;
            UniversalAdditionalCameraData data = cam.GetUniversalAdditionalCameraData();
            data.renderPostProcessing = false;
            data.renderShadows = false;
            Resize(256, 192);
            cam.enabled = false;
            RenderPipelineManager.endCameraRendering += AfterRender;
        }

        /// <summary>The I key's night view: the frame just rendered, turned to the night-vision greys.</summary>
        private void AfterRender(ScriptableRenderContext context, Camera rendered)
        {
            if (rendered != cam || flight == null || !flight.nightVision) return;
            if (nightMaterial == null) nightMaterial = new Material(Shader.Find("Hidden/Retro/NightVision"));
            if (night == null || night.width != texture.width || night.height != texture.height)
            {
                if (night != null)
                {
                    night.Release();
                    Destroy(night);
                }
                night = new RenderTexture(texture.width, texture.height, 0) { name = "target camera night", filterMode = FilterMode.Point };
            }
            var cmd = new CommandBuffer { name = "night vision" };
            cmd.Blit(texture, night, nightMaterial);
            context.ExecuteCommandBuffer(cmd);
            cmd.Release();
            context.Submit();
        }

        /// <summary>The texture's size: the MFD viewport it is shown in (half resolution on the web).</summary>
        public void Resize(int width, int height)
        {
            width = Mathf.Max(16, width);
            height = Mathf.Max(16, height);
            if (texture != null && texture.width == width && texture.height == height) return;
            if (texture != null)
            {
                cam.targetTexture = null;
                texture.Release();
                Destroy(texture);
            }
            texture = new RenderTexture(width, height, 24) { name = "target camera", filterMode = FilterMode.Point };
            cam.targetTexture = texture;
        }

        private void LateUpdate()
        {
            if (cam == null || flight == null || viewer == null || viewer.UnityCamera == null || flight.Sim == null)
            {
                return;
            }
            Camera mainCam = viewer.UnityCamera;
            main.Position = viewer.ScenePosition;
            main.Fov = mainCam.fieldOfView;
            main.Aspect = mainCam.aspect;
            zoomFactor = TargetCamera.UpdateTargetCamera(flight, main, pose);
            // The showcase draws the airframe alone: no target display.
            cam.enabled = zoomFactor > 0 && flight.flightView != FlightView.Showcase;
            if (!cam.enabled) return;
            cam.backgroundColor = mainCam.backgroundColor;
            cam.fieldOfView = (float)pose.Fov;
            cam.nearClipPlane = (float)pose.Near;
            cam.farClipPlane = (float)pose.Far;
            cam.aspect = (float)texture.width / texture.height;
            cam.transform.SetPositionAndRotation(SceneFrame.ToUnity(pose.Position - viewer.ScenePosition), SceneFrame.ToUnity(pose.Quaternion));
        }

        private void OnDestroy()
        {
            RenderPipelineManager.endCameraRendering -= AfterRender;
            if (night != null)
            {
                night.Release();
                Destroy(night);
            }
            if (texture != null)
            {
                texture.Release();
                Destroy(texture);
            }
        }
    }
}
