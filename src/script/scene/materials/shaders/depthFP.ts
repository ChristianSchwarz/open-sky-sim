import { DITHER_PARS_FRAGMENT } from './dither';
import { LOG_DEPTH_FRAGMENT, LOG_DEPTH_PARS_FRAGMENT } from './logDepth';

export const DepthFragProgram: string = `
  precision lowp float;

  uniform vec3 vCameraPos;
  uniform vec3 vCameraNormal;
  uniform float vCameraD;
  uniform int shadingType;
  uniform vec3 color;
  uniform vec3 colorSecondary;
  uniform int fogType;
  uniform float fogDensity;
  uniform vec3 fogColor;
  uniform float alphaDither;
  uniform float colorDither;
  uniform float overbright;
  uniform float uGrazingHighlight;
  uniform vec3 uSunTint;

  varying vec3 vPosition;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
${LOG_DEPTH_PARS_FRAGMENT}
${DITHER_PARS_FRAGMENT}
  void main() {
    vec2 screen = gl_FragCoord.xy;

    // A grazing view also thickens the dither, not just brightens it - real
    // glass looks progressively more solid (not just whiter) the more
    // edge-on it is, and a sparse dither at the rim undersells the effect.
    float rim = 0.0;
    if (uGrazingHighlight > 0.5) {
      vec3 grazeNormal = normalize(vNormalView);
      vec3 grazeView = normalize(vViewDir);
      float facing = abs(dot(grazeNormal, grazeView));
      rim = 1.0 - smoothstep(0.0, 0.65, facing);
    }
    float effectiveAlphaDither = alphaDither + rim * 0.55;

    if (effectiveAlphaDither > 0.001) {
      float alpha = effectiveAlphaDither + bayerThreshold(screen);
      if (alpha < 0.5) {
        discard;
      }
    }

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

    vec3 diffuse;
    if (colorDither > 0.5 || (shadingType == 0 && colorDither > -0.5)) {
      // colorDither: 1 = force two-tone stipple, 0 = duotone-only, -1 = solid primary.
      bool dithering = mod(floor(screen.x + screen.y), 2.0) > 0.5;
      diffuse = dithering ? color : colorSecondary;
    } else {
      diffuse = color;
    }

    // Real glass gets noticeably more reflective toward a grazing view - a
    // canopy pane read as uniformly dark from every angle otherwise. Blends
    // toward the sun's own colour (rim computed above, alongside the dither
    // density boost) rather than a fixed white, the way a canopy actually
    // glints with whatever light it's catching - amber at sunset, blue-white
    // at noon - rather than a flat highlight that never changes with the sky.
    if (rim > 0.001) {
      diffuse = mix(diffuse, uSunTint, rim);
    }

    // Light sources first: a palette entry stops at white, which is nowhere
    // near enough for the sun, so it is scaled up and left to clip the way a
    // light does rather than sitting wherever the palette left it.
    diffuse *= overbright;
    gl_FragColor = mix(vec4(diffuse, 1.0), vec4(fogColor, 1.0), fogFactor * 0.92);
${LOG_DEPTH_FRAGMENT}
  }
`;
