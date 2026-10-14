/**
 * GLSL snippets for the depth the custom ShaderMaterials write: Three's
 * logarithmic depth (USE_LOGARITHMIC_DEPTH_BUFFER), or under a reversed float
 * depth buffer (USE_REVERSED_DEPTH_BUFFER, see Renderer useReversedDepth)
 * nothing but the depth push - the rasteriser's own depth is the depth, and
 * leaving gl_FragDepth alone is what keeps the early depth test on.
 */

export const LOG_DEPTH_PARS_VERTEX = `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  varying float vFragDepth;
  varying float vIsPerspective;
#endif
#if defined(USE_LOGARITHMIC_DEPTH_BUFFER) || defined(USE_REVERSED_DEPTH_BUFFER)
  /**
   * Metres added to the view depth before it is written, so a surface can be
   * made to lose the depth test to anything drawn within that of it. A
   * material that never sets it leaves it at GLSL's zero; only the terrain
   * land material does, for a parent tile drawn under its dissolving children
   * (see LOD_DEPTH_PUSH_SCALE).
   */
  uniform float uDepthPush;
#endif
`;

export const LOG_DEPTH_VERTEX = `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth = 1.0 + gl_Position.w + uDepthPush;
  // Orthographic projections leave w at 1, so the log curve would hand every
  // fragment the same depth and the pass would z-fight itself. Same test
  // Three's own chunk makes; the ortho branch falls back to gl_FragCoord.z.
  vIsPerspective = projectionMatrix[2][3] == -1.0 ? 1.0 : 0.0;
#elif defined(USE_REVERSED_DEPTH_BUFFER)
  // Three's reversed projection writes depth = d / w - c, with c and d its
  // [2][2] and [3][2] entries; a push takes the depth of w + uDepthPush.
  // Per vertex rather than per fragment, so only exact at the vertices: the
  // pushes are a tile's geometric error and more, far past that error.
  if (uDepthPush != 0.0 && projectionMatrix[2][3] == -1.0) {
    gl_Position.z = gl_Position.w * (projectionMatrix[3][2] / (gl_Position.w + uDepthPush) - projectionMatrix[2][2]);
  }
#endif
`;

export const LOG_DEPTH_PARS_FRAGMENT = `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  uniform float logDepthBufFC;
  varying float vFragDepth;
  varying float vIsPerspective;
#endif
`;

export const LOG_DEPTH_FRAGMENT = `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(vFragDepth) * logDepthBufFC * 0.5;
#endif
`;
