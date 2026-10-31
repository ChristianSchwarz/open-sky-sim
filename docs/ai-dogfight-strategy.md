# AI Dogfight Strategy Overhaul

> **Status: implemented.** This document is the design plan for the ENGAGE-phase
> dogfight sub-state-machine added to `AiPilot`. All to-dos below were completed;
> the code lives in [src/script/ai/aiPilot.ts](../src/script/ai/aiPilot.ts) and
> [src/script/ai/dogfightGeometry.ts](../src/script/ai/dogfightGeometry.ts), with
> tests in `src/script/ai/dogfightGeometry.test.ts` and
> `src/script/ai/aiPilot.dogfight.test.ts`. Kept here as the rationale/reference
> for the design.

Give the AI opponent real basic-fighter-maneuver (BFM) decision-making — energy
management, defensive break turns, yo-yos, and disengage-to-extend — instead of
always flying straight lead-pursuit, by adding a maneuver sub-state-machine
inside the existing `ENGAGE` phase of `AiPilot`.

## Assumption (no answer given to clarifying questions)

Since the scope-narrowing questions were skipped, this plan targets a
**genuinely skilled, fair dogfighter** — it adds real tactics (energy
management, defensive maneuvers, yo-yos) tuned aggressively enough to win most
fights, while leaving a `skill` knob so it can be dialed down/up later without
another redesign. If a different intent was meant (e.g. a scripted "unbeatable
boss"), the design can be adjusted before further tuning.

## Current behavior (why the AI lost before this change)

All combat logic used to live in one method, `doEngage()`:

```ts
private doEngage(delta: number): void {
    ...
    // Gun lead solution: where the target will be when a bullet arrives.
    const tof = range / this.bulletSpeed;
    this.aim.copy(this.tvel).multiplyScalar(tof).add(this.tpos);
    ...
    this.commandHeading(desiredHeading, MAX_BANK_COMBAT);
    this.commandElevation(desiredElev);

    // Energy management: ease off when very close to avoid overshoot.
    const desiredSpeed = range < 250 ? this.combatSpeed * 0.7 : this.combatSpeed;
    this.commandSpeed(desiredSpeed, delta);

    this.firing = range <= this.gunRange && aimAngle <= GUN_CONE_RAD;
}
```

It always pointed the nose straight at the lead-pursuit aimpoint, regardless of
turn geometry, closure rate, or energy state, and it **never checked whether it
was itself being tracked/shot at** — so it never broke, never extended to
rebuild energy, and never used vertical maneuvers. This was the single method
replaced.

## New design: a maneuver sub-state-machine inside ENGAGE

```mermaid
stateDiagram-v2
    [*] --> Pursue
    Pursue --> DefensiveBreak: threat detected (enemy AOT small and in range)
    LagPursue --> DefensiveBreak: threat detected
    HighYoYo --> DefensiveBreak: threat detected
    LowYoYo --> DefensiveBreak: threat detected
    Pursue --> LagPursue: angle-off too high to lead-pursue
    Pursue --> HighYoYo: closure too fast, overshoot imminent
    LagPursue --> LowYoYo: energy edge and wide angle-off
    Pursue --> Extend: energy deficit vs target
    LagPursue --> Extend: energy deficit vs target
    DefensiveBreak --> Pursue: threat cleared
    HighYoYo --> Pursue: maneuver timer done
    LowYoYo --> Pursue: maneuver timer done
    Extend --> Pursue: energy recovered
```

### 1. Pure, testable geometry helpers — `src/script/ai/dogfightGeometry.ts`

Functions with no engine/state dependency, taking plain `THREE.Vector3`/numbers,
so they can be unit tested directly (previously there were **zero** AI tests):

- `specificEnergyHeight(altitude, speed)` — "energy height" `h + v²/(2g)`, used
  to compare the AI's total energy against the target's.
- `closureRate(myPos, myVel, targetPos, targetVel)` — signed range-rate along
  the line of sight (negative = closing).
- `trackingAngle(shooterPos, shooterForward, targetPos)` — angle between a
  shooter's nose and the line to a point; reused both for the AI's own gun
  solution (already computed inline before this change) and, with the
  **target's velocity as a nose proxy**, for detecting whether the target has a
  gun solution on the AI (its `Combatant` interface exposes only
  position/velocity, so velocity direction is used as the forward proxy —
  consistent with how the existing lead-pursuit math already treats target
  velocity as "the way it's pointed").
- `aspectAngle(observerPos, targetPos, targetVel)` — angle off the target's
  tail, used to classify offense/defense/neutral merges.
- `angleOff(myVel, targetVel)` — angle between the two flight paths, used to
  decide whether a lead-pursuit turn is flyable.

Covered by `src/script/ai/dogfightGeometry.test.ts` against known
hand-computed geometries (dead six, head-on, perpendicular, energy-advantage
cases).

### 2. Maneuver modes and transition logic — `src/script/ai/aiPilot.ts`

A `DogfightMode` enum (`PURSUE`, `LAG_PURSUE`, `HIGH_YOYO`, `LOW_YOYO`,
`DEFENSIVE_BREAK`, `EXTEND`) plus mode-timer/hysteresis state fields, following
the file's existing pattern for the terrain pull-up latch (`pullUpActive`).

`doEngage()` is now a thin dispatcher:

1. Compute shared per-frame geometry once (range, closure, angle-off, target's
   tracking angle on the AI, energy delta) via the geometry helpers.
2. `updateDogfightMode(...)` — the decision layer — evaluates transitions in
   priority order:
   - **Defensive break** (highest priority): target's `trackingAngle` on the
     AI is small AND range is inside a threat radius, sustained past a short
     reaction-delay timer (skill-dependent) → hard break turn toward the
     attacker's bearing at max bank, **does not fire**.
   - **Extend**: AI's energy height is meaningfully below the target's (and
     not already defensive) → heads away from the target, unloads, holds max
     throttle, accepts pointing off the target briefly to rebuild airspeed;
     exits back to `PURSUE` once energy height recovers past a threshold (and
     a minimum duration has elapsed, to avoid flip-flopping).
   - **High yo-yo**: closure rate high relative to range (overshoot imminent)
     → pulls the nose above the flight path briefly to bleed excess closure
     without losing energy, then resumes pursuit.
   - **Low yo-yo**: AI has an energy edge but angle-off is too large to
     out-turn the target directly → trades some altitude for turn
     rate/closure across the circle.
   - **Lag pursuit**: angle-off is too large for a lead-pursuit aimpoint to be
     flyable at the current bank/turn-rate limits → aims at a blended point
     between the target's current position and the lead point (previously the
     code always aimed at the pure lead point even when that required an
     impossible turn, a large source of overshoot/energy loss).
   - **Pursuit** (default/fallback): the original lead-pursuit logic, kept for
     the common, easily-flyable case.
