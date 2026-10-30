import { DITHER_PARS_FRAGMENT } from './dither';
import { LOG_DEPTH_FRAGMENT, LOG_DEPTH_PARS_FRAGMENT } from './logDepth';
import { TERRAIN_COVER_PARS } from './terrainCover';

/**
 * Terrain land fragments.
 *
 * ConstantFragProgram with one substitution: the base colour is the varying
 * the terrain vertex program resolved per facet, not a material-wide uniform.
 * Fog is identical, deliberately — terrain has to recede into exactly the same
 * haze as everything standing on it.
 *
 * The duotone branch that program carries is gone: it exists for authored
 * two-tone surfaces, and every terrain mode is a single colour under coloured
 * light.
 *
 * The one addition is the reveal: a leaf tile coming in over its parent, or
 * a land-use fill too small to show from here, drops fragments on an ordered
 * dither by how far in it is (vReveal, from the vertex program), so what is
 * underneath - the parent tile, or the ground the fill lies on - shows
 * through the holes.
 *
 * The other addition is the far cover texture. A coarse tile that has one
 * (uHasCoverTex) takes its base colour from the texel under the fragment,
 * resolved through the same facetColor the vertex program applied to the
 * facet, so the four colour modes and the leaf dissolving in over it agree.
 * A no-data texel keeps the facet colour. A water texel (PTX_WATER) is the
 * water mesh's colour, unlit like it: the strokes and small waters a far
 * tile no longer draws as meshes. See coverTextures.ts.
 */
export const TerrainFragProgram: string = `
  precision highp float;
  precision highp int;

  uniform float distance;
  uniform int shadingType;
  uniform int fogType;
  uniform float fogDensity;
  uniform vec3 fogColor;

  uniform sampler2D uCoverTex;
  uniform float uHasCoverTex;
  /** The player's far-texture switch, one uniform for every draw. */
  uniform float uCoverEnabled;
  /** The texture is read past this distance only; a leaf keeps its facets close up. */
  uniform float uCoverFromM;
  /** The water mesh's colour (TERRAIN_WATER, tweaked), for water texels. */
  uniform vec3 uCoverWater;

  varying vec3 vLight;
  varying vec3 vBase;
  varying float vReveal;
  varying vec2 vCoverUv;
  varying float vDist;
  varying float vCameraAbove;
  varying float vHeightOverCamera;
${LOG_DEPTH_PARS_FRAGMENT}
${DITHER_PARS_FRAGMENT}
${TERRAIN_COVER_PARS}
  /**
   * One cover texel's verdict: what it shows (kind 0 land, 1 water, 2 no data)
   * and, for land, its colour.
   */
  vec3 coverTexelColour(vec4 texel, out float kind) {
    // Alpha is the class byte; 255 is no data (PTX_NO_DATA), 254 water (PTX_WATER).
    float coverClass = floor(texel.a * 255.0 + 0.5);
    kind = coverClass > 254.5 ? 2.0 : coverClass > 253.5 ? 1.0 : 0.0;
    return kind == 0.0 ? facetColor(texel.rgb, coverClass, 1.0) : vec3(0.0);
  }

  /**
   * A magnified cover texture, filtered by hand: nearest sampling showed a
   * coarse tile's texels as hard squares and its coast as their staircase.
   * Each of the four texels round the point votes for land, water or no data
   * with its bilinear weight; the heaviest wins, which puts a coast on a
   * smooth line between texel centres, and land is the weighted mean of the
   * land texels' colours. Class and sentinel bytes are never interpolated.
   */
  vec3 coverMagnified(vec2 uv, out float kind) {
    ivec2 size = textureSize(uCoverTex, 0);
    vec2 st = uv * vec2(size) - 0.5;
    vec2 f = fract(st);
    ivec2 i0 = ivec2(floor(st));
    vec3 landSum = vec3(0.0);
    vec3 votes = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      ivec2 o = ivec2(k & 1, k >> 1);
      float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
      ivec2 at = clamp(i0 + o, ivec2(0), size - 1);
      float kk;
      vec3 c = coverTexelColour(texelFetch(uCoverTex, at, 0), kk);
      if (kk == 0.0) {
        landSum += c * w;
        votes.x += w;
      } else if (kk == 1.0) {
        votes.y += w;
      } else {
        votes.z += w;
      }
    }
    kind = votes.x >= votes.y && votes.x >= votes.z ? 0.0 : votes.y >= votes.z ? 1.0 : 2.0;
    return kind == 0.0 ? landSum / votes.x : vec3(0.0);
  }

  void main() {
    // Texels per pixel of the cover texture, taken here in uniform control
    // flow: past one the mips and nearest sampling do the job, under it the
    // texture is magnified and filtered by hand.
    float coverTexelsPerPx = max(fwidth(vCoverUv.x), fwidth(vCoverUv.y)) * float(textureSize(uCoverTex, 0).x);
    // <= so that 0 drops every fragment: the threshold bottoms out at 0 for
    // one cell in sixteen, which a plain < would keep.
    if (vReveal < 1.0 && vReveal <= bayerThreshold(gl_FragCoord.xy) + 0.5) {
      discard;
    }
    // An under-parent seen from below: only its top may fill in for the leaves.
    // Only what hangs over the camera counts: a facet turned away from a
    // camera well above it is no ceiling, and dropping it leaves a hole
    // wherever the leaves have not arrived.
    if (vCameraAbove < 0.0 && vHeightOverCamera > 0.0) {
      discard;
    }

    float fogSteps = 12.0;
    if (fogType == 2) {
      fogSteps = 24.0;
    }

    float fogFactor = exp2(-fogDensity * vDist);
    fogFactor = 1.0 - clamp(fogFactor, 0.0, 1.0);
    if (shadingType != 3) {
      fogFactor = floor(fogFactor * fogSteps + 0.5) / fogSteps;
    }

    vec3 base = vBase;
    vec3 light = vLight;
    if (uHasCoverTex > 0.5 && uCoverEnabled > 0.5 && vDist > uCoverFromM) {
      float kind;
      vec3 land = coverTexelsPerPx < 1.0
          ? coverMagnified(vCoverUv, kind)
          : coverTexelColour(texture2D(uCoverTex, vCoverUv), kind);
      if (kind == 1.0) {
        base = uCoverWater;
        light = vec3(1.0);
      } else if (kind == 0.0) {
        base = land;
      } else if (uCoverFromM < 0.0) {
        // The map mode (a negative reach, see setCoverUnderlay): no data is
        // water, drawn by the texture underlay beneath, not this facet.
        discard;
      }
    }
    vec3 diffuse = base * light;
    gl_FragColor = mix(vec4(diffuse, 1.0), vec4(fogColor, 1.0), fogFactor * 0.92);
${LOG_DEPTH_FRAGMENT}
  }
`;
