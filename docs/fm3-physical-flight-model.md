# FM3 — Physical Flight Model

> **Status: implemented 2026-09-16, not yet committed (branch `terrain-rewrite`).**
> Selectable as *FM3 (Physical, post-stall)* under Settings → Simulation → Flight
> model, next to FM2 and Debug. Player aircraft only; AI stays on FM2. This file
> began as the plan and now describes what was built, how it was checked against
> NASA TP-1538, and where it still falls short.

FM3 is a 6-DOF rigid body in which every force comes from a physical mechanism at
its real location:

- lifting surfaces cut into spanwise strips, with section aerodynamics that hold
  over the full ±180°
- a lifting line with the tail's downwash delay and the wing's wake
- strake vortex lift and its breakdown
- a slender-body fuselage

Stall, departure, deep stall, flat spins and tail slides are computed, not scripted. Nothing in
the model is keyed to a manoeuvre, an angle-of-attack window or a speed band.

## Why a third model

FM2 is a rigid body with lift built up from surfaces, and it flies well inside the
envelope. Past stall it stops being physics:

| FM2 | Consequence past stall |
|---|---|
| Diagonal inertia; the Ixz product dropped | no inertial roll↔yaw coupling |
| Angular rate clamped to 6 rad/s | spins, tumbles and snap rolls are cut off |
| Explicit Euler on ω | adds energy to torque-free rotation |
| 9 surfaces, one force point each, all at y = 0 | no sweep or sideslip effects, no dihedral, no tip-first stall |
| Curve shapes tuned rather than derived (flat-plate blend, a vortex bump at 50°) | post-stall moments are whatever the tuning made them |
| Separation lag in fixed seconds | the same lag at 100 kt and at 500 kt |
| No downwash, wake or ground effect | no Cmα̇ damping, no tail blanketing, no deep-stall mechanism |
| Thrust through the CG; Mach only as drag | no thrust-line moment, no compressibility effect on lift |

FM2 is unchanged by FM3.

## Decisions

1. **Aerodynamics from geometry, not coefficient tables.** Any aircraft can be
   described by planforms and a fuselage; only the F-16 has tables. The tables
   validate FM3 and never drive it.
2. **FM3 runs inside the combat-sim worker, beside FM2.** The gun, damage, carrier
   decks, arrestor wires and AI targeting all live in `CombatSim`.
3. **Player only.** The AI pilots are tuned to FM2. The protocol carries a model kind
   per aircraft (`SimFlightModelKind`), so AI can move later.
4. **FM3 has its own flight control system.** An F-16 built from its real geometry at
   its real CG has relaxed static stability and needs angle-of-attack feedback, which
   FM2's pitch laws do not have. `L` (limiters off) keeps stability augmentation.
5. **Tuning knobs are physical parameters with stated ranges.** Where a fit pushes one
   to the edge of its range, that is recorded as a finding (see *Default F-16*).
6. **Every aircraft flies the F-16 airframe** until per-aircraft geometry exists, as
   every pack flies `defaultFm2Config` in FM2 today.

## Where it runs

```
Settings → Flight model ─► ConfigService ─► SimProxyFlightModel(combatSim, 'player', 'fm3')
                                                 │  reset / setAircraftConfig { model: 'fm3' }
                                                 ▼
               combat-sim worker:  CombatSim ─► createSimFlightModel(kind, config)
                                                 │         ├─ 'fm2'   → Fm2FlightModel
                                                 │         ├─ 'debug' → Fm2FlightModel { kinematic }
                                                 │         └─ 'fm3'   → Fm3FlightModel
                                                 ▼
                      carrier, arrestor, guns, AI pilots — unchanged
```

`SimFlightModel` (`physics/sim/simFlightModel.ts`) is `FlightModel` plus the four
methods `CombatSim` calls on a model: `setWorldQuery`, `clearAngularVelocity`,
`contactSpeedIntoNormal` and `applyContactDragAt`. Changing the model kind mid-session
rebuilds the aircraft (`rebuildIfModelChanged`), and the game re-pushes its collision
mesh after the swap.

## Code layout

