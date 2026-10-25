# AI Pilot: Takeoff, Landing and the Dogfight Link — Plan

Status (2026-10-25, uncommitted): P0–P4 done for FM2 on flat ground and a
mesa. The AI joins final from any position and heading, lands, and stops, or
goes around and comes back, diverting after two. P5 (game wiring) and
everything after are not started. See [P0 results](#p0-results),
[Energy management](#energy-management-p1--p3-part) and
[Pattern and go-around](#pattern-and-go-around-p3--p4).

Goal: an AI pilot that can take an aircraft from a standstill on a runway into
the air, and bring it back down onto a runway and stop it — reliably, on any
baked airfield, under all four pilot models and both flight models (FM2, FM3).
Then join that up with the existing dogfight AI into a full sortie:
takeoff → patrol → fight → disengage → RTB → land.

## What already exists

The classic `AiPilot` ([aiPilot.ts](../src/script/ai/aiPilot.ts)) already has
the phases `GROUND_IDLE, TAKEOFF_ROLL, CLIMB_OUT, RTB, APPROACH, FLARE, ROLLOUT`
(lines ~810–1470), and Shaw / Aggressive / Ace delegate every non-`ENGAGE`
phase to it. The world side is there too: `WorldQuery.runways()`,
`nearestRunway()`, `groundHeightAt()` (includes runway surface pads), and the
runway list is rebased with the floating origin.

But it is a sketch, never exercised:

- `startTakeoff()` has no caller. Opponents and the wingman always spawn
  airborne. The only use of the landing chain is the player's in-worker
  autopilot set to `RTB` at [game.ts:4682](../src/script/state/game.ts:4682).
- No test covers any of these phases.

### Defects found reading it

These are blockers, roughly in order of severity:

1. **GPWS fights the approach.** `update()` exempts only `GROUND_IDLE`,
   `TAKEOFF_ROLL`, `FLARE`, `ROLLOUT` from terrain avoidance. `APPROACH` isn't
   exempt, so below `hardDeck` (150 m default) on final the predictive pull-up
   fires: full power, nose up, **gear retracted**. As written the aircraft
   probably can't reach the flare. (Unverified, but the code path is direct.
   The first test will confirm it.)
2. **Glideslope tracks the terrain under the aircraft**, not the runway:
   `targetAlt = groundHeightAt(pos) + dist * 0.052`. Over a valley the glidepath
   drops, over a ridge it rises. It has to be referenced to threshold elevation.
3. **Altitude loop droops.** `commandAltitude` ends in a P-only attitude loop
   that settles ~150 m low (documented in the formation constants). On a 3°
   path that's 2.9 km short, i.e. in the ground before the runway.
4. **Hard-coded speeds.** Rotate at 90 m/s, approach at 150 m/s (≈290 kt) and
   flaps up at 150 m/s, for every airframe. They should come from the airframe.
5. **One landing direction.** Always approaches from the runway's `-heading`
   end. No reciprocal choice, no length check, no wind.
6. **Geometry.** Flies straight at a fix 8 km out and switches to APPROACH
   within 2.5 km of it at whatever intercept angle it has. That means overshoots
   and S-turns onto final, with no base turn.
7. **Open-loop flare and no go-around.** The flare is a fixed 0.15 pitch command
   at idle, with no sink-rate control and no float limit. A bad approach has no
   way out.
8. **Rollout:** full brakes at touchdown, heading-only steering with no
   centreline term, and it stops wherever it stops.
9. **`setPhase` has no unchanged-phase guard**, and the three wrapper models call
   `classic.setPhase()` every frame (see memory note on this). Any landing phase
   holding state (flare latch, go-around count, pattern leg) would be reset every
   tick under Shaw / Aggressive / Ace.

## Design

### Where it lives

A new module `src/script/ai/airfield/`, with `AiPilot` delegating its ground and
pattern phases to it. The wrappers already delegate those phases to the classic
pilot, so all four models pick it up without changes. The dogfight code is left
alone.

```
src/script/ai/airfield/
  airframePerformance.ts   Vs, Vr, Vref, rotate attitude, AoA targets from the config
  runwayEnds.ts            Runway → two landable ends (threshold, elevation, direction, length)
  runwaySelection.ts       pick end: length vs. landing distance, wind if any, terrain on approach
  patternPlanner.ts        entry → downwind → base → final as lines + arcs
  pathGuidance.ts          L1 lateral guidance on lines/arcs, glidepath vertical guidance
  takeoffController.ts     line-up, roll, rotate, liftoff, clean-up, climb
  landingController.ts     final, flare, touchdown, derotate, rollout, go-around
  airfieldPilot.ts         the phase machine, owned by AiPilot
```

### 1. Airframe performance

Derive the speeds from the aircraft config instead of hard-coding them:
`Vs = sqrt(2·m·g / (ρ·S·CLmax))` for clean, takeoff-flap and landing-flap
configurations, using the density at the field's elevation. Then:

- `Vr = 1.1·Vs_TO`, `V2 = 1.2·Vs_TO`
- `Vref = 1.3·Vs_LDG`
- Maximum rotate attitude from gear geometry (tail-strike angle minus margin).

Jets fly the approach on **AoA** rather than speed (F-16 ≈ 13°). AoA is the
primary target where the config gives one, with speed as the fallback. This also
handles weight changes automatically.

**Calibration step:** run each airframe in the headless sim (steady glide, flaps
down) and check the derived Vref holds the target AoA. The FM3 memory note says to
recalibrate after aero changes, so add this as a test rather than a one-off.

### 2. Runway ends and selection

`Runway` has centre, heading, halfLength and halfWidth. Make two `RunwayEnd`s from
each, each with threshold position, threshold elevation (sampled from the surface
pad), landing direction, available length, and a touchdown point (threshold +
300 m, or a scaled distance on short strips).

Selection rules:

- Reject an end if the landing distance (from Vref and a deceleration estimate)
  exceeds its available length × 1.4.
- Prefer the end into the wind, if the sim has wind (to check: there are `wind`
  references in fm2/fm3, but they may only be wind-tunnel code).
- Otherwise prefer the end whose 10 km approach corridor has the lowest terrain
  above the glidepath, sampled with `groundHeightAt`. In mountain areas like the
  Alps or Garmisch this matters more than anything else.
- Commit once, as `homeRunway` already does. Re-pick only on go-around ×2
  (divert).

### 3. Pattern and guidance

`patternPlanner` builds the path as a list of segments (line or arc) from the
aircraft's current state:

- **Straight-in** when the aircraft is within ±30° of final course and far enough
  out to intercept 8 km before the threshold.
- Otherwise a **standard pattern**: enter downwind abeam at 45°, fly downwind at
  pattern altitude (threshold + 450 m), base turn, final. Turn radius is
  `r = V² / (g·tan φ)` at 30° bank and pattern speed. The base turn is placed so
  the aircraft rolls out on final ≥ 5 km out, at glidepath height.
- From very far away, fly direct to the pattern entry first, using the
  existing RTB cruise leg.

**Lateral guidance:** L1 nonlinear path following (Park/Deyst/How). It tracks
lines and arcs with one gain and has no wind-up, and it outputs a lateral
acceleration that maps to bank: `φ = atan(a/g)`. This replaces the hand-tuned
`lateral*0.01 - headingErr` blend.

**Vertical guidance:** a glidepath to the touchdown point at 3° (steeper,
e.g. 3.5–4°, if the corridor check needs it). Command a **flight-path angle**
(γ = path angle + correction on height error) with an **integral term** so the
150 m droop can't occur. Use throttle for speed/AoA. Use airbrakes when fast and
high.

**Stabilised gate at 150 m AGL:** gear and flaps down, lateral error < 30 m,
speed within −5/+10 m/s of Vref, sink < 7 m/s. If any of these fails, go around.

GPWS stays active on the approach but switches to an approach mode: no gear
retraction, and it compares against the glidepath and the corridor terrain rather
than the 150 m hard deck. Below 60 m on a stabilised approach only the flare can
hold the nose.

### 4. Flare, touchdown, rollout, go-around

- **Flare** is a closed loop on sink rate. Start at `h_f = τ·|ḣ|` (τ ≈ 2–3 s,
  per airframe) and command `ḣ = -h/τ` down to a minimum sink of 0.6 m/s. Throttle
  to idle at `h_f/2`. Limit pitch attitude to the tail-strike angle.
- **Touchdown:** `isLanded()` held for 0.3 s. Bounce detection: airborne again
  above 2 m → go around.
- **Float limit:** not on the ground by touchdown point + 600 m → go around.
- **Derotation:** jets hold the nose up for aero-braking down to ~0.7·Vref, then
  lower the nosewheel at a limited rate.
- **Rollout:** airbrakes out, brakes ramped (not slammed), nosewheel steering on
  the L1 centreline with gain scheduled on speed. Stop on the centreline, then
  `GROUND_IDLE`. Taxiing clear is phase 6.
- **Go-around:** full power, pitch to a climb attitude, gear up on positive climb,
  re-enter the pattern on the runway heading. After two go-arounds, divert to the
  next suitable runway.

### 5. Takeoff

- **Line-up:** spawn on the runway threshold, aligned (what `pickStartRunway`
  already does for the player). Hold brakes and spool to 100% (AB optional).
  Release once RPM/thrust has settled, or after 2 s.
- **Roll:** nosewheel steering plus rudder on the L1 centreline, gain scheduled
  on speed (nosewheel effective low, rudder high). Wings level, stick neutral.
- **Rotate at Vr** to a *pitch-attitude target*, not a raw stick value: 8–12°
  depending on the airframe, rate-limited to 3°/s, capped below tail strike.
- **Liftoff:** `!isLanded()` held for 0.5 s plus positive climb. Gear up above
  10 m AGL with a positive rate. Flaps up above V2 + 20. Climb at V2 + 20 to
  300 m AGL, then accelerate to climb speed and hand off to the mission phase.
- **Abort:** if Vr isn't reached within 85% of the runway, idle, full brakes and
  airbrakes. This mainly catches short OSM strips with jets on them.

### 6. Taxi (later, optional)

`bake_osm_airports.py` already bakes taxiway geometry. Build a taxi graph from it
(nodes at junctions and runway-holding points) and run A* from the apron to the
active runway end. Taxi at ~10 m/s using the same ground-steering L1 controller.
This is only needed for "start from parking" and "clear the runway after
landing", so it is not part of the first pass.

## Testing and verification

Headless scenario tests on the existing `combatSim` test pattern
(`combatSim.*.test.ts`), with pilots built via **`createAiPilot` across all four
models** (constructing `AiPilot` directly silently ignores `model`):

| Scenario | Pass criteria |
|---|---|
| Takeoff, each airframe, FM2 + FM3 | airborne before 85% of the runway, gear up, never more than 10 m off centreline, no tail strike, reaches 300 m AGL |
| Landing, Monte Carlo: start 15 km out, random bearing/altitude/speed | touchdown in TDZ (+150..+900 m), sink < 3 m/s, on the paved width, stops on the runway, no GPWS pull-up after the gate |
| Go-around triggers | high/fast, offset final, bounce: each one goes around and lands on the second try |
| Short strip | rejects an unusable end or diverts; never runs off the end |
| Terrain | approach to a valley airfield (Garmisch area runway list): no terrain clearance below 100 m before the threshold |
| Phase stability | the phase sequence is monotone (no per-frame re-entry), regression for the `setPhase` guard |

Then on screen: verify in the pane with the player autopilot RTB and a wingman
scramble. Per the memory notes, screenshots are unreliable for fine detail, so
also read the MFD maneuver label / phase.

## Implementation order

| Step | Work | Done when |
|---|---|---|
| P0 | Test harness + the three blockers: `setPhase` guard, approach exempt from the hard-deck GPWS, glideslope referenced to threshold elevation | the existing RTB lands at least once in a headless test, measured as-is |
| P1 | `airframePerformance` + `runwayEnds` + selection | derived Vref holds target AoA per airframe |
| P2 | Takeoff controller | takeoff table rows green across models/FMs |
| P3 | Pattern planner + L1 + glidepath with integral + stabilised gate | Monte Carlo approaches reach the gate stabilised ≥ 95% |
| P4 | Flare / touchdown / rollout / go-around | landing table rows green |
| P5 | Game wiring: wingman taxis-less scramble behind the player; opponents optionally scramble from a hostile field; "AI land" key for the player autopilot; MFD phase labels | seen in the pane |
| P6 | Taxi graph (optional) | parks after landing |
| P7 | Carrier: CASE I pattern to the deck, hook, arrestor already modelled (`arrestorLatch`) | traps on the Kuznetsov |

P0 is small and shows whether the existing chain is salvageable at all. If it
lands with only the blockers fixed, P3/P4 can be incremental rather than a
rewrite.

### P0 results

Test: [combatSim.airfield.test.ts](../src/script/physics/sim/combatSim.airfield.test.ts)
(real FM2 airframe through `CombatSim`, all four models).

Measured on the unchanged pilot:

- **Takeoff already worked** on all four models: lifts off ~750 m down the
  roll, on the centreline, and climbs out.
- **No landing ever.** A straight-in held the glidepath ~140 m high and levelled
  off at 16 m, just above the 15 m flare gate, then cruised past. On a 300 m
  mesa it porpoised along and ended 47 km downrange. From a crossing start the
  lateral law saturated the bank and sent it 9 km to the other side.

Fixed in [aiPilot.ts](../src/script/ai/aiPilot.ts):

1. `setPhase` unchanged-phase guard.
2. The terrain guard on APPROACH uses a deck of 40% of the glidepath's height,
   ignores ground past the touchdown point, and no longer retracts the gear.
3. The glidepath is referenced to the runway surface at the touchdown point. The
   IAF altitude is the glidepath's height there, not `0.4 · cruiseAltitude`.
4. Found while measuring, and needed to reach the flare:
   - centreline intercept capped at 30° instead of bank on the raw offset;
   - glidepath sink-rate feed-forward plus an integral altitude trim (as on a
     formation slot);
   - a sink-rate flare (`ḣ = −h/3 s`, min 0.6 m/s) replacing the fixed 0.15
     stick, which ballooned a fast approach to 520 m.

Now: the straight-in reaches the flare on the centreline over the touchdown
zone under all four models, with no pull-up on short final, and touches down
gently (< 1 m/s). The mesa approach flares at the runway's height.

Still failing after P0: **energy.** It arrived on final at ~220 m/s and flared
at 130–170 m/s whatever approach speed was commanded, then floated 2.5–6 km past
the runway end. Fixed below.

### Energy management (P1 / P3 part)

The flight model only counts a touchdown as landed below the airframe's
`envelope.landingMaxSpeedMps` (90 m/s for the default F-16). So "float until
90 m/s" was the flight model's rule, not just the pilot being slow.

- **Vref from the airframe:**
  [airframePerformance.ts](../src/script/ai/airfield/airframePerformance.ts)
  computes `min(1.3 · minFlyingSpeedMps, landingMaxSpeedMps − 5)`, which is
  85 m/s for the default jet. The pilot reads both speeds through a new
  `PilotableAircraft.getSlowSpeeds()`, which `SimAircraft` fills from its config
  (and refreshes on `setAircraftConfig`).
- **Slow down before the IAF:** the RTB speed ramps down with distance to the
  IAF (0.008 m/s per m, reaching Vref + 10 at 3 km out). The formation
  speedbrake latch is now the general `commandSpeedWithAirbrakes`. Gear and
  flaps go down below 1.5 Vref instead of at 500 m AGL. Vref is held on final.
- **Path hold:** this was the real blocker, as P-only loops droop slow and dirty
  (a level-off at 130 m/s settled 200 m low, then porpoised into the terrain
  guard). For RTB, approach and flare only (`holdPath` / `integrate`):
  - the nose target adds the measured nose-above-path angle (the AoA in the
    vertical plane), so the flight path is what gets held;
  - an integral on nose error, capped at 0.4 stick. A cap of 0.8 started a
    45 s phugoid on final (73–108 m/s), so 0.8 is allowed in the flare only.
  - Other phases are untouched.
- **Flare:**
  - It starts where `h/τ` equals the current sink, so it only ever asks for
    less. The fixed 15 m gate asked for more and pushed the nose down.
  - It carries the glidepath command's standing bias across the switch.
  - The path-offset estimate is frozen during the flare (otherwise it chases
    the nose down).
  - Approach thrust is held to 4 m.
  - It tracks the centreline at ≤ 5° bank.

Result (FM2 default, all four models):

Runway z −1500…+1500, aim point z −1200, half-width 30 m:

| Start | Touchdown | Sink | Stops at |
|---|---|---|---|
| 35 km straight-in | 350 m past aim point, 3 m off centreline | 1.5 m/s | z −88 |
| 15 km straight-in (arrives fast) | 610 m past aim point, 17 m off centreline | 2.4 m/s | z +143 |
| 300 m mesa, 15 km | 250 m past aim point, 17 m off centreline | 3.2 m/s | z −200, on the mesa |

(Superseded by the pattern and go-around work below: the flare changed, and the
~20° touchdown nose is now capped at 14°.)

### Pattern and go-around (P3 / P4)

**Pattern:** RTB is now three legs, with the geometry in
[patternGuidance.ts](../src/script/ai/airfield/patternGuidance.ts):

- **DIRECT:** intercept the extended centreline. The intercept grows smoothly
  to 45°, with a capture distance of half a turn radius.
- **DOWNWIND:** when there isn't room for that (too close, too far to the side,
  past the runway, pointing away), fly a leg parallel to the runway, two turn
  radii out, outbound past the join point.
- **BASE:** a 180° arc about a centre one radius off the centreline, then back
  to DIRECT.

Further details:

- The turn radius comes from pattern speed (1.3 Vref) at 30° bank.
- Established means within 150 m and 15°. That hands over to the approach from
  11 km.
- The approach's speed ramp carries on to reach Vref 4 km out.

**Go-around:** `AiFlightPhase.GO_AROUND`, appended to the enum. The maneuver
label carries the reason, e.g. `GO_AROUND:FAST`. Triggers:

| Trigger | Where | Limits |
|---|---|---|
| Unstable at the gate (below 150 m above the runway) | APPROACH | lateral > 60 m, heading > 15°, glidepath > 50 m, speed outside Vref −10/+15 |
| `LONG` | APPROACH | more than 300 m past the aim point unflared |
| `EDGE` | flare start | wheels within 5 m of the runway edge |
| `FLOAT` | FLARE | more than 900 m past the aim point |
| `BOUNCE` | ROLLOUT | airborne again above 3 m |

Then full power, climb at 12 m/s on the runway heading, gear up on a positive
climb, flaps up at pattern speed. Above 300 m it re-plans RTB, and after two
go-arounds it diverts to the nearest other runway.

What else had to change to make every scenario stable:

- **Pitch gain scheduling:** in the airfield phases, P and D are scaled by
  (200 / airspeed)², capped at 3 (6 in the flare). The pitch gains are tuned
  at fighting speed, and at 85 m/s the jet sank off every glidepath it was
  slowing down on.
- **Proportional throttle:** 0.04 per m/s on top of the integrator, in the
  airfield phases. With the integrator alone, a tight path hold turned into a
  25 s speed/path oscillation (75–100 m/s, AoA 7–21°).
- **Terrain guard stands down inside the gate.** Its 8 s look-ahead reads the
  runway itself as terrain whenever the sink is a little over nominal. That
  gave a full-power pull-up at 30 m that ballooned the flare. The gate has just
  checked the approach, and the go-around covers it from there.
- **Flare is an attitude ramp:**
  - The nose goes from its value at the gate to the 14° cap as the height runs
    out, plus 0.03 rad per m/s of excess sink.
  - Pitch integral gain 4 in the flare (0.4 elsewhere).
  - The gate is at 5 s × sink rate, no earlier than 800 m before the aim point.
    This replaced the 400 m distance gate, which flared too late on a low final.
  - It holds 30% power only when at or below Vref; when fast, power only floats
    it.
- **Centreline gain:** the approach intercept gain went 0.001 → 0.003 rad/m.
  At 0.001 a 17 m offset sat inside the heading loop's 1° deadband for good.

Result (CLASSIC; the other three models delegate here and pass the same tests).
Runway z −1500…+1500, aim point z −1200:

| Start | Go-arounds | Touchdown | Sink | Stops at |
|---|---|---|---|---|
| 15 km straight-in | 0 | z −1130, on centreline | 2.5 m/s | z −358 |
| 35 km straight-in | 0 | z −1334, 3 m off | 2.5 m/s | z −561 |
| 90° crossing, 6 km off | 0 | z −1333, 3 m off | 2.5 m/s | z −562 |
| Beyond the far end, flying away | 0 | z −1336 | 2.6 m/s | z −565 |
| Overhead, heading the wrong way | 0 | z −1336 | 2.5 m/s | z −564 |
| Unstable final (high, fast, clean) | 1 (`GLIDEPATH`) | z −1336 | 2.6 m/s | z −565 |
| 300 m mesa | 0 | z −1217 | 3.5 m/s | z −455 |
| Two runways, one go-around already flown | 1, then divert | stops on the other runway | | |

Known gaps:

- **Low finals:** fixed later (pitch integral cap 0.6); see RTB in mountains.
- **Flare cap:** the 14° cap is a judgement; the airframe config doesn't
  describe the tail. With it, a few landings come in at 3.5 m/s.
- **Terrain inside the gate:** terrain rising above runway height in the last
  150 m isn't guarded against.
- **Divert test:** white-box only (it sets the go-around count).
- **FM3:** untested (FM2 only). Only flat ground and one mesa.
### Game wiring (P5)

**Wingman scramble:**

- On a runway start, `spawnScrambleWingman` parks the wingman 100 m behind the
  player and up to 15 m right (half the runway width), in `GROUND_IDLE`, with
  the player as formation lead.
- The pilot scrambles when its lead is within 3 km, within 30 m of its height
  (on the same field), and rolling faster than 15 m/s.
- `lineUp()` latches the runway direction nearer the nose (no U-turn on the
  runway) and the lateral line the aircraft stands on, so the takeoff holds that
  line.
- Climb-out hands over above 300 m AGL, cleaned up: to `FORMATION` with a
  lead, to `ENGAGE` with a target, otherwise on to patrol.

**Opponents:** the setting "Take off from another airfield" (`opponentsScramble`,
in the AI pilot model section, off by default).

- Opponents park on the threshold of the nearest other airfield 8–40 km away.
- Failing that, another runway of the player's own field, from its far end,
  facing the player.
- They are in `TAKEOFF_ROLL`, targeting the friendly faction.
- Neither available means the usual merge.
- The merge itself no longer parks an opponent on the player's runway in
  `ENGAGE` when the player is on the ground. It starts at 900 m AGL and
  180 m/s ahead instead.

**Player autopilot (`a`):**

- Engaging hands the aircraft to the pilot as before, and now also sets its
  job: `TAKEOFF_ROLL` on the ground, `RTB` in the air.
- Fixed: every key, including `a`, was dropped while the autopilot flew, so it
  could never be switched off. `a` now gets through (not on key repeat).

**Labels:**

- The HUD's `AP` reads `AP T/O`, `AP CLB`, `AP RTB`, `AP APP`, `AP FLR`,
  `AP ROLL`, `AP G/A` (from `ai/phaseLabels.ts`).
- The MFD target page already showed an AI's maneuver label, so it shows the
  new phases and `GO_AROUND:<reason>` as they are.

**Dev telemetry:** `globalThis.__aiStats` (game.ts `publishAiStats`) gives each
sim-flown aircraft's label, position, AGL, and the player's speed and autopilot
state.

**In-game check:**

- **Why headless:** the Browser pane got no animation frames with the app
  window out of view. The check runs in headless real-GPU Chrome over CDP
  (scratch `airfield.mjs`): runway start, `a` for takeoff, `a` off and on at
  1000 m AGL for RTB, sampling `__aiStats`.
- **Area:** Gran Canaria's default "home" area has no OSM airfields (they are
  tagged "Kanaren"). It starts at the authored airbase and opponents fall back
  to the merge there.

