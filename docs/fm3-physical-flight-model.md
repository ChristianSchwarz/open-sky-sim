# FM3 — Physical Flight Model

> **Status: planned 2026-09-11, no code yet.** A fourth entry for the settings
> menu's *Flight model* list, next to FM2 and Debug.

A 6-DOF rigid body in which every force comes from a physical mechanism at its
real location:

- lifting surfaces cut into spanwise strips, with section aerodynamics that hold
  over the full ±180°
- a slender-body fuselage
- leading-edge vortex lift
- a wing wake that the tail can sit in

With those in place, stall, departure, deep stall, spins and tail slides are
computed rather than scripted. It is to be validated against the F-16
wind-tunnel data of NASA TP-1538, which runs to 90° angle of attack.

## Why a third model

FM2 is already a rigid body with lift built up from surfaces, and it flies well
inside the envelope. Past stall it stops being physics:

| FM2 today | Where | Consequence past stall |
|---|---|---|
| Diagonal inertia; the Ixz product dropped | `fm2Constants.ts:40-52` | no inertial roll↔yaw coupling |
| Angular rate clamped to 6 rad/s | `rigidBody.ts:77-81` | spins, tumbles and snap rolls are cut off |
| Explicit Euler on ω | `rigidBody.ts:68-75` | adds energy to torque-free rotation |
| 9 surfaces, one force point each; spanwise flow discarded; all panels at y = 0 | `aeroSurface.ts:113-115`, `fm2Constants.ts:127-318` | no sweep or sideslip effects, no dihedral, no tip-first stall, no autorotation |
| Curve shapes tuned, not derived: a flat-plate blend, a vortex "bump" peaking at 50°, a stalled tail's damping scaled by 0.7 "to arrest the cobra apex" | `aeroSurface.ts:186-300`, `fm2Constants.ts:289` | post-stall moments are whatever the tuning made them |
| Separation lag in fixed seconds | `aeroSurface.ts:138-144` | the same lag at 100 kt and at 500 kt |
| No downwash, wake or ground effect | — | no Cmα̇ damping, no tail blanketing, no deep-stall mechanism |
| Mach only adds drag at the CG above M 0.95; thrust acts through the CG | `fm2FlightModel.ts:433-436, 650-665` | no compressibility effect on lift or moments; no thrust-line moment |
| Pitch damping added in transonic flight to suppress an FCS limit cycle | `fm2FlightModel.ts:568-590` | a non-physical Cmq term |
| Lateral asymmetry only through an opt-in "laminar" switch, off by default | `fm2FlightModel.ts:535-566` | nothing drives a lateral departure; a hard pull stays symmetric by test (`fm2FlightModel.test.ts:867`) |
| Limiters off = raw stick, no damping | `fcs.ts:209-214` | |

JSBSim's F-16 is table-driven from the same NASA report, but has three limits:

- its tables stop at 45° (`assets/jsbsim/aircraft/f16/f16.xml`)
- it flies one airframe on a flat world
- it runs outside the combat sim, so the player has no gun and takes no damage

FM3 replaces neither model, and FM2 stays bit-exact (milestone M0 pins that).

## Decisions

1. **Aerodynamics from geometry, not coefficient tables.** Every aircraft in the
   menu can be described by planforms and a fuselage; only the F-16 has tables.
   The tables *validate* FM3 and never drive it.
2. **FM3 runs inside the combat-sim worker, beside FM2.** The gun, damage, carrier
   decks, arrestor wires and AI targeting all live in `CombatSim`; anywhere else
   the player loses them.
3. **Player only at first.** AI stays on FM2, because its pilots are tuned to FM2's
   behaviour (`aiPilot.ts:128-176`, `shaw/flightControlComputer.ts:24`). The model
   kind becomes per-aircraft in the protocol, so AI can move later.
4. **FM3 gets its own flight control system.** FM2's pitch laws use angle of attack
   only to fade stick authority near the limit, never as stabilising feedback
   (`fcs.ts:301-359`). An F-16 built from real geometry at its real CG has relaxed
   static stability — the premise of TP-1538 — and needs that feedback.