```
src/script/physics/fm3/
  frames.ts            sim body axes ↔ NASA axes; inertia and body-rate conversions
  rigidBody6.ts        full inertia tensor, rotor momentum, RK4, NaN rollback
  sectionAero.ts       2-D section forces over ±180°, separation dynamics, compressibility, flaps
  liftingLine.ts       Phillips–Snyder horseshoe vortices; influence tables over wake direction
  aeroModel.ts         Fm3Aero: strips, lifting line, downwash delay, wake, strakes, bodies, drag areas;
                       coefficients() and pitchDamping() for validation
  fm3Airframe.ts       the airframe schema (NASA body axes, SI)
  f16Airframe.ts       the default F-16 and its fitted parameters
  propulsion.ts        F100 power lag over the F-16 throttle quadrant's thrust
  actuators.ts         position limit, rate limit and lag per channel
  groundContact.ts     spring-damper gear against sampled terrain planes
  fcs.ts               control laws and the leading-edge flap schedule
  reference/f16Tables.ts   Stevens & Lewis tables (TP-1538 data, α −10..45°)
  reference/tp1538.ts      TP-1538 figures 9, 10 and 44 and the pitch-rocking results
src/script/physics/model/fm3FlightModel.ts   the FlightModel subclass
src/script/physics/sim/simFlightModel.ts     SimFlightModel and its factory
tools/fm3/   windTunnel, calibrate, stepResponses, scenarios, bench, extract_f16_reference
```

Inner loops run on preallocated `Float64Array`s: no per-strip objects and no
allocation per step.

## One step

Each fixed 1/120 s step:

1. **State in.** Adopt any pose or velocity set from outside (spawns, carrier, contact
   impulses). Air density and speed of sound at altitude; height above the ground for
   ground effect.
2. **Engine.** Spool, then thrust.
3. **Controls.** Sensors → FCS → actuator commands → actuators.
4. **Slow aerodynamic states**, advanced once: separation per strip, circulation (with
   separated-flow smoothing), the circulation history for the tail, induced velocity,
   the wake over the tail, strake vortex breakdown.
5. **Terrain.** One height-and-normal plane per gear leg.
6. **RK4.** Each stage evaluates aerodynamics with the step-4 states frozen, thrust at
   the nozzle, gear forces against the step-5 planes, and gravity; the rigid body adds
   the gyroscopic terms. The first stage records per-strip results for the next
   step's state update and for the force-vector overlay.
7. **Finish.** A non-finite state rolls the step back and zeroes the rates
   (`nanGuardTrips` counts it). Then the gear penetration clamp, publishing, the
   parked-creep clamp, the stall indicator (share of wing area separated), and FM2's
   landed and crash rules.

## The physics

All state and forces live in the sim body frame (+X left, +Y up, +Z forward). The
airframe is described in NASA body axes (x forward, y right, z down); `frames.ts`
converts, and a test pins the mapping to FM2's control polarities.

### Rigid body

```
m · v̇ = R(q) · F_body + m · g
I · ω̇ = M − ω × (I · ω + h_engine)        full symmetric inertia tensor
q̇     = ½ · q ⊗ (0, ω)
```

- RK4, no angular-rate limit.
- Ixz = +1,331 kg·m² in NASA axes, TP-1538's sign.
- Engine angular momentum 216.9 kg·m²/s along the thrust axis, held constant as in
  TP-1538.
- Contact impulses go through the full inverse inertia tensor.

### Section aerodynamics

Each strip resolves its local velocity (CG velocity plus ω × r, minus the induced
velocity) into the plane normal to its quarter-chord line, so sideslip changes each
wing half's effective sweep. The Kirchhoff / Leishman–Beddoes normal and chordwise
forces, with `f` ∈ [0, 1] the trailing-edge separation point:

```
C_N = C_Nα·sin(α−α₀)·((1+√f)/2)² + (1−f)²·(C_plate − ¼·C_Nα·sin(α−α₀))
C_plate = C_D90·sin α / (s + (1−s)·|sin α|)        s: plate shape, 0.56 for a high-aspect plate
C_C = η·C_Nα·sin(α−α₀)·sin α·√f
x_cp = 0.25 + 0.25·(1−f)·|sin α|
```

