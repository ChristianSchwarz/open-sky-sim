import { Particle, ParticleForce } from '../particleSystem';

/**
 * Linear air drag: damps velocity toward zero. Combined with gravity
 * ({@link ConstantForce}), horizontal speed dies off and vertical speed
 * approaches terminal freefall `g / drag` (m/s downward).
 */
export class LinearDragForce implements ParticleForce {

    constructor(
        /** Drag coefficient (1/s). Higher = quicker deceleration / lower terminal speed. */
        private readonly drag: number,
    ) { }

    apply(delta: number, particle: Particle): Particle {
        // Exact integration of dv/dt = -drag * v over the step.
        const factor = Math.exp(-this.drag * delta);
        particle.velocity.multiplyScalar(factor);
        return particle;
    }
}