5. **No scripted terms.** Every tuning knob is a physical parameter with a stated
   range (section break angle, tail efficiency, crossflow drag coefficient…).
   Nothing is keyed to an angle-of-attack window, a manoeuvre or a speed band.
6. **The default airframe is the F-16**, because it is the one we can check. Every
   aircraft flies it until per-aircraft geometry lands. That matches FM2 today: all
   57 packs have `flight: null` and fly `defaultFm2Config`.

## Where it runs

```
menu radio ─► ConfigService.flightModels ─► SimProxyFlightModel(combatSim, 'player', 'fm3')
                                                 │  reset / setAircraftConfig { model: 'fm3' }
                                                 ▼
                      combat-sim worker:  CombatSim ─► createFlightModel(kind, config)
                                                 │         ├─ 'fm2'   → Fm2FlightModel
                                                 │         ├─ 'debug' → Fm2FlightModel { kinematic }
                                                 │         └─ 'fm3'   → Fm3FlightModel
                                                 ▼
                      carrier, arrestor, guns, AI pilots — unchanged
```

`SimAircraft.model` becomes an interface, `SimFlightModel`: `FlightModel` plus the
six methods `CombatSim` calls on FM2 today (`combatSim.ts:232, 449, 1212, 1294,
1367, 1379`):

- `setWorldQuery`
- `getForceVectorSnapshot`
- `clearAngularVelocity`
- `getGearCompressionMean`
- `contactSpeedIntoNormal`
- `applyContactDragAt`

## Code layout

```
src/script/physics/fm3/
  frames.ts            sim body axes ↔ NASA body/stability axes (validation and FCS only)
  rigidBody6.ts        full inertia tensor, engine angular momentum, RK4
  atmosphere.ts        aeroUtils ISA + Sutherland viscosity → Reynolds number
  sectionAero.ts       2-D section forces over ±180°, compressibility
  separation.ts        Goman–Khrabrov separation state
  liftingSurface.ts    planform → strips; control segments
  inducedFlow.ts       lifting line, lagged circulation, tail downwash delay, ground effect
  wake.ts              wing wake over the tail (Silverstein–Katzoff)
  vortexLift.ts        LERX/strake vortex lift and breakdown (Polhamus)
  bodyAero.ts          fuselage stations: slender body + viscous crossflow, forebody asymmetry
  propulsion.ts        thrust at the nozzle, spool lag, rotor angular momentum
  actuators.ts         position and rate limits, first-order lag
  fcs.ts               FM3 control laws
  trim.ts              trim solver (tests, airborne spawn, FCS design)
  fm3Airframe.ts       schema + the default F-16 airframe
  reference/tp1538.ts  transcribed NASA TP-1538 tables, cited by table number
src/script/physics/contact/gearContact.ts   extracted from FM2, shared by both models
src/script/physics/model/fm3FlightModel.ts  the FlightModel subclass assembling the above
tools/fm3/                                  linearise.ts, windTunnel.ts, bench.ts
```

Inner loops run on preallocated `Float64Array`s: no per-strip objects, no
`THREE.Vector3` method calls, no allocation per step.

## The physics

All state and forces live in the sim body frame (+X right, +Y up, +Z forward), with
FM2's control polarities unchanged. `frames.ts` is the only place that converts to
the NASA convention (x forward, y right, z down), and only for validation and the FCS.

Derive that mapping in a test, from FM2's measured polarities, before comparing
anything against NASA coefficients. The sim labels its frame `RIGHT × UP = FORWARD`,
which makes a backwards sign easy to miss.

### One step

Each fixed 1/120 s step (`flightModel.ts:6`):

1. **Controls.** Spool the engine. The FCS reads last step's sensors and produces
   surface commands, which go through the actuators.
2. **Slow aero states.** Advance them once, with exact first-order updates:
   separation per strip, LERX vortex breakdown, strip circulation, the wake-delay
   buffer.
3. **Terrain.** Sample it once per gear leg, reducing it to a height and normal:
   a local plane.
4. **Integration.** RK4 on position, velocity, orientation and body rates. Each
   stage evaluates:
   - aerodynamics, with the step-2 states frozen
   - thrust
   - gear forces against the step-3 planes
   - gravity and the gyroscopic terms
