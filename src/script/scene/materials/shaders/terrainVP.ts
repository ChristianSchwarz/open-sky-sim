import { CLASS_COUNT, LAND_TONE_COUNT, TerrainClass, TerrainColourMode } from '../../../terrain/tones';
import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';

/**
 * How many colours the swatch table holds. Compile-time, because a GLSL ES
 * 1.00 loop bound has to be constant and a dynamically-indexed uniform array
 * makes ANGLE emit helper functions the HLSL compiler dislikes.
 */
export const TERRAIN_SWATCH_COUNT = 24;

// The other two array sizes come from the terrain vocabulary rather than being
// restated here: a tone added to the palette without the shader's array
// growing to match would silently clamp every facet above it.
export const TERRAIN_TONE_COUNT = LAND_TONE_COUNT;
export const TERRAIN_CLASS_COUNT = CLASS_COUNT;

/**
 * Terrain land: the shaded vertex program plus a per-facet colour decision.
 *
 * Every land facet arrives carrying two observations - what the landcover
 * raster said it is (coverClass) and what the satellite said it looks like
 * (coverColor) - and this picks which of them to paint with. That choice is a
 * uniform, so switching between the four looks costs one uniform write and no
 * re-upload of anything.
 *
 * It is resolved here rather than in the fragment program on purpose. The two
 * attributes are facet constants replicated across the facet's three vertices,
 * so a per-vertex decision is exactly equal to a per-fragment one — and it
 * keeps the swatch search off the fragment path, where it would run per pixel
 * instead of per triangle.
 *
 * The lighting below is ShadedVertProgram's, unchanged. Land is always the
 * STATIC path (normals are baked in world ENU and tiles are never rotated), so
 * the shadingType branch that program needs is not repeated here.
 */
