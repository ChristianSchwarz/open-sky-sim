using System.Collections.Generic;
using UnityEngine;

namespace Retro.Unity
{
    /// <summary>
    /// The F12 showcase's rendering and picking (game.ts enterShowcaseView,
    /// updateShowcasePicking, applyShowcaseHighlight): the player's airframe
    /// is the only thing drawn (its parts move to their own layer and the
    /// camera culls everything else, every RenderMesh draw included) on a
    /// black backdrop without fog; the part under the mouse is named, and
    /// while the button is held it turns yellow.
    /// </summary>
    public sealed class Showcase
    {
        /// <summary>The layer the showcased airframe is drawn on (an otherwise unused one).</summary>
        public const int Layer = 30;

        private readonly Dictionary<Transform, int> savedLayers = new Dictionary<Transform, int>();
        private int savedMask;
        private CameraClearFlags savedClear;
        private Color savedBackground;
        private bool savedFog;
        private Renderer highlighted;
        private Material[] highlightOriginal;
        private Material yellow;
        private readonly List<Vector3> vertices = new List<Vector3>();
        private readonly List<int> triangles = new List<int>();

        public bool Active { get; private set; }

        public void Enter(Transform model, Camera camera)
        {
            if (Active || model == null) return;
            Active = true;
            savedLayers.Clear();
            foreach (Transform t in model.GetComponentsInChildren<Transform>(true))
            {
                savedLayers[t] = t.gameObject.layer;
                t.gameObject.layer = Layer;
            }
            savedMask = camera.cullingMask;
            savedClear = camera.clearFlags;
            savedBackground = camera.backgroundColor;
            savedFog = RenderSettings.fog;
            camera.cullingMask = 1 << Layer;
            camera.clearFlags = CameraClearFlags.SolidColor;
            // ShowcasePalette: daytime aircraft colours on pure black, fog off.
            camera.backgroundColor = Color.black;
            RenderSettings.fog = false;
        }

        public void Exit(Camera camera)
        {
            if (!Active) return;
            Active = false;
            ClearHighlight();
            foreach (var (t, layer) in savedLayers)
            {
                if (t != null) t.gameObject.layer = layer;
            }
            savedLayers.Clear();
            camera.cullingMask = savedMask;
            camera.clearFlags = savedClear;
            camera.backgroundColor = savedBackground;
            RenderSettings.fog = savedFog;
        }

        /// <summary>
        /// updateShowcasePicking: the nearest drawn part under the screen point, or null; held,
        /// that part is highlighted, else any highlight goes.
        /// </summary>
        public string Pick(Transform model, Camera camera, Vector2 screen, bool held)
        {
            if (!Active || model == null)
            {
                ClearHighlight();
                return null;
            }
            Ray ray = camera.ScreenPointToRay(screen);
            Renderer best = null;
            float bestT = float.PositiveInfinity;
            foreach (MeshFilter mf in model.GetComponentsInChildren<MeshFilter>(false))
            {
                Renderer r = mf.GetComponent<Renderer>();
                Mesh mesh = mf.sharedMesh;
                if (r == null || !r.enabled || mesh == null || !mesh.isReadable) continue;
                if (!r.bounds.IntersectRay(ray)) continue;
                Matrix4x4 toWorld = mf.transform.localToWorldMatrix;
                mesh.GetVertices(vertices);
                for (int sub = 0; sub < mesh.subMeshCount; sub++)
                {
                    if (mesh.GetTopology(sub) != MeshTopology.Triangles) continue;
                    mesh.GetTriangles(triangles, sub);
                    for (int i = 0; i + 2 < triangles.Count; i += 3)
                    {
                        Vector3 a = toWorld.MultiplyPoint3x4(vertices[triangles[i]]);
                        Vector3 b = toWorld.MultiplyPoint3x4(vertices[triangles[i + 1]]);
                        Vector3 c = toWorld.MultiplyPoint3x4(vertices[triangles[i + 2]]);
                        if (Intersect(ray, a, b, c, out float t) && t < bestT)
                        {
                            bestT = t;
                            best = r;
                        }
                    }
                }
            }
            if (held && best != null) Highlight(best);
            else ClearHighlight();
            if (best == null) return null;
            string name = best.gameObject.name;
            return string.IsNullOrEmpty(name) ? "(unnamed)" : name;
        }

        /// <summary>Möller–Trumbore, both faces.</summary>
        private static bool Intersect(Ray ray, Vector3 a, Vector3 b, Vector3 c, out float t)
        {
            t = 0;
            Vector3 e1 = b - a, e2 = c - a;
            Vector3 p = Vector3.Cross(ray.direction, e2);
            float det = Vector3.Dot(e1, p);
            if (Mathf.Abs(det) < 1e-8f) return false;
            float inv = 1 / det;
            Vector3 s = ray.origin - a;
            float u = Vector3.Dot(s, p) * inv;
            if (u < 0 || u > 1) return false;
            Vector3 q = Vector3.Cross(s, e1);
            float v = Vector3.Dot(ray.direction, q) * inv;
            if (v < 0 || u + v > 1) return false;
            t = Vector3.Dot(e2, q) * inv;
            return t > 0;
        }

        private void Highlight(Renderer r)
        {
            if (highlighted == r) return;
            ClearHighlight();
            if (yellow == null)
            {
                yellow = new Material(Shader.Find("Retro/SceneryLit")) { name = "showcase highlight" };
                yellow.SetColor("_Color", new Color32(0xff, 0xff, 0x66, 0xff));
                yellow.SetFloat("_GltfWinding", 1);
                yellow.SetFloat("_Cull", (float)UnityEngine.Rendering.CullMode.Back);
            }
            highlighted = r;
            highlightOriginal = r.sharedMaterials;
            var mats = new Material[highlightOriginal.Length];
            for (int i = 0; i < mats.Length; i++) mats[i] = yellow;
            r.sharedMaterials = mats;
        }

        public void ClearHighlight()
        {
            if (highlighted != null) highlighted.sharedMaterials = highlightOriginal;
            highlighted = null;
            highlightOriginal = null;
        }
    }
}
