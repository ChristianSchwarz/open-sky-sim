using Retro.Core;
using UnityEngine;
#if RETRO_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace Retro.Unity
{
    /// <summary>
    /// A free camera that lives in double-precision scene space. The Unity
    /// camera stays at the origin with only a rotation; everything else is
    /// drawn relative to <see cref="ScenePosition"/> (the floating origin).
    ///
    /// Controls: WASD move, Q/E down/up, right mouse drag to look, wheel to
    /// change speed, Shift for 10x.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    [RequireComponent(typeof(Camera))]
    public sealed class FlyCamera : MonoBehaviour
    {
        [Tooltip("Start latitude, longitude (degrees) and altitude above the ellipsoid (m).")]
        public double startLat = 27.85;
        public double startLon = -15.55;
        public double startAltitude = 3000;

        [Tooltip("Degrees clockwise from north.")]
        public double headingDeg;
        [Tooltip("Degrees, positive nose up.")]
        public double pitchDeg = -15;

        public float speed = 250;
        public float lookSensitivity = 0.15f;

        /// <summary>Camera position in scene metres (x east, y up, z south), double precision.</summary>
        public Vec3d ScenePosition;

        private EnuBasis basis;
        private bool placed;

        public Camera UnityCamera { get; private set; }

        /// <summary>Set by the terrain once its frame is known; places the camera at the start point.</summary>
        public EnuBasis Basis
        {
            get => basis;
            set
            {
                basis = value;
                if (!placed)
                {
                    ScenePosition = Geodesy.GeodeticToWorld(basis, startLat, startLon, startAltitude);
                    placed = true;
                }
            }
        }

        private void Awake()
        {
            UnityCamera = GetComponent<Camera>();
            UnityCamera.nearClipPlane = 2;
            UnityCamera.fieldOfView = 50;
            transform.position = Vector3.zero;
            SceneOrientation = SceneFrame.SceneCameraOrientation(headingDeg, pitchDeg);
        }

        /// <summary>
        /// The view orientation in scene axes, three.js convention (looks down
        /// its own -Z): what the terrain's frustum culling reads.
        /// </summary>
        public Quatd SceneOrientation { get; private set; } = Quatd.Identity;

        /// <summary>True while something else (a flight view) places the camera each frame.</summary>
        public bool External { get; private set; }

        /// <summary>
        /// Place the camera from outside (chase and cockpit views): scene
        /// position, three.js-convention orientation and vertical FOV. Holds
        /// until <see cref="ReleasePose"/>.
        /// </summary>
        public void SetPose(Vec3d position, Quatd orientation, double fovDeg)
        {
            External = true;
            ScenePosition = position;
            SceneOrientation = orientation;
            UnityCamera.fieldOfView = (float)fovDeg;
            transform.SetPositionAndRotation(Vector3.zero, SceneFrame.ToUnity(orientation));
            UpdateFarPlane();
        }

        /// <summary>Back to the free camera, looking where the last pose looked (heading/pitch only).</summary>
        public void ReleasePose()
        {
            if (!External) return;
            External = false;
            Vec3d f = new Vec3d(0, 0, -1).Rotate(SceneOrientation);
            headingDeg = System.Math.Atan2(f.X, -f.Z) * 180 / System.Math.PI;
            pitchDeg = System.Math.Asin(System.Math.Max(-1, System.Math.Min(1, f.Y))) * 180 / System.Math.PI;
        }

        private void UpdateFarPlane()
        {
            if (basis == null) return;
            double altitude = Geodesy.WorldToGeodetic(basis, ScenePosition.X, ScenePosition.Y, ScenePosition.Z).Height;
            UnityCamera.farClipPlane = (float)Retro.Terrain.Lod.CameraFarForAltitudeM(altitude);
        }

        private void Update()
        {
            if (External) return;
            float dt = Time.unscaledDeltaTime;
            ReadInput(out Vector3 move, out Vector2 look, out float wheel, out bool fast);

            headingDeg = (headingDeg + look.x * lookSensitivity) % 360;
            pitchDeg = System.Math.Max(-89, System.Math.Min(89, pitchDeg - look.y * lookSensitivity));
            if (wheel != 0) speed = Mathf.Clamp(speed * (wheel > 0 ? 1.25f : 0.8f), 5, 200000);

            Quaternion rotation = SceneFrame.UnityCameraRotation(headingDeg, pitchDeg);
            Vector3 unityMove = rotation * new Vector3(move.x, 0, move.z) + Vector3.up * move.y;
            double step = speed * (fast ? 10 : 1) * dt;
            Vec3d delta = SceneFrame.ToScene(unityMove) * step;
            ScenePosition = ScenePosition + delta;

            SceneOrientation = SceneFrame.SceneCameraOrientation(headingDeg, pitchDeg);
            transform.SetPositionAndRotation(Vector3.zero, rotation);
            UpdateFarPlane();
        }

        private static void ReadInput(out Vector3 move, out Vector2 look, out float wheel, out bool fast)
        {
            move = Vector3.zero;
            look = Vector2.zero;
            wheel = 0;
            fast = false;
#if RETRO_INPUT_SYSTEM
            Keyboard k = Keyboard.current;
            Mouse m = Mouse.current;
            if (k != null)
            {
                if (k.wKey.isPressed) move.z += 1;
                if (k.sKey.isPressed) move.z -= 1;
                if (k.dKey.isPressed) move.x += 1;
                if (k.aKey.isPressed) move.x -= 1;
                if (k.eKey.isPressed) move.y += 1;
                if (k.qKey.isPressed) move.y -= 1;
                fast = k.leftShiftKey.isPressed;
            }
            if (m != null)
            {
                if (m.rightButton.isPressed) look = m.delta.ReadValue();
                wheel = m.scroll.ReadValue().y;
            }
#else
            if (Input.GetKey(KeyCode.W)) move.z += 1;
            if (Input.GetKey(KeyCode.S)) move.z -= 1;
            if (Input.GetKey(KeyCode.D)) move.x += 1;
            if (Input.GetKey(KeyCode.A)) move.x -= 1;
            if (Input.GetKey(KeyCode.E)) move.y += 1;
            if (Input.GetKey(KeyCode.Q)) move.y -= 1;
            fast = Input.GetKey(KeyCode.LeftShift);
            if (Input.GetMouseButton(1)) look = new Vector2(Input.GetAxis("Mouse X"), Input.GetAxis("Mouse Y")) * 10;
            wheel = Input.mouseScrollDelta.y;
#endif
        }
    }
}
