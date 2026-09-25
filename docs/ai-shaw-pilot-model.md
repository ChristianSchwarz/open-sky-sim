# Shaw AI Pilot Model

Selectable alternative to the classic BFM `AiPilot`, based on Robert L. Shaw’s
*Fighter Combat: Tactics and Maneuvering*.

## Selecting the model

In **Settings → AI pilot model**:

- **Classic BFM** — existing `AiPilot` dogfight modes (`PURSUE`, yo-yos, etc.).
- **Shaw (Fighter Combat)** — Offensive / Neutral / Defensive FSM + Flight Control Computer.
- **Aggressive (Berserker)** — Attack / Merge / Counter FSM (see `ai-aggressive-pilot-model.md`).
- **Ace (vertical fight + post-stall)** — Control / Merge / Evade / Reset FSM (see `ai-ace-pilot-model.md`).

The choice is applied on the **next merge / opponent spawn**, not mid-dogfight.

## Architecture

```
ConfigService.aiPilotModels
        │
        ▼
createAiPilot(aircraft, world, options)
   ├── CLASSIC → AiPilot
   └── SHAW    → ShawAiPilot
                    ├── FighterTacticalFSM  → FlightCommand
                    └── FlightControlComputer → stick / throttle
```

Both models implement `AiPilotController` and fly through `PilotableAircraft`.

## Shaw states

| State | Trigger (approx.) | Maneuvers |
|-------|-------------------|-----------|
| OFFENSIVE | AOT &lt; 60°, range &lt; 4 km | Lead / Pure / Lag pursuit, High/Low Yo-Yo |
| NEUTRAL | Merge / high offset | Lead Turn, Energy Climb, Head-On |
| DEFENSIVE | Bandit ATA &lt; 60°, range &lt; 2.5 km | Break Turn, Defensive Spiral, Flat Scissors |

Non-`ENGAGE` phases (takeoff, RTB, landing) still use the classic pilot so mission
logic stays shared.

## Out of scope

- Missiles / BVR weapons (guns only)
- Multi-bandit / wingman tactics
- Replacing or retuning classic `AiPilot` behaviour