5. **Finish.**
   - Normalise the quaternion.
   - Run the NaN guard: on a non-finite state, restore the previous step and raise
     a flag. It never clamps.
   - Shared contact post-processing: penetration, crash rules.
   - Publish telemetry.

### Rigid body

```
m · v̇ = R(q) · F_body + F_contact + m · g
I · ω̇ = M − ω × (I · ω + h_engine)        full symmetric inertia tensor
q̇     = ½ · q ⊗ (0, ω)
```

- **Inertia sign.** The tensor is transformed from the source's axes, product of
  inertia included. Sources disagree on its sign convention: JSBSim's `f16.xml`
  lists Ixz = −982 slug·ft², TP-1538 Table I gives +982. A test pins the tilt of the
  principal axis.
- **No angular-rate limit.**
- **Cost budget.** RK4 costs four aerodynamic evaluations per step. The budget is
  25 µs per step, bundled: about 10× FM2's measured 2.4 µs, or about 3 ms per
  simulated second per aircraft.
- **Fallback.** If that doesn't fit, use Heun's method (2 evaluations).

### Section aerodynamics

For each strip, the local air velocity is

```
u = v_air + ω × r − w_induced
```

resolved into the plane normal to the local quarter-chord line (simple sweep
theory). Sideslip therefore changes each wing half's effective sweep, and the
dihedral effect falls out. The section angle α runs the full ±180°.

Normal and chordwise force coefficients follow the Kirchhoff / Leishman–Beddoes
model:

```
C_N = C_Nα · sin(α − α₀) · ((1 + √f) / 2)²
C_C = η · C_Nα · sin²(α − α₀) · √f
```

`f` ∈ [0, 1] is the trailing-edge separation point (1 = attached). Its static curve
is the Leishman–Beddoes exponential form: a break angle α₁ and two widths. Flaps
and leading-edge flaps shift α₁ and α₀.

- **Full separation.** As `f` → 0 the normal force hands over to a flat plate,
  `C_N = C_D90 · sin α / (0.56 + 0.44·|sin α|)` (Lindenburg), with C_D90 corrected
  for aspect ratio.
- **Pitching moment.** The centre of pressure moves from quarter- toward mid-chord
  as the flow separates, so stall changes the pitching moment on its own.
- **Reverse flow.** Past ±90° the section flies backwards: sharp leading edge, no
  suction, mirrored camber.
- **Induced drag.** Lift and drag are C_N and C_C resolved into the local wind.
  Induced drag needs no formula: it appears because the induced velocity tilts that
  wind.
- **Compressibility.** Uses the Mach number normal to the sweep line:
  - Prandtl–Glauert on C_Nα up to about M 0.8, with a smooth bridge to the
    supersonic 4/√(M² − 1)
  - α₁ falling with Mach
  - wave drag from the Korn equation with Lock's fourth-power rise

### Unsteady separation

Separation cannot follow α instantly (Goman & Khrabrov):

```
τ₁ · ḟ + f = f_static(α − τ₂ · α̇)        τ₁ = k₁ · c/V,   τ₂ = k₂ · c/V
```

- **Why c/V scaling.** FM2's fixed-seconds lag lacks it; with it, the same pull
  delays stall more at low speed.
- **Initial constants.** k₁ and k₂ start from the Leishman–Beddoes airfoil constants
  (T_f ≈ 3 semichords) and are then fitted to TP-1538's forced-oscillation data.
- **What it produces.** Dynamic lift overshoot, stall hysteresis, and the loss of
  damping behind wing rock.

### Lifting surfaces and induced flow

Each surface (wing, horizontal tail, fin, LERX, ventral fins) is a planform:

- root and tip leading edges, chords and twist
- cut into 8–16 strips per side, spaced closer toward the tips (cosine spacing)
- control segments covering a span range and chord fraction, or the whole surface
  when all-moving

The induced flow:

- **Induced velocity.** A Weissinger-style lifting line with horseshoe vortices on
  the quarter-chord line. The influence coefficients depend only on geometry and
  are precomputed at load.
