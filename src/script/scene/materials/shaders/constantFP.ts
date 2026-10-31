import { HAZE_MATERIAL_PARS_FRAGMENT } from './haze';
import { DITHER_PARS_FRAGMENT } from './dither';
import { LOG_DEPTH_FRAGMENT, LOG_DEPTH_PARS_FRAGMENT } from './logDepth';

export const ConstantFragProgram: string = `
  precision highp float;

  uniform float distance;
  uniform int shadingType;
  uniform vec3 color;
  uniform vec3 colorSecondary;
  uniform int fogType;
  varying vec3 vHazeRay;
  uniform float clipBelowY;

  varying float shade;
  varying vec3 vLight;
  varying float vWorldY;
  varying float vDist;
#ifdef VERTEX_TONES
  varying vec3 vToneColor;
  varying vec3 vToneShade;
  #define TONE_PRIMARY vToneColor
  #define TONE_SECONDARY vToneShade
#else
  #define TONE_PRIMARY color
  #define TONE_SECONDARY colorSecondary
#endif
${LOG_DEPTH_PARS_FRAGMENT}
${HAZE_MATERIAL_PARS_FRAGMENT}
${DITHER_PARS_FRAGMENT}
  void main() {
    // Hide ship hull (etc.) below the waterline. Disabled when clipBelowY is very negative.
    // Threshold is in camera-relative world Y (absolute clip − RENDER_ORIGIN.y).
    if (clipBelowY > -1.0e20 && vWorldY < clipBelowY) {
      discard;
    }

    vec3 diffuse;
    if (shadingType == 0) {
      if (shade > 0.9) {
        diffuse = TONE_PRIMARY;
      } else if (shade > 0.8) {
        vec2 screen = gl_FragCoord.xy;
        bool dithering = mod(floor(screen.x + screen.y), 2.0) > 0.5;
        diffuse = dithering ? TONE_PRIMARY : TONE_SECONDARY;
      } else {
        diffuse = TONE_SECONDARY;
      }
    } else {
      // Coloured light, not a grey multiply: see vLight in shadedVP. The
      // duotone branch above stays on the scalar shade on purpose: its two
      // authored tones are the whole look, and warming them would break it.
      diffuse = TONE_PRIMARY * vLight;
    }
    gl_FragColor = vec4(hazed(diffuse, vHazeRay), 1.0);
${LOG_DEPTH_FRAGMENT}
  }
`;
