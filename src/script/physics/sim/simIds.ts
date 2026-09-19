/** Stable combat-sim aircraft ids, shared across the main thread and worker. */

/** The player aircraft (shared by its FM2/DEBUG render proxies). */
export const PLAYER_SIM_ID = 'player';

/** The first (and, for now, only) AI opponent. */
const AI_SIM_ID = 'ai0';

/** Deterministic id for the Nth AI opponent. */
export function aiSimId(index: number): string {
    return `ai${index}`;
}

/** The player's AI wingman (Faction.PLAYER, flies the FORMATION phase). */
export const WINGMAN_SIM_ID = 'wing0';
