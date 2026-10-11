using System;
using Retro.Core;
using UnityEngine;

namespace Retro.Unity
{
    /// <summary>
    /// The sun of the web game (scene/materials/shaders/sun.ts): equinox
    /// declination at 29 N, local solar time, and the 45/55 direct/ambient
    /// split of SUN_SHADE_AMBIENT. Drives the URP directional light and the
    /// ambient so terrain reads with the same balance as in the browser.
    /// </summary>
    public static class SunModel
    {
        public const double DefaultHours = 14;
        /// <summary>SUN_SHADE_AMBIENT: the ambient floor of the shading ramp with the sun high.</summary>
        public const float ShadeAmbient = 0.55f;
        private const double LatitudeRad = 29 * Math.PI / 180;

        /// <summary>sunDirectionAt: unit vector towards the sun in scene axes (x east, y up, z south).</summary>
        public static Vec3d DirectionAt(double hours)
        {
            double hourAngle = (hours - 12) * 15 * Math.PI / 180;
            double sinElevation = JsMath.Clamp(Math.Cos(LatitudeRad) * JsTrig.Cos(hourAngle), -1, 1);
            double cosElevation = Math.Sqrt(Math.Max(0, 1 - sinElevation * sinElevation));
            double cosAzimuth = cosElevation > 1e-6
                ? JsMath.Clamp(-sinElevation * JsTrig.Sin(LatitudeRad) / (cosElevation * JsTrig.Cos(LatitudeRad)), -1, 1)
                : -1;
            double azimuth = JsTrig.Acos(cosAzimuth);
            if (hours > 12) azimuth = 2 * Math.PI - azimuth;
            return new Vec3d(cosElevation * JsTrig.Sin(azimuth), sinElevation, -cosElevation * JsTrig.Cos(azimuth));
        }

        /// <summary>Point a directional light from the sun and set the URP ambient to the web game's split (noon tints are neutral).</summary>
        public static void Apply(Light sun, double hours)
        {
            Vector3 toSun = SceneFrame.ToUnity(DirectionAt(hours)).normalized;
            sun.transform.rotation = Quaternion.LookRotation(-toSun);
            sun.color = Color.white;
            sun.intensity = 1 - ShadeAmbient;
            // terrainVP's sky view: ambient * mix(0.3, 1, 0.5 + 0.5 n.y), i.e. 1 facing up,
            // 0.65 sideways, 0.3 facing down. Trilight interpolates across the same three.
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = Color.white * ShadeAmbient;
            RenderSettings.ambientEquatorColor = Color.white * (ShadeAmbient * 0.65f);
            RenderSettings.ambientGroundColor = Color.white * (ShadeAmbient * 0.3f);
        }
    }
}