- **Vortex lift.** Where a section has a sharp, swept edge, the suction lost to
  separation reappears as normal force (Polhamus), `k_v·C_Nα·sin(α−α₀)·|sin α|·(1−√f)`,
  at its own chord station, and fades as the vortex bursts.
- **Reverse flow.** Past ±90° the section flies backwards, with a reduced lift slope
  and an early break.
- **Flaps.** Hinged surfaces change camber through Glauert's effectiveness τ(c_f/c),
  fading at large deflection and in separated flow. Leading-edge flaps raise the
  separation angle by half their droop.
- **Compressibility**, on the Mach number normal to the sweep line: Prandtl–Glauert to
  M 0.8, a bridge to Ackeret's 4/√(M²−1) above M 1.2; the separation angle shrinks by up
  to 40% by M 0.9; wave drag by the Korn equation with Lock's fourth-power rise.

### Unsteady separation

Goman & Khrabrov: `τ₁·ḟ + f = f_static(α − τ₂·α̇)` with τ = k·c/V, so the same pull
delays stall more at low speed. The F-16's sections use k₁ = 3, k₂ = 1.5.

### Lifting line and induced flow

- **Vortex system.** Phillips–Snyder horseshoes on the quarter-chord line, with a core
  of 0.1·min(chord, 2·strip width). The trailing legs follow the freestream, so the
  influence coefficients depend on the wake's direction: they are tabulated at load
  over α −30..90° and β ±30° in 15° steps and blended bilinearly, re-blended only when
  the wake has turned 0.25°.
- **Strips.** Spaced toward the tip on the outer panels; uniform on a panel that meets
  another, where tip spacing left a zig-zag past stall.