**Results in the game** (default area, F-22, FM2):

- **Takeoff:** `a` → `AP T/O` on the HUD, brakes held 4 s at full power, then
  the roll.
- **Wingman:** parked in `GROUND_IDLE`, rolls as the player passes ~15 m/s,
  lifts off on its own line (x = 15), then `FORMATION`, then engages the
  opponent.
- **Opponent:** starts at 880 m AGL ahead (merge, no field), not on the runway.
- **RTB:** `a` off/on at 1000 m → `AP RTB`. The pattern was a downwind 4.3 km
  out at 110 m/s, a base turn, final from 11.2 km, `AP APP` / `FLR`.
- **Touchdown:** z −756 (730 m past the threshold, beyond the ski jump),
  sinking 2.9 m/s at 14° nose, on the centreline. It stopped at z −13.

Bugs only the game showed, all fixed with tests:

- **Ski jump at the aim point:** the authored airbase has a 12 m ski jump on
  the centreline exactly at the aim point, and every landing was launched off
  it (vy −3.3 → +18 m/s at touchdown). The pilot now scans the runway for
  anything more than 1 m above the plane through its thresholds. It aims 600 m
  past an obstruction and doesn't flare before its end.
- **Stale line-up:** `lineUp()` ran in `setPhase` from a stale picture of
  where the aircraft was (a fresh pilot's is the origin). At GCXO it lined up
  on a neighbouring runway. It now lines up on the first takeoff frame, on the
  runway the aircraft is actually on.
- **Bounce check from the ground:** it measured from the ground, not from the
  CG's height on its wheels.
- **Rollout lift:** the rollout held neutral stick, which is 1 g through the
  fly-by-wire. It now derotates and puts the speedbrakes out.
- **Thrown airborne early:** off the ski jump, the takeoff kept steering with
  the rudder. It now flies wings level at a 10° attitude.

**Home base ski jump moved to 400 m (2026-10-25).** At 90 m past the runway
start, a standing start reached it at ~40 m/s, well under the 68 m/s minimum
flying speed, and in the game at GCXO the autopilot crashed off it. Now:
`skiJumpAheadM` is 400 in game.ts, and a sim test checks the ramp is reached
above flying speed (it fails at 90 m: 33 m/s).

Takeoff changes that came with it:

- Brakes held 4 s at full power from a standstill.
- Line-up on the first takeoff frame.
- Off the wheels the takeoff is flown: wings level, rudder neutral, the rotate
  stick (0.5) held until climb-out. A held 10-15° attitude was too little pull
  off the ramp tip in the game and sank back onto the runway at 93 m/s.

In-game result at GCXO:

- **Player autopilot:** reaches the ramp at 79 m/s, hops (down to 3-5 m),
  accelerates to 108 m/s and climbs out.
- **Wingman (still open):** it starts 100 m further back and 15 m right, and
  crashes ~120 m past the ramp. The ramp now throws the jets up just under
  rotate speed. Whether the hop back onto the runway is survivable is marginal,
  and the Node sim never reproduces it (all ramp distances, both lines, climb
  out), so it can't be tuned offline. Options: park the wingman *beyond* the
  ramp, give AIs a longer run-up, or move the ramp off the runway.

**RTB in mountains (GCXO), fixed 2026-10-25.** Before the fix the pattern
never closed: it was flown at the glidepath's join height (~1050 m above sea
level), only ~300 m above Tenerife's terrain, and the terrain guard kept taking
over with wings-level pull-ups. Now:

