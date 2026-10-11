using Retro.Core;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// Open sea where the index has no tile: a camera-centred grid whose height
    /// follows the earth's curvature in the vertex shader (seaLevelSceneY), so
    /// the horizon falls away like the curved terrain tiles do. The TS game uses
    /// per-tile ellipsoid patches; one curved grid is the spike's stand-in.
    /// </summary>
    [DefaultExecutionOrder(110)]
    public sealed class SeaSurface : MonoBehaviour
    {
        public FlyCamera viewer;
        public Material material;
        [Tooltip("Metres below the tiles' baked water, so coastal water wins the depth test.")]
        public float sink = 1.5f;

        private Mesh grid;

        private void Start()
        {
            if (material == null)
            {
                material = new Material(Shader.Find("Retro/SeaSurface"));
                material.SetColor("_Color", TerrainColours.FromHex(TerrainColours.WaterHex));
            }
            grid = BuildGrid(96, 3_000_000f);
        }

        /// <summary>Rings densest near the camera: radius grows quadratically with ring index.</summary>
        private static Mesh BuildGrid(int rings, float radius)
        {
            const int segments = 96;
            var vertices = new Vector3[rings * segments + 1];
            vertices[0] = Vector3.zero;
            for (int r = 1; r <= rings; r++)
            {
                float t = (float)r / rings;
                float rr = radius * t * t;
                for (int s = 0; s < segments; s++)
                {
                    float a = s * Mathf.PI * 2 / segments;
                    vertices[(r - 1) * segments + s + 1] = new Vector3(Mathf.Cos(a) * rr, 0, Mathf.Sin(a) * rr);
                }
            }
            var indices = new System.Collections.Generic.List<int>();
            for (int s = 0; s < segments; s++)
            {
                indices.Add(0);
                indices.Add(1 + (s + 1) % segments);
                indices.Add(1 + s);
            }
            for (int r = 1; r < rings; r++)
            {
                int a0 = (r - 1) * segments + 1, b0 = r * segments + 1;
                for (int s = 0; s < segments; s++)
                {
                    int s1 = (s + 1) % segments;
                    indices.Add(a0 + s); indices.Add(a0 + s1); indices.Add(b0 + s);
                    indices.Add(a0 + s1); indices.Add(b0 + s1); indices.Add(b0 + s);
                }
            }
            var mesh = new Mesh { name = "sea grid", indexFormat = IndexFormat.UInt32 };
            mesh.SetVertices(vertices);
            mesh.SetTriangles(indices, 0);
            mesh.bounds = new Bounds(Vector3.zero, new Vector3(radius * 2, 400000, radius * 2));
            return mesh;
        }

        private void Update()
        {
            if (viewer == null || grid == null) return;
            Vec3d cam = viewer.ScenePosition;
            // The shader adds the curvature drop for scene (x, z) = camera + vertex offset.
            material.SetVector("_CameraScene", new Vector4((float)cam.X, (float)cam.Y, (float)cam.Z, sink));
            material.SetFloat("_EarthRadius", (float)Geodesy.Wgs84A);
            var rp = new RenderParams(material) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            Graphics.RenderMesh(rp, grid, 0, Matrix4x4.identity);
        }
    }
}
