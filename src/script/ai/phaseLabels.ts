/**
 * HUD-sized names for what an in-worker pilot is doing, from its maneuver
 * label ({@link import('./aiPilotController').AiPilotController.getManeuverLabel}):
 * the airfield phases by their usual abbreviations, anything else (a dogfight
 * maneuver) passed through.
 */
const SHORT: Record<string, string> = {
    GROUND_IDLE: 'PARK',
    TAKEOFF_ROLL: 'T/O',
    CLIMB_OUT: 'CLB',
    NAVIGATE: 'NAV',
    STRAIGHT: 'HDG',
    RTB: 'RTB',
    APPROACH: 'APP',
    FLARE: 'FLR',
    ROLLOUT: 'ROLL',
    FORMATION: 'FORM',
    WAYPOINT: 'WPT',
};

export function shortPhaseLabel(label: string | undefined): string | undefined {
    if (label === undefined) {
        return undefined;
    }
    if (label.startsWith('GO_AROUND')) {
        return 'G/A';
    }
    if (label.startsWith('RTB')) {
        return 'RTB';
    }
    return SHORT[label] ?? label;
}
