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
 * A no-data texel keeps the facet colour. See coverTextures.ts.
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

  varying vec3 vLight;
  varying vec3 vBase;
  varying float vReveal;
  varying vec2 vCoverUv;
${LOG_DEPTH_PARS_FRAGMENT}
${DITHER_PARS_FRAGMENT}
${TERRAIN_COVER_PARS}
  void main() {
    // <= so that 0 drops every fragment: the threshold bottoms out at 0 for
    // one cell in sixteen, which a plain < would keep.
    if (vReveal < 1.0 && vReveal <= bayerThreshold(gl_FragCoord.xy) + 0.5) {
      discard;
    }

    float fogSteps = 12.0;
    if (fogType == 2) {
      fogSteps = 24.0;
    }

    float fogFactor = exp2(-fogDensity * distance);
    fogFactor = 1.0 - clamp(fogFactor, 0.0, 1.0);
    if (shadingType != 3) {
      fogFactor = floor(fogFactor * fogSteps + 0.5) / fogSteps;
    }

    vec3 base = vBase;
    if (uHasCoverTex > 0.5 && uCoverEnabled > 0.5) {
      vec4 texel = texture2D(uCoverTex, vCoverUv);
      // Alpha is the class byte; 255 is no data (PTX_NO_DATA).
      float coverClass = floor(texel.a * 255.0 + 0.5);
      if (coverClass < 254.5) {
        base = facetColor(texel.rgb, coverClass, 1.0);
      }
    }
    vec3 diffuse = base * vLight;
    gl_FragColor = mix(vec4(diffuse, 1.0), vec4(fogColor, 1.0), fogFactor * 0.92);
${LOG_DEPTH_FRAGMENT}
  }
`;
