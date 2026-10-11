using System;
using System.Collections.Generic;

namespace Retro.Core
{
    /// <summary>
    /// Polygon triangulation exactly as three.js does it: a line-for-line port
    /// of three/src/extras/lib/earcut.js (mapbox/earcut 3.0.2, three 0.185),
    /// which <c>THREE.Earcut.triangulate</c> and <c>ShapeUtils.triangulateShape</c>
    /// call. The port keeps every comparison, the JS truthiness of numbers
    /// (0 and NaN are false), the <c>| 0</c> int32 conversions of the z-order
    /// hash and V8's stable sort of the holes, so it returns the same indices
    /// in the same order as the browser for the same doubles.
    /// </summary>
    public static class Earcut
    {
        private sealed class Node
        {
            public int I;
            public double X, Y;
            public Node Prev, Next;
            public int Z;
            public Node PrevZ, NextZ;
            public bool Steiner;
        }

        /// <summary>
        /// earcut(data, holeIndices, dim): `data` is flat coordinates, `holeIndices`
        /// the vertex index each hole starts at (null or empty for none). Returns
        /// vertex indices, three per triangle.
        /// </summary>
        public static List<int> Triangulate(IReadOnlyList<double> data, IReadOnlyList<int> holeIndices = null, int dim = 2)
        {
            bool hasHoles = holeIndices != null && holeIndices.Count > 0;
            int outerLen = hasHoles ? holeIndices[0] * dim : data.Count;
            Node outerNode = LinkedList(data, 0, outerLen, dim, true);
            var triangles = new List<int>();

            if (outerNode == null || outerNode.Next == outerNode.Prev) return triangles;

            double minX = 0, minY = 0, invSize = 0;

            if (hasHoles) outerNode = EliminateHoles(data, holeIndices, outerNode, dim);

            // If the shape is not too simple, a z-order curve hash is used later; calculate the polygon bbox.
            if (data.Count > 80 * dim)
            {
                minX = data[0];
                minY = data[1];
                double maxX = minX;
                double maxY = minY;

                for (int i = dim; i < outerLen; i += dim)
                {
                    double x = data[i];
                    double y = data[i + 1];
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }

                // minX, minY and invSize are later used to transform coords into integers for z-order calculation.
                invSize = Math.Max(maxX - minX, maxY - minY);
                invSize = invSize != 0 ? 32767 / invSize : 0;
            }

            EarcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);

            return triangles;
        }

        /// <summary>JS truthiness of a number: false for 0, -0 and NaN.</summary>
        private static bool Truthy(double v) => v != 0 && !double.IsNaN(v);

        /// <summary>JS ToInt32 (the <c>x | 0</c> conversion).</summary>
        internal static int ToInt32(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
            double t = Math.Truncate(v);
            if (t >= int.MinValue && t <= int.MaxValue) return (int)t;
            double m = t % 4294967296.0;
            if (m < 0) m += 4294967296.0;
            return unchecked((int)(uint)m);
        }

        // Create a circular doubly linked list from polygon points in the specified winding order.
        private static Node LinkedList(IReadOnlyList<double> data, int start, int end, int dim, bool clockwise)
        {
            Node last = null;

            if (clockwise == (SignedArea(data, start, end, dim) > 0))
            {
                for (int i = start; i < end; i += dim) last = InsertNode(i / dim, data[i], data[i + 1], last);
            }
            else
            {
                for (int i = end - dim; i >= start; i -= dim) last = InsertNode(i / dim, data[i], data[i + 1], last);
            }

            if (last != null && EqualsPt(last, last.Next))
            {
                RemoveNode(last);
                last = last.Next;
            }

            return last;
        }