3. Each mode has a small handler (`doPursue`, `doLagPursue`, `doHighYoYo`,
   `doLowYoYo`, `doDefensiveBreak`, `doExtend`) that sets heading/elevation/
   speed setpoints through the **existing** inner controllers
   (`commandHeading`, `commandElevation`, `commandSpeed` — unchanged) so all
   the PIO/overspeed/terrain safety guards already in the file keep applying.
4. The firing gate is suppressed whenever the active mode isn't nose-tracking
   the target (`EXTEND`, `HIGH_YOYO`, `LOW_YOYO`, `DEFENSIVE_BREAK`) even if
   the instantaneous aim angle happens to fall inside the cone.

New tuning constants live near the existing gain block, documented in the same
style, e.g. `DEFENSIVE_AOT_THRESHOLD`, `DEFENSIVE_RANGE_MULT`,
`YOYO_CLOSURE_TRIGGER`, `EXTEND_ENERGY_DEFICIT` (via `SkillTuning`),
`EXTEND_RECOVER_MARGIN`.

### 3. Difficulty/skill knob

`AiPilotOptions.skill?: AiSkillLevel` (`ROOKIE` / `VETERAN` / `ACE`, default
`ACE`), scaling:

- Defensive reaction delay — rookies notice threats slower.
- How readily the AI chooses `EXTEND` vs. staying in a losing turning fight
  (energy-deficit threshold).
- Firing discipline (gun-cone tolerance).

This is the first difficulty concept in the codebase, giving a single place to
tune "how hard is this to beat" later.

### 4. Wiring

`spawnOpponent()`'s call site in
[src/script/state/game.ts](../src/script/state/game.ts) passes
`skill: AiSkillLevel.ACE` in the opponent's `AiPilotOptions` literal; no other
call sites needed to change since `AiPilotOptions` fields stay optional with
backward-compatible defaults.

### 5. Tests

- `src/script/ai/dogfightGeometry.test.ts` — pure function unit tests per
  helper above.
- `src/script/ai/aiPilot.dogfight.test.ts` — scenario tests driving
  `AiPilot.update()` over many frames against lightweight fake
  `PilotableAircraft`/`WorldQuery`/`Combatant` implementations (no rendering or
  physics worker needed, using the existing `PilotableAircraft` boundary):
  - Starting on the target's six at good aspect and range → stays in a
    tracking mode and eventually fires.
  - Target maneuvers onto the AI's six within threat range → AI enters
    `DEFENSIVE_BREAK` within the reaction delay and does not fire while
    defensive.
  - AI energy height well below target's → AI enters `EXTEND` and holds it for
    at least its minimum duration rather than immediately turning back in.
  - A wide-angle-off crossing merge selects `LAG_PURSUE` instead of forcing an
    unflyable lead turn.

## Out of scope for this pass

- Multi-aircraft/wingman coordination (only one AI opponent exists today).
- Missiles (none exist in `src/`; combat is guns-only via
  [src/script/weapons/gun.ts](../src/script/weapons/gun.ts)).
