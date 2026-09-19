/**
 * Two-dimensional section aerodynamics for FM3's strips, over the whole ±180°.
 *
 * The section is described by the forces normal to its chord and along it,
 * the way Kirchhoff's trailing-edge-separation model (as used by Leishman and
 * Beddoes) writes them:
 *
 *     C_N = C_Nα · sin(α − α₀) · ((1 + √f) / 2)²
 *     C_C = η · C_Nα · sin(α − α₀) · sin α · √f
 *
 * f ∈ [0, 1] is the trailing-edge separation point (1 = attached). Lift and
 * drag are not coefficients here at all: the strip applies C_N along its
 * normal and C_C along its chord, so the resultant's tilt relative to the
 * local wind — induced drag, the drag rise at stall — comes from the geometry
 * of those two forces rather than from a polar.
 *
 * As f falls to zero the normal force hands over to a flat plate,
 *
 *     C_N,plate = C_D90 · sin α / (0.56 + 0.44 · |sin α|)     (Lindenburg)
 *
 * and the centre of pressure walks from the quarter chord towards mid-chord,
 * so a stall changes the section's pitching moment on its own. Past ±90° the
 * section flies backwards: the sharp trailing edge leads, there is no suction,
 * and camber is ignored.
 *
 * f itself is a state with Goman–Khrabrov dynamics (see {@link separationTarget}):
 * it relaxes towards a static curve evaluated at a lagged angle, with time
 * constants that scale with chord / airspeed.
 */

/** Everything that characterises one family of wing sections. Angles in radians. */
export interface SectionParams {
    /** Normal-force slope at low Mach (per radian). A thin section is ~2π. */
    cnAlpha: number;
    /** Zero-lift angle; negative for positive camber. */
    alpha0: number;
    /** Angle past zero-lift at which the static separation point reaches 0.5. */
    alphaSep: number;
    /** Width of the static separation curve around `alphaSep`. */
    sepWidth: number;
    /** Profile (skin-friction) drag coefficient. */
    cd0: number;
    /** Fraction of the ideal leading-edge suction recovered in attached flow. */
    suctionEta: number;
    /** Normal-force coefficient of the fully separated section at 90°. */
    cd90: number;
    /** Pitching couple about the quarter chord in attached flow (camber); nose-down negative. */
    cm0: number;
    /** Normal-force slope in reverse flow, as a fraction of `cnAlpha`. */
    reverseSlopeFactor: number;
    /** `alphaSep` for reverse flow, measured from the reversed chord. */
    reverseAlphaSep: number;
    /** Goman–Khrabrov relaxation time constant, in units of chord / airspeed. */
    tau1: number;
    /** Goman–Khrabrov lag of the angle the static curve is read at, in chord / airspeed. */
    tau2: number;
    /** Thickness / chord, for the drag-divergence estimate. */
    thickness: number;
    /**
     * Shape of the separated normal-force curve, C_D90·sin α / (a + (1 − a)·|sin α|).
     * 0.56 (default) is Lindenburg's high-aspect-ratio blade; a low-aspect-ratio
     * planform reaches its plateau at a much lower angle, so takes a smaller a.
     */
    plateShape?: number;
    /**
     * Leading-edge vortex lift, by the Polhamus suction analogy: the leading-edge
     * suction a sharp, swept edge loses as its flow separates reappears as normal
     * force. 0 (default) for a rounded or unswept edge, ~1 for full recovery.
     */
    vortexLift?: number;
    /** Chord station of the vortex lift, fraction from the leading edge (default 0.3). */
    vortexCp?: number;
    /** Regime angles over which the vortex bursts and its lift is lost. */
    vortexBurstStart?: number;
    vortexBurstEnd?: number;
}

/** Control and flow modifiers applied to one section evaluation. */
export interface SectionModifiers {
    /** Zero-lift angle shift from hinged flaps (rad; negative = more lift). */
    dAlpha0: number;
    /** Shift of the separation angle, e.g. from leading-edge flaps or flaps (rad). */
    dAlphaSep: number;
    /** Extra profile drag (deflected flaps, wave drag). */
    dCd0: number;
    /** Share of the section's vortex lift available, e.g. while a feeding vortex is intact (default 1). */
    vortexScale?: number;
}

