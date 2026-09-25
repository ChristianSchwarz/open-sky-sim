/**
 * 4×4 ordered (Bayer) dither threshold without dynamic matrix indexing.
 * `mat[x][y]` selected by loop indices makes ANGLE emit dyn-index helper
 * functions that the HLSL compiler flags as potentially uninitialized
 * (warning X4000). Conditional selects from constants compile clean and
 * skip the old 16-iteration lookup loop.
 * Returns the classic index matrix value / 16 − 0.5 (range −0.5 … +0.4375).
 */
export const DITHER_PARS_FRAGMENT: string = `
float bayerThreshold(vec2 screen) {
  vec2 m = floor(mod(screen, 4.0));
  vec4 row = vec4( 0.0,  8.0,  2.0, 10.0);
  if (m.y > 0.5) row = vec4(12.0,  4.0, 14.0,  6.0);
  if (m.y > 1.5) row = vec4( 3.0, 11.0,  1.0,  9.0);
  if (m.y > 2.5) row = vec4(15.0,  7.0, 13.0,  5.0);
  float v = row.x;
  if (m.x > 0.5) v = row.y;
  if (m.x > 1.5) v = row.z;
  if (m.x > 2.5) v = row.w;
  return v / 16.0 - 0.5;
}
`;