- Changing the `Combatant` interface (no new fields needed; velocity is used
  as the forward-direction proxy for threat detection).

## Merge bench (2026-10-31)

The design above was only ever tested against scripted stand-ins (a kinematic
fake aircraft, a frozen target). Flown on the real flight model it did not
work, so there is now a bench that flies two AI pilots through a merge,
headless, on FM2:

- `src/script/physics/sim/dogfightMerge.ts`: `runMerge(setup, blue, red)` puts
  two `CombatSim` aircraft (default airframe, the game's gun and opponent
  options) on a merge, each targeting the other, and scores the fight: kills,
  crashes, midairs, hits, seconds offensive (in the other's rear 60 deg cone
  inside 2 km) and nose-on, minimum speed and altitude, time per maneuver
  label. `MERGE_SETUPS` holds twelve merges: the game's own (3 km head-on,
  co-altitude, 200 m/s), offset, stacked, mismatched-speed, beam, low, high,
  oblique and tail chase.
- `tools/dogfight_merge.ts` flies every pairing of pilot models through every
  merge from both sides and prints a table. `--blue/--red/--setup/--trace 1`
  fly one fight with a trace. A frozen copy of the classic pilot at
  `src/script/ai/aiPilotBaseline.ts` (untracked; copy `aiPilot.ts` there
  before changing it) joins the matrix as `BASE`, so a change fights what it
  replaces. The sim is deterministic in practice: gun spread is seeded and
  too small to change a hit.
- `src/script/physics/sim/dogfightMerge.test.ts` pins the classic pilot's
  results: no midair at the merge, no stall in a turning fight, kills against
  Shaw and Ace from the game's merge, no losses against the other models.

### What the bench found

Baseline, all four models, 96 fights of 180 s: **no kill at all**. Every
fight was a draw: twelve ended in head-on midairs, the rest with both
aircraft below 90 m/s for 40-120 s. Nobody fired a round outside the first
pass, even after 50-100 s sat behind the other inside 2 km.

Measured on the airframe: lift runs out at 18-20 deg AoA long before the
9.5 g limit, so full stick gives 2.3 g at 120 m/s, 4.1 g at 180 and 6.3 g at
240, and the jet still accelerates in that turn on full power. Turn rate
therefore rises with speed and the radius barely changes; there is no corner
speed below the 240 m/s overspeed cap. In the classic pilot:

1. **Speed.** It fought at a "corner speed" of 180 m/s, slowed to 0.65 x
   combat speed (117 m/s) inside 250 m, and cut to idle at the merge.
2. **The vertical.** The hard turn rolled only toward the aim's compass
   bearing and pulled. Where the aim was in the vertical played no part, so
   chasing a climbing target it pulled the nose up whatever the aim said, and
   both aircraft hung at 10 m/s.
3. **Tracking.** The hard turn switched in at 8 deg off the lead and out at 5,
   over heading/pitch loops tuned for navigation. The nose hunted 3-9 deg off
   the lead (30-90 m predicted miss against a 13 m allowance) and never fired.
4. **The merge.** Two lead-pursuing pilots flew straight down each other's
   noses into a midair.

### What changed (classic pilot only)

- `CORNER_SPEED` 180 -> 230 m/s; tucked in behind and closing it matches the
  target's speed plus 15 m/s, never below 160 (`combatTurnSpeed`).
- Hard turns put the lift vector on the aim, allowing for the 1 g that holds
  the aircraft up, roll before they pull when the lift is more than 90 deg
  off, use full stick, and may pull inverted above 1200 m AGL over the deck.
- Pursuit tracks with one law (`commandTrack`): commanded lift = line-of-sight
  rate x speed + `TRACK_GAIN` (6/s) x speed x aim error + 1 g, stick sized
  from the measured stick-to-g curve, and a small push rather than a roll
  through 180 deg. Gains of 4, 6 and 8 all won the same share; 6 resolved
  more fights.
- Below 170 m/s the steepest climb pursuit will aim at falls to 15 deg nose
  low at 110 m/s (`capAimClimb`).
- If the straight-line paths would pass within 150 m in the next 4 s, the aim
  is pushed aside to pass clear, left to left when dead on (`deconflictAim`).

Result, same matrix plus `BASE`: the classic pilot wins 84 of 96 fights
against Shaw, Aggressive and Ace and 19 of 24 against its old self, loses
none, and never crashes or collides. Against itself 5 of 24 fights end in a
kill. Shaw, Aggressive and Ace still never shoot anything down (and still
collide at the merge): they fly their own tactical layers and controllers
and have none of these fixes.

Open:

- The other three models, which share the four problems above.
- A stalled, tumbling target: the aim point jumps with its acceleration
  estimate and the nose chases it 0-10 deg off. Most remaining draws are
  this.
- Difficulty. This pilot is far more lethal; the human player now faces a
  pilot that tracks to about 1 deg. `AiSkillLevel` only scales reaction time
  and the miss allowance, and the game always uses ACE.
