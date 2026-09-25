import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';

const shader = (highp: boolean): string => `
  precision highp float;

  uniform float halfWidth;
  uniform float halfHeight;
  uniform int shadingType;

  varying vec3 vPosition;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
${LOG_DEPTH_PARS_VERTEX}
  void main() {
  #ifdef USE_INSTANCING
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec4 viewPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  #endif
    vPosition = vec3(worldPos.x, 0.0, worldPos.z);
    vNormalView = normalize(normalMatrix * normal);
    vViewDir = -viewPos.xyz;
    vec4 pos = projectionMatrix * viewPos;`+ (highp ? '' : `
    if (shadingType != 3) {
      pos.x = floor(pos.x / pos.w * halfWidth + 0.5) / halfWidth * pos.w;
      pos.y = floor(pos.y / pos.w * halfHeight + 0.5) / halfHeight * pos.w;
    }`) + `
    gl_Position = pos;
${LOG_DEPTH_VERTEX}
  }
`;

export const FlatVertProgram: string = shader(false);
export const HighpFlatVertProgram: string = shader(true);
