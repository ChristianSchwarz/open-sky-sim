using System.Collections.Generic;

namespace Retro.Core
{
    /// <summary>
    /// THREE.ShapeUtils (three/src/extras/ShapeUtils.js, three 0.185): contour
    /// area, winding and <c>triangulateShape</c> on top of <see cref="Earcut"/>,
    /// index for index what the browser returns.
    /// </summary>
    public static class ShapeUtils
    {
        /// <summary>ShapeUtils.area: signed area, positive counter-clockwise (x right, y up).</summary>
        public static double Area(IReadOnlyList<(double X, double Y)> contour)
        {
            int n = contour.Count;
            double a = 0.0;

            for (int p = n - 1, q = 0; q < n; p = q++)
            {
                a += contour[p].X * contour[q].Y - contour[q].X * contour[p].Y;
            }

            return a * 0.5;
        }

        /// <summary>ShapeUtils.isClockWise: <c>Area(pts) &lt; 0</c>.</summary>
        public static bool IsClockWise(IReadOnlyList<(double X, double Y)> pts)
        {
            return Area(pts) < 0;
        }

        /// <summary>
        /// ShapeUtils.triangulateShape. Faces index the contour's points followed
        /// by each hole's, after three's <c>removeDupEndPts</c>: a ring of more
        /// than two points whose last point equals its first (exactly) loses
        /// the last one. three pops it from the caller's arrays; this leaves the
        /// inputs alone, so a caller that indexes its own unshortened arrays
        /// (as buildingRoofs.ts does with courtyards) must allow for that.
        /// Input winding is free: earcut re-orients each ring itself.
        /// A hole with no points throws, as three does.
        /// </summary>
        public static List<int[]> TriangulateShape(
            IReadOnlyList<(double X, double Y)> contour,
            IReadOnlyList<IReadOnlyList<(double X, double Y)>> holes)
        {
            var vertices = new List<double>(); // flat array of vertices like [ x0,y0, x1,y1, x2,y2, ... ]
            var holeIndices = new List<int>(); // array of hole indices
            var faces = new List<int[]>(); // final array of vertex indices like [ [ a,b,d ], [ b,c,d ] ]

            int contourLength = KeptLength(contour);
            AddContour(vertices, contour, contourLength);

            int holeIndex = contourLength;

            if (holes != null)
            {
                for (int i = 0; i < holes.Count; i++)
                {
                    int length = KeptLength(holes[i]);
                    holeIndices.Add(holeIndex);
                    holeIndex += length;
                    AddContour(vertices, holes[i], length);
                }
            }

            List<int> triangles = Earcut.Triangulate(vertices, holeIndices);

            for (int i = 0; i < triangles.Count; i += 3)
            {
                // three slices; a trailing partial face cannot occur (earcut emits threes).
                faces.Add(new[] { triangles[i], triangles[i + 1], triangles[i + 2] });
            }

            return faces;
        }

        /// <summary>The ring's length after removeDupEndPts.</summary>
        private static int KeptLength(IReadOnlyList<(double X, double Y)> points)
        {
            int l = points.Count;
            if (l > 2 && points[l - 1].X == points[0].X && points[l - 1].Y == points[0].Y)
            {
                return l - 1;
            }
            return l;
        }

        private static void AddContour(List<double> vertices, IReadOnlyList<(double X, double Y)> contour, int length)
        {
            for (int i = 0; i < length; i++)
            {
                vertices.Add(contour[i].X);
                vertices.Add(contour[i].Y);
            }
        }
    }
}
