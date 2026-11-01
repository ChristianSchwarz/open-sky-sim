/**
 * The knobs of the TUNABLE pilot model (see TunableAiPilot). Each is 0..1
 * except {@link AiPersonality.gLimit}; {@link personalityTuning} turns them
 * into the numbers the tactics and the trigger actually read.
 */
export interface AiPersonality {
    /**
     * 0 cautious .. 1 relentless. How far it lets its energy run down before
     * it disengages to rebuild it (never, at 1), how much closure it accepts
     * before easing off with a yo-yo, and whether it takes head-on gun passes
     * (from 0.35) or turns aside at the merge and dodges the other's shot.
     */
    aggression: number;
    /**
     * 0 ignores a bandit until it is close on its tail .. 1 reacts to
     * anything pointing at it from the beam back. Also how long it keeps
     * defending once it starts, how hard it breaks, whether it jinks out of
     * a gun solution (from 0.4).
     */
    defensiveness: number;
    /**
     * 0 rookie .. 1 ace. Reaction time (1.5 s to 0.15 s), aim wander (4 deg
     * to none), how much of its g limit it dares to pull (65 % to all of it),
     * the fight speed it holds (slower is a worse turn on this airframe),
     * how quickly its guns-defence jinks come, and how far out it opens fire
     * on a head-on (1.5 to 2.4 km). From 0.4 it reverses level after a pass
     * and dives for speed before a break; from 0.5 it brakes in a fast pass
     * and knows a nose race it has lost.
     */
    skill: number;
    /**
     * 0 turn-and-burn .. 1 boom-and-zoom. A turn fighter stays level and
     * cuts inside with low yo-yos; an energy fighter climbs for an altitude
     * advantage (up to 1200 m of energy height) before it attacks, slashes
     * from above and fights at full speed.
     */
    energyFighting: number;
    /**
     * 0 sprays at anything near the nose .. 1 fires only when the round is
     * predicted to hit, and only inside gun range.
     */
    gunDiscipline: number;
    /** Highest load factor (g) it will pull, 3..9. */
    gLimit: number;
}

export const AI_PERSONALITY_KEYS = [
    'aggression', 'defensiveness', 'skill', 'energyFighting', 'gunDiscipline', 'gLimit',
] as const satisfies readonly (keyof AiPersonality)[];

export const AI_G_LIMIT_MIN = 3;
export const AI_G_LIMIT_MAX = 9;

export function defaultAiPersonality(): AiPersonality {
    return { aggression: 0.6, defensiveness: 0.5, skill: 0.7, energyFighting: 0.3, gunDiscipline: 0.7, gLimit: 9 };
}

/** Starting points for the sliders, each a recognisable kind of opponent. */
/**
 * Starting points for the sliders, each a recognisable kind of opponent.
 * `description` is the settings tooltip; its results are from the merge
 * bench (docs/ai-dogfight-strategy.md, "Tunable opponent").
 */
export const AI_PERSONALITY_PRESETS: { id: string; label: string; description: string; personality: AiPersonality }[] = [
    {
        id: 'rookie', label: 'Rookie',
        description: 'Slow to react, aim wanders, sprays rounds from far out and pulls only about 4 g. '
            + 'The easiest opponent: it loses almost every fight against the built-in pilots.',
        personality: { aggression: 0.5, defensiveness: 0.3, skill: 0.1, energyFighting: 0.2, gunDiscipline: 0.2, gLimit: 6 },
    },
    {
        id: 'veteran', label: 'Veteran',
        description: 'The default. Competent all round: decent reactions and aim, takes head-on shots, '
            + 'and breaks off to rebuild speed and height when it falls behind. Wins about a third of its '
            + 'fights against the built-in pilots.',
        personality: defaultAiPersonality(),
    },
    {
        id: 'ace', label: 'Ace',
        description: 'Full skill: instant reactions, exact aim, opens fire on head-on passes from 2.4 km, '
            + 'turns back level after every pass and dives for speed before it breaks. The hardest '
            + 'opponent: it beats every built-in pilot model.',
        personality: { aggression: 0.7, defensiveness: 0.6, skill: 1, energyFighting: 0.3, gunDiscipline: 0.9, gLimit: 9 },
    },
    {
        id: 'berserker', label: 'Berserker',
        description: 'All attack, almost no defence: always takes the head-on shot, never breaks off, '
            + 'fires freely and turns with you. Dangerous nose to nose, vulnerable once you are behind it.',
        personality: { aggression: 1, defensiveness: 0.1, skill: 0.7, energyFighting: 0, gunDiscipline: 0.4, gLimit: 9 },
    },
    {
        id: 'cautious', label: 'Cautious',
        description: 'Will not trade shots: turns aside at head-on merges, dodges your shot and breaks at '
            + 'any threat. Hard to pin down for a quick kill, but it rarely shoots back, so it is easy to beat.',
        personality: { aggression: 0.1, defensiveness: 1, skill: 0.7, energyFighting: 0.3, gunDiscipline: 0.8, gLimit: 9 },
    },
    {
        id: 'boomzoom', label: 'Boom & zoom',
        description: 'Energy fighter: climbs for a height advantage before it attacks, dives on you at full '
            + 'speed and zooms back up rather than turning with you. Long, drawn-out fights.',
        personality: { aggression: 0.4, defensiveness: 0.6, skill: 0.8, energyFighting: 1, gunDiscipline: 0.8, gLimit: 9 },
    },
];

