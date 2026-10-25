/**
 * Seconds of unpaused game time, for effects that age outside an entity's
 * update(delta) (they are posed from render3D, which has no frame time).
 * Game.update advances it only past its pause guard, so a menu or a
 * streaming hold stops these effects ageing along with the world.
 */
let elapsedS = 0;

export function advanceFxClock(deltaS: number): void {
    if (deltaS > 0) {
        elapsedS += deltaS;
    }
}

export function fxClockS(): number {
    return elapsedS;
}