export interface SectionForces {
    /** Normal-force coefficient, along the section normal. */
    cn: number;
    /** Chordwise force coefficient, positive towards the leading edge. */
    cc: number;
    /** Profile drag coefficient, along the local relative wind. */
    cdProfile: number;
    /** Centre of pressure, fraction of chord from the (geometric) leading edge. */
    xcp: number;
    /** Pitching couple coefficient about the span axis, nose-up positive. */
    cm: number;
}

export const NO_MODIFIERS: Readonly<SectionModifiers> = Object.freeze({ dAlpha0: 0, dAlphaSep: 0, dCd0: 0 });

const HALF_PI = Math.PI / 2;

/**
 * Static separation point for a regime angle `a` ≥ 0 (angle past zero lift in
 * forward flow, angle from the reversed chord in reverse flow). A logistic
 * normalised to exactly 1 at a = 0, 0.5 near `alphaSep`, and ~0 well past it.
 */
export function staticSeparation(a: number, alphaSep: number, width: number): number {
    const w = width > 1e-4 ? width : 1e-4;
    const s = 1 / (1 + Math.exp((a - alphaSep) / w));
    const s0 = 1 / (1 + Math.exp(-alphaSep / w));
    const f = s / s0;
    return f > 1 ? 1 : f;
}

/** True while the section's leading edge leads (|α| ≤ 90°). */
export function isForwardFlow(alpha: number): boolean {
    return alpha <= HALF_PI && alpha >= -HALF_PI;
}

/**
 * The angle the separation state is keyed on and its sign convention: in
 * forward flow |α − α₀ − Δα₀|, in reverse flow π − |α|.
 */
export function regimeAngle(alpha: number, alpha0: number): number {
    if (isForwardFlow(alpha)) {
        return Math.abs(alpha - alpha0);
    }
    return Math.PI - Math.abs(alpha);
}

/**
 * Goman–Khrabrov target for the separation state: the static curve read at
 * the regime angle lagged by τ₂·ȧ. Positive ȧ (angle growing) reads the curve
 * at a smaller angle, delaying separation; negative ȧ delays reattachment.
 */
export function separationTarget(
    alpha: number, regimeRate: number, speed: number, chord: number,
    p: SectionParams, mod: Readonly<SectionModifiers>, mach: number,
): number {
    const forward = isForwardFlow(alpha);
    const a = forward ? Math.abs(alpha - (p.alpha0 + mod.dAlpha0)) : Math.PI - Math.abs(alpha);
    const v = speed > 1 ? speed : 1;
    const lagged = a - p.tau2 * (chord / v) * regimeRate;
    const sep = forward ? (p.alphaSep + mod.dAlphaSep) * stallMachFactor(mach) : p.reverseAlphaSep;
    return staticSeparation(lagged > 0 ? lagged : 0, sep, p.sepWidth);
}

/** First-order relaxation of the separation state towards its target. */
export function advanceSeparation(f: number, target: number, dt: number, speed: number, chord: number, tau1: number): number {
    if (tau1 <= 0 || dt <= 0) return target;
    const v = speed > 1 ? speed : 1;
    const tau = tau1 * chord / v;
    return f + (target - f) * (1 - Math.exp(-dt / tau));
}

/**
 * Compressibility factor on the normal-force slope: Prandtl–Glauert to Mach
 * 0.8, a linear bridge through the transonic band, and Ackeret's 4/√(M²−1)
 * (relative to the section's own low-speed slope) above Mach 1.2.
 */
export function slopeMachFactor(mach: number, cnAlpha: number): number {
    const m = mach > 0 ? mach : 0;
    if (m <= 0.8) {
        return 1 / Math.sqrt(1 - m * m);
    }
    const pgAt08 = 1 / Math.sqrt(1 - 0.64);
    const supAt12 = 4 / Math.sqrt(1.44 - 1) / cnAlpha;
    if (m < 1.2) {
        const t = (m - 0.8) / 0.4;
        return pgAt08 + (supAt12 - pgAt08) * t;
    }
    return 4 / Math.sqrt(m * m - 1) / cnAlpha;
}

