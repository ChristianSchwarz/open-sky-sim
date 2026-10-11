using System;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>
    /// One arrestor cable's shape as the TS entity holds it in its BufferAttributes
    /// (carrier-local, float32), plus the same polyline in double and in scene space.
    /// </summary>
    public sealed class ArrestorCableShape
    {
        /// <summary>The cable's sheave endpoints in carrier-local space.</summary>
        public ArrestorCableLocal Local;

        /// <summary>
        /// Near LOD, leg sheave A to mid: 4 vertices xyz (carrier-local, float32), drawn
        /// with index [0, 1, 2, 2, 1, 3]. Vertices 0/1 sit at A, 2/3 at the mid, offset
        /// +-0.04 m across the leg.
        /// </summary>
        public readonly float[] RibbonA = new float[12];

        /// <summary>Near LOD, leg mid to sheave B: same layout as <see cref="RibbonA"/>.</summary>
        public readonly float[] RibbonB = new float[12];

        /// <summary>Far LOD: the 3-point line strip A, mid, B (carrier-local, float32).</summary>
        public readonly float[] Line = new float[9];

        /// <summary>The line's three points in double before the float32 cast (carrier-local).</summary>
        public readonly Vec3d[] PolylineLocal = new Vec3d[3];

        /// <summary>The line's three points in scene space (x east, y up, z south), double.</summary>
        public readonly Vec3d[] PolylineWorld = new Vec3d[3];

        /// <summary>
        /// Leg quad was degenerate (under 0.1 mm) on its last placement: the TS leaves
        /// that quad's vertices as they were (only the raised mid Y is rewritten) and,
        /// because LOD visibility is applied afterwards, still draws it.
        /// </summary>
        public bool DegenerateA, DegenerateB;
    }

    /// <summary>
    /// CPU half of the carrier arrestor cables (port of arrestorCablesEntity.ts):
    /// straight when idle, V-bent to the hook tip while trapped, with the
    /// ribbon / 1 px line LOD switch and its hysteresis.
    ///
    /// Shapes are kept in carrier-local space, exactly as the TS writes them into
    /// its Float32 attributes under a root that follows the carrier pose; put the
    /// drawn object at <see cref="RootPosition"/> / <see cref="RootRotation"/>.
    /// </summary>
    public sealed class ArrestorCableShapes
    {
        /// <summary>Fallback deck Y if the ground sampler is unavailable (carrier-local).</summary>
        public const double DeckYFallback = 13.55;
        /// <summary>How far above the deck surface the visible cable sits (m).</summary>
        public const double CableClearanceM = 0.35;
        /// <summary>Visible cable ribbon half-width (m).</summary>
        public const double CableHalfWidthM = 0.04;
        /// <summary>Camera distance (m) at which ribbons switch to 1 px lines.</summary>
        public const double LodLineM = 350;
        /// <summary>Hysteresis band (m) around the LOD switch.</summary>
        public const double LodHysteresisM = 25;

        private readonly Func<double, double, double> groundHeightAt;
        private readonly Vec3d lodAnchorLocal;
        private Vec3d tipLocal;
        private bool cablesBuilt;
        private int lastRebuiltLatch = -1;

        /// <summary>The four cables, stern to bow (ArrestorCables.ArrestorCableLocalZ order).</summary>
        public readonly ArrestorCableShape[] Cables;

        /// <summary>Root translation: the carrier pose position (scene space).</summary>
        public Vec3d RootPosition { get; private set; }

        /// <summary>Root rotation: the carrier pose quaternion, identity when the pose has none.</summary>
        public Quatd RootRotation { get; private set; } = Quatd.Identity;

        /// <summary>true = far LOD (1 px lines), false = near LOD (ribbons).</summary>
        public bool UseLineLod { get; private set; }

        /// <summary>Ribbon quads drawn this frame (all four cables alike).</summary>
        public bool RibbonsVisible => !UseLineLod;

        /// <summary>Lines drawn this frame.</summary>
        public bool LinesVisible => UseLineLod;

        /// <summary>Camera distance to the LOD anchor (mean cable mid) at the last update.</summary>
        public double LodDistance { get; private set; }

        /// <param name="initialPose">Carrier pose at construction (the TS samples the deck there once).</param>
        /// <param name="groundHeightAt">World ground height at scene (x, z); null = the 13.55 m fallback.</param>
        public ArrestorCableShapes(ArrestorCarrierPose initialPose, Func<double, double, double> groundHeightAt = null)
        {
            this.groundHeightAt = groundHeightAt ?? ((x, z) => DeckYFallback);
            SyncRootPose(initialPose);

            ArrestorCableLocal[] locals = ArrestorCables.ArrestorCableLocals();
            double sumX = 0;
            double sumZ = 0;
            foreach (ArrestorCableLocal local in locals)
            {
                sumX += (local.Ax + local.Bx) * 0.5;
                sumZ += (local.Az + local.Bz) * 0.5;
            }
            lodAnchorLocal = new Vec3d(sumX / locals.Length, ArrestorCables.ArrestorCableY, sumZ / locals.Length);

            Cables = new ArrestorCableShape[locals.Length];
            for (int i = 0; i < locals.Length; i++)
            {
                ArrestorCableLocal local = locals[i];
                var c = new ArrestorCableShape { Local = local };
                Cables[i] = c;
                double midX = (local.Ax + local.Bx) * 0.5;
                double midZ = (local.Az + local.Bz) * 0.5;
                c.DegenerateA = !PlaceCableQuad(c.RibbonA, local.Ax, local.Az, midX, midZ);
                c.DegenerateB = !PlaceCableQuad(c.RibbonB, midX, midZ, local.Bx, local.Bz);
                PlaceCableLine(c, local.Ax, local.Az, midX, midZ, local.Bx, local.Bz, CableLocalY(midX, midZ));
            }
            UpdateWorldPolylines();
        }

        /// <summary>World hinge of the hook arm: body hinge rotated by the display pose (player.ts order).</summary>
        public static Vec3d HookHingeWorld(Vec3d hingeBody, Quatd displayQuaternion, Vec3d displayPosition) =>
            hingeBody.Rotate(displayQuaternion) + displayPosition;

        /// <summary>
        /// One frame: follow the carrier pose, rebuild the bend (only on the first call
        /// or while / right after a hook is latched, as the TS does), then pick the LOD
        /// from the camera. Call after the player's display pose is current.
        /// </summary>
        /// <param name="pose">Live carrier pose.</param>
        /// <param name="latch">Latched cable index, or -1 when no hook is on a wire.</param>
        /// <param name="hookHingeWorld">World hinge of the hook arm (see <see cref="HookHingeWorld"/>); read only while latched.</param>
        /// <param name="cameraPosition">Camera position in scene space.</param>
        public void Update(ArrestorCarrierPose pose, int latch, Vec3d hookHingeWorld, Vec3d cameraPosition)
        {
            Rebuild(pose, latch, hookHingeWorld);
            UpdateLodFromCamera(cameraPosition);
        }

        private void SyncRootPose(ArrestorCarrierPose pose)
        {
            RootPosition = pose.Position;
            RootRotation = pose.Quaternion ?? Quatd.Identity;
        }

        private void Rebuild(ArrestorCarrierPose pose, int latch, Vec3d hingeWorld)
        {
            SyncRootPose(pose);
            if (latch < 0 && lastRebuiltLatch < 0 && cablesBuilt)
            {
                UpdateWorldPolylines();
                return;
            }
            cablesBuilt = true;
            lastRebuiltLatch = latch;
            if (latch >= 0)
            {
                Vec3d sheaveWorld = ArrestorCables.ArrestorCableStartWorld(latch, pose);
                Vec3d tipWorld = ArrestorCables.LatchedHookTipWorld(hingeWorld, sheaveWorld, out _, new Vec3d(0, -1, -1));
                tipLocal = WorldToCarrierLocal(tipWorld, pose);
            }

            for (int i = 0; i < Cables.Length; i++)
            {
                ArrestorCableShape c = Cables[i];
                ArrestorCableLocal l = c.Local;
                double midX, midZ;
                if (i == latch)
                {
                    midX = tipLocal.X;
                    midZ = tipLocal.Z;
                }
                else
                {
                    midX = (l.Ax + l.Bx) * 0.5;
                    midZ = (l.Az + l.Bz) * 0.5;
                }
                c.DegenerateA = !PlaceCableQuad(c.RibbonA, l.Ax, l.Az, midX, midZ);
                c.DegenerateB = !PlaceCableQuad(c.RibbonB, midX, midZ, l.Bx, l.Bz);

                double midY = CableLocalY(midX, midZ);
                if (i == latch)
                {
                    midY = Math.Max(tipLocal.Y, midY);
                    // raiseQuadEnd / raiseQuadStart: the V apex follows the hook height.
                    c.RibbonA[2 * 3 + 1] = (float)midY;
                    c.RibbonA[3 * 3 + 1] = (float)midY;
                    c.RibbonB[0 * 3 + 1] = (float)midY;
                    c.RibbonB[1 * 3 + 1] = (float)midY;
                }
                PlaceCableLine(c, l.Ax, l.Az, midX, midZ, l.Bx, l.Bz, midY);
            }
            UpdateWorldPolylines();
        }

        private void UpdateWorldPolylines()
        {
            var pose = new ArrestorCarrierPose { Position = RootPosition, Quaternion = RootRotation };
            foreach (ArrestorCableShape c in Cables)
            {
                for (int k = 0; k < 3; k++)
                {
                    Vec3d p = c.PolylineLocal[k];
                    c.PolylineWorld[k] = ArrestorCables.CarrierLocalToWorld(p.X, p.Y, p.Z, pose);
                }
            }
        }

        /// <summary>Inverse of CarrierLocalToWorld (translation, then the conjugate rotation).</summary>
        private static Vec3d WorldToCarrierLocal(Vec3d world, ArrestorCarrierPose pose)
        {
            Vec3d o = world - pose.Position;
            if (pose.Quaternion.HasValue)
            {
                o = o.Rotate(pose.Quaternion.Value.Conjugate());
            }
            return o;
        }

        /// <summary>Sampled deck Y in carrier-local space (never below the authored floor).</summary>
        private double DeckLocalY(double localX, double localZ, double liftM)
        {
            Vec3d s = new Vec3d(localX, 0, localZ).Rotate(RootRotation);
            double wx = RootPosition.X + s.X;
            double wz = RootPosition.Z + s.Z;
            double sampled = groundHeightAt(wx, wz);
            double floorWorld = RootPosition.Y + Math.Max(DeckYFallback, ArrestorCables.ArrestorCableY - 0.3);
            double deckWorld = Math.Max(sampled, floorWorld);
            return deckWorld + liftM - RootPosition.Y;
        }

        private double CableLocalY(double localX, double localZ) => DeckLocalY(localX, localZ, CableClearanceM);

        /// <summary>placeRibbonQuad; false (positions untouched) when the leg is under 0.1 mm.</summary>
        private bool PlaceCableQuad(float[] pos, double ax, double az, double bx, double bz)
        {
            double dx = bx - ax;
            double dz = bz - az;
            double len = JsMath.Hypot(dx, dz);
            if (len < 1e-4)
            {
                return false;
            }
            double halfW = CableHalfWidthM;
            double hx = (-dz / len) * halfW;
            double hz = (dx / len) * halfW;
            double y0 = CableLocalY(ax, az);
            double y1 = CableLocalY(bx, bz);
            Set(pos, 0, ax - hx, y0, az - hz);
            Set(pos, 1, ax + hx, y0, az + hz);
            Set(pos, 2, bx - hx, y1, bz - hz);
            Set(pos, 3, bx + hx, y1, bz + hz);
            return true;
        }

        private void PlaceCableLine(ArrestorCableShape c, double ax, double az, double midX, double midZ, double bx, double bz, double midY)
        {
            double ay = CableLocalY(ax, az);
            double by = CableLocalY(bx, bz);
            c.PolylineLocal[0] = new Vec3d(ax, ay, az);
            c.PolylineLocal[1] = new Vec3d(midX, midY, midZ);
            c.PolylineLocal[2] = new Vec3d(bx, by, bz);
            Set(c.Line, 0, ax, ay, az);
            Set(c.Line, 1, midX, midY, midZ);
            Set(c.Line, 2, bx, by, bz);
        }

        private static void Set(float[] a, int i, double x, double y, double z)
        {
            a[i * 3] = (float)x;
            a[i * 3 + 1] = (float)y;
            a[i * 3 + 2] = (float)z;
        }

        /// <summary>Ribbons near the camera, lines when far, with hysteresis.</summary>
        private void UpdateLodFromCamera(Vec3d camera)
        {
            Vec3d anchorWorld = lodAnchorLocal.Rotate(RootRotation) + RootPosition;
            double dist = Vec3d.Distance(camera, anchorWorld);
            LodDistance = dist;
            if (UseLineLod)
            {
                if (dist < LodLineM - LodHysteresisM)
                {
                    UseLineLod = false;
                }
            }
            else if (dist > LodLineM + LodHysteresisM)
            {
                UseLineLod = true;
            }
        }
    }
}