export const TerrainVertProgram: string = `
  precision highp float;

  uniform float halfWidth;
  uniform float halfHeight;
  uniform int shadingType;
  uniform vec3 uSunDir;
  uniform vec3 uSunAmbient;
  uniform vec3 uSunDirect;
  uniform vec3 uSunTint;

  uniform int uTerrainMode;
  /** Palette colour per land tone, already blended for the time of day. */
  uniform vec3 uToneColor[${TERRAIN_TONE_COUNT}];
  /** Land tone for each cover class, as a float so it can index by compare. */
  uniform float uClassTone[${TERRAIN_CLASS_COUNT}];
  /**
   * The swatch table, in sRGB rather than linear like every other colour
   * uniform here. Deliberate: the bake chose these by median cut over sRGB
   * bytes, so matching in the same space picks the same swatch it would.
   * Nearest-in-linear is not the same answer - it spends the table's
   * resolution on highlights - and the winner is converted below anyway.
   */
  uniform vec3 uSwatch[${TERRAIN_SWATCH_COUNT}];
  uniform int uSwatchCount;
  /** Hybrid mode: how many shade bands, and how far they reach either side. */
  uniform float uShadeSteps;
  uniform float uShadeRange;
  /** The brightness this bake calls average, and one standard deviation of it. */
  uniform vec2 uShadeWindow;
  /**
   * What a colour the palette does not own must be multiplied by to stand in
   * the same light as one it does — the same factor the rawColor path takes.
   * Imagery is exactly that kind of colour: real, and with no authored night
   * counterpart of its own.
   */
  uniform vec3 uRawLight;

  attribute vec3 coverColor;
  attribute float coverClass;

  const float AMBIENT_SKY_FLOOR = 0.4;
  /**
   * Sharpens the light/shadow terminator across slopes: N·L still spans the
   * same 0..1 range, but a facet only half turned to the sun now reads
   * noticeably darker instead of a wash of mid-grey. This is what makes
   * terrain relief legible from slope shading alone, so it runs steeper than
   * ShadedVertProgram's plain N·L for aircraft and objects.
   */
  const float SHADOW_CONTRAST_POWER = 1.69;
  const float RIM_POWER = 3.0;
  const float RIM_STRENGTH = 0.35;
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  // Two varyings, not the shaded program's four: terrain has no duotone
  // branch to feed a scalar shade to, and no waterline to clip against.
  varying vec3 vLight;
  varying vec3 vBase;
${LOG_DEPTH_PARS_VERTEX}

  /**
   * The baked colour arrives as sRGB bytes; every palette uniform reached its
   * value through THREE.Color, which decodes sRGB to the linear working space.
   * Without this the two sit in different spaces and imagery reads visibly
   * paler than the palette modes it is meant to be comparable with.
   *
   * Same piecewise curve THREE.Color uses, not a 2.2 power: the toe matters at
   * exactly the dark end where sea cliffs and lava live.
   */
  vec3 srgbToLinear(vec3 c) {
    vec3 lo = c * 0.0773993808;
    vec3 hi = pow(c * 0.9478672986 + 0.0521327014, vec3(2.4));
    return mix(hi, lo, step(c, vec3(0.04045)));
  }

  /** uToneColor[i] without dynamic indexing. */
  vec3 toneColor(float index) {
    vec3 c = uToneColor[0];
    for (int i = 1; i < ${TERRAIN_TONE_COUNT}; i++) {
      if (abs(float(i) - index) < 0.5) {
        c = uToneColor[i];
        break; // indices are unique - nothing later could also match
      }
    }
    return c;
  }

  /** uClassTone[i] without dynamic indexing. */
  float toneOfClass(float cls) {
    float t = uClassTone[0];
    for (int i = 1; i < ${TERRAIN_CLASS_COUNT}; i++) {
      if (abs(float(i) - cls) < 0.5) {
        t = uClassTone[i];
        break; // indices are unique - nothing later could also match
      }
    }
    return t;
  }

  /** Nearest table colour, in plain RGB distance. */
  vec3 nearestSwatch(vec3 c) {
    vec3 best = c;
    float bestD = 1.0e9;
    for (int i = 0; i < ${TERRAIN_SWATCH_COUNT}; i++) {
      if (i >= uSwatchCount) {
        break;
      }
      vec3 d = uSwatch[i] - c;
      float dist = dot(d, d);
      if (dist < bestD) {
        bestD = dist;
        best = uSwatch[i];
      }
    }
    return best;
  }

  vec3 facetColor() {
    // srgbToLinear(coverColor) only ever feeds the two branches below - it
    // used to run unconditionally ahead of every branch instead, which is a
    // pow(x, 2.4) every one of Hybrid/Swatch-table/Plain mode's vertices paid
    // for and threw away, uTerrainMode being one uniform for the whole draw
    // rather than something that could vary in and skip back out per vertex.
    if (uTerrainMode == ${TerrainColourMode.Imagery}) {
      return srgbToLinear(coverColor) * uRawLight;
    }
    if (uTerrainMode == ${TerrainColourMode.Swatch}) {
      // With no table baked there is nothing to snap to, and returning the raw
      // colour is a better answer than returning black.
      if (uSwatchCount == 0) {
        return srgbToLinear(coverColor) * uRawLight;
      }
      return srgbToLinear(nearestSwatch(coverColor)) * uRawLight;
    }

    // Unmapped ground on a landuse tile: its colour is already a smoothly
    // blended regional mean, so paint it as it is. A palette tone would put
    // one flat green over everything between the polygons.
    if (abs(coverClass - ${TerrainClass.Ground}.0) < 0.5) {
      return srgbToLinear(coverColor) * uRawLight;
    }

    vec3 tone = toneColor(toneOfClass(coverClass));
    if (uTerrainMode == ${TerrainColourMode.Hybrid}) {
      // The palette keeps the hue; the imagery only says how light this patch
      // of that cover is relative to an average one. Banded, so neighbouring
      // facets share a step and the result reads as terraced rather than as
      // noise — which is the whole point of picking this over raw imagery.
      // sRGB, and measured against what this bake calls average rather than
      // against mid-grey: in linear light real ground bunches into the bottom
      // fifth of the range, and every facet lands in the same band.
      float lum = dot(coverColor, LUMA);
      float d = clamp((lum - uShadeWindow.x) / max(uShadeWindow.y, 0.001), -1.0, 1.0);
      // Not named "step": that shadows the built-in, which some ES 1.00
      // compilers take badly and srgbToLinear above actually calls.
      float band = floor(d * uShadeSteps + 0.5) / max(uShadeSteps, 1.0);
      return tone * (1.0 + band * uShadeRange);
    }
    return tone;
  }

  void main() {
    // Land normals are baked in world ENU and tiles are placed by translation
    // only, so the attribute is already the world normal.
    vec3 worldNormal = normalize(normal);

    float ndl = pow(max(dot(worldNormal, uSunDir), 0.0), SHADOW_CONTRAST_POWER);
    float skyView = mix(AMBIENT_SKY_FLOOR, 1.0, 0.5 + 0.5 * worldNormal.y);

    vLight = uSunAmbient * skyView + uSunDirect * ndl;
    vBase = facetColor();

    vec4 worldPos = modelMatrix * vec4(position, 1.0);

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