/** Shock-induced separation arrives earlier with Mach: the break angle shrinks by up to 40%. */
function stallMachFactor(mach: number): number {
    if (mach <= 0.3) return 1;
    const t = mach >= 0.9 ? 1 : (mach - 0.3) / 0.6;
    const s = t * t * (3 - 2 * t);
    return 1 - 0.4 * s;
}

/**
 * Section force coefficients at geometric angle `alpha` (−π, π] with
 * separation state `f`. `mach` is the Mach number of the flow normal to the
 * sweep line. Writes into `out`.
 */
export function sectionForces(
    alpha: number, f: number, p: SectionParams, mod: Readonly<SectionModifiers>, mach: number,
    out: SectionForces,
): SectionForces {
    const ff = f < 0 ? 0 : f > 1 ? 1 : f;
    const sq = Math.sqrt(ff);
    const sinA = Math.sin(alpha);
    const absSinA = sinA < 0 ? -sinA : sinA;
    const shape = p.plateShape ?? 0.56;
    const plate = p.cd90 * sinA / (shape + (1 - shape) * absSinA);
    const w = (1 - ff) * (1 - ff);
    const kirchhoffFactor = 0.25 * (1 + sq) * (1 + sq);

    if (isForwardFlow(alpha)) {
        const cnA = p.cnAlpha * slopeMachFactor(mach, p.cnAlpha);
        const alphaE = alpha - (p.alpha0 + mod.dAlpha0);
        const sinAe = Math.sin(alphaE);
        const attached = cnA * sinAe;
        let cn = attached * kirchhoffFactor + w * (plate - 0.25 * attached);
        let xcp = 0.25 + 0.25 * (1 - ff) * absSinA;
        const kv = (p.vortexLift ?? 0) * (mod.vortexScale ?? 1);
        if (kv > 0) {
            const burst = 1 - smoothstep(p.vortexBurstStart ?? 0.6, p.vortexBurstEnd ?? 1.0, Math.abs(alphaE));
            if (burst > 0) {
                // The suction lost to separation, (1 − √f) of the potential C_Nα·sin αe·sin α,
                // turned normal to the section.
                const vortex = kv * attached * absSinA * (1 - sq) * burst;
                const total = cn + vortex;
                if (Math.abs(total) > 1e-9 && cn * vortex >= 0) {
                    xcp = (cn * xcp + vortex * (p.vortexCp ?? 0.3)) / total;
                }
                cn = total;
            }
        }
        out.cn = cn;
        out.cc = p.suctionEta * attached * sinA * sq;
        out.xcp = xcp;
        out.cm = p.cm0 * ff;
    } else {
        const attached = p.cnAlpha * p.reverseSlopeFactor * sinA;
        out.cn = attached * kirchhoffFactor + w * (plate - 0.25 * attached);
        out.cc = 0;
        out.xcp = 0.75 - 0.25 * (1 - ff) * absSinA;
        out.cm = 0;
    }
    out.cdProfile = p.cd0 + mod.dCd0;
    return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    if (edge1 <= edge0) return x < edge0 ? 0 : 1;
    const t = x <= edge0 ? 0 : x >= edge1 ? 1 : (x - edge0) / (edge1 - edge0);
    return t * t * (3 - 2 * t);
}

/**
 * Glauert's thin-airfoil flap effectiveness: the zero-lift angle shift per
 * radian of deflection for a plain flap of chord fraction `cf`.
 */
export function flapEffectiveness(cf: number): number {
    const c = cf < 0 ? 0 : cf > 1 ? 1 : cf;
    const theta = Math.acos(2 * c - 1);
    return 1 - (theta - Math.sin(theta)) / Math.PI;
}

/**
 * Real plain flaps lose effectiveness at large deflections as the flow over
 * them separates: full effect to 12°, falling to 60% by 30° (DATCOM-style).
 */
export function flapDeflectionEfficiency(deltaRad: number): number {
    const d = Math.abs(deltaRad) * 180 / Math.PI;
    if (d <= 12) return 1;
    if (d >= 30) return 0.6;
    return 1 - 0.4 * (d - 12) / 18;
}
