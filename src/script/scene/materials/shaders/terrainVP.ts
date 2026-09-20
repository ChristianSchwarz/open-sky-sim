import { LOD_FADE_NEAR, LOD_FADE_SOFTNESS } from '../../../terrain/lod';
import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';
import { TERRAIN_COVER_PARS } from './terrainCover';

export { TERRAIN_CLASS_COUNT, TERRAIN_SWATCH_COUNT, TERRAIN_TONE_COUNT } from './terrainCover';

/**
 * Terrain land: the shaded vertex program plus a per-facet colour decision.
 *
 * Every land facet arrives carrying two observations - what the landcover
 * raster said it is (coverClass) and what the satellite said it looks like
 * (coverColor) - and facetColor (see terrainCover.ts) picks which of them to
 * paint with. That choice is a uniform, so switching between the four looks
 * costs one uniform write and no re-upload of anything.
 *
 * It is resolved here rather than in the fragment program for a facet. The
 * two attributes are facet constants replicated across the facet's three
 * vertices, so a per-vertex decision is exactly equal to a per-fragment one
 * — and it keeps the swatch search off the fragment path, where it would run
 * per pixel instead of per triangle. A far tile with a cover texture is the
 * exception: its colour is a texel, which only the fragment program can
 * see, so this also emits where in that texture the vertex falls
 * (vCoverUv) and the fragment program resolves the texel through the same
 * facetColor. Where the texture has no data the facet colour resolved here
 * still shows.
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

${TERRAIN_COVER_PARS}
  /**
   * The far cover texture's frame, per tile (see coverFrame in
   * coverTextures.ts): local east and north at the tile centre in these
   * axes, scaled so a dot with the raw position is the fraction of the tile
   * from its centre, and the lon span's shrink toward the pole per lat
   * fraction. Zero vectors on a tile without a texture.
   */
  uniform vec3 uCoverEast;
  uniform vec3 uCoverNorth;
  uniform float uCoverK;
  /**
   * The leaf dissolve, see LOD_FADE_NEAR. uLodFadeM is the distance (m) this
   * tile's parent handed over at, the far end of the dissolve; 0 for a tile
   * not dissolving. uLodFadeCap is the time ramp, 0..1, for a leaf that
   * arrived inside the band.
   */
  uniform float uLodFadeM;
  uniform float uLodFadeCap;
  /**
   * Land-use regions by size, see LANDUSE_REVEAL_MIN_PX: a region shows once
   * the camera is within regionSize * uSizeRevealScale metres (0 turns it
   * off). uLodFills says whether this tile's regions are fills lifted over
   * the ground (1), which a hidden one is dithered away from, or votes
   * painted onto it (0), which are painted as their own sampled colour.
   */
  uniform float uSizeRevealScale;
  uniform float uLodFills;

  attribute vec3 coverColor;
  attribute float coverClass;
  /** Width (m) of this vertex's land-use region on the tile; 0 for ground. */
  attribute float regionSize;

  const float AMBIENT_SKY_FLOOR = 0.3;
  /**
   * Sharpens the light/shadow terminator across slopes: N·L still spans the
   * same 0..1 range, but a facet only half turned to the sun now reads
   * noticeably darker instead of a wash of mid-grey. This is what makes
   * terrain relief legible from slope shading alone, so it runs steeper than
   * ShadedVertProgram's plain N·L for aircraft and objects.
   */
  const float SHADOW_CONTRAST_POWER = 2.2;
  const float RIM_POWER = 3.0;
  const float RIM_STRENGTH = 0.35;

  // Two varyings, not the shaded program's four: terrain has no duotone
  // branch to feed a scalar shade to, and no waterline to clip against.
  varying vec3 vLight;
  varying vec3 vBase;
  /** How far in the leaf dissolve is here, 0..1; the fragment dithers on it. */
  varying float vReveal;
  /** Where in the tile's cover texture this vertex falls; see uCoverEast. */
  varying vec2 vCoverUv;
  /** Camera distance at this vertex, so haze varies across a tile, not per draw. */
  varying float vDist;
${LOG_DEPTH_PARS_VERTEX}

  /**
   * How far in the leaf dissolve is at this vertex: 0 still the parent, 1
   * this tile. The band runs from one softness under the switch distance -
   * so a tile arrives fully transparent, its parent's sphere putting every
   * vertex at or past the switch - to LOD_FADE_NEAR of it. Distance is to
   * the camera, which the camera-relative rebase puts at the origin.
   */
  float lodReveal(float d) {
    if (uLodFadeM <= 0.0) {
      return 1.0;
    }
    float far = 1.0 - ${LOD_FADE_SOFTNESS.toFixed(3)};
    float t = uLodFadeM * mix(${LOD_FADE_NEAR.toFixed(3)}, far, 0.5);
    float soft = t * ${LOD_FADE_SOFTNESS.toFixed(3)};
    float byDistance = 1.0 - smoothstep(t - soft, t + soft, d);
    return min(byDistance, uLodFadeCap);
  }

  /**
   * Whether this vertex's land-use region is big enough to show from here:
   * 1 fully, 0 not at all, with the same softness as the dissolve. Ground,
   * and every vertex of a raster-only tile, carries no size and always shows.
   */
  float sizeReveal(float d) {
    if (uSizeRevealScale <= 0.0 || regionSize <= 0.0) {
      return 1.0;
    }
    float t = regionSize * uSizeRevealScale;
    float soft = t * ${LOD_FADE_SOFTNESS.toFixed(3)};
    return 1.0 - smoothstep(t - soft, t + soft, d);
  }

  void main() {
    // Land normals are baked in world ENU and tiles are placed by translation
    // only, so the attribute is already the world normal.
    vec3 worldNormal = normalize(normal);

    float ndl = pow(max(dot(worldNormal, uSunDir), 0.0), SHADOW_CONTRAST_POWER);
    float skyView = mix(AMBIENT_SKY_FLOOR, 1.0, 0.5 + 0.5 * worldNormal.y);

    vLight = uSunAmbient * skyView + uSunDirect * ndl;

    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    float d = length(worldPos.xyz);
    vDist = d;
    float bySize = sizeReveal(d);
    bool fills = uLodFills > 0.5;
    vBase = facetColor(coverColor, coverClass, fills ? 1.0 : bySize);
    vReveal = min(lodReveal(d), fills ? bySize : 1.0);

    // The cover texture's grid is the tile's lon/lat box: east and north
    // fractions from the centre, the east one over a lon span that narrows
    // toward the pole. Row 0 of the texture is the north edge.
    float coverE = dot(position, uCoverEast);
    float coverN = dot(position, uCoverNorth);
    vCoverUv = vec2(0.5 + coverE / (1.0 - uCoverK * coverN), 0.5 - coverN);

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