- **Pattern altitude:** the higher of the join height and a minimum safe
  altitude. That is the highest ground within 6 km ahead, across a 1.6 km-wide
  swath, along both the current track and the one being turned to, plus 300 m.
- **Downwind side:** the side whose downwind and base turn cross lower ground
  (by its highest point). The side the aircraft is on wins ties within 100 m.
- **Approach terrain floor:** the final never goes below the ground ahead
  (3 km look-ahead, stopping 1.5 km short of touchdown) plus a clearance. The
  clearance is the smaller of 150 m and half the glidepath's height, so it
  never rises above the glidepath over flat ground.
- **Approach from above:** high on the final, it descends to the glidepath at
  no more than 6 m/s beyond the glidepath's own sink. The altitude trim only
  integrates within 40 m of the target, so it doesn't wind up over a ridge.
- **Approach gain:** 0.1 m/s per m on the final, up from 0.06.
- **Pitch integral cap: 0.4 → 0.6.** At approach speed the loop needs ~0.6;
  pinned at 0.4 it couldn't hold the glidepath. That was the cause of "finals
  ~10 m low": flat finals now reach the flare 1-4 m from the glidepath and
  touch down 70-130 m past the aim point at ~2.7 m/s. With the gain scheduling
  in place, 0.6 doesn't bring back the phugoid that 0.8 caused before it.

