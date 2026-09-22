import { LOG_DEPTH_PARS_VERTEX, LOG_DEPTH_VERTEX } from './logDepth';

/**
 * Minimum half-width of a watercourse stroke, in pixels.
 *
 * The whole reason this program exists. A watercourse is baked at its true
 * width and nothing else, so a 12 m canal is 12 m at 200 m range and a
 * fraction of a pixel at 20 km — which is exactly how it used to disappear.
 * Below this the stroke stops narrowing and holds, which is what a chart does
 * and what makes a canal readable from a cockpit without making it four times
 * too wide underneath you.
 *
 * 0.9 rather than 1: a stroke is two of these across, so this is a floor of
 * 1.8 px. A one-pixel line disappears into the resolution snapping the rest of
 * the terrain is drawn with.
 */
export const RIVER_MIN_HALF_PIXELS = 0.9;

/**
 * Cap on how far the minimum may stretch a stroke, as a multiple of true width.
 *
 * Needed at grazing angles. Holding a pixel floor across a river seen almost
 * edge-on takes an enormous world-space offset — the perpendicular is nearly
 * along the view direction, so it projects to almost nothing — and without a
 * cap a distant reach fans out into a sheet lying across the landscape. Capped,
 * it thins out and fades instead, which is the honest answer for something you
 * are looking along rather than at.
 *
 * 8 covers the range that matters. A 12 m canal falls below the floor at about
 * 3.7 km on a 720-line display, so 8x carries it to roughly 30 km looking
 * straight at it — past the terrain view range. Beyond that the stroke is
 * standing on ground it does not cover, and the wider it gets the more of it
 * the terrain in front can occlude.
 */
export const RIVER_MAX_STRETCH = 8.0;

/**
 * Watercourse stroke: a centreline widened in the vertex program.
 *
 * The geometry is two vertices per centreline point, at the *same* position,
 * carrying opposite unit offsets across the flow (`riverDir`) and the true
 * half-width in decimetres (`riverHalf`). This turns that into a ribbon, and
 * measures the result in pixels so it can hold a floor.
 *
 * Widening here rather than in the bake is the point. The bake works in metres
 * on a grid whose cell is 12 m at Potsdam z12 and 190 m at z10, and no width in
 * metres is both visible at range and honest close up. Pixels are the units the
 * question is actually asked in.
 *
 * The widening happens in view space and the result is projected once. It is
 * tempting to give the whole stroke the centreline's depth and w — the ribbon
 * is lifted off the ground plane once the floor bites, so the two banks are not
 * really at different depths — but doing that means dividing by the corner's own
 * w and rebuilding a clip position around a different one, and that breaks the
 * homogeneous coordinate the near-plane clip depends on. A vertex behind the eye
 * stops being clipped and lands somewhere arbitrary instead, which paints the
 * stroke across the entire frame whenever a river passes under the aircraft.
 *
 * There is no resolution snapping here, the same as the water material, which is
 * built `highp` for the same reason. Snapping both banks of a two-pixel ribbon
 * to the pixel grid independently collapses it to nothing on some frames and
 * opens it on others: the river itself flickers.
 */
export const RiverVertProgram: string = `
  precision highp float;

  uniform float halfWidth;
  uniform float halfHeight;
  uniform float uMinHalfPixels;
  uniform float uMaxStretch;

  attribute vec3 riverDir;
  attribute float riverHalf;

  varying vec3 vPosition;
  // Unused (uGrazingHighlight is always 0 here) but declared to match the
  // varyings DepthFragProgram shares with the mesh vertex shaders.
  varying vec3 vNormalView;
  varying vec3 vViewDir;
${LOG_DEPTH_PARS_VERTEX}
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosition = vec3(worldPos.x, 0.0, worldPos.z);
    vNormalView = vec3(0.0, 0.0, 1.0);
    vViewDir = vec3(0.0, 0.0, 1.0);

    vec4 centreView = modelViewMatrix * vec4(position, 1.0);
    // The model matrix carries the tile's quantisation as a uniform scale, so
    // normalising is what turns the rotated offset back into a unit vector.
    // riverDir is already unit length in tile-local axes.
    vec3 offsetView = mat3(modelViewMatrix) * riverDir;
    float offsetLen = length(offsetView);
    offsetView = offsetLen > 1.0e-6 ? offsetView / offsetLen : vec3(1.0, 0.0, 0.0);

    float halfM = riverHalf * 0.1;   // decimetres on the wire
    vec4 centreClip = projectionMatrix * centreView;
    vec4 edgeClip = projectionMatrix * vec4(centreView.xyz + offsetView * halfM, 1.0);

    // How many pixels that offset actually came out as. Behind the eye there
    // is no answer, and no need for one: the vertex is clipped away.
    float stretch = 1.0;
    if (centreClip.w > 1.0e-4 && edgeClip.w > 1.0e-4) {
      vec2 centrePx = centreClip.xy / centreClip.w * vec2(halfWidth, halfHeight);
      vec2 edgePx = edgeClip.xy / edgeClip.w * vec2(halfWidth, halfHeight);
      float px = length(edgePx - centrePx);
      if (px > 1.0e-4 && px < uMinHalfPixels) {
        stretch = min(uMaxStretch, uMinHalfPixels / px);
      }
    }

    // Widen in view space and project once. Anything that divides by the
    // widened vertex's own w and rebuilds a clip position around a different w
    // breaks the homogeneous coordinate the near-plane clip depends on: a
    // vertex behind the eye then lands somewhere arbitrary on screen instead of
    // being clipped, and the stroke flashes across the whole frame — terrain,
    // sky and all — every time a river passes under the aircraft.
    gl_Position = projectionMatrix
        * vec4(centreView.xyz + offsetView * (halfM * stretch), 1.0);
${LOG_DEPTH_VERTEX}
  }
`;
