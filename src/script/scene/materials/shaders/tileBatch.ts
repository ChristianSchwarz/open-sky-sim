/**
 * The vertex-program side of TileBatch (src/script/terrain/tileBatch.ts):
 * under USE_BATCHING, which three defines for a batched object's program,
 * the model matrix is the draw's own, fetched from uDrawMatrices by
 * gl_DrawID, and modelMatrix / modelViewMatrix / normalMatrix stand for it
 * from the top of main on. Without USE_BATCHING both chunks are empty, so a
 * program that includes them compiles exactly as before for every other
 * object drawn with it.
 *
 * Without WEBGL_multi_draw three draws the batch one range at a time and
 * sets _gl_DrawID itself; the same fallback its own batching chunk has.
 */
export const TILE_BATCH_PARS_VERTEX = `
#ifdef USE_BATCHING
  #if ! defined( GL_ANGLE_multi_draw )
  #define gl_DrawID _gl_DrawID
  uniform int _gl_DrawID;
  #endif
  uniform highp sampler2D uDrawMatrices;
  mat4 tileBatchMatrix() {
    int j = gl_DrawID * 4;
    int width = textureSize(uDrawMatrices, 0).x;
    ivec2 at = ivec2(j % width, j / width);
    return mat4(
      texelFetch(uDrawMatrices, at, 0),
      texelFetch(uDrawMatrices, at + ivec2(1, 0), 0),
      texelFetch(uDrawMatrices, at + ivec2(2, 0), 0),
      texelFetch(uDrawMatrices, at + ivec2(3, 0), 0));
  }
#endif
`;

/** First thing in main: what the rest of the program reads as its matrices. */
export const TILE_BATCH_VERTEX = `
#ifdef USE_BATCHING
    mat4 tileBatchModel = tileBatchMatrix();
    mat4 tileBatchModelView = viewMatrix * tileBatchModel;
    #define modelMatrix tileBatchModel
    #define modelViewMatrix tileBatchModelView
    #define normalMatrix mat3(tileBatchModelView)
#endif
`;