- **Circulation** relaxes toward ½·V·c·c_l with a time constant of one chord of travel
  (the wake's build-up), treating each strip's own trailing legs implicitly so narrow
  tip strips don't ring. Past stall, neighbouring strips are smoothed in proportion to
  how separated they are: a lifting line with a negative lift slope has more than one
  solution, and nothing in real separated flow keeps a jump that sharp.
- **Downwash at the tail** uses the wing's circulation from one transport time l_t/V
  earlier (a 96-step ring buffer): the physical source of Cmα̇.
- **Ground effect.** The induced flow is scaled by σ = (16h/b)² / (1 + (16h/b)²).
  Surfaces on the fuselage (fin, ventral fins) mirror their trailing legs in a root
  endplate.

### Wake over the tail

Each wing strip sheds a Silverstein–Katzoff wake whose width and centreline
dynamic-pressure deficit follow its current section drag. A tail strip inside it flies
at the reduced dynamic pressure, so a deep-stalled wing blankets the inboard
stabilator.

### Strakes

- **Vortex lift** on the strake planform by the Polhamus suction analogy, plus the
  augmented vortex lift the strake vortex induces on the wing area beneath it. The
  inboard wing panel's own section vortex lift is fed by the same vortex and bursts
  with it.
- **Breakdown** moves from the trailing edge to the apex between two angles of attack.
  In sideslip the windward strake sees less sweep, so its vortex bursts earlier: the
  breakdown angle shifts by half the sideslip.
- **Breakdown lag**, Goman–Khrabrov again, with τ₁ = 2 and τ₂ = 0.5 strake chords of
  travel. With 8 chords a forced pitch oscillation went unstable past 60°: the lag held
  the vortex's nose-up lift while α rose and kept it burst while α fell.

### Fuselage

Thirteen stations. At each, the local velocity including ω × r splits into axial and
crossflow parts: a potential normal force from the growth of the cross-section
(slender-body theory in Jorgensen's high-α form) and a viscous crossflow force
½ρ·u_c²·width·C_dc·η (Allen & Perkins, Jorgensen's η). Each station's own ω × r makes
the body damp pitch and yaw. C_dc is a fitted constant: there is no Reynolds-number
dependence and no forebody vortex asymmetry.

### Controls, drag areas, propulsion, gear

- **Actuators** (position limit, rate limit, lag 1/20.2 s unless noted): stabilator
  ±25° symmetric plus ±5.375° differential at 60°/s; flaperons ±21.5° at 80°/s; rudder
  ±30° at 120°/s; leading-edge flaps 0–25° at 25°/s, lag 1/7.25 s; speedbrake 0–60°.
- **Drag areas** at their own positions: each gear leg, the speedbrake.
- **Propulsion.** Thrust magnitude from the F-16 throttle quadrant (so the afterburner
  detents, HUD and audio are unchanged), acting at the nozzle along its axis; spool by
  the Stevens & Lewis F100 power-lag model.
- **Gear.** FM3's own contact model on FM2's gear configuration: spring-damper legs
  against a terrain plane sampled per leg per step (0.45 m footprint), regularised
  friction inside a friction circle, brakes. FM2's landed and crash rules and parked
  creep clamp are ported unchanged.

## Flight control system

`fcs.ts`, laid out like the F-16's (gains are FM3's own, in `F16_FCS`):

- **Pitch.** Stick → g command (+9 / −3 g) through a 0.12 s prefilter, blended with a
  pitch-rate command below q̄ ≈ 2,500–6,000 Pa. Proportional-integral on the g error
  with anti-windup, pitch-rate damping, and angle-of-attack feedback that gives the
  unstable airframe apparent stability; gains scheduled on dynamic pressure.
- **Envelope protection** is a min-select on lead-predicted values: the g error the
  loop acts on can never exceed the headroom to the AoA limit (25°, α̇ lead 0.3 s) or
  the g limit (ṅ lead 0.35 s), so a full pull flies to whichever limit comes first.
- **Roll.** Stability-axis roll-rate command (300°/s), faded with angle of attack
  (15–30°) and gain-faded at 30–60°.
- **Yaw.** Washed-out stability-axis yaw damper, aileron–rudder interconnect growing
  with angle of attack, sideslip feedback, pedal authority faded at 20–30°. Above 29°
  with the limiters on, spin prevention takes the rudder (opposing yaw rate) and
  removes roll stick.
- **Leading-edge flaps** on the Stevens & Lewis schedule, 1.38·α° − 9.05·q̄/p_s + 1.45,
  limited to 0–25° (`leadingEdgeFlapSchedule`).
- **`L`, limiters off**, roughly the F-16's manual pitch override: no AoA or g limit, no
  roll or pedal fade, no spin prevention, and the AoA feedback fades out past the limit.
  Stability augmentation stays, with its pitch damping capped so it cannot overpower the
  stick; full stick now reaches the deep stall. FM2's limiter-strategy keys 1/2/3 do
  nothing in FM3; the HUD shows `FCS FM3`.

The gains were tuned on `tools/fm3/stepResponses.ts`, not by the modal analysis
against MIL-F-8785C that the plan proposed.

## Default F-16

- **Mass and reference geometry** from TP-1538 Table I: S 27.87 m², b 9.144 m,
  c̄ 3.45 m; W 91,188 N; Ix / Iy / Iz / Ixz 12,875 / 75,674 / 85,552 / 1,331 kg·m²; CG at
  0.35 c̄. (FM2's F-16 flies at 13,608 kg; FM3 uses TP-1538's validation mass.)
- **Planforms** from a public three-view. The wing (40° leading-edge sweep, NACA 64A204)
  is two panels split at 40% semi-span: inboard, under the strake vortex, and outboard.
  Stabilator with anhedral, fin with rudder, ventral fins, strakes, 13 fuselage stations.
- **Set by hand, with reasons:** section lag constants (Leishman–Beddoes-like), strake
  breakdown lag (forced-oscillation damping, above), breakdown shift of half the
  sideslip (the F-16's strake feeds a wing, which makes it less sensitive than a slender
  delta), leading-edge flap separation gain of half the droop (below).
- **Fitted** by `tools/fm3/calibrate.ts` inside physical bounds, with the leading-edge
  flaps on their schedule (TP-1538's figures are the airplane as flown), against:
  - figure 9 lift, α 0–40°
  - figure 10 pitching moment at δh = 0 and ±25°, α 0–90°, weighted double over 40–70°
  - the reference roll damping Clp at 15–30°
  - forced-oscillation pitch damping at 60–80°, which must stay at or below −0.5

  The fit reaches pitching-moment RMS error 0.034 (about the accuracy of reading the
  figures), lift 0.087, Clp 0.046, and damping −0.50 at worst.

| Parameter | Value | Range |
|---|---|---|
| Inboard panel separation angle | 28.0° | 10–28° (at bound) |
| Inboard vortex lift, share of lost suction | 1.5 | 0.5–1.5 (at bound) |
| Inboard vortex lift chord station | 0.461 | 0.25–0.6 |
| Outboard panel separation angle | 25.0° | 10–28° |
| Outboard plate shape | 0.297 | 0.2–0.56 |
| Stabilator separation angle / width | 18.0° / 8.0° | 12–32° / 3–8° (width at bound) |
| Stabilator plate shape | 0.431 | 0.2–0.56 |
| Stabilator vortex lift | 0.023 | 0–1.6 |
| Stabilator dynamic-pressure factor | 0.919 | 0.7–1.0 |
| Strake span | 0.696 m | 0.6–1.3 m |
| Strake breakdown at trailing edge / apex | 53.0° / 88.0° | 35–65° / 50–88° (apex at bound) |
| Wing area under the strake vortex, centroid x | 1.469 m², 1.318 m | 0–6 m², −1.5–2.5 m |
| Fuselage crossflow drag coefficient | 1.13 | 0.8–2.0 |

The parameters at their bounds are findings: the inboard panel stays attached to 28°
and recovers 1.5× its lost leading-edge suction (the strake vortex augmenting it), and
the strake vortex bursts gradually all the way to 88°.

**The leading-edge flap trade-off.** With the flaps' separation gain at 0.1, lift
matched the figures but the outboard panels reached their break at the 25° AoA limit:
Clp collapsed from −0.29 to about 0, and a rolling pull overshot the limiter to 34–40°.
At 0.5–0.7 the limiter held, but before recalibration lift at the limit was ~0.33 too
high. The gain is 0.5, and calibration with the flaps on schedule takes the extra lift
back. Weighting lift over roll damping in that fit (Clp weight 0.1 instead of 0.3)
lands the outboard break near 18° and Clp collapses again. The reference `CLDlef`
increment, about 0.03 per radian of droop, is far smaller than FM3's; whether the base
tables already include scheduled flaps is not settled.

## Validation

**Reference data.** JSBSim's `f16.xml` (Stevens & Lewis tables from TP-1538, α −10..45°)
is gone from the tree; `tools/fm3/extract_f16_reference.mjs` pulled its tables from git
history into `reference/f16Tables.ts`. TP-1538's figures 9, 10 and 44 and its
pitch-rocking results were read off the report by eye (±0.02 in the coefficients) into
`reference/tp1538.ts`. Nothing flies from either.

### Wind tunnel

`tools/fm3/windTunnel.ts` at 60 m/s, sea level, leading-edge flaps on schedule. Each
cell is FM3 / reference table.

| α | C_L | C_D | C_m, δh 0 | C_m, δh +25° |
|---|---|---|---|---|
| 0° | 0.06 / 0.10 | 0.015 / 0.021 | 0.00 / −0.01 | −0.24 / −0.18 |
| 10° | 0.72 / 0.73 | 0.09 / 0.10 | 0.03 / −0.01 | −0.20 / −0.20 |
| 20° | 1.40 / 1.33 | 0.29 / 0.35 | 0.04 / 0.01 | −0.13 / −0.16 |
| 25° | 1.71 / 1.55 | 0.44 / 0.58 | 0.04 / 0.00 | −0.10 / −0.17 |
| 30° | 1.98 / 1.74 | 0.60 / 0.83 | 0.03 / 0.01 | −0.06 / −0.10 |
| 40° | 1.78 / 1.82 | 1.00 / 1.33 | 0.02 / −0.01 | 0.00 / −0.04 |
| 45° | 1.74 / 1.67 | 1.29 / 1.48 | 0.02 / 0.03 | 0.01 / −0.01 |

Past the tables, C_m with full nose-down stabilator against TP-1538 figure 10: 0.02 /
0.02 at 50°, 0.04 / 0.03 at 55°, 0.03 / 0.00 at 60°, −0.03 / −0.05 at 65°, −0.12 / −0.10
at 70°, −0.35 / −0.45 at 80°, −0.47 / −0.53 at 90°. It crosses zero at 62° with a
negative slope — TP-1538's "weak but stable trim point at α = 60°".

| α | C_nβ | C_lβ | C_lp | C_nr | C_mq (static) |
|---|---|---|---|---|---|
| 10° | 0.20 / 0.22 | −0.13 / −0.18 | −0.34 / −0.38 | −0.32 / −0.37 | −3.3 / −6.1 |
| 20° | 0.17 / 0.15 | −0.20 / −0.25 | −0.36 / −0.33 | −0.30 / −0.55 | −3.7 / −5.7 |
| 25° | 0.16 / 0.08 | −0.22 / −0.24 | −0.37 / −0.29 | −0.28 / −0.58 | −3.9 / −6.0 |
| 30° | 0.12 / 0.05 | −0.35 / −0.17 | −0.25 / −0.23 | −0.26 / −0.60 | −3.9 / −6.2 |
| 35° | −0.26 / −0.16 | −0.76 / −0.09 | +0.48 / −0.21 | +0.29 / −0.64 | −3.7 / −6.4 |
| 45° | −0.20 / −0.38 | −0.21 / −0.17 | −0.21 / −0.10 | +0.04 / −0.84 | −3.9 / −6.0 |

Directional stability turns unstable between 30° and 35°, against the reference's 33°.

Pitch damping by forced oscillation (Cmq + Cmα̇, ±5° at 0.8 rad/s, stabilator +25°):
−2.8 at 30°, −3.2 at 40°, −6.2 at 50°, −1.8 at 60°, −0.5 at 70°, −0.8 at 80°.

### Handling

`tools/fm3/stepResponses.ts`, limiters on:

| Altitude, speed | Trim α | ½-stick step: peak / settled g | Full aft | Full forward | Full roll: peak rate, time to 90° | Full pedal: β |
|---|---|---|---|---|---|---|
| 1,000 m, 120 m/s | 3.9° | 3.15 / 3.14 (1%) | 7.1 g, α 24.8° | −1.3 g | 212°/s, 0.83 s | 12.0° |
| 1,000 m, 200 m/s | 1.0° | 3.42 / 3.20 (10%) | 8.9 g, α 13.0° | −2.9 g | 198°/s, 0.64 s | 13.0° |
| 5,000 m, 150 m/s | 4.1° | 3.11 / 3.10 (0%) | 7.1 g, α 26.3° | −1.0 g | 228°/s, 0.83 s | 12.0° |
| 5,000 m, 250 m/s | 0.9° | 3.44 / 3.19 (11%) | 8.7 g, α 15.6° | −2.9 g | 213°/s, 0.62 s | 12.9° |
| 9,000 m, 250 m/s | 2.0° | 3.28 / 3.17 (5%) | 7.9 g, α 24.7° | −1.7 g | 237°/s, 0.65 s | 12.5° |
| 3,000 m, 330 m/s | 0.0° | 3.52 / 3.20 (14%) | 9.2 g, α 7.1° | −3.4 g | 185°/s, 0.63 s | 12.2° |

### Post-stall scenarios

`tools/fm3/scenarios.ts`, CG 0.35 c̄ unless noted:

| Scenario | FM3 | TP-1538 |
|---|---|---|
| Deep stall from equilibrium at 9,144 m, full nose-down stick, limiters off | α 54–67° for 16 s; sideslip swings grow to ±48° and it falls out at ~20 s | α about 60° (50–70°) for a minute; sideslip ±20–27°, dying away |
| Rolling at α 20°, limiters off, CG 0.375 c̄ | pitches out to α 86° within 5 s, sideslip ±45° | pitch departure through inertia coupling |
| The same, limiters on | α ≤ 25°, sideslip ≤ 15°, roll rate builds to 178°/s | no departure |
| Full aft and full roll at 100 m/s, limiters on | α 22–25° for 20 s, sideslip ≤ 19° | — |
| Full aft, full pedal, opposite roll, limiters on | α ≤ 29°, sideslip ≤ 22°, no departure | resistant to the yaw departure |
| Vertical at 60 m/s, idle | the airflow reverses (α 178°), the nose falls through, 121 m/s in a dive after 20 s | — |
| A 100°/s rotation seeded at α 70°, pro-spin controls held | a developed flat spin: α 70–87°, 40–95°/s about the vertical, nose within 20° of level, 75 m/s down, holding for the full 40 s at the reference CG | — |
| Cross-controls from level flight: full aft, full rudder, opposite aileron | winds into that spin at 0.40 c̄; at 0.35 c̄ the departure tumbles instead. Anti-spin controls, neutral controls and the limiters all fail to recover it | — |
| Pitch rocking out of the deep stall | not reproduced (see *Known gaps*) | recovery in 8 s when well phased |

### Tests

52 tests in eight files, about a second under `node --import tsx`:

- `physics/fm3/*.test.ts`: axis mapping and FM2 polarities; rigid-body conservation,
  fourth-order convergence, precession and NaN rollback; section forces over ±180°,
  hysteresis, Prandtl–Glauert and Glauert flaps; lifting line against Helmbold's lift
  slope, near-elliptic induced drag, roll damping and no ringing; F-16 control and
  stability signs.
- `physics/model/fm3FlightModel.test.ts`: runway rest, cruise, a hard pull inside the
  limits, roll rate, pedal, 30 s of random stick.
- `physics/model/fm3PostStall.test.ts`: the deep-stall trim, forced-oscillation pitch
  damping at 50–80°, 10 s in the deep stall, the AoA limit while rolling, departure
  resistance under cross-controls, the roll-coupling departure with the limiters off
  (and none with them on), the tail slide, determinism.
- `physics/sim/combatSim.fm3.test.ts`: an airborne and a grounded FM3 player in the
  combat sim, and an in-flight FM2↔FM3 swap.

The full `npm test` has no failures other than those present before FM3, compared by
test name.

## Known gaps

- **Lateral-directional stability above 30°.** With the flaps down the outboard panels
  break near 35°, where roll and yaw damping reverse (Clp +0.48 and Cnr +0.29 against
  −0.21 and −0.64). At 60–70° C_lβ turns positive — the inboard wing's vortex lift and
  the strake breakdown asymmetry in sideslip — so C_nβ,dyn is strongly negative at the
  deep-stall trim. The reference tables stop at 45°, so there is nothing to fit it
  against. This is why FM3's deep stall falls out sideways after ~20 s where
  TP-1538's held.
- **Spin entry.** A developed flat spin is a stable attractor at every CG — α ~80°, ~95°/s about the vertical, 75 m/s down — and nothing recovers it: opposite rudder, forward stick, neutral controls and switching the limiters back on all leave it spinning through 4 km. Entering one from level flight, though, only works with the CG at 0.40 c̄; at the reference 0.35 c̄ the departure tumbles rather than organising into autorotation. That asymmetry is the high-α lateral gap above, not a separate mechanism.
- **Drag** is about a quarter low at 25–40° (0.60 against 0.83 at 30°). The fit has no
  drag term, so hard turns bleed less energy than they should.
- **Lift with the flaps down** is up to 0.17 above figure 9 at 25–30°.
- **Pitch.** Static Cmq is about 40% low (−3.9 against −6.0), and full nose-down
  authority at 20–35° is about 0.05 short of the tables.
- **Side force.** C_Yβ is 60% of the reference below 30° and near zero at 35–45°.
- **Limiter overshoot.** Full cross-controls take α to 29° against the 25° limit.
- **Pitch rocking** is not reproduced: the aircraft leaves the deep stall on its own
  before rocking can be judged.
- **Not modelled:** forebody vortex asymmetry, Reynolds-number effects, rotor momentum
  varying with spool.
- **Cost:** 33–49 µs per step bundled, depending on machine load (FM2: 2 µs).
- **Every aircraft flies the F-16's aerodynamics.**

## Tools

All physics tools run bundled:

```
node_modules/.bin/esbuild tools/fm3/<tool>.ts --bundle --platform=node --outfile=<tmp>/<tool>.cjs
node <tmp>/<tool>.cjs [args]
```

| Tool | What it does |
|---|---|
| `windTunnel.ts` | Coefficients against the reference tables; lateral derivatives; damping; per-component moment and normal force; per-strip state at 20/35/60°; the 45–90° sweep; forced-oscillation pitch damping |
| `calibrate.ts [samples] [rounds]` | Seeded random search, then coordinate descent over `F16AeroParams`; prints the block for `f16Airframe.ts` (about 4 minutes at 400 samples, 5 rounds) |
| `stepResponses.ts` | FCS metrics at six flight conditions, plus a limiters-off deep-stall entry |
| `scenarios.ts [name]` | Post-stall time histories: `deepstall`, `entry`, `rocking`, `rocking35`, `coupling`, `coupling2`, `yaw`, `tailslide`, `flatspin`, `flatspinentry` |
| `bench.ts` | FM2 against FM3, µs per step |
| `extract_f16_reference.mjs` | Regenerates `reference/f16Tables.ts` from git history |

Time and profile only bundled builds.

## Deviations from the plan

- **Gear contact was not extracted from FM2.** FM3 has its own (`groundContact.ts`) and
  FM2 was not touched, so the golden-trajectory guard was not needed.
- **Fewer files.** Separation lives in `sectionAero.ts`; surfaces, induced flow, wake,
  strakes and bodies in `aeroModel.ts`. There is no `atmosphere.ts` (no Reynolds
  number), no `trim.ts` (an airborne spawn settles the aerodynamic states and trims the
  pitch integrator) and no `linearise.ts`.
- **Reference data** are the extracted Stevens & Lewis tables and figures read by eye,
  not TP-1538's appendix tables; there are no lateral or rate data above 45°.
- **The menu** is the Angular settings dialog, not `index.html` radios.
- **Cost** is 33–49 µs per step bundled against the 25 µs budget; RK4 stayed.
- **Calibration** grew roll-damping and forced-oscillation pitch-damping terms, and fits
  with the leading-edge flaps on schedule.
- **Not done:** forebody vortex asymmetry; FM3 takeoff, carrier trap and wingtip-scrape
  tests; the ten-minute fuzz (the test fuzzes 30 s); per-airframe geometry for other
  aircraft.

## Milestones

| # | Milestone | State |
|---|---|---|
| M0 | Guardrails | Test baseline compared by name; bench; reference data. No FM2 goldens (FM2 untouched) |
| M1 | Rigid body | Done |
| M2 | Plumbing | Done, without the gear extraction. The swap now re-pushes the collision mesh; the other planning-time bug (a model outside the sim leaving the player enabled) cannot occur, since every model in the menu runs in the sim |
| M3 | Sections | Done |
| M4 | Surfaces | Done |
| M5 | Bodies, vortex lift, propulsion, controls | Done |
| M6 | F-16 airframe + wind tunnel | Done; see *Known gaps* for what misses the plan's bands |
| M7 | FCS | Done, tuned on step responses rather than modal analysis |
| M8 | Post-stall, robustness, performance | Post-stall tests in; performance over budget |
| M9 | Polish | HUD label, README; no separation colouring on the force-vector overlay |
| M10 | Other airframes, AI opt-in | Not started |

## References

- Nguyen et al., *Simulator Study of Stall/Post-Stall Characteristics of a Fighter
  Airplane With Relaxed Longitudinal Static Stability*, NASA TP-1538, 1979 —
  <https://ntrs.nasa.gov/citations/19800005879>.
- Stevens & Lewis, *Aircraft Control and Simulation* (F-16 model).
- Garza & Morelli, *A Collection of Nonlinear Aircraft Simulations in MATLAB*,
  NASA TM-2003-212145, 2003 — <https://ntrs.nasa.gov/citations/20030013626>.
- Leishman & Beddoes, "A Semi-Empirical Model for Dynamic Stall", *Journal of the
  American Helicopter Society*, 1989.
- Goman & Khrabrov, "State-Space Representation of Aerodynamic Characteristics of an
  Aircraft at High Angles of Attack", *Journal of Aircraft*, 1994.
- Polhamus, NASA TN D-3767, 1966 — the leading-edge suction analogy.
- Allen & Perkins, NACA TR-1048, 1951 — viscous crossflow on slender bodies.
- Jorgensen, NASA TR R-474, 1977 — slender bodies to very high angles of attack.
- Silverstein, Katzoff & Bullivant, NACA TR-651, 1939 — wake and downwash.
- Phillips & Snyder, "Modern Adaptation of Prandtl's Classic Lifting-Line Theory",
  *Journal of Aircraft*, 2000.
- MIL-F-8785C, *Flying Qualities of Piloted Airplanes*, 1980.
