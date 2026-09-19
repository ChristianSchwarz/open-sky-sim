/**
 * FM3 axis conventions.
 *
 * FM3 integrates in the sim body frame it shares with FM2 and the renderer:
 * +Y up, +Z forward, and +X completing a right-handed set (X × Y = Z). The sim
 * names +X "RIGHT", but for an aircraft facing +Z with +Y up, a right-handed
 * frame puts the starboard wing on −X — and FM2's controls agree: right roll
 * stick raises the +X wing (frames.test.ts pins this against FM2).
 *
 * Everything FM3 is built from and checked against — NASA TP-1538, Stevens &
 * Lewis — uses NASA body axes instead: x forward, y out the starboard wing,
 * z down. The two are related by a proper rotation:
 *
 *     x_N = +Z_sim     y_N = −X_sim     z_N = −Y_sim
 *
 * so NASA roll rate p = ωz, pitch rate q = −ωx and yaw rate r = −ωy, and
 * moments map the same way. This file is the only place the mapping is
 * written down.
 */

export type Vec3 = [number, number, number];

/** NASA body-axis vector → sim body-axis vector. */
export function nasaToSim(v: Readonly<Vec3>): Vec3 {
    return [-v[1], -v[2], v[0]];
}

/** Sim body-axis vector → NASA body-axis vector. */
export function simToNasa(v: Readonly<Vec3>): Vec3 {
    return [v[2], -v[0], -v[1]];
}

/**
 * Moments of inertia in NASA body axes (kg·m²). Products of inertia follow
 * the ∫xz dm convention used by TP-1538 and Stevens & Lewis, so the tensor's
 * off-diagonal terms are their negatives.
 */
export interface InertiaNasa {
    ixx: number;
    iyy: number;
    izz: number;
    ixz: number;
    ixy?: number;
    iyz?: number;
}

/**
 * The inertia tensor in sim body axes, row-major 3×3.
 *
 * I_sim = C · I_N · Cᵀ with C the NASA→sim rotation above. Worked through,
 * the diagonal permutes (Iyy, Izz, Ixx) and the one product an aircraft
 * usually has, Ixz, lands on the (Y, Z) entries with its sign flipped back to
 * positive, because both y_N and z_N change sign on the way over.
 */
export function inertiaNasaToSim(i: InertiaNasa): Float64Array {
    const ixy = i.ixy ?? 0;
    const iyz = i.iyz ?? 0;
    const out = new Float64Array(9);
    out[0] = i.iyy; out[1] = -iyz; out[2] = ixy;
    out[3] = -iyz; out[4] = i.izz; out[5] = i.ixz;
    out[6] = ixy; out[7] = i.ixz; out[8] = i.ixx;
    return out;
}

/** Body rates in NASA axes (p roll, q pitch, r yaw; rad/s) from sim body ω. */
export function nasaRatesFromSimOmega(wx: number, wy: number, wz: number, out: Float64Array): Float64Array {
    out[0] = wz;
    out[1] = -wx;
    out[2] = -wy;
    return out;
}

/** Sim body ω from NASA body rates. */
export function simOmegaFromNasaRates(p: number, q: number, r: number, out: Float64Array): Float64Array {
    out[0] = -q;
    out[1] = -r;
    out[2] = p;
    return out;
}

const SLUG_FT2_TO_KG_M2 = 1.3558179483;
export const FT_TO_M = 0.3048;
const LBF_TO_N = 4.4482216153;
export const DEG = Math.PI / 180;