        // Eliminate colinear or duplicate points.
        private static Node FilterPoints(Node start, Node end = null)
        {
            if (start == null) return start;
            if (end == null) end = start;

            Node p = start;
            bool again;
            do
            {
                again = false;

                if (!p.Steiner && (EqualsPt(p, p.Next) || Area(p.Prev, p, p.Next) == 0))
                {
                    RemoveNode(p);
                    p = end = p.Prev;
                    if (p == p.Next) break;
                    again = true;
                }
                else
                {
                    p = p.Next;
                }
            } while (again || p != end);

            return end;
        }

        // Main ear slicing loop which triangulates a polygon (given as a linked list).
        private static void EarcutLinked(Node ear, List<int> triangles, int dim, double minX, double minY, double invSize, int pass)
        {
            if (ear == null) return;

            // Interlink polygon nodes in z-order.
            if (pass == 0 && Truthy(invSize)) IndexCurve(ear, minX, minY, invSize);

            Node stop = ear;

            // Iterate through ears, slicing them one by one.
            while (ear.Prev != ear.Next)
            {
                Node prev = ear.Prev;
                Node next = ear.Next;

                if (Truthy(invSize) ? IsEarHashed(ear, minX, minY, invSize) : IsEar(ear))
                {
                    triangles.Add(prev.I);
                    triangles.Add(ear.I);
                    triangles.Add(next.I);

                    RemoveNode(ear);

                    // Skipping the next vertex leads to less sliver triangles.
                    ear = next.Next;
                    stop = next.Next;

                    continue;
                }

                ear = next;

                // If we looped through the whole remaining polygon and can't find any more ears:
                if (ear == stop)
                {
                    if (pass == 0)
                    {
                        // try filtering points and slicing again,
                        EarcutLinked(FilterPoints(ear), triangles, dim, minX, minY, invSize, 1);
                    }
                    else if (pass == 1)
                    {
                        // if this didn't work, try curing all small self-intersections locally,
                        ear = CureLocalIntersections(FilterPoints(ear), triangles);
                        EarcutLinked(ear, triangles, dim, minX, minY, invSize, 2);
                    }
                    else if (pass == 2)
                    {
                        // and as a last resort, try splitting the remaining polygon into two.
                        SplitEarcut(ear, triangles, dim, minX, minY, invSize);
                    }

                    break;
                }
            }
        }

        // Check whether a polygon node forms a valid ear with adjacent nodes.
        private static bool IsEar(Node ear)
        {
            Node a = ear.Prev, b = ear, c = ear.Next;

            if (Area(a, b, c) >= 0) return false; // reflex, can't be an ear

            // Now make sure we don't have other points inside the potential ear.
            double ax = a.X, bx = b.X, cx = c.X, ay = a.Y, by = b.Y, cy = c.Y;

            // Triangle bbox.
            double x0 = Min3(ax, bx, cx), y0 = Min3(ay, by, cy), x1 = Max3(ax, bx, cx), y1 = Max3(ay, by, cy);

            Node p = c.Next;
            while (p != a)
            {
                if (p.X >= x0 && p.X <= x1 && p.Y >= y0 && p.Y <= y1 &&
                    PointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p.X, p.Y) &&
                    Area(p.Prev, p, p.Next) >= 0) return false;
                p = p.Next;
            }

