import { HAZE_UNIFORMS } from './haze';

/**
 * How much of the ground-level haze survives, 1 down to 0.
 *
 * The haze is integrated along each ray from the camera, which is right for
 * a horizon a few hundred km away and wrong for a planet: from 400 km every
 * ray to the ground is long enough to be fully hazed, and the globe comes out
 * as a flat wash of sky colour. Above the air the atmosphere shell supplies
 * the aerial perspective per pixel instead, so the game turns the haze down
 * as the shell turns up. Writes straight through to the haze's optical depth
 * scale, so no material has to know about it.
 */
export const SPACE_FOG = {
    get scale(): number {
        return HAZE_UNIFORMS.uHazeStrength.value;
    },
    set scale(value: number) {
        HAZE_UNIFORMS.uHazeStrength.value = value;
    },
};
