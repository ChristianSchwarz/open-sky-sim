# Aggressive ("Berserker") AI Pilot Model

Third selectable AI air-combat model, alongside the classic BFM `AiPilot` and
the doctrinal `ShawAiPilot`: a maximally aggressive fighter that never
disengages to rebuild energy and never breaks defensively away from a
threat — it always presses the attack.

## Selecting the model

In **Settings → AI pilot model**:

- **Classic BFM** — existing `AiPilot` dogfight modes (`PURSUE`, yo-yos, etc.).
- **Shaw (Fighter Combat)** — Offensive / Neutral / Defensive FSM + Flight Control Computer.
- **Aggressive (Berserker)** — Attack / Merge / Counter FSM + the same Flight Control Computer.
- **Ace (vertical fight + post-stall)** — Control / Merge / Evade / Reset FSM + the same
  Flight Control Computer, plus post-stall maneuvers (see `ai-ace-pilot-model.md`).

The choice is applied on the **next merge / opponent spawn**, not mid-dogfight.

## Architecture

```
ConfigService.aiPilotModels
        │
        ▼
createAiPilot(aircraft, world, options)
   ├── CLASSIC    → AiPilot
   ├── SHAW       → ShawAiPilot
   │                   ├── FighterTacticalFSM     → FlightCommand
   │                   └── FlightControlComputer  → stick / throttle
   └── AGGRESSIVE → AggressiveAiPilot
                       ├── AggressiveTacticalFSM  → AggressiveFlightCommand
                       └── FlightControlComputer  → stick / throttle (reused from Shaw)
```

All three models implement `AiPilotController` and fly through
`PilotableAircraft`. `AggressiveAiPilot` reuses Shaw's `FlightControlComputer`
directly (see `src/script/ai/shaw/flightControlComputer.ts`) — its
`applyCommand()` only depends on a minimal `FlightSetpoint` shape
(`targetDirection`, `targetSpeed`, `useAirbrakes`, `allowHardTurn`), so a new
tactical FSM can plug into the same low-level stick/throttle control without
duplicating it. It also reuses `computeTacticalGeometry` (and, transitively,
the shared pure geometry helpers in `dogfightGeometry.ts`) from
`src/script/ai/shaw/shawGeometry.ts`.

Non-`ENGAGE` phases (takeoff, RTB, landing) still use the classic pilot so
mission logic stays shared across all three models.

## Aggressive states

| State | Trigger (approx.) | Maneuvers | Notes |
|-------|-------------------|-----------|-------|
| ATTACK | AOT &lt; 75°, range &lt; 5 km | Lead Pursuit, High Yo-Yo | No lag-pursuit/low-yo-yo caution — always drives the lead-pursuit turn at max-G; high yo-yo only fires when an overshoot is truly imminent at knife-fight range. |
| MERGE | Head-on / high offset | Head-On Press, Post-Merge Reversal | Commits to a nose-to-nose gunfight instead of a cautious lead turn or energy climb; reverses hard right after the pass to regain an offensive angle. |
| COUNTER | Bandit ATA &lt; 60°, range &lt; 2.5 km | Scissors Counter | **Never breaks away or extends.** Always rolls/pulls straight at the bandit's current bearing — never off to a side or away — forcing an overshoot instead of escaping; this is the model's defining "never flees" trait. |

Compared to Shaw/Classic, firing is also more permissive: a wider
tracking-angle cone (~14° vs. Shaw's 8°/5°) and snap-shooting out to ~1.2x the
"clean" gun range, trading accuracy for constant pressure.

## Out of scope

- Missiles / BVR weapons (guns only)
- Multi-bandit / wingman tactics
- Replacing or retuning the Classic, Shaw or Ace pilot behaviour