- **Circulation.** It relaxes toward its nonlinear value with a time constant of
  order c/V instead of being solved exactly each step. That lag is the physical
  build-up of the wake (Wagner). It also stops the post-stall solution jumping
  between branches, and it is stable at 120 Hz.
- **Downwash at the tail.** It comes from the wing's trailing vortices, using the
  circulation from one wake-transport time l_t/V ago (a ring buffer). That delay is
  the physical source of Cmα̇ damping.
- **Wake direction.** The trailing vortices follow the freestream at high α. The
  wing-on-tail influence is tabulated over wake angles and interpolated.
- **Ground effect.** Image vortices, approximated by a height factor per strip. Near
  the runway lift rises and tail downwash falls.

### Wake over the tail

- **Tracking.** The separated wing/LERX wake is followed along the freestream from
  the trailing edge.
- **Shape.** Width and centreline dynamic-pressure deficit follow Silverstein and
  Katzoff (NACA TR-651), driven by each strip's current section drag. A deep-stalled
  wing makes a wide, slow wake.
- **Effect.** When the horizontal tail sits inside that wake, its pitch authority
  collapses. That is the mechanism for a deep-stall trim; nothing tells the model to
  have one.

### Leading-edge vortex lift

Strakes and LERX add vortex lift by the Polhamus leading-edge-suction analogy (NASA
TN D-3767): a normal force K_v·sin²α on the strake planform, far ahead of the CG.

- **Breakdown.** As α rises, vortex breakdown moves up the strake, starting at an
  angle set by the sweep. It lags with its own c/V time constant.
- **Sideslip.** Each side's effective sweep changes, so windward and leeward break
  down at different angles. That produces rolling moments without a special case.

This replaces FM2's `foreStrake` vortex bump.

### Fuselage

The fuselage is 15–25 stations with elliptical cross-sections. At each station the
local velocity, including ω × r, splits into axial and crossflow parts:

