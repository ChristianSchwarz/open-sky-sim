import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';

export const ShadedVertProgram: string = `
  precision highp float;

  uniform float halfWidth;
  uniform float halfHeight;
  uniform mat3 normalModelMatrix;
  uniform int shadingType;
  // Direction towards the sun (ENU) and its shading weights, all moved by the
  // time-of-day setting; see shaders/sun.ts. uSunShade is the scalar (ambient,
  // direct) pair; uSunAmbient / uSunDirect are the same two weights in colour.
  uniform vec3 uSunDir;
  uniform vec2 uSunShade;
  uniform vec3 uSunAmbient;
  uniform vec3 uSunDirect;
  uniform vec3 uSunTint;

  /**
   * Skylight arrives from the dome overhead, not from all around, so how much
   * of it a surface collects depends on how much sky it can see. A flat ambient
   * term lit the underside of a wing exactly as brightly as its top, which is
   * what kept backlit shapes looking lit-but-dim instead of going to silhouette.
   */
  const float AMBIENT_SKY_FLOOR = 0.65;

  /** Same terminator sharpening as terrain, so meshes read from slope shading alone. */
  const float SHADOW_CONTRAST_POWER = 1.0;
  /** Skylight kept on a face fully turned from the sun, and the beam boost toward it. */
  const float SHADE_AWAY_AMBIENT = 0.95;
  const float SUN_FACING_GAIN = 1.0;

  /** Fresnel rim: how sharply it tightens to the edge, and how far it lifts. */
  const float RIM_POWER = 3.0;
  const float RIM_STRENGTH = 0.35;

  varying float shade;
  varying vec3 vLight;
  varying float vWorldY;
${LOG_DEPTH_PARS_VERTEX}
  void main() {
    vec3 worldNormal;

    if (shadingType == 2 || shadingType == 3) {
      worldNormal = normalize(normalModelMatrix * normal);
    } else {
      // STATIC / DUOTONE: attribute is already in world/ENU for unrotated meshes.
      worldNormal = normalize(normal);
    }

    // Clamped at zero: a surface turned away from the sun receives none of the
    // beam, never a negative amount of it.
    float rawNdl = max(dot(worldNormal, uSunDir), 0.0);
    float ndl = pow(rawNdl, SHADOW_CONTRAST_POWER);
    // How much of the sky this surface can see, 1 looking up and a floor's
    // worth looking straight down.
    float skyView = mix(AMBIENT_SKY_FLOOR, 1.0, 0.5 + 0.5 * worldNormal.y);

    // Ambient floor so land keeps the palette base colour in shadow. The direct
    // weight fades to 0 as the sun sets, leaving night lit flat by its palette.
    // Faces turned from the sun lose part of their skylight, faces toward it
    // gain a boosted beam: contrast both ways around the old mid-tone.
    float ambientScale = mix(SHADE_AWAY_AMBIENT, 1.0, rawNdl);
    float directGain = SUN_FACING_GAIN;
    shade = uSunShade.x * skyView * ambientScale + uSunShade.y * ndl * directGain;
    // Same ramp in colour: a reddened beam over a blue skylight fill, so a low
    // sun leaves the faces it strikes warmer than the ones it misses. Both
    // tints are luminance-normalised, so this matches shade in brightness.
    vLight = uSunAmbient * skyView * ambientScale + uSunDirect * ndl * directGain;

    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldY = worldPos.y;

    // Rim light. The lists are drawn camera-relative, so the camera is at the
    // origin and the direction back to it is just the negated position.
    //
    // Gated twice over, because an ungated Fresnel is a chrome edge on
    // everything: only where the surface is turned away from the sun, and only
    // where the sun is behind the subject from where the camera stands. What is
    // left is the one case it is for - a shape against a bright sky, which
    // without it reads as a hole cut out of the background.
    vec3 toCamera = normalize(-worldPos.xyz);
    float backlit = max(-dot(toCamera, uSunDir), 0.0);
    float fresnel = pow(1.0 - max(dot(worldNormal, toCamera), 0.0), RIM_POWER);
    vLight += uSunTint * (fresnel * backlit * (1.0 - ndl) * RIM_STRENGTH);
    vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    if (shadingType != 3) {
      pos.x = floor(pos.x / pos.w * halfWidth + 0.5) / halfWidth * pos.w;
      pos.y = floor(pos.y / pos.w * halfHeight + 0.5) / halfHeight * pos.w;
    }
    gl_Position = pos;
${LOG_DEPTH_VERTEX}
  }
`;
