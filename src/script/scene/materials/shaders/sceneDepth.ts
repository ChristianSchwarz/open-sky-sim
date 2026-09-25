import * as THREE from 'three';

/**
 * The finished scene's depth, linearised into a texture that a later pass can
 * sample.
 *
 * There is exactly one client: the sun's glare, which is drawn over the whole
 * frame and has to know how far away what it is covering is. It cannot read the
 * depth buffer it is drawing into - that is a feedback loop - so the scene pass'
 * depth is resolved into a separate texture first (see SceneDepthPass) and this
 * is the format the two halves agree on.
 *
 * Distance is stored as a fraction of the camera's far plane packed across three
 * 8-bit channels, which is ~24 bits: about 3 cm at a 550 km far plane, and far
 * more than the 4x4 stipple downstream can spend. A single 8-bit channel was
 * tempting for that reason, but the value is a *distance* and the veil built
 * from it is exponential, so the resolution has to be spent near the camera
 * where the exponential is steep, not spread evenly to the far plane.
 */

/**
 * Largest fraction the pack can represent.
 *
 * Exactly 1.0 packs to (0, 0, 0) - every `fract()` lands on a whole number - and
 * unpacks to zero, which would read as "the scene is at the camera" for every
 * pixel showing open sky, i.e. precisely the case the glare cares most about.
 */
export const SCENE_DEPTH_CEILING = 1.0 - 1.0 / 16777216.0;

/**
 * Fraction of the far plane at or beyond which a pixel counts as open sky.
 *
 * The depth buffer is cleared to 1, so sky resolves to the ceiling above; this
 * only has to sit clear of it and above anything the scene actually draws. The
 * terrain's own horizon is a few hundred km at cruising altitude against a
 * 550 km far plane, so there is a wide gap to put it in.
 */
export const SCENE_DEPTH_SKY_CUT = 0.999;

/** Writes a 0..1 fraction across three 8-bit channels. */
export const SCENE_DEPTH_PACK_FRAGMENT: string = `
vec3 packUnit(float v) {
  vec3 enc = fract(v * vec3(1.0, 255.0, 65025.0));
  enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
  return enc;
}
`;

/**
 * Reads the resolved depth back. Declares the uniforms itself, so a material
 * only has to include this and spread {@link SCENE_DEPTH_UNIFORMS}.
 */
export const SCENE_DEPTH_PARS_FRAGMENT: string = `
uniform sampler2D uSceneDepth;
uniform vec2 uSceneDepthSize;
uniform float uSceneFar;

float unpackUnit(vec3 enc) {
  return dot(enc, vec3(1.0, 1.0 / 255.0, 1.0 / 65025.0));
}

// View-axis distance to whatever the scene pass left at this pixel, in world
// units. Open sky comes back as the far plane rather than as anything nearer,
// so a test against uSceneFar tells the two apart.
float sceneDistance(vec2 fragCoord) {
  vec3 packed = texture2D(uSceneDepth, fragCoord / uSceneDepthSize).rgb;
  return unpackUnit(packed) * uSceneFar;
}
`;

/**
 * Shared *by reference* with every material that samples the resolved depth,
 * exactly as SUN_UNIFORMS is: the pass writes these once per frame rather than
 * walking a material list.
 */
export const SCENE_DEPTH_UNIFORMS = {
    uSceneDepth: { value: null as THREE.Texture | null },
    uSceneDepthSize: { value: new THREE.Vector2(1, 1) },
    uSceneFar: { value: 1 },
};
