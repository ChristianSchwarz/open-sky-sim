import { CLASS_COUNT, LAND_TONE_COUNT, TerrainClass, TerrainColourMode } from '../../../terrain/tones';

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
 * The cover colour decision, shared by both terrain programs.
 *
 * Every land facet arrives carrying two observations - what the landcover
 * raster said it is (a TerrainClass) and what the satellite said it looks
 * like (an sRGB colour) - and `facetColor` picks which of them to paint
 * with. That choice is a uniform, so switching between the four looks costs
 * one uniform write and no re-upload of anything.
 *
 * The vertex program calls it with the facet's attributes, once per vertex;
 * the fragment program with a texel of a far tile's cover texture, once per
 * fragment, which is why it lives in a chunk both can include. The uniforms
 * are declared in both stages under the same names, so they are one uniform
 * each to the material - which is also why every int here is spelled highp:
 * a fragment stage defaults ints to mediump and the link fails on the
 * mismatch.
 */
export const TERRAIN_COVER_PARS: string = `
  uniform highp int uTerrainMode;
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
  uniform highp int uSwatchCount;
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
  /**
   * Hybrid mode: share of a land-use facet's colour taken from its palette
   * tone, the rest from its sampled imagery colour. 0..1, a player setting.
   */
  uniform float uLanduseBlend;

  const vec3 COVER_LUMA = vec3(0.2126, 0.7152, 0.0722);

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

  /**
   * The colour to paint a patch of cover with: its sampled sRGB colour, its
   * class, and how much of a land-use region it is allowed to show as.
   *
   * shown is sizeReveal for a region that is a vote painted onto the
   * surface: it cannot be dropped, so below 1 it is painted as its own
   * sampled colour, the way untagged Ground is. A fill is dropped by the
   * fragment program instead and arrives here with shown = 1, as does a
   * texel, whose region is long since averaged away.
   */
  vec3 facetColor(vec3 coverColor, float coverClass, float shown) {
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
      float lum = dot(coverColor, COVER_LUMA);
      float d = clamp((lum - uShadeWindow.x) / max(uShadeWindow.y, 0.001), -1.0, 1.0);
      // Not named "step": that shadows the built-in, which some ES 1.00
      // compilers take badly and srgbToLinear above actually calls.
      float band = floor(d * uShadeSteps + 0.5) / max(uShadeSteps, 1.0);
      vec3 toned = tone * (1.0 + band * uShadeRange);
      // Then mixed with the colour sampled from imagery, by the player's
      // setting: all tone keeps a field recognisably a field, all sampled
      // keeps it in the colours of the ground around it.
      return mix(srgbToLinear(coverColor) * uRawLight, toned, uLanduseBlend * shown);
    }
    return mix(srgbToLinear(coverColor) * uRawLight, tone, shown);
  }
`;
