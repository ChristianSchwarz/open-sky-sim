/**
 * How much of the ground-level distance fog survives, 1 down to 0.
 *
 * The fog is one uniform colour blended in by distance, which is right for a
 * horizon a few hundred km away and wrong for a planet: from 400 km every
 * fragment is far enough to be fully fogged, and the globe comes out as a
 * flat wash of sky colour. Above the air the atmosphere shell supplies the
 * aerial perspective per pixel instead, so the game turns the fog down as the
 * shell turns up. Read when a shaded draw's distance uniform is set, so it
 * scales the fog without any material having to know about it.
 */
export const SPACE_FOG = { scale: 1 };
