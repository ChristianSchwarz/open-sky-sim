# Ace AI Pilot Model

Fourth selectable AI air-combat model, alongside the classic BFM `AiPilot`, the
doctrinal `ShawAiPilot` and the never-retreat `AggressiveAiPilot`: an elite
dogfighter that fights in the vertical, manages energy deliberately, shoots on
a full ballistic solution, and finishes with post-stall maneuvers (Cobra,
Kulbit).

## Selecting the model

In **Settings → AI pilot model**:

- **Classic BFM** — existing `AiPilot` dogfight modes (`PURSUE`, yo-yos, etc.).
- **Shaw (Fighter Combat)** — Offensive / Neutral / Defensive FSM + Flight Control Computer.
- **Aggressive (Berserker)** — Attack / Merge / Counter FSM + the same Flight Control Computer.
- **Ace (vertical fight + post-stall)** — Control / Merge / Evade / Reset FSM + the same
  Flight Control Computer, plus a post-stall layer that flies the stick directly.

The choice is applied on the **next merge / opponent spawn**, not mid-dogfight.

## Architecture

```
ConfigService.aiPilotModels
        │
        ▼
createAiPilot(aircraft, world, options)
   ├── CLASSIC    → AiPilot
   ├── SHAW       → ShawAiPilot
   ├── AGGRESSIVE → AggressiveAiPilot
   └── ACE        → AceAiPilot
                       ├── AceTacticalFSM         → AceFlightCommand
                       ├── FlightControlComputer  → stick / throttle (reused from Shaw)
                       └── post-stall executor    → stick / throttle (bypasses the FCC)
```

Like the Shaw and Aggressive models, `AceAiPilot` implements `AiPilotController`,
flies through `PilotableAircraft`, reuses Shaw's `FlightControlComputer` (its
`applyCommand()` only needs the minimal `FlightSetpoint` shape) and
`computeTacticalGeometry`, and delegates every non-`ENGAGE` mission phase
(takeoff, RTB, landing) to the classic pilot.

## Ace states

| State | Trigger (approx.) | Maneuvers | Notes |
|-------|-------------------|-----------|-------|
| CONTROL | AOT &lt; 70°, range &lt; 3.5 km | Lead / Lag Pursuit, High &amp; Low Yo-Yo, Barrel Roll Attack | A developing overshoot is answered by *how much energy is in the bank*: barrel-roll attack at knife range, high yo-yo with energy to spare, lag pursuit without. |
| MERGE | Head-on / high offset | Lead Turn, Vertical Reposition, Head-On Snapshot | The ace answer to a neutral pass is the vertical: a max-G pull up through the merge to start the fight on top of the bandit's turn circle. |
| EVADE | Bandit ATA &lt; 45°, ours &gt; 110°, range &lt; 2 km | Break Turn, Defensive Spiral, Rolling Scissors, **Cobra**, **Kulbit** | Defeats the tracking solution, preferring to make the bandit overshoot rather than to run. |
| RESET | Energy deficit &gt; 900 m, range &gt; 1.2 km, bandit **not** pointing at us | Zoom Climb, Split-S | The trait Aggressive deliberately lacks: when the energy fight is lost, buy it back and re-enter from above instead of grinding out a losing turn circle. Never extends in front of a bandit that is already pointing at us, and never fires while extending. |

## Post-stall maneuvers

`COBRA_BRAKE` and `KULBIT` are open-loop, timed departures from controlled
flight, so the Flight Control Computer's closed loops would fight them. The FSM
only *requests* one; `AceAiPilot` flies it directly on the stick (full aft
stick, wings held level, throttle chopped for the departure and slammed back in
for the recovery) and vetoes the request unless:

- there is at least 800 m above local terrain to recover in (while departed,
  the FCC's terrain-avoidance loop is not running), and
- airspeed is inside the maneuver's window (Cobra 140–330 m/s, Kulbit
  110–270 m/s), and
- the 8 s cooldown since the last one has expired.

A maneuver already in progress is abandoned back to the FCC if the ground comes
up to 400 m. The nose sweeps through the bandit during both, so the gun
solution is still evaluated while departed.

## Gunnery

The FSM's gun envelope (range + tracking angle) is only *permission* to shoot.
The aim direction is the full ballistic lead solution — the round inherits our
own velocity, the bandit is extrapolated through its turn using a smoothed
finite-difference acceleration estimate, and the gravity drop is held over —
and the pilot pulls the trigger only when `predictedMissDistance` puts the round
inside the target's hit radius (×1.6 slack). Against a hard-crossing target this
model holds fire where a fixed angular cone would shoot and miss.

## Out of scope

- Missiles / BVR weapons (guns only)
- Multi-bandit / wingman tactics
- Replacing or retuning the Classic, Shaw or Aggressive pilot behaviour
