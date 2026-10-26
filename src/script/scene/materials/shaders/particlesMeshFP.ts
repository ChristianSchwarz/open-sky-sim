import { DITHER_PARS_FRAGMENT } from './dither';
import { LOG_DEPTH_FRAGMENT, LOG_DEPTH_PARS_FRAGMENT } from './logDepth';

export const ParticleMeshFragProgram: string = `
precision highp float;
// Must match ParticleMeshVertProgram — see the note there.
precision highp int;
// GLSL ES 3.00 with ES 1.00 spellings - see ParticleMeshVertProgram.
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor

uniform vec3 vCameraPos;
uniform vec3 vCameraNormal;
uniform float vCameraD;
uniform int shadingType;
uniform vec3 color;
uniform vec3 colorSecondary;
uniform int fogType;
uniform float fogDensity;
uniform vec3 fogColor;

varying vec3 vPosition;
varying vec4 vColor;
${LOG_DEPTH_PARS_FRAGMENT}
${DITHER_PARS_FRAGMENT}
void main() {
  vec2 screen = gl_FragCoord.xy;

  // Wake foam (GROUND_PLANE) fades by its alpha in every shading mode: solid
  // discs made the bow arms hard white bars all the way out.
#ifndef GROUND_PLANE
  if (shadingType != 3)
#endif
  {
    float alpha = vColor.a + bayerThreshold(screen);
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
  if (shadingType == 0) {
    bool dithering = mod(floor(screen.x + screen.y), 2.0) > 0.5;
    diffuse = dithering ? color : colorSecondary;
  } else {
    diffuse = vColor.rgb;
  }

  gl_FragColor = mix(vec4(diffuse, 1.0), vec4(fogColor, 1.0), fogFactor * 0.92);
${LOG_DEPTH_FRAGMENT}
}
`;