- **Potential normal force.** From the rate of change of cross-section area
  (slender-body theory, in Jorgensen's high-α form, NASA TR R-474). Summed along the
  body it gives the destabilising Munk moment.
- **Viscous crossflow.** `½ρ·u_c²·d·C_dc·η` (Allen & Perkins, NACA TR-1048), with
  C_dc set by the crossflow Reynolds and Mach numbers. This is the dominant body
  force at high α. Because each station uses its own ω × r, it also supplies the
  fuselage's yaw damping in a spin.
- **Axial force.** Turbulent skin friction on the wetted area, plus base drag.
- **Forebody vortex asymmetry.** FM2's Ericsson model (`forebodyAsymmetry.ts`), with
  its regime chosen by the actual Reynolds number. `setForebodyLaminar(true)` still
  forces the laminar case.

### Controls

- **Actuators.** Position limit, rate limit, first-order lag. F-16 position limits
  from TP-1538 Table I; rates and lag from Stevens & Lewis:
  - stabilator ±25° symmetric plus ±5.375° differential per surface, at 60°/s
  - ailerons (flaperons) ±21.5° at 80°/s
  - rudder ±30° at 120°/s
  - lag 1/20.2 s
- **Deflections.**
  - All-moving surfaces rotate their strips' chord lines.
  - Hinged surfaces change camber through Glauert's flap effectiveness τ(c_f/c),
    which fades at large deflections and in separated flow.
- **Leading-edge flaps.** The F-16's follow the Stevens & Lewis schedule on α and
  q̄/p_s, raising the section break angle.
- **Bluff-body drag.** The speedbrake and each gear leg produce drag at their own
  positions, so they change the trim the way the real ones do.

### Propulsion

- **Thrust line.** Thrust acts at the nozzle, along its axis, so any offset makes a
  moment.
- **Magnitude.** Unchanged: `computeF16EngineThrustN`, so the afterburner quadrant,
  HUD, audio and detents are all unchanged.
- **Spool.** Follows the Stevens & Lewis F100 power-lag model instead of FM2's fixed
  0.10/s ramp.
- **Rotor.** Its angular momentum enters the rotational equation, scaled by spool.
  TP-1538 held it at a fixed 216.9 kg·m²/s (160 slug·ft²/s); validation runs do the
  same.

### Ground contact

FM2's gear code moves to `physics/contact/gearContact.ts`, used by both models
(`fm2FlightModel.ts:182-205, 667-869`):

- spring-damper legs and tyre footprint sampling
- terrain normals and friction
- the penetration clamp and the parked-creep clamp
- the crash rules

Before the move, record FM2 golden trajectories; the move lands only if they stay
bit-exact.

### What should emerge

None of this is coded as a behaviour; each item is a test that the physics produces
it:

- stall break, tip-first stall on a swept wing, and wing drop in sideslip
- the F-16's pitch-up past the lift peak, and its deep-stall trim. TP-1538 reports
  "a weak but stable trim point at α = 60°" even with the stabilators at full
  nose-down.
- pitch departures from inertia coupling in rapid, large rolls at low airspeed, and
  resistance to the classical yaw departure (both TP-1538)
- autorotation under pro-spin controls on airframes that have it
- tail slides, falling leaf, wing rock
- ground effect in the flare, and trim changes from gear, flaps and speedbrake

## Aircraft data

`Fm2AircraftConfig` gains an optional `fm3` block. The whole path is unchanged: the
manifest's `flight` field, `flightConfigWithArrestorHook`, and the worker messages.
Gear, engine, envelope and hook still come from the FM2 part. With no `fm3` block,
FM3 uses the default F-16 airframe.

```ts
interface Fm3Airframe {
    reference: { areaM2: number; spanM: number; chordM: number; momentRef: Vec3 };
    mass: { massKg: number; cg: Vec3; inertia: SymmetricTensor }; // sim axes, SI
    sections: Record<string, SectionFamily>;  // C_Nα, α₀, α₁/S1/S2, cd0, C_D90, k₁, k₂
    surfaces: LiftingSurface[];               // planform, strip count, section, control segments
    bodies: SlenderBody[];                    // stations [z, width, height]
    vortexLift?: LeadingEdgeVortex[];
    engines: Engine[];                        // nozzle position, axis, rotor momentum
    controls: ControlSurface[];               // limits, rates, lag
    drag: { miscCd0: number; gearLegs: BluffBody[]; airbrake?: BluffBody };
    fcs: Fm3FcsConfig;
}
```

Positions are measured from a fixed datum, not from the CG, so moving the CG changes
the static margin by itself.

**Default F-16.**

- **Mass, inertia, reference geometry.** From TP-1538 Table I; Stevens & Lewis
  reuse the same numbers:
  - S = 27.87 m² (300 ft²), b = 9.144 m (30 ft), c̄ = 3.45 m (11.32 ft)
  - reference CG at 0.35 c̄, where TP-1538 flew most runs; it went as far aft as
    0.39 c̄
  - W = 91,188 N (20,500 lb)
  - Ix / Iy / Iz / Ixz = 12,875 / 75,674 / 85,552 / 1,331 kg·m²
    (9,496 / 55,814 / 63,100 / 982 slug·ft²), in NASA body axes
  - engine angular momentum 216.9 kg·m²/s (160 slug·ft²/s), from appendix B
- **Schedules.** Actuator rates and lags and the leading-edge-flap schedule come from
  Stevens & Lewis.
- **Planforms and fuselage stations.** Authored from a public three-view; none is in
  the repo. The wing section is NACA 64A204.
- **Mass gap.** The validation mass is about 9,300 kg, while FM2 flies at 13,608 kg.
  Heavier loadings come later as `mass` variants.

**Other aircraft (M10).** Two sources exist that nothing reads yet:

- **TCA mod zips.** They carry per-airframe mass, wing area, span, thrust, critical
  AoA and gear springs in `Data/Aircraft2/*.json`. 16 of the 82 files contain `//`
  comments that `parseJsonLoose` (`tools/modserver.ts:209-214`) does not strip.
- **Manifests.** They carry control-surface hinge positions, wingtip and nozzle
  points, and a collision mesh (5,462 triangles on the Su-33) that can be sliced into
  planforms and fuselage sections.

The importer would derive an `fm3` block from both.

## Flight control system

Separate from FM2's; `fm2/fcs.ts` is not touched. The laws follow the F-16's
published structure:

- **Pitch.**
  - g command, blended with a pitch-rate command at low dynamic pressure
  - proportional-integral action on the g error
  - pitch-rate and angle-of-attack feedback; the AoA feedback gives the unstable
    airframe apparent static stability
  - above the AoA limit, the AoA feedback rises sharply (the limiter); the
    negative-g limiter mirrors it. TP-1538's basic control system held 25°, and its
    limiter depended on the nose-down control moment that is left at high α. That
    moment is what the deep stall takes away.
- **Roll.** Roll-rate command, scheduled on dynamic pressure and faded with AoA.
- **Yaw.** Washed-out yaw damper, aileron-rudder interconnect scaled with AoA, and
  rudder authority faded at high AoA. TP-1538's roll/yaw augmentation had the same
  parts (roll-rate command, stability-axis yaw damper, interconnect), plus automatic
  spin prevention above 29° AoA. FM3 includes that too, active with the limiters on.
- **`L` (limiters off).** Removes the AoA and g limiters and the roll fade but keeps
  stability augmentation. The aircraft stays flyable and can reach deep stall,
  roughly the F-16's manual pitch override. FM2's keys 1/2/3 (limiter strategies)
  have no meaning in FM3.
- **Airframes without fly-by-wire.** Direct stick-to-surface gearing plus an optional
  yaw damper.

**Gain design.** Gains are scheduled on dynamic pressure and designed with
`tools/fm3/linearise.ts`: a numerical Jacobian at trim, then modal analysis.
Acceptance is MIL-F-8785C Level 1, Class IV, Category A:

- short-period damping 0.35–1.30
- roll-mode time constant ≤ 1.0 s
- spiral time to double ≥ 12 s
- Dutch-roll damping and frequency per the specification's Dutch-roll table

**Parallel start.** The FCS is the biggest schedule risk, so start it alongside the
aerodynamics, against a table-driven reference model: FM3's rigid body plus the
TP-1538 coefficient tables. Retune it on FM3 once M6 passes.

## Validation

**Reference data.**

- **Source.** Transcribe the needed TP-1538 tables into `reference/tp1538.ts`, citing
  table numbers:
  - static coefficients against α (−20..90°) and β (±30°)
  - control increments
  - forced-oscillation rate derivatives

  NASA reports are public domain.
- **Cross-check below 45°.** `assets/jsbsim/aircraft/f16/f16.xml` (Hofman, built from
  the same report) is an independent transcription to catch typos. Tests read it;
  nothing is copied from it.
- **What the data leaves out.** The data is low-speed (M 0.1–0.2), which is where
  post-stall flight happens anyway. TP-1538's model also left out Mach, Reynolds and
  aeroelastic effects, and its rate derivatives exist only at zero sideslip.
  Compressibility is therefore checked separately: against theory, and against the
  Mach tables in `f16.xml`.

**A. Pure units.**

- Section forces: continuous and symmetric over ±180°; flat-plate limit at 90°;
  reverse flow correct.
- Goman–Khrabrov: the hysteresis loop opens as oscillation frequency rises and closes
  as it falls to zero.
- Torque-free rigid body:
  - conserves energy and angular momentum over 60 s at 6 rad/s
  - shows the intermediate-axis flip
- RK4 converges at fourth order.
- The axis mapping matches FM2's polarities.

**B. Theory checks.**

- Elliptic wing induced drag within 5% of C_L²/(πA).
- Rectangular wing lift slope within 5% of Helmbold's formula.
- Strip roll damping correct in sign and magnitude.
- Slender body: C_Nα = 2·S_base/S_ref, and a destabilising Munk moment.

**C. Virtual wind tunnel (F-16 against TP-1538).** Hold the aircraft fixed in the
airflow:

1. Sweep α −20..90° at several β.
2. Sweep each control.
3. Run small forced oscillations for the rate derivatives.

A geometry-based model will not match tables exactly, so these are proposed bands:

- C_L within ±0.15 below 25° and ±0.25 above; α at C_Lmax within ±5°; C_N at 90°
  within ±20%.
- C_m has the reference's slope sign in each α band, including the break past the
  lift peak. With full nose-down stabilator, C_m crosses zero with a negative slope
  near α = 60°: TP-1538's weak but stable deep-stall trim point.
- C_nβ changes sign within ±7° of the reference α; C_lβ has the right sign wherever
  the data's sign is clear.
- Rate derivatives have the right sign and are within a factor of 2.

**D. Closed loop.**

- Trims exist across an altitude × Mach grid, with the stabilator inside its limits.
- The MIL-F-8785C bands above hold at each grid point.
- Roll rate reaches the FCS cap.
- The limiters hold AoA and g.
- With limiters off, the aircraft stays controllable inside the normal envelope.

**E. Post-stall scenarios (limiters off unless stated).**

1. **Stall.** Idle, 1 g deceleration through stall; the aircraft recovers when the
   stick is released.
2. **Deep stall.** At a CG of 0.35 c̄, pull past the break at low speed, then hold
   full nose-down stick: AoA settles near 60° and stays there for at least 10 s.
   Then pitch rocking recovers: cycling the stick in phase with the pitch
   oscillation. TP-1538's piloted rocking recoveries at 0.375 c̄ took 8 s when well
   phased, and five cycles over about 30 s when not. The test asserts recovery
   within five cycles at 0.375 c̄.
3. **Inertia coupling.** With limiters off, rapid, large-amplitude rolls at low
   airspeed produce a pitch departure. At 0.375 c̄, TP-1538 recorded a pitch-out to
   α = 76° that ended in the deep-stall trim. At 0.35 c̄ with FM3's roll limiting on,
   the same rolls do not depart.
4. **Yaw departure.** Full-rudder and cross-control inputs inside the normal envelope
   do not produce a classical yaw departure.
5. **Tail slide.** A vertical climb to zero airspeed rotates through with no NaN and
   finite rates.
6. **Fuzz.** Ten minutes of random stick, rudder and throttle from random attitudes:
   no NaN, no guard trips, energy bounded.
7. **Determinism.** Identical inputs give a bit-identical trajectory.

**F. Integration.**

- FM2 golden trajectories stay bit-exact.
- The existing route, wingman and arrestor combat-sim tests are unchanged.
- New tests with the player on FM3:
  - resting on the runway
  - takeoff
  - carrier trap
  - wingtip scrape
  - a mid-session model swap that keeps the collision mesh

**G. Performance.**

- A benchmark bundled with esbuild holds FM3 to 25 µs per step. It must be bundled:
  `node --import tsx` runs this code about 50× slower than the game does.
- `npm test` runs scenarios under tsx, so keep their simulated durations short. At
  that slowdown a 30 s scenario costs about 5 s.

## Menu and plumbing checklist

1. `state/gameDefs.ts:19-23` — add `FlightModels.FM3 = 'FM3'`.
2. `src/index.html:268-282` — add radio `flightmodel-fm3`, labelled "FM3 (Physical)".
   In the help text (105-106), mark keys 1/2/3 as FM2-only.
3. `osd/osdPanel.ts:302-322, 413-417` — add the change listener and the radio id.
4. `index.ts:45-49` — add
   `[FlightModels.FM3]: new SimProxyFlightModel(combatSim, PLAYER_SIM_ID, 'fm3')`.
5. `physics/sim/simTypes.ts:61-77, 157-158` — replace `kinematic: boolean` with
   `model: 'fm2' | 'debug' | 'fm3'` in `SimAircraftDesc` and in the `reset` and
   `setAircraftConfig` messages.
6. `physics/sim/combatSimClient.ts:200-212` and `physics/worker/combatSimWorker.ts`
   — pass `model` through.
7. `physics/sim/combatSim.ts`:
   - type `SimAircraft.model` (130) as `SimFlightModel`
   - call `createFlightModel` at 213, 806 and 838
   - rename `rebuildIfKinematicChanged` (836-848) to `rebuildIfModelChanged`
8. `physics/model/simProxyFlightModel.ts:42-49, 214-219, 258-261` — take the model
   kind.
9. `state/game.ts`:
   - `addAircraft` (2892-2905) sends the active model and derives `enabled` from it
   - the swap listener (656-668) re-pushes the collision mesh after `setAircraft`

   Those are the two existing bugs found while planning; fix them here unless the
   separate task already has.
10. `scene/entities/overlay/hud.ts:651-653` — show FM3's FCS state instead of FM2's
    limiter strategy.
11. `README.md:110-115` — document FM3; this file becomes its design doc.
12. No change needed:
    - `settingsStorage.ts` validates against the enum
    - `configService.ts`
    - `flightRecorder.ts` uses generic getters and records FM3 as `flight-FM3-….json`
    - the AI code

## Milestones

Each milestone ends with its exit criteria passing.

| # | Milestone | Exit |
|---|---|---|
| M0 | **Guardrails.** FM2 golden trajectories; test baseline via `git stash -u`; bundled benchmark; TP-1538 tables transcribed; JSBSim XML reader | goldens bit-exact; reference data loads |
| M1 | **Rigid body.** `frames`, `rigidBody6`, mass properties | suite A rigid-body and axis tests |
| M2 | **Plumbing.** `SimFlightModel`, factory, protocol kind, menu entry marked experimental, gear-contact extraction, swap-bug fixes. FM3 v0 = rigid body + gear + thrust + flat-plate drag | select FM3; spawn on runway and carrier; taxi; swap mid-session; gun and damage work; all existing tests unchanged |
| M3 | **Sections.** `sectionAero`, `separation`, compressibility | suite A section tests |
| M4 | **Surfaces.** Strips, lifting line, downwash delay, wake, ground effect | suite B |
| M5 | **Bodies, vortex lift, propulsion, controls** | slender-body checks; control and thrust-moment signs |
| M6 | **F-16 airframe + wind tunnel** | suite C, reached by changing physical parameters only |
| M7 | **FCS, trim, handling qualities** (started early against the table reference model) | suite D |
| M8 | **Post-stall, robustness, performance** | suites E and G |
| M9 | **Polish.** Per-surface force-vector overlay coloured by separation; β on the telemetry graph; HUD label; README; drop "experimental" | manual flight checklist on the dev server: takeoff, aerobatics, stall, deep stall and recovery, carrier trap |
| M10 | **Other airframes, AI opt-in** (follow-on) | importer derives `fm3` for mods; each derived airframe trims, and stalls within ±5° of its critical AoA |

## Risks

- **Lifting line past stall.** With a negative lift slope, the spanwise solution can
  zig-zag or jump between branches. The lagged circulation and separation states
  damp this out; add spanwise smoothing if a test shows oscillation.
- **Matching tables with geometry.** Strip theory misses some interference effects:
  inlet, strake–wing, tail–body. Allow a short list of named physical corrections
  with documented ranges. Accept the bands rather than chasing the tables with
  α-keyed terms.
- **FCS schedule.** A relaxed-stability airframe won't fly until the FCS does, hence
  the parallel start in M7.
- **Sign conventions.** Sim axes, NASA axes and JSBSim's Ixz sign all differ. Keep
  every conversion in `frames.ts`, pinned by M1 tests.
- **Branch hygiene.** `terrain-rewrite` carries unrelated uncommitted work and a
  growing count of pre-existing test failures. Build FM3 on its own branch from a
  clean base.

## Open questions

- Player-only to start, with AI staying on FM2 — acceptable?
- Should `L` keep stability augmentation in FM3 (proposed), or be raw stick as in FM2?
- The menu's default aircraft is the F-22. In FM3 it would fly F-16 aerodynamics,
  exactly as it does in FM2. Acceptable until M10?

## References

- Nguyen et al., *Simulator Study of Stall/Post-Stall Characteristics of a Fighter
  Airplane With Relaxed Longitudinal Static Stability*, NASA TP-1538, 1979 —
  <https://ntrs.nasa.gov/citations/19800005879>. Table I gives mass and dimensions;
  appendix B the aerodynamic data and equations of motion; "Deep-Stall Simulation
  Results" covers the α = 60° trim and pitch rocking.
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