Sim tests:

- **Ridge beside the pattern:** an 800 m ridge under the arrival side's
  downwind. No pattern pull-ups; it lands.
- **Ridge under the final:** a 600 m ridge across the final 9-15 km out, above
  the glidepath there. It crosses high, descends, and lands at the aim point.

In the game at GCXO: autopilot takeoff over the ramp, then downwind, base,
direct, and an approach from ~9.5 km. It touched down ~1.29 km past the
threshold (just past the aim point moved beyond the ski jump) with no
go-around, and stopped on the centreline (`AP PARK`). The wingman also took
off cleanly over the ramp this time and joined the fight. That's one run, and
the touchdown sink rate wasn't captured.

**Opponent scramble is only unit-tested.** It needs a base with a second runway
(GCLP) or another field within 40 km. Kanaren bases at GCXO (single runway,
nearest field 30+ km beyond range), so in-game it fell back to the merge. That
was correct, and `__aiStats.opponentSpawn` reports the decision.

## The dogfight AI

The fight itself is in better shape than the airfield work: four models (Classic
BFM sub-FSM, Shaw, Aggressive, Ace with post-stall moves), geometry helpers, and
gun lead. Every model's doc lists the same gaps: guns only, 1v1, no wingman
tactics. Here's what I'd do next, in value order.

