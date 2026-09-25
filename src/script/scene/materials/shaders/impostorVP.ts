import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';

/**
 * Billboarded impostor for distant vegetation. Each instance is placed at its
 * tree base via instanceMatrix; the 2D shape (position.xy, in world units at
 * unit scale) is expanded in view space so it always faces the camera. Uniform
 * per-instance scale is recovered from the instance matrix basis length.
 */
export const ImpostorVertProgram: string = `
  precision highp float;

  uniform float halfWidth;
  uniform float halfHeight;
  uniform int shadingType;

  varying vec3 vPosition;
  // Unused (uGrazingHighlight is always 0 here) but declared to match the
  // varyings DepthFragProgram shares with the mesh vertex shaders.
  varying vec3 vNormalView;
  varying vec3 vViewDir;
${LOG_DEPTH_PARS_VERTEX}
  void main() {
    vec4 worldBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float s = length(instanceMatrix[0].xyz);

    vec4 viewCenter = viewMatrix * worldBase;
    viewCenter.xy += position.xy * s;

    vPosition = vec3(worldBase.x, 0.0, worldBase.z);
    vNormalView = vec3(0.0, 0.0, 1.0);
    vViewDir = vec3(0.0, 0.0, 1.0);

    vec4 pos = projectionMatrix * viewCenter;
    if (shadingType != 3) {
      pos.x = floor(pos.x / pos.w * halfWidth + 0.5) / halfWidth * pos.w;
      pos.y = floor(pos.y / pos.w * halfHeight + 0.5) / halfHeight * pos.w;
    }
    gl_Position = pos;
${LOG_DEPTH_VERTEX}
  }
`;
