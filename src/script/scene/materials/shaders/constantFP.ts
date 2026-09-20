import { DITHER_PARS_FRAGMENT } from './dither';
import { LOG_DEPTH_FRAGMENT, LOG_DEPTH_PARS_FRAGMENT } from './logDepth';

export const ConstantFragProgram: string = `
  precision highp float;

  uniform float distance;
  uniform int shadingType;
  uniform vec3 color;
  uniform vec3 colorSecondary;
  uniform int fogType;
  uniform float fogDensity;
  uniform vec3 fogColor;
  uniform float clipBelowY;

  varying float shade;
  varying vec3 vLight;
  varying float vWorldY;
  varying float vDist;
${LOG_DEPTH_PARS_FRAGMENT}
${DITHER_PARS_FRAGMENT}
  void main() {
    // Hide ship hull (etc.) below the waterline. Disabled when clipBelowY is very negative.
    // Threshold is in camera-relative world Y (absolute clip − RENDER_ORIGIN.y).
    if (clipBelowY > -1.0e20 && vWorldY < clipBelowY) {
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

    vec3 diffuse;
    if (shadingType == 0) {
      if (shade > 0.9) {
        diffuse = color;
      } else if (shade > 0.8) {
        vec2 screen = gl_FragCoord.xy;
        bool dithering = mod(floor(screen.x + screen.y), 2.0) > 0.5;
        diffuse = dithering ? color : colorSecondary;
      } else {
        diffuse = colorSecondary;
      }
    } else {
      // Coloured light, not a grey multiply: see vLight in shadedVP. The
      // duotone branch above stays on the scalar shade on purpose: its two
      // authored tones are the whole look, and warming them would break it.
      diffuse = color * vLight;
    }
    gl_FragColor = mix(vec4(diffuse, 1.0), vec4(fogColor, 1.0), fogFactor * 0.92);
${LOG_DEPTH_FRAGMENT}
  }
`;