export function aiPersonalityPreset(id: string): AiPersonality | undefined {
    const preset = AI_PERSONALITY_PRESETS.find(p => p.id === id);
    return preset ? { ...preset.personality } : undefined;
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** A valid personality from anything (stored settings, a partial override): missing or bad fields take the default. */
export function clampAiPersonality(value: unknown): AiPersonality {
    const d = defaultAiPersonality();
    const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof AiPersonality, unknown>>;
    return {
        aggression: clampNum(v.aggression, 0, 1, d.aggression),
        defensiveness: clampNum(v.defensiveness, 0, 1, d.defensiveness),
        skill: clampNum(v.skill, 0, 1, d.skill),
        energyFighting: clampNum(v.energyFighting, 0, 1, d.energyFighting),
        gunDiscipline: clampNum(v.gunDiscipline, 0, 1, d.gunDiscipline),
        gLimit: clampNum(v.gLimit, AI_G_LIMIT_MIN, AI_G_LIMIT_MAX, d.gLimit),
    };
}

const DEG = Math.PI / 180;
const mix = (t: number, a: number, b: number) => a + (b - a) * t;

/** What a personality means in numbers. */
export interface PersonalityTuning {
    /** Seconds a new tactical situation must last before the pilot acts on it. */
    reactTime: number;
    /** RMS aim wander (rad) on every shot. */
    aimNoise: number;
    /** Seconds the aim wander takes to change. */
    aimNoiseTau: number;
    /** Highest g it pulls. */
    gCap: number;
    /** Airspeed (m/s) it fights at. */
    combatSpeed: number;
    /** A bandit pointing within this angle (rad) of us ... */
    threatCone: number;
    /** ... at least this far (rad) off our nose ... */
    threatAta: number;
    /** ... and this range (m) is a threat. */
    threatRange: number;
    /** Least seconds in DEFEND once in it. */
    defendHold: number;
    /** g share of {@link gCap} used in a break. */
    breakG: number;
    /** Jink out of a gun solution every this many seconds; Infinity = never. */
    jinkPeriod: number;
    /** Energy-height deficit (m) that sends it away to rebuild; Infinity = never. */
    extendDeficit: number;
    /** Closure (m/s) inside 1200 m that it eases off with a high yo-yo. */
    overshootVc: number;
    /** Nose-to-target angle (rad) past which it flies lag pursuit. */
    lagAngle: number;
    /** Takes the head-on gun pass rather than turning aside. */
    headOnPass: boolean;
    /** Energy height (m) it wants over the bandit before attacking. */
    altitudeAdvantage: number;
    /** Gun range multiplier. */
    gunRangeMult: number;
    /** Range (m) it opens fire from on a head-on gun pass ... */
    headOnFireRange: number;
    /** ... and from which it points for that pass. */
    headOnSetupRange: number;
    /** Brakes, rather than pulling off the aim, when over the speed cap in that pass. */
    gunPassBrakes: boolean;
    /**
     * A bandit with its nose on us while ours is this much further (rad) off
     * it has won the nose race: defend instead of taking the pass. Infinity =
     * never sees it.
     */
    noseRaceMargin: number;
    /**
     * Reverses level after a pass (see TunableTacticalFSM.reversal) rather
     * than pulling whichever way, and dives for speed before a break.
     */
    reversal: boolean;
    /** Predicted miss allowed, as a multiple of the target's hit radius ... */
    missMult: number;
    /** ... plus this (m). */
    missSlack: number;
}

export function personalityTuning(p: AiPersonality): PersonalityTuning {
    return {
        reactTime: mix(p.skill, 1.5, 0.15),
        aimNoise: mix(p.skill, 4, 0) * DEG,
        aimNoiseTau: 1.2,
        gCap: p.gLimit * mix(p.skill, 0.65, 1),
        combatSpeed: mix(p.energyFighting, mix(p.skill, 195, 238), 240),
        threatCone: mix(p.defensiveness, 20, 70) * DEG,
        threatAta: mix(p.defensiveness, 160, 60) * DEG,
        threatRange: mix(p.defensiveness, 1000, 3500),
        defendHold: mix(p.defensiveness, 0.5, 4),
        breakG: mix(p.defensiveness, 0.6, 1),
        jinkPeriod: p.defensiveness >= 0.4 ? mix(p.skill, 2.5, 1.0) : Infinity,
        extendDeficit: p.aggression >= 0.95 ? Infinity : mix(p.aggression, 150, 2000),
        overshootVc: mix(p.aggression, 40, 150),
        lagAngle: mix(p.aggression, 20, 50) * DEG,
        headOnPass: p.aggression >= 0.35,
        altitudeAdvantage: p.energyFighting * 1200,
        gunRangeMult: mix(p.gunDiscipline, 1.3, 0.85),
        headOnFireRange: mix(p.skill, 1500, 2400),
        headOnSetupRange: mix(p.skill, 3000, 4000),
        gunPassBrakes: p.skill >= 0.5,
        noseRaceMargin: p.skill >= 0.5 ? 30 * DEG : Infinity,
        reversal: p.skill >= 0.4,
        missMult: mix(p.gunDiscipline, 3, 0.85),
        missSlack: mix(p.gunDiscipline, 8, 2),
    };
}