1. **Close the sortie loop.** Give the fight an exit. Today `ENGAGE` only ends
   when the target dies. Add disengage triggers (Winchester ammo, bingo fuel if
   fuel is modelled, damage above a threshold, a lost fight with no energy to
   reset) leading to `RTB` and the new landing chain. This is the piece that
   connects the two halves of this plan and makes the takeoff/landing work
   visible in play.
2. **Performance-aware fighting.** Corner speed, sustained turn rate and
   `maxSpeed` are hard-coded (`combatSpeed 220`, `MAX_SPEED 240`). Derive them per
   airframe from the same `airframePerformance` module (Ps/turn-rate tables from a
   headless sweep), so a MiG and an F-16 fight differently and the AI knows when
   it is out-turned.
3. **Arena harness before more tuning.** A headless tournament: model vs model
   and model vs scripted player, N seeded merges each (neutral, offensive,
   defensive starts). Track win rate, time-to-kill, ground collisions, stalls and
   time on the gun. Tuning has been by eye so far. This makes it measurable and
   catches regressions like the ones the ring/overspeed mitigations were patched
   around.
4. **Human limits as the difficulty knob**, instead of (or on top of) model
   choice: reaction latency, a visual-detection cone (losing sight low/behind,
   sun), g-tolerance with G-LOC for the AI too, and aiming error. A "fair" AI
   that loses sight is more fun than one with perfect information that is told to
   miss.
5. **Terrain in the fight.** GPWS is a wings-level override. Make maneuver
   selection terrain-aware instead: no Split-S or low yo-yo when the altitude
   needed (≈ 2× turn radius) isn't there, and prefer fighting up valleys over
   into ridges. The DACH/Alps areas make this matter.
6. **2v1 / 2v2.** The sim already re-picks targets by faction. Add roles
   (engaged/supporting), bracket and sandwich for the attacking pair, and a
   defensive split, and let the wingman call "engaged/visual". Watch the
   16-aircraft sim ceiling.
7. **Missiles** are the biggest and most disruptive item. They need a weapon
   model, seeker and countermeasures plus a BVR state layer above BFM. I'd do it
   only after 1–3.

Housekeeping: the four models duplicate a lot (each wraps the classic pilot and
re-implements firing gates and geometry). Extracting the shared non-ENGAGE
delegation and gun logic into one base is worth doing while adding the
disengage triggers, not as a separate refactor.
