using Retro.Core;

namespace Retro.Game
{
    /// <summary>carrierOverSternCameraUpdater.ts: 100 m behind the carrier, 30 m above the deck, looking over the stern.</summary>
    public sealed class CarrierOverSternCameraUpdater : CameraUpdater
    {
        private IPosedEntity _carrier;

        public CarrierOverSternCameraUpdater(ICameraActor actor, CameraPose camera, IPosedEntity carrier = null)
            : base(actor, camera)
        {
            _carrier = carrier;
        }

        public void SetCarrier(IPosedEntity carrier)
        {
            _carrier = carrier;
        }

        public override void Update(double delta)
        {
            if (_carrier == null)
            {
                return;
            }

            // Carrier position in world space
            Vec3d carrierPos = _carrier.Position;
            Quatd carrierQuat = _carrier.Quaternion;

            const double deckY = 14;
            const double cameraDistanceBehind = 100; // 100m behind carrier
            const double cameraHeightAboveDeck = 30;
            const double focusHeightAboveDeck = 20;

            // Focal point: center of carrier at 20m above deck
            Vec3d sternPos = new Vec3d(0, deckY + focusHeightAboveDeck, 0).Rotate(carrierQuat) + carrierPos;

            // Camera position: behind the carrier
            Vec3d cameraPos = new Vec3d(0, deckY + cameraHeightAboveDeck, -cameraDistanceBehind).Rotate(carrierQuat) + carrierPos;

            camera.Position = cameraPos;
            camera.LookAt(sternPos);
        }
    }
}
