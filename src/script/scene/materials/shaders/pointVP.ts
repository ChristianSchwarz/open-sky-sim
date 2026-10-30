import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';

export const PointVertProgram: string = `
  precision highp float;

  uniform float halfWidth;
  uniform float halfHeight;
  uniform int shadingType;
  // Size of the point: uPointSizePx pixels, or - for a light, uPointSizeM > 0 -
  // that many metres across as the camera sees it, held between
  // uPointSizePx and uPointMaxPx so a far light stays a dot and a near one
  // does not grow into a square.
  uniform float uPointSizePx;
  uniform float uPointSizeM;
  uniform float uPointMaxPx;

  varying vec3 vPosition;
  // Unused (uGrazingHighlight is always 0 here) but declared to match the
  // varyings DepthFragProgram shares with the mesh vertex shaders.
  varying vec3 vNormalView;
  varying vec3 vViewDir;
${LOG_DEPTH_PARS_VERTEX}
  void main() {
    vec4 tmpPos = modelMatrix * vec4(position, 1.0);
    vPosition = vec3(tmpPos.x, 0.0, tmpPos.z);
    vNormalView = vec3(0.0, 0.0, 1.0);
    vViewDir = vec3(0.0, 0.0, 1.0);

    vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uPointSizeM > 0.0
      ? clamp(uPointSizeM * projectionMatrix[1][1] * halfHeight / max(pos.w, 1e-3), uPointSizePx, uPointMaxPx)
      : uPointSizePx;
    if (shadingType != 3) {
      pos.x = floor(pos.x / pos.w * halfWidth + 0.5) / halfWidth * pos.w;
      pos.y = floor(pos.y / pos.w * halfHeight + 0.5) / halfHeight * pos.w;
    }
    gl_Position = pos;
${LOG_DEPTH_VERTEX}
  }
`;
