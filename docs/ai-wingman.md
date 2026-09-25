# AI Wingman

A second AI-flown aircraft on the player's side: same airframe, same FM2 physics
and FX as the opponents, but `Faction.PLAYER`, and flown in a new
`AiFlightPhase.FORMATION` off the player instead of being sent to `ENGAGE`.

It spawns with the player on every flight (sim id `wing0`) — there is no menu
option or key for it.

## Behaviour

| Situation | What it does |
|-----------|--------------|
| No bandit assigned | Flies the echelon-right wing slot on the player: 70 m aft, 45 m out, 12 m low. |
| Far from the slot | Rejoins — flies *at* the slot with up to 60 m/s of overtake — until within 350 m. |
| A hostile is in the air | Promotes itself to `ENGAGE` and fights it with the AI model selected in **Settings → AI pilot model**, exactly like an opponent. |
| Every hostile destroyed | Drops back to `FORMATION` and rejoins, rather than the lone patrol (`NAVIGATE`) an opponent falls back to. |
| Player parked on a runway or deck | There is no slot to fly on a stationary lead, so it spawns airborne and holds overhead until the player is rolling. |
| Player destroyed | Falls back to `NAVIGATE`. |

Friendly fire needs no special case: the projectile pool already skips
same-faction combatants, so neither aircraft can damage the other.

## Architecture

```
Game.spawnWingman()
   ├── AiAircraftEntity('wing0', Faction.PLAYER)   render proxy + Combatant
   └── CombatSimClient
         ├── setFormationLead('wing0', 'player')      ← new sim message
         ├── setTargetFaction('wing0', Faction.ENEMY) ← new sim message
         └── setPhase('wing0', FORMATION)
                     │
                     ▼  (in the sim worker)
              AiPilot.doFormation()
```

`setFormationLead` is deliberately separate from `setTarget`: a wingman needs to
know *both* the lead (to rejoin) and the bandit (to peel off), so the two cannot
share one slot. It is part of `AiPilotController`, so every AI model supports it
— the Shaw / Aggressive / Ace models delegate all non-`ENGAGE` phases to the
classic pilot, and formation is one of those.

`AiFlightPhase.FORMATION` is appended last in the enum on purpose: the phase
crosses the worker boundary as a raw ordinal (`{ type: 'setPhase'; phase: number }`).

## Control loops

Two steering laws with hysteresis between them (600 m in, 350 m out). Rejoin is
pure pursuit of the slot; station keeping holds the lead's heading and trims out
the residuals — cross-track error into a bounded heading offset, along-track
error into a speed trim. Flying *at* the slot the whole time is not an option:
the bearing to a slot a few metres away swings wildly.

Three things the naive version got wrong, each of which showed up as a specific
failure when flown against real FM2 physics:

- **Speedbrake.** Idle thrust alone does not slow a clean airframe at altitude.
  Without the brake the wingman creeps past the slot, and once it is ahead the
  heading loop cannot recover the along-track error — it ends up circling.
- **Closure damping.** The inner speed loop (throttle integrator + airframe) lags
  the outer position loop badly. Proportional-only along-track control
  limit-cycles with a ~45 s period: overshoot, brake, sink, accelerate, climb,
  repeat. The fix is a derivative term on the closing rate.
- **Altitude integral trim.** The shared altitude hold ends in a
  proportional-only pitch-attitude loop, which droops — a standing climb demand
  settles ~150 m low. Every phase lives with that, but on a wing slot it reads
  as the wingman flying visibly low, so formation integrates the residual away
  (bounded, for anti-windup).

Settled station keeping holds within roughly 100 m of the slot indefinitely, with
lateral offset within a few metres.

## Faction targeting

Neither side is handed one named aircraft to fight. `setTargetFaction(id, faction)`
tells the sim to engage *any* live combatant of that faction and to re-pick the
best one as the fight develops — opponents get `Faction.PLAYER` (so they fight the
player and the wingman), the wingman gets `Faction.ENEMY`.

Selection runs in the worker, which owns the authoritative positions. It scores
each candidate by range, penalised by how far off the nose it is
(`range * (1 + ata/π)`) — picking purely by range would have an aircraft turn its
back on the target it is already tracking for one barely closer behind it. The
incumbent gets a 25% scoring bonus, so a challenger has to be clearly better to
steal the fight and the AI does not swap back and forth between two friendlies at
a similar range.

A full re-scan runs twice a second. A target that *dies* is replaced on the very
next step instead — waiting up to half a second would drop the pilot out of
`ENGAGE`, and a wingman all the way back into formation, for a visible beat.

An explicit `setTarget` cancels faction selection for that aircraft; the two modes
are mutually exclusive.

## Out of scope

- Player commands to the wingman (attack / rejoin / break) — it decides for itself.
- Threat-weighted target priority: selection is geometric, so an aircraft already
  shooting at you is not preferred over one that is not.
- More than one wingman, or a wingman on the ground / in the landing pattern.
