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
  uniform vec3 color;
  uniform vec3 uNoonForest;
  uniform vec3 uSunDir;
  uniform vec3 uSunAmbient;
  uniform vec3 uSunDirect;

  attribute vec4 instanceShade;
  attribute float instanceSpecies;
  attribute vec3 instanceNormal;

  varying vec3 vPosition;
  varying vec2 vUv;
  varying vec3 vLeaf;
  varying vec3 vTrunk;
${LOG_DEPTH_PARS_VERTEX}
  void main() {
    vec4 worldBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float s = length(instanceMatrix[0].xyz);

    // Billboard about world up, not camera up: using the camera's view-space
    // x/y directly would roll the quad with the aircraft's bank, tilting
    // trees over whenever the plane banks. Instead build a right axis
    // perpendicular to both world up and the line of sight, so the quad
    // always stands vertical in world space regardless of camera roll.
    vec3 toCamWorld = cameraPosition - worldBase.xyz;
    vec3 worldUp = vec3(0.0, 1.0, 0.0);
    vec3 rightW = normalize(cross(worldUp, normalize(vec3(toCamWorld.x, 0.0, toCamWorld.z))));
    vec3 worldOffset = (rightW * position.x + worldUp * position.y) * s;

    vec4 viewCenter = viewMatrix * (worldBase + vec4(worldOffset, 0.0));
    // The quad is screen-aligned, so looking steeply down its "up" runs along
    // the ground and the tree's top sits at the base's depth - inside any
    // terrain rising behind it, which slices the sprite away more and more
    // as the pitch grows. A real tree's top is nearer the camera by
    // height * sin(elevation); push the quad toward the camera by that (depth
    // only, so its on-screen size is unchanged).
    vec3 toCamW = cameraPosition - worldBase.xyz;
    float sinElev = clamp((cameraPosition.y - worldBase.y) / max(length(toCamW), 0.001), 0.0, 1.0);
    viewCenter.z += position.y * s * sinElev;

    vPosition = vec3(worldBase.x, 0.0, worldBase.z);
    // Leaf colour is per instance, so resolve it here (a handful of vertices)
    // rather than per pixel: the ground colour mixed 50:50 with the palette
    // green, darkened by the brightness factor, then pushed away from its own
    // grey for saturation. Linear in the sprite's canopy value, so the
    // fragment shader only has to scale it.
    // The sampled ground colour is the baked (daylight) satellite colour, so
    // it is used as a colour *ratio* against a typical forest value and applied
    // to the palette colour: brightness then comes from the palette - which
    // darkens at dusk and night like the terrain's own - and only the local
    // hue/lightness variation comes from the ground under the tree.
    vec3 groundRatio = clamp(instanceShade.rgb / 0.25, 0.3, 2.0);
    vec3 leaf = color * mix(vec3(1.0), groundRatio, 0.5) * instanceShade.a;
    float leafLuma = dot(leaf, vec3(0.299, 0.587, 0.114));
    vLeaf = max(mix(vec3(leafLuma), leaf, 1.6), 0.0);

    // Lit exactly the way the terrain is (same sun uniforms, same ambient and
    // direct terms, same facet normal), in absolute terms: the leaves darken
    // at dusk, warm and cool with the sun and brighten by day together with
    // the ground they stand on, and slopes shade by their aspect to the sun.
    vec3 n = normalize(instanceNormal);
    vec3 lit = uSunAmbient * mix(0.4, 1.0, 0.5 + 0.5 * n.y)
        + uSunDirect * pow(max(dot(n, uSunDir), 0.0), 1.69);
    vLeaf *= lit;
    // Trunks are not tinted, so dim them by how far the palette's forest colour
    // has darkened from its noon value, and light them the same way.
    vec3 lumaW = vec3(0.299, 0.587, 0.114);
    vTrunk = lit * clamp(dot(color, lumaW) / max(dot(uNoonForest, lumaW), 0.001), 0.03, 1.0);

    vec2 toCam = cameraPosition.xz - worldBase.xz;
    float horizDist = max(length(toCam), 0.001);
    // Tangent of the camera's elevation angle above the tree (0 = looking at
    // it horizontally, infinite = straight down). Comparing tangents against
    // tan(30/55/80 degrees) picks the same band as the angle would, without
    // an atan per vertex.
    float elevTan = max(cameraPosition.y - worldBase.y, 0.0) / horizDist;

    // Bands 0-30 / 30-55 / 55-80 / 80-90 pick the 4 baked angles (0/30/60/90),
    // laid out row-major in a 2x2 view grid: (0,0)=0deg, (1,0)=30deg,
    // (0,1)=60deg, (1,1)=90deg.
    float col = 0.0;
    float row = 0.0;
    if (elevTan < 0.5774) {
      col = 0.0; row = 0.0;
    } else if (elevTan < 1.4281) {
      col = 1.0; row = 0.0;
    } else if (elevTan < 5.6713) {
      col = 0.0; row = 1.0;
    } else {
      col = 1.0; row = 1.0;
    }

    // Shared atlas: species blocks in a 2x2 grid (species % 2, species / 2),
    // each block holding the 2x2 view cells above - see treeAtlas.ts.
    float spCol = mod(instanceSpecies, 2.0);
    float spRow = floor(instanceSpecies * 0.5);
    vec2 uvBase = uv * vec2(0.25, 1.0 / 6.0);
    vUv = vec2(uvBase.x + spCol * 0.5 + col * 0.25, uvBase.y + spRow / 3.0 + row / 6.0);

    vec4 pos = projectionMatrix * viewCenter;
    if (shadingType != 3) {
      pos.x = floor(pos.x / pos.w * halfWidth + 0.5) / halfWidth * pos.w;
      pos.y = floor(pos.y / pos.w * halfHeight + 0.5) / halfHeight * pos.w;
    }
    gl_Position = pos;
${LOG_DEPTH_VERTEX}
  }
`;
