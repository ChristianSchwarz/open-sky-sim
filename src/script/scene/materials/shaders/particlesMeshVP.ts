import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';

export const ParticleMeshVertProgram: string = `
precision highp float;
// RawShaderMaterial gets no precision prologue from three.js, so the GLSL ES
// defaults apply: int is highp here but mediump in the fragment stage. Shared
// int uniforms (shadingType) would then mismatch and ANGLE refuses to link the
// program — silently dropping every particle effect. Both stages state it.
precision highp int;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float halfWidth;
uniform float halfHeight;
uniform float minPixels;
uniform int shadingType;
uniform vec3 uRenderOrigin;

attribute vec3 position;
attribute vec3 offset;
attribute float scale;
attribute float rotation;
attribute vec4 color;

varying vec3 vPosition;
varying vec4 vColor;
${LOG_DEPTH_PARS_VERTEX}
void main() {
  vColor = color;
  // Camera-relative world position for fog / view transform.
  vec3 world = offset - uRenderOrigin;
  vPosition = world;

  float cosA = cos(rotation);
  float sinA = sin(rotation);
  mat2 rot = mat2(cosA, -sinA, sinA, cosA);

  vec4 viewOffset = viewMatrix * vec4(world, 1.0);
  float s = scale;
  // Keep distant chips at least minPixels tall so debris stays readable past ~5km
  // without making nearby pieces huge. minPixels==0 disables (ground smoke).
  if (minPixels > 0.0) {
    float z = max(0.001, -viewOffset.z);
    float minS = minPixels * z / (halfHeight * projectionMatrix[1][1]);
    s = max(scale, minS);
  }
  vec3 localPosition = s * vec3(rot * position.xy, position.z);

#ifdef GROUND_PLANE
  // Discs lie on the water/ground surface (world XZ) instead of billboarding:
  // used by ship wake foam, which must foreshorten at grazing angles.
  vec4 pos = projectionMatrix * viewMatrix
      * vec4(world + vec3(localPosition.x, localPosition.z, localPosition.y), 1.0);
#else
  vec4 pos = projectionMatrix * (viewOffset + vec4(localPosition, 1.0));
#endif
  if (shadingType != 3) {
    pos.x = floor(pos.x / pos.w * halfWidth + 0.5) / halfWidth * pos.w;
    pos.y = floor(pos.y / pos.w * halfHeight + 0.5) / halfHeight * pos.w;
  }
  gl_Position = pos;
${LOG_DEPTH_VERTEX}
}
`;
