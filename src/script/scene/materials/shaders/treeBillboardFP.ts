import { LOG_DEPTH_FRAGMENT, LOG_DEPTH_PARS_FRAGMENT } from './logDepth';

/**
 * Textured counterpart to DepthFragProgram: same fog treatment, sampling the
 * tree atlas instead of a flat palette colour - except the atlas itself only
 * carries a neutral (near-white/grey) canopy silhouette, not a baked colour.
 * `color` (the standard palette uniform every material gets, here built from
 * PaletteCategory.TERRAIN_FOREST - see treeBillboards.ts) is what actually
 * tints the canopy, so trees read as the same forest green the ground paints
 * for TerrainTone.Forest, time-of-day and palette changes included, rather
 * than a fixed hue baked in at sprite-generation time. The trunk is left
 * alone: it is drawn as an actual saturated brown in the atlas, which the
 * low-saturation canopy test below excludes from tinting.
 */
export const TreeBillboardFragProgram: string = `
  precision lowp float;

  uniform sampler2D uMap;
  uniform vec3 vCameraPos;
  uniform vec3 vCameraNormal;
  uniform float vCameraD;
  uniform int shadingType;
  uniform int fogType;
  uniform float fogDensity;
  uniform vec3 fogColor;

  varying vec3 vPosition;
  varying vec2 vUv;
  varying vec3 vLeaf;
${LOG_DEPTH_PARS_FRAGMENT}
  void main() {
    vec4 texel = texture2D(uMap, vUv);
    if (texel.a < 0.5) {
      discard;
    }

    float mx = max(texel.r, max(texel.g, texel.b));
    float mn = min(texel.r, min(texel.g, texel.b));
    // Low saturation = the neutral canopy fill; the trunk is a saturated
    // brown and fails this, so it keeps its own baked colour untinted.
    float canopyMask = step(mx - mn, 0.12);
    vec3 leaf = vLeaf * texel.r;
    vec3 tinted = mix(texel.rgb, leaf, canopyMask);

    float distance = 0.0;
    float fogSteps = 12.0;

    if (fogType == 1) {
      distance = dot(vPosition, vCameraNormal) + vCameraD;
    } else if (fogType == 2) {
      vec3 dV = vPosition - vCameraPos;
      distance = sqrt(dot(dV, dV));
      fogSteps = 24.0;
    }

    float fogFactor = exp2(-fogDensity * distance);
    fogFactor = 1.0 - clamp(fogFactor, 0.0, 1.0);
    if (shadingType != 3) {
      fogFactor = floor(fogFactor * fogSteps + 0.5) / fogSteps;
    }

    gl_FragColor = mix(vec4(tinted, 1.0), vec4(fogColor, 1.0), fogFactor * 0.92);
${LOG_DEPTH_FRAGMENT}
  }
`;
