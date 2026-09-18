import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';

/**
 * Billboarded tree with a discrete 4-angle atlas instead of a single
 * always-facing quad: the quadrant sampled is picked here, per frame, from
 * the camera's elevation angle above the tree - how far down it is looking,
 * not its horizontal orbit angle, since a plane overwhelmingly changes
 * altitude and dive angle over a tree rather than circling it at a fixed
 * height. 0 degrees (eye-level) samples the side silhouette, 90 degrees
 * (looking straight down) samples a flat top-down disc. See treeAtlas.ts for
 * the atlas layout this must agree with, and treeSprites.ts for the source
 * art and why elevation, not azimuth, is what picks the view.
 *
 * The quad itself still expands in view space like ImpostorVertProgram, so a
 * tree's silhouette always reads edge-on to the camera; only the texture
 * pasted onto it changes with viewing angle, not the geometry.
 */
export const TreeBillboardVertProgram: string = `
  precision highp float;

  uniform float halfWidth;
  uniform float halfHeight;
  uniform int shadingType;

  attribute vec4 instanceShade;

  varying vec3 vPosition;
  varying vec2 vUv;
  varying vec4 vShade;
${LOG_DEPTH_PARS_VERTEX}
  void main() {
    vec4 worldBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float s = length(instanceMatrix[0].xyz);

    vec4 viewCenter = viewMatrix * worldBase;
    viewCenter.xy += position.xy * s;

    vPosition = vec3(worldBase.x, 0.0, worldBase.z);
    vShade = instanceShade;

    vec2 toCam = cameraPosition.xz - worldBase.xz;
    float horizDist = length(toCam);
    // 0 = looking at the tree horizontally, 90 = looking straight down at it.
    float elevDeg = atan(cameraPosition.y - worldBase.y, max(horizDist, 0.001)) * (180.0 / 3.14159265359);
    elevDeg = clamp(elevDeg, 0.0, 90.0);

    // Bands 0-30 / 30-55 / 55-80 / 80-90 pick the 4 baked angles (0/30/60/90), laid out row-major in a
    // 2x2 atlas: (0,0)=0deg, (1,0)=30deg, (0,1)=60deg, (1,1)=90deg.
    float col = 0.0;
    float row = 0.0;
    if (elevDeg < 30.0) {
      col = 0.0; row = 0.0;
    } else if (elevDeg < 55.0) {
      col = 1.0; row = 0.0;
    } else if (elevDeg < 80.0) {
      col = 0.0; row = 1.0;
    } else {
      col = 1.0; row = 1.0;
    }

    vec2 uvBase = uv * 0.5;
    vUv = vec2(uvBase.x + col * 0.5, uvBase.y + row * 0.5);

    vec4 pos = projectionMatrix * viewCenter;
    if (shadingType != 3) {
      pos.x = floor(pos.x / pos.w * halfWidth + 0.5) / halfWidth * pos.w;
      pos.y = floor(pos.y / pos.w * halfHeight + 0.5) / halfHeight * pos.w;
    }
    gl_Position = pos;
${LOG_DEPTH_VERTEX}
  }
`;
