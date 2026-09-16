# AI Waypoint Navigation

> **Status: implemented.** `AiFlightPhase.WAYPOINT` and the route sequencer are
> in [src/script/ai/aiPilot.ts](../src/script/ai/aiPilot.ts) and
> [src/script/mission/route.ts](../src/script/mission/route.ts), with the wire
> message in [src/script/physics/sim/combatSim.ts](../src/script/physics/sim/combatSim.ts).

An AI aircraft can be given a **route** — an ordered list of fixes, each with an
altitude, a speed, a capture radius and an action — and will fly it, resuming
after a dogfight and landing at the field a `land` leg names.

## The phase

`WAYPOINT` is ordinal **11**, appended after `FORMATION` and required to stay
last. The ordinal *is* the wire format: `setPhase(id, phase: number)` casts a
raw number straight to the enum with no range check, so inserting a value ahead
of it silently re-tasks every route in flight. `aiPilot.route.test.ts` asserts
the number.

| Leg action | What the pilot does |
| --- | --- |
| `transit` | Track the fix, hold its altitude and speed, advance on capture |
| `orbit` | As `transit`, then hold over the fix for `holdSeconds` before advancing |
| `engage` | Hand off to `ENGAGE` when a live target is assigned; otherwise transit |
| `land` | Hand off to `RTB` toward the runway the leg names |

Transitions in and out:

```
TAKEOFF_ROLL ──► CLIMB_OUT ──► WAYPOINT        (doClimbOut, when a route is loaded)
                                  │  ▲
                    engage leg    │  │  target dead
                                  ▼  │
                               ENGAGE ┘        (doEngage's fallback)
                                  │
                     land leg     ▼
WAYPOINT ─────────────────────► RTB ──► APPROACH ──► FLARE ──► ROLLOUT

WAYPOINT ──► NAVIGATE                          (route finished and loop: false)
```

A wingman is **not** given the route. Members 2..N of a flight fly `FORMATION`
off the element lead, because the wing-slot law in `doFormation` already solves
intra-flight geometry — handing every member the same fixes and the same capture
radii walks the whole flight onto one point.

## Four traps a route follower hits

These are the reasons `doWaypoint` looks the way it does. Each was found by
watching the aircraft do the wrong thing.

**1. The GPWS gate returns before the phase switch.** `update()` runs
`if (!groundPhase && this.updateTerrainAvoidance(delta)) return;` *before* the
`switch (this.phase)`, so a pull-up suspends the phase entirely. Leg bookkeeping
placed inside `doWaypoint` would freeze mid-manoeuvre and the aircraft would
silently overfly its fix. Hence `tickRoute(delta)`, called from `update()`
*before* the gate: capture tests and orbit dwell keep running through a pull-up,
while steering does not.

**2. The look-ahead cannot trust coarse terrain.** The horizon reaches ~1.7 km
at cruise, well outside the mirrored disk around any aircraft that is not the
player, and off the fine tier the height is interpolated across a 611 m lattice
that invents ridges between posts. Trusting those probes latches `pullUpActive`
on relief that is not there — and because the gate returns, the aircraft goes
wings-level at `PITCH_MAX` and climbs away *without ever steering*. The symptom
is not "flew into a hill", it is **"never turned, climbed to the ceiling"**.
`WorldQuery.isAuthoritativeAt` (optional; absent means yes) lets the pilot skip
those probes. The instantaneous clearance and every phase's hard-deck floor
still apply.

**3. Deceleration needs the speedbrake.** `commandSpeed`'s throttle integrator
bottoms out at idle long before a clean airframe at altitude has actually
slowed, so a leg slower than the one before it would simply be flown at the old
speed. `doWaypoint` uses `commandFormationSpeed`, which owns the boards with
hysteresis.

**4. The altitude loop droops.** It ends in a proportional-only pitch-attitude
cascade that settles roughly 150 m below a standing demand. On a wing slot that
reads as flying low; on a route it reads as the whole mission being planned at
the wrong altitude. `doWaypoint` carries a bounded integral trim
(`ROUTE_ALT_TRIM_RATE` / `ROUTE_ALT_TRIM_MAX`), copied from `formationAltTrim`.

One more, not in `doWaypoint` itself: **the heading is never latched.**
`avoidObstacles` *discards* the heading it is handed when it fires and returns
one of its own, so a latched course would be silently overridden and never
recovered. The bearing to the fix is recomputed every frame.

## Where the route lives

On `SimAircraft`, beside `pilotOptions` — not on the pilot. Handing it to the
pilot loses it twice over:

- `buildPilot` returns early while the world is undefined, so a route arriving
  before `setWorld` would never reach the pilot that `setWorld` then builds;
- `setPilotOptions` forces a pilot rebuild on **every flight start**, which
  would drop it again.

`buildPilot` re-applies `this.route` after `createAiPilot`, the same way it
re-applies `prevPhase`. `combatSim.route.test.ts` covers both orderings, and
removing the re-apply fails exactly those two cases.

## `setPhase` is idempotent

`AiPilot.setPhase` returns early when the phase is unchanged. This is load
bearing, not tidiness: `ShawAiPilot`, `AggressiveAiPilot` and `AceAiPilot` each
call `this.classic.setPhase(this.phase)` on *every frame* of their non-ENGAGE
path, so without the guard every entry effect re-fires sixty times a second —
the altitude trim never accumulates, and the formation rejoin law re-arms
forever and never settles. Route *progress* happens to be immune, because it
lives with the route rather than with the phase.

Any test of this must build its pilot through `createAiPilot`:
`new AiPilot(ac, world, { model: SHAW })` **silently ignores the option** —
`model` is read only inside `createAiPilot` — so a suite that constructs
`AiPilot` directly builds a CLASSIC pilot and passes either way.

## Out of scope

- Re-tasking a route in flight from outside the sim (the message exists; nothing
  sends it mid-flight).
- Per-leg formation or engagement rules. `engages` is per-flight, because target
  scanning lives in `CombatSim` and not in the pilot.
- Anything below the hard deck. Low-level routes remain the least reliable part
  of the feature: `commandAltitudeClamped` floors on the ground under the
  *aircraft*, not under the waypoint, so a low leg aimed past a ridge only
  reacts on arrival.