            return true;
        }

        private static bool IsEarHashed(Node ear, double minX, double minY, double invSize)
        {
            Node a = ear.Prev, b = ear, c = ear.Next;

            if (Area(a, b, c) >= 0) return false; // reflex, can't be an ear

            double ax = a.X, bx = b.X, cx = c.X, ay = a.Y, by = b.Y, cy = c.Y;

            // Triangle bbox.
            double x0 = Min3(ax, bx, cx), y0 = Min3(ay, by, cy), x1 = Max3(ax, bx, cx), y1 = Max3(ay, by, cy);

            // Z-order range for the current triangle bbox.
            int minZ = ZOrder(x0, y0, minX, minY, invSize), maxZ = ZOrder(x1, y1, minX, minY, invSize);

            Node p = ear.PrevZ, n = ear.NextZ;

            // Look for points inside the triangle in both directions.
            while (p != null && p.Z >= minZ && n != null && n.Z <= maxZ)
            {
                if (p.X >= x0 && p.X <= x1 && p.Y >= y0 && p.Y <= y1 && p != a && p != c &&
                    PointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p.X, p.Y) && Area(p.Prev, p, p.Next) >= 0) return false;
                p = p.PrevZ;

                if (n.X >= x0 && n.X <= x1 && n.Y >= y0 && n.Y <= y1 && n != a && n != c &&
                    PointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, n.X, n.Y) && Area(n.Prev, n, n.Next) >= 0) return false;
                n = n.NextZ;
            }

            // Look for remaining points in decreasing z-order.
            while (p != null && p.Z >= minZ)
            {
                if (p.X >= x0 && p.X <= x1 && p.Y >= y0 && p.Y <= y1 && p != a && p != c &&
                    PointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p.X, p.Y) && Area(p.Prev, p, p.Next) >= 0) return false;
                p = p.PrevZ;
            }

            // Look for remaining points in increasing z-order.
            while (n != null && n.Z <= maxZ)
            {
                if (n.X >= x0 && n.X <= x1 && n.Y >= y0 && n.Y <= y1 && n != a && n != c &&
                    PointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, n.X, n.Y) && Area(n.Prev, n, n.Next) >= 0) return false;
                n = n.NextZ;
            }

            return true;
        }

        // Go through all polygon nodes and cure small local self-intersections.
        private static Node CureLocalIntersections(Node start, List<int> triangles)
        {
            Node p = start;
            do
            {
                Node a = p.Prev, b = p.Next.Next;

                if (!EqualsPt(a, b) && Intersects(a, p, p.Next, b) && LocallyInside(a, b) && LocallyInside(b, a))
                {
                    triangles.Add(a.I);
                    triangles.Add(p.I);
                    triangles.Add(b.I);

                    // Remove two nodes involved.
                    RemoveNode(p);
                    RemoveNode(p.Next);

                    p = start = b;
                }
                p = p.Next;
            } while (p != start);

            return FilterPoints(p);
        }

        // Try splitting the polygon into two and triangulate them independently.
        private static void SplitEarcut(Node start, List<int> triangles, int dim, double minX, double minY, double invSize)
        {
            // Look for a valid diagonal that divides the polygon into two.
            Node a = start;
            do
            {
                Node b = a.Next.Next;
                while (b != a.Prev)
                {
                    if (a.I != b.I && IsValidDiagonal(a, b))
                    {
                        // Split the polygon in two by the diagonal.
                        Node c = SplitPolygon(a, b);

                        // Filter colinear points around the cuts.
                        a = FilterPoints(a, a.Next);
                        c = FilterPoints(c, c.Next);

                        // Run earcut on each half.
                        EarcutLinked(a, triangles, dim, minX, minY, invSize, 0);
                        EarcutLinked(c, triangles, dim, minX, minY, invSize, 0);
                        return;
                    }
                    b = b.Next;
                }
                a = a.Next;
            } while (a != start);
        }

        // Link every hole into the outer loop, producing a single-ring polygon without holes.
        private static Node EliminateHoles(IReadOnlyList<double> data, IReadOnlyList<int> holeIndices, Node outerNode, int dim)
        {
            var queue = new List<Node>();

            for (int i = 0, len = holeIndices.Count; i < len; i++)
            {
                int start = holeIndices[i] * dim;
                int end = i < len - 1 ? holeIndices[i + 1] * dim : data.Count;
                Node list = LinkedList(data, start, end, dim, false);
                // three throws a TypeError here (reading `next` of undefined) for an empty hole.
                if (list == null) throw new ArgumentException($"earcut: hole {i} has no vertices");
                if (list == list.Next) list.Steiner = true;
                queue.Add(GetLeftmost(list));
            }

            V8Sort(queue, CompareXYSlope);

            // Process holes from left to right.
            for (int i = 0; i < queue.Count; i++)
            {
                outerNode = EliminateHole(queue[i], outerNode);
            }

            return outerNode;
        }

        private static double CompareXYSlope(Node a, Node b)
        {
            double result = a.X - b.X;
            // When the left-most point of 2 holes meet at a vertex, sort the holes counterclockwise so that when we find
            // the bridge to the outer shell is always the point that they meet at.
            if (result == 0)
            {
                result = a.Y - b.Y;
                if (result == 0)
                {
                    double aSlope = (a.Next.Y - a.Y) / (a.Next.X - a.X);
                    double bSlope = (b.Next.Y - b.Y) / (b.Next.X - b.X);
                    result = aSlope - bSlope;
                }
            }
            return result;
        }

        /// <summary>
        /// Array.prototype.sort as V8 runs it on a short array: TimSort's first
        /// run (descending runs reversed) extended by binary insertion. For
        /// arrays under 64 elements that is all TimSort does, so the order is
        /// the browser's even for a comparator that returns NaN (taken as "not
        /// less"). Longer arrays get a stable merge sort, which equals V8's for
        /// every consistent comparator.
        /// </summary>
        internal static void V8Sort<T>(List<T> a, Func<T, T, double> cmp)
        {
            int n = a.Count;
            if (n < 2) return;
            if (n >= 64)
            {
                StableMergeSort(a, cmp);
                return;
            }
            // CountAndMakeRun(0, n).
            int runLength = 2;
            double order = cmp(a[1], a[0]);
            bool isDescending = order < 0;
            T previous = a[1];
            for (int idx = 2; idx < n; idx++)
            {
                T current = a[idx];
                order = cmp(current, previous);
                if (isDescending)
                {
                    if (order >= 0) break;
                }
                else
                {
                    if (order < 0) break;
                }
                previous = current;
                runLength++;
            }
            if (isDescending) a.Reverse(0, runLength);
            // BinaryInsertionSort(0, runLength, n).
            for (int start = runLength; start < n; start++)
            {
                int left = 0, right = start;
                T pivot = a[start];
                while (left < right)
                {
                    int mid = left + ((right - left) >> 1);
                    double o = cmp(pivot, a[mid]);
                    if (o < 0) right = mid;
                    else left = mid + 1;
                }
                for (int p = start; p > left; p--) a[p] = a[p - 1];
                a[left] = pivot;
            }
        }

        private static void StableMergeSort<T>(List<T> a, Func<T, T, double> cmp)
        {
            var src = a.ToArray();
            var tmp = new T[src.Length];
            for (int width = 1; width < src.Length; width *= 2)
            {
                for (int lo = 0; lo < src.Length; lo += 2 * width)
                {
                    int mid = Math.Min(lo + width, src.Length), hi = Math.Min(lo + 2 * width, src.Length);
                    int i = lo, j = mid, k = lo;
                    while (i < mid && j < hi) tmp[k++] = cmp(src[j], src[i]) < 0 ? src[j++] : src[i++];
                    while (i < mid) tmp[k++] = src[i++];
                    while (j < hi) tmp[k++] = src[j++];
                }
                var t = src;
                src = tmp;
                tmp = t;
            }
            for (int i = 0; i < src.Length; i++) a[i] = src[i];
        }

        // Find a bridge between vertices that connects the hole with the outer ring and link it.
        private static Node EliminateHole(Node hole, Node outerNode)
        {
            Node bridge = FindHoleBridge(hole, outerNode);
            if (bridge == null)
            {
                return outerNode;
            }

            Node bridgeReverse = SplitPolygon(bridge, hole);

            // Filter collinear points around the cuts.
            FilterPoints(bridgeReverse, bridgeReverse.Next);
            return FilterPoints(bridge, bridge.Next);
        }

        // David Eberly's algorithm for finding a bridge between a hole and the outer polygon.
        private static Node FindHoleBridge(Node hole, Node outerNode)
        {
            Node p = outerNode;
            double hx = hole.X;
            double hy = hole.Y;
            double qx = double.NegativeInfinity;
            Node m = null;

            // Find a segment intersected by a ray from the hole's leftmost point to the left;
            // the segment's endpoint with lesser x will be the potential connection point,
            // unless they intersect at a vertex, then choose the vertex.
            if (EqualsPt(hole, p)) return p;
            do
            {
                if (EqualsPt(hole, p.Next)) return p.Next;
                else if (hy <= p.Y && hy >= p.Next.Y && p.Next.Y != p.Y)
                {
                    double x = p.X + (hy - p.Y) * (p.Next.X - p.X) / (p.Next.Y - p.Y);
                    if (x <= hx && x > qx)
                    {
                        qx = x;
                        m = p.X < p.Next.X ? p : p.Next;
                        if (x == hx) return m; // hole touches outer segment; pick leftmost endpoint
                    }
                }
                p = p.Next;
            } while (p != outerNode);

            if (m == null) return null;

            // Look for points inside the triangle of hole point, segment intersection and endpoint;
            // if there are no points found, we have a valid connection;
            // otherwise choose the point of the minimum angle with the ray as the connection point.

            Node stop = m;
            double mx = m.X;
            double my = m.Y;
            double tanMin = double.PositiveInfinity;

            p = m;

            do
            {
                if (hx >= p.X && p.X >= mx && hx != p.X &&
                    PointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.X, p.Y))
                {
                    double tan = Math.Abs(hy - p.Y) / (hx - p.X); // tangential

                    if (LocallyInside(p, hole) &&
                        (tan < tanMin || (tan == tanMin && (p.X > m.X || (p.X == m.X && SectorContainsSector(m, p))))))
                    {
                        m = p;
                        tanMin = tan;
                    }
                }

                p = p.Next;
            } while (p != stop);

            return m;
        }

        // Whether the sector in vertex m contains the sector in vertex p in the same coordinates.
        private static bool SectorContainsSector(Node m, Node p)
        {
            return Area(m.Prev, m, p.Prev) < 0 && Area(p.Next, m, m.Next) < 0;
        }

        // Interlink polygon nodes in z-order.
        private static void IndexCurve(Node start, double minX, double minY, double invSize)
        {
            Node p = start;
            do
            {
                if (p.Z == 0) p.Z = ZOrder(p.X, p.Y, minX, minY, invSize);
                p.PrevZ = p.Prev;
                p.NextZ = p.Next;
                p = p.Next;
            } while (p != start);

            p.PrevZ.NextZ = null;
            p.PrevZ = null;

            SortLinked(p);
        }

        // Simon Tatham's linked list merge sort algorithm.
        private static Node SortLinked(Node list)
        {
            int numMerges;
            int inSize = 1;

            do
            {
                Node p = list;
                Node e;
                list = null;
                Node tail = null;
                numMerges = 0;

                while (p != null)
                {
                    numMerges++;
                    Node q = p;
                    int pSize = 0;
                    for (int i = 0; i < inSize; i++)
                    {
                        pSize++;
                        q = q.NextZ;
                        if (q == null) break;
                    }
                    int qSize = inSize;

                    while (pSize > 0 || (qSize > 0 && q != null))
                    {
                        if (pSize != 0 && (qSize == 0 || q == null || p.Z <= q.Z))
                        {
                            e = p;
                            p = p.NextZ;
                            pSize--;
                        }
                        else
                        {
                            e = q;
                            q = q.NextZ;
                            qSize--;
                        }

                        if (tail != null) tail.NextZ = e;
                        else list = e;

                        e.PrevZ = tail;
                        tail = e;
                    }

                    p = q;
                }

                tail.NextZ = null;
                inSize *= 2;
            } while (numMerges > 1);

            return list;
        }

        // Z-order of a point given coords and the inverse of the longer side of the data bbox.
        private static int ZOrder(double xd, double yd, double minX, double minY, double invSize)
        {
            // Coords are transformed into the non-negative 15-bit integer range.
            int x = ToInt32((xd - minX) * invSize);
            int y = ToInt32((yd - minY) * invSize);

            x = (x | (x << 8)) & 0x00FF00FF;
            x = (x | (x << 4)) & 0x0F0F0F0F;
            x = (x | (x << 2)) & 0x33333333;
            x = (x | (x << 1)) & 0x55555555;

            y = (y | (y << 8)) & 0x00FF00FF;
            y = (y | (y << 4)) & 0x0F0F0F0F;
            y = (y | (y << 2)) & 0x33333333;
            y = (y | (y << 1)) & 0x55555555;

            return x | (y << 1);
        }

        // Find the leftmost node of a polygon ring.
        private static Node GetLeftmost(Node start)
        {
            Node p = start, leftmost = start;
            do
            {
                if (p.X < leftmost.X || (p.X == leftmost.X && p.Y < leftmost.Y)) leftmost = p;
                p = p.Next;
            } while (p != start);

            return leftmost;
        }

        // Check if a point lies within a convex triangle.
        private static bool PointInTriangle(double ax, double ay, double bx, double by, double cx, double cy, double px, double py)
        {
            return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
                   (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
                   (bx - px) * (cy - py) >= (cx - px) * (by - py);
        }

        // Check if a point lies within a convex triangle but false if it equals the first point of the triangle.
        private static bool PointInTriangleExceptFirst(double ax, double ay, double bx, double by, double cx, double cy, double px, double py)
        {
            return !(ax == px && ay == py) && PointInTriangle(ax, ay, bx, by, cx, cy, px, py);
        }

        // Check if a diagonal between two polygon nodes is valid (lies in the polygon interior).
        private static bool IsValidDiagonal(Node a, Node b)
        {
            return a.Next.I != b.I && a.Prev.I != b.I && !IntersectsPolygon(a, b) && // doesn't intersect other edges
                   ((LocallyInside(a, b) && LocallyInside(b, a) && MiddleInside(a, b) && // locally visible
                     (Truthy(Area(a.Prev, a, b.Prev)) || Truthy(Area(a, b.Prev, b)))) || // does not create opposite-facing sectors
                    (EqualsPt(a, b) && Area(a.Prev, a, a.Next) > 0 && Area(b.Prev, b, b.Next) > 0)); // special zero-length case
        }

        // Signed area of a triangle.
        private static double Area(Node p, Node q, Node r)
        {
            return (q.Y - p.Y) * (r.X - q.X) - (q.X - p.X) * (r.Y - q.Y);
        }

        // Check if two points are equal.
        private static bool EqualsPt(Node p1, Node p2)
        {
            return p1.X == p2.X && p1.Y == p2.Y;
        }

        // Check if two segments intersect.
        private static bool Intersects(Node p1, Node q1, Node p2, Node q2)
        {
            int o1 = Sign(Area(p1, q1, p2));
            int o2 = Sign(Area(p1, q1, q2));
            int o3 = Sign(Area(p2, q2, p1));
            int o4 = Sign(Area(p2, q2, q1));

            if (o1 != o2 && o3 != o4) return true; // general case

            if (o1 == 0 && OnSegment(p1, p2, q1)) return true; // p1, q1 and p2 are collinear and p2 lies on p1q1
            if (o2 == 0 && OnSegment(p1, q2, q1)) return true; // p1, q1 and q2 are collinear and q2 lies on p1q1
            if (o3 == 0 && OnSegment(p2, p1, q2)) return true; // p2, q2 and p1 are collinear and p1 lies on p2q2
            if (o4 == 0 && OnSegment(p2, q1, q2)) return true; // p2, q2 and q1 are collinear and q1 lies on p2q2

            return false;
        }

        // For collinear points p, q, r, check if point q lies on segment pr.
        private static bool OnSegment(Node p, Node q, Node r)
        {
            return q.X <= JsMax(p.X, r.X) && q.X >= JsMin(p.X, r.X) && q.Y <= JsMax(p.Y, r.Y) && q.Y >= JsMin(p.Y, r.Y);
        }

        private static int Sign(double num)
        {
            return num > 0 ? 1 : num < 0 ? -1 : 0;
        }

        // Check if a polygon diagonal intersects any polygon segments.
        private static bool IntersectsPolygon(Node a, Node b)
        {
            Node p = a;
            do
            {
                if (p.I != a.I && p.Next.I != a.I && p.I != b.I && p.Next.I != b.I &&
                    Intersects(p, p.Next, a, b)) return true;
                p = p.Next;
            } while (p != a);

            return false;
        }

        // Check if a polygon diagonal is locally inside the polygon.
        private static bool LocallyInside(Node a, Node b)
        {
            return Area(a.Prev, a, a.Next) < 0
                ? Area(a, b, a.Next) >= 0 && Area(a, a.Prev, b) >= 0
                : Area(a, b, a.Prev) < 0 || Area(a, a.Next, b) < 0;
        }

        // Check if the middle point of a polygon diagonal is inside the polygon.
        private static bool MiddleInside(Node a, Node b)
        {
            Node p = a;
            bool inside = false;
            double px = (a.X + b.X) / 2;
            double py = (a.Y + b.Y) / 2;
            do
            {
                if (((p.Y > py) != (p.Next.Y > py)) && p.Next.Y != p.Y &&
                    (px < (p.Next.X - p.X) * (py - p.Y) / (p.Next.Y - p.Y) + p.X))
                    inside = !inside;
                p = p.Next;
            } while (p != a);

            return inside;
        }

        // Link two polygon vertices with a bridge; if the vertices belong to the same ring, it splits the polygon into two;
        // if one belongs to the outer ring and another to a hole, it merges it into a single ring.
        private static Node SplitPolygon(Node a, Node b)
        {
            Node a2 = CreateNode(a.I, a.X, a.Y),
                b2 = CreateNode(b.I, b.X, b.Y),
                an = a.Next,
                bp = b.Prev;

            a.Next = b;
            b.Prev = a;

            a2.Next = an;
            an.Prev = a2;

            b2.Next = a2;
            a2.Prev = b2;

            bp.Next = b2;
            b2.Prev = bp;

            return b2;
        }

        // Create a node and optionally link it with the previous one (in a circular doubly linked list).
        private static Node InsertNode(int i, double x, double y, Node last)
        {
            Node p = CreateNode(i, x, y);

            if (last == null)
            {
                p.Prev = p;
                p.Next = p;
            }
            else
            {
                p.Next = last.Next;
                p.Prev = last;
                last.Next.Prev = p;
                last.Next = p;
            }
            return p;
        }

        private static void RemoveNode(Node p)
        {
            p.Next.Prev = p.Prev;
            p.Prev.Next = p.Next;

            if (p.PrevZ != null) p.PrevZ.NextZ = p.NextZ;
            if (p.NextZ != null) p.NextZ.PrevZ = p.PrevZ;
        }

        private static Node CreateNode(int i, double x, double y)
        {
            return new Node { I = i, X = x, Y = y };
        }

        private static double SignedArea(IReadOnlyList<double> data, int start, int end, int dim)
        {
            double sum = 0;
            for (int i = start, j = end - dim; i < end; i += dim)
            {
                sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
                j = i;
            }
            return sum;
        }

        /// <summary>JS Math.min / Math.max: NaN wins.</summary>
        private static double JsMin(double a, double b) => double.IsNaN(a) || double.IsNaN(b) ? double.NaN : Math.Min(a, b);

        private static double JsMax(double a, double b) => double.IsNaN(a) || double.IsNaN(b) ? double.NaN : Math.Max(a, b);

        private static double Min3(double a, double b, double c) => JsMin(JsMin(a, b), c);

        private static double Max3(double a, double b, double c) => JsMax(JsMax(a, b), c);
    }
}
