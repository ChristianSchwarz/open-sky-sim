using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    // ---------------------------------------------------------------------------------
    // Input: an aircraft's drawable geometry, as the wreck code reads it from a three.js
    // Model (models.ts ModelLodLevel.volumes of LOD 0). The frontend fills these from its
    // own meshes (glTFast); nothing here knows about an engine.
    // ---------------------------------------------------------------------------------

    /// <summary>
    /// One drawable triangle mesh of a model's LOD 0 volumes (a THREE.Mesh in
    /// models.ts ModelLodLevel.volumes, after ModelManager.processModel: face
    /// normals where the import had none, the 0.0001 rad rotateY hack applied).
    /// Lines, points, collider meshes and hidden meshes are left out (the TS
    /// collectMeshes skips them).
    /// </summary>
    public sealed class WreckMeshInput
    {
        /// <summary>Vertex positions, xyz, in the mesh's own frame (the geometry's float32 position attribute).</summary>
        public float[] Positions;

        /// <summary>Vertex normals, xyz, or null.</summary>
        public float[] Normals;

        /// <summary>Vertex colours (<see cref="ColorSize"/> per vertex, already denormalised), or null.</summary>
        public float[] Colors;

        public int ColorSize = 3;

        /// <summary>Texture coordinates (<see cref="UvSize"/> per vertex), or null.</summary>
        public float[] Uvs;

        public int UvSize = 2;

        /// <summary>Triangle list indices, or null for a soup (three vertices per triangle).</summary>
        public int[] Indices;

        /// <summary>
        /// The mesh's transform within the model, column-major like Matrix4.elements
        /// (the TS uses mesh.matrix = compose(mesh.position, mesh.quaternion, mesh.scale);
        /// see <see cref="WreckMath.Compose"/>). Null is the identity.
        /// </summary>
        public double[] Matrix;

        /// <summary>
        /// The frontend's material (or palette category) for this mesh. Carried
        /// unchanged onto every piece cut from it (the TS shares the material object).
        /// </summary>
        public object Material;
    }

    /// <summary>A model: models.ts Model, LOD 0 only (what the wreck reads).</summary>
    public sealed class WreckModel
    {
        public List<WreckMeshInput> Meshes = new List<WreckMeshInput>();

        /// <summary>Model.maxSize: the largest side of the model's bounding box over all LODs (model units).</summary>
        public double MaxSize;
    }

    public enum WreckPartKind
    {
        Gear,
        Surface,
    }

    /// <summary>A separately-posed piece of the airframe (gear, control surface) at crash time (wreckField.ts WreckPart).</summary>
    public sealed class WreckPart
    {
        public WreckModel Model;

        /// <summary>Scene-space pose of the part (the gear at the body pose; a surface at its hinge, see poseSurface).</summary>
        public Vec3d Position;

        public Quatd Quaternion;

        /// <summary>Gear and surfaces near the impact snap off more readily than ones far from it.</summary>
        public WreckPartKind Kind;

        /// <summary>Which part it is, stable between calls: gear 0, control surface i = 1 + i. Null = its index in the list.</summary>
        public int? Id;

        public WreckPart Clone() => new WreckPart { Model = Model, Position = Position, Quaternion = Quaternion, Kind = Kind, Id = Id };
    }

    /// <summary>Everything the field needs to take an aircraft apart (wreckField.ts WreckSource). All vectors are scene-space.</summary>
    public sealed class WreckSource
    {
        /// <summary>Sim id of the aircraft, so its fires can replace the old pinned plume.</summary>
        public string Id;

        public WreckModel Body;
        public Vec3d Position;
        public Quatd Quaternion = Quatd.Identity;
        public Vec3d Scale = new Vec3d(1, 1, 1);

        /// <summary>Velocity just before the impact (m/s).</summary>
        public Vec3d Velocity;

        public List<WreckPart> Parts = new List<WreckPart>();

        /// <summary>Pilot's eye in the body frame (m), so a camera can follow the cockpit piece.</summary>
        public Vec3d? Cockpit;

        /// <summary>Damage from impacts that did not destroy it (see <see cref="AirframeDamage"/>).</summary>
        public AirframeDamage Damage;
    }

    /// <summary>Ground that moves under the wreckage, such as a carrier deck (movingSurface.ts MovingSurface).</summary>
    public interface IWreckMovingSurface
    {
        /// <summary>The surface's velocity (m/s), read every frame.</summary>
        Vec3d Velocity { get; }

        /// <summary>Whether a point is standing on the surface (on the deck, not high above it or in the sea beside it).</summary>
        bool Contains(double x, double y, double z);
    }

    // ---------------------------------------------------------------------------------
    // Output: the pieces, as the TS geometry ends up (float32 BufferAttributes).
    // ---------------------------------------------------------------------------------

    /// <summary>
    /// One mesh of a wreck piece or of a damaged airframe: what the TS puts in a
    /// BufferGeometry (non-indexed, three vertices per triangle). Attributes the
    /// source mesh lacked are null.
    /// </summary>
    public sealed class WreckMeshData
    {
        public float[] Position = Array.Empty<float>();
        public float[] Normal;
        public float[] Color;
        public int ColorSize = 3;
        public float[] Uv;
        public int UvSize = 2;

        /// <summary>The source mesh's <see cref="WreckMeshInput.Material"/>.</summary>
        public object Material;

        public int VertexCount => Position.Length / 3;
    }

    public enum WreckFireKind
    {
        Fuselage,
        WingRoot,

        /// <summary>A small burning shard thrown clear of the wreck.</summary>
        Brand,
    }

    /// <summary>A fire that rides on a fragment, at a fixed spot in that fragment's frame (wreckField.ts WreckFire).</summary>
    public sealed class WreckFire
    {
        public WreckFragment Fragment;
        public Vec3d Local;
        public WreckFireKind Kind;
    }

    /// <summary>A break-up (wreckField.ts WreckEvent).</summary>
    public sealed class WreckEvent
    {
        public string Id;
        public Vec3d Position;
        public Vec3d Velocity;
        public Vec3d Normal;

        /// <summary>0.2 (scrape-off) .. 1.5 (dive into the ground).</summary>
        public double Severity;

        public List<WreckFire> Fires;

        /// <summary>The impact was in open water.</summary>
        public bool Water;
    }

    /// <summary>A fuel fire on a damaged, living aircraft: in its own body frame, metres.</summary>
    public struct WreckDamageFire
    {
        /// <summary><see cref="WreckFireKind.Fuselage"/> or <see cref="WreckFireKind.WingRoot"/>.</summary>
        public WreckFireKind Kind;

        public Vec3d Local;
    }

    /// <summary>A living aircraft was bent or torn by an impact it survived (wreckField.ts WreckDamageEvent).</summary>
    public sealed class WreckDamageEvent
    {
        public string Id;
        public double Severity;
        public List<WreckDamageFire> Fires;
    }

    /// <summary>
    /// How a part riding on the dislocated fuselage has been carried (airframeDamage.ts
    /// PartBend): in the body frame, model units, a point p becomes M p.
    /// </summary>
    public sealed class PartBend
    {
        /// <summary>The section's rigid move M, column-major (Matrix4.toArray).</summary>
        public double[] M;

        /// <summary>The rotation part of M.</summary>
        public Quatd Q;
    }

    /// <summary>One joint of the fuselage, summed over every impact (airframeDamage.ts JointState).</summary>
    public sealed class JointState
    {
        /// <summary>Hinge angle about the vertical axis (sideways), rad.</summary>
        public double Yaw;

        /// <summary>Hinge angle about the lateral axis (the tail rising for +), rad.</summary>
        public double Pitch;

        /// <summary>Sideways shift, model units.</summary>
        public double Shift;
    }

    /// <summary>
    /// A rigid wreck piece (wreckField.ts Fragment): its meshes, built around its
    /// own centre, are drawn at <see cref="Position"/> / <see cref="Quaternion"/>.
    /// The geometry never changes once the piece exists; a piece that breaks is
    /// replaced by new ones (see <see cref="WreckField.FragmentAdded"/> / FragmentRemoved).
    /// </summary>
    public sealed class WreckFragment
    {
        /// <summary>The piece's meshes (Object3D children), positions relative to the piece's centre.</summary>
        public readonly List<WreckMeshData> Meshes = new List<WreckMeshData>();

        /// <summary>Scene pose (obj.position / obj.quaternion).</summary>
        public Vec3d Position;

        public Quatd Quaternion = Quatd.Identity;

        /// <summary>False once it has sunk out of sight (obj.visible).</summary>
        public bool Visible = true;

        /// <summary>Body-origin-relative centre the fragment's geometry was built around.</summary>
        public Vec3d Centre;

        public bool Disposed;

        /// <summary>Where the aircraft origin sits in this piece's own frame (follows splits).</summary>
        public Vec3d OriginLocal;

        /// <summary>Times this lineage has already broken apart.</summary>
        public int Depth;

        public bool SplitQueued;
        public double DustAccum;
        public double SlideAccum;
        public int TrailMarks;
        public double TrailWidth;

        /// <summary>Half extents of the piece.</summary>
        public Vec3d Half;

        public double? SettleS;
        public double? ReseatS;
        public double MarkCooldown;
        public bool WasTouching;

        /// <summary>Lying on a moving surface (a carrier deck) this frame.</summary>
        public bool OnMover;

        /// <summary>In the water: it has gone in; it floats for a while, then sinks.</summary>
        public bool Wet;

        public double WetTime;
        public double BobPhase;
        public double FoamAccum;

        /// <summary>Holds fuselage: it is never split further.</summary>
        public bool Tough;

        /// <summary>Far enough under that a fire on it is out.</summary>
        public bool Submerged;

        /// <summary>Water surface height where it went in.</summary>
        public double WaterY;

        public double ImpactCooldown;
        public Vec3d Velocity;
        public Vec3d Spin;

        /// <summary>Local-space AABB corners used as contact points.</summary>
        public Vec3d[] Corners;

        /// <summary>Radius-of-gyration squared (m^2), for contact impulses.</summary>
        public double Gyration2;

        public bool Asleep;
        public double RestTime;

        /// <summary>Highest wreck generation this belongs to (oldest dropped first).</summary>
        public int Serial;
    }
}
