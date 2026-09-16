# Barricade Phase 6: Tuning & Validation

**Completed**: 2026-09-03  
**Status**: Test framework and debug infrastructure complete  
**Next**: Integration into CombatSim and parameter tuning

## Overview

Phase 6 establishes the testing and validation infrastructure needed to tune the rigid body solver and compare its behavior against the existing particle-based solver. Rather than implementing tuning directly, this phase provides the tools needed to measure, validate, and iterate on parameters.

## Deliverables

### 1. Comprehensive Test Suite (`barricadeRigidBodySolver.test.ts`)

A Jest-based test suite with **10 test cases** validating core solver behavior:

#### Unit Tests (8 tests)
- **Initialization**: Verify body count matches layout specification
- **Gravity Settling**: Confirm stable equilibrium without oscillation (<10cm change per frame)
- **Constraint Maintenance**: Validate belt length preservation
- **Deployment Animation**: Test stanchion rotation tracking (0% → 100% deploy)
- **Rendering Output**: Verify position array format and finite values
- **Wire Tension Tracking**: Confirm non-negative tension values
- **Contact Force Accumulation**: Validate F/torque vector generation
- **Component Integration**: Full solver lifecycle test

#### Comparison Tests (2 tests)
- **Belt Configuration**: Both solvers produce equivalent initial rigging
- **Sustained Gravity**: Bounding box similarity ±0.5m over 10 frames

**Running the tests**:
```bash
npm test -- barricadeRigidBodySolver
```

**Test Output Interpretation**:
- ✅ All tests pass: Solver is physically plausible
- ⚠️ Constraint violations: Stiffness/compliance may need tuning
- ❌ Position divergence: Algorithm difference requires investigation

### 2. Debug Configuration System (`barricadeDebugConfig.ts`)

A runtime configuration system enabling solver comparison and profiling:

#### Solver Modes
```typescript
PARTICLE        // Current system (default)
RIGID_BODY      // New implementation
PARALLEL_DEBUG  // Both in parallel (renderer uses PARTICLE)
```

#### Debug Options
```typescript
logConstraintViolations  // Constraint error reporting
logTensionProfiles       // Per-wire tension logging
logPositionDeltas        // Frame-to-frame position changes
profileSolverTime        // Millisecond timing per step()
validateAgainstParticle  // Compare outputs (tolerance: 5cm default)
```

#### Quick Testing via URL
```
?barricadeSolver=rigid_body      // Use new solver
?barricadeSolver=parallel_debug  // Run both, compare
```

#### Runtime Metrics Tracking
```typescript
interface BarricadeDebugMetrics {
    frameCount: number           // Frames since reset
    totalSolverTimeMs: number    // Cumulative solver time
    maxPositionDelta: number     // Largest diff to particle solver
    avgPositionDelta: number     // Average diff
    validationFailures: number   // Count of tolerance violations
    wireTensions: number[]       // Last frame tensions [N0, N1, N2, N3]
    hasConstraintViolations: boolean
}
```

### 3. Integration Hooks (Prepared, Not Yet Integrated)

The debug system is designed to integrate into `CombatSim.stepBarricadeWebbing()` via:

```typescript
if (config.solverMode === 'PARALLEL_DEBUG') {
    rbSolver.step(dt);
    particleSolver.step(dt);
    validateOutputs(rbSolver, particleSolver, config);
}
```

This allows side-by-side testing without code branching.

## Testing Workflow

### Baseline Validation (Run Once)
```bash
npm test -- barricadeRigidBodySolver
```
Ensures solver produces physically valid results.

### Regression Testing (During Parameter Tuning)
```bash
# Run specific test scenario
npm test -- barricadeRigidBodySolver -t "sustained gravity"

# Capture baseline metrics
npm test -- barricadeRigidBodySolver --json > baseline.json
```

### Live Comparison (In Browser)
1. Load game with `?barricadeSolver=parallel_debug`
2. Open DevTools console
3. Check `window.barricadeDebugMetrics` each frame
4. Monitor `maxPositionDelta` during arrestment
5. Compare `wireTensions` arrays between solvers

### Performance Validation
```typescript
// From BarricadeDebugMetrics
const fps = 30; // assumed frame rate
const solverTime = metrics.totalSolverTimeMs / metrics.frameCount;
const solverBudget = (1000 / fps) * 0.2; // 20% of frame budget
console.log(`Solver: ${solverTime.toFixed(2)}ms (budget: ${solverBudget.toFixed(2)}ms)`);
```

## Key Metrics for Tuning

### Wire Tension Validation
- **Expected**: Tensions increase smoothly under impact load
- **Check**: `metrics.wireTensions` should match particle solver ±10%
- **If divergent**: Adjust `BARRICADE_RB_COMPLIANCE_DISTANCE` in `BarricadeConstraint`

### Position Stability
- **Expected**: `maxPositionDelta` stays below 5cm during normal operation
- **Check**: Debug console or test output
- **If > 5cm**: Solver stiffness is too low; reduce compliance by 10%

### Constraint Violations
- **Expected**: Zero violations in settled state
- **Check**: `hasConstraintViolations` flag in metrics
- **If true**: Increase iteration count or reduce timestep

### Arrestment Distance
- **Expected**: ±5% of particle solver (typically 30-50m)
- **Measure**: Run identical impact scenario on both solvers
- **Validate**: Create a test harness in Phase 6b (future work)

## Tuning Parameters (From Phase 1-5 Implementation)

The rigid body solver uses these constants that can be adjusted:

```typescript
// From barricadeRigidBodySolver.ts
BARRICADE_RB_GRAVITY = 9.81              // m/s²
BARRICADE_RB_DECK_WIND_MPS = 13          // m/s headwind
BARRICADE_RB_SUBSTEPS = 32               // iterations per frame
BARRICADE_RB_SKIN_M = 0.04               // collision margin

// From barricadeRigidBody.ts (DistanceConstraint)
alpha = 1.0 / (stiffness * dt²)          // compliance scaling
```

### Tuning Guide

| Symptom | Parameter | Change | Why |
|---------|-----------|--------|-----|
| Bouncy arrestment | `alpha` (compliance) | ↓ (increase stiffness) | Reduce overshoot |
| Overly stiff | `alpha` | ↑ (decrease stiffness) | Add elasticity |
| Jitter/oscillation | `SUBSTEPS` | ↑ | More constraint iterations |
| Solver too slow | `SUBSTEPS` | ↓ | Faster but less stable |
| Clipping aircraft | `BARRICADE_RB_SKIN_M` | ↑ | Larger collision margin |
| Too much gap | `BARRICADE_RB_SKIN_M` | ↓ | Tighter collision |

## What's NOT in Phase 6

Phase 6 provides measurement and validation infrastructure, but does NOT include:

- ❌ Integration into CombatSim (requires `src/script/physics/sim/combatSim.ts` changes)
- ❌ Live arrestment test harness (requires UI to trigger scenarios)
- ❌ Automated parameter tuning (requires numerical optimization)
- ❌ Video comparison tools (requires frame-by-frame capture)
- ❌ Batch regression testing (requires CI pipeline)

These are candidates for Phase 6b if needed.

## Files Added/Modified

### New Files
- `src/script/scene/entities/barricadeRigidBodySolver.test.ts` (184 lines, 8 unit + 2 comparison tests)
- `src/script/scene/entities/barricadeDebugConfig.ts` (101 lines, enum + config types)

### Related Existing Files (No Changes)
- `src/script/scene/entities/barricadeRigidBody.ts` (Phase 1)
- `src/script/scene/entities/barricadeRigidBodySolver.ts` (Phase 2-5)
- `src/script/scene/entities/barricadeSolver.ts` (existing, particle solver)
- `src/script/physics/sim/combatSim.ts` (not yet modified for integration)

## Success Criteria Met

- ✅ Comprehensive test suite with 10 test cases
- ✅ Validation framework for comparing solvers
- ✅ Debug configuration system with URL support
- ✅ Metrics tracking for performance validation
- ✅ Build succeeds without errors
- ✅ Tests compile and are ready to run

## Next Steps (Future Work)

1. **Phase 6b: CombatSim Integration**
   - Wire up debug config in `stepBarricadeWebbing()`
   - Add metrics display overlay
   - Run initial test suite on both solvers

2. **Phase 6c: Parameter Tuning**
   - Run live arrestment scenarios
   - Measure tension profiles and run-out distance
   - Adjust compliance/stiffness values
   - Validate against video footage

3. **Phase 6d: Edge Case Testing**
   - Low-speed impacts (gravity dominates)
   - High-speed impacts (engine at max payout)
   - Asymmetric loading (wing on net)
   - Stanchion deployment dynamics
   - Re-rigging behavior (deploy → retract → deploy)

4. **Phase 7: Production Integration (Future)**
   - Swap BarricadeSolver for BarricadeRigidBodySolver in CombatSim
   - Remove old particle solver after validation
   - Benchmark performance on full scenarios

## Reference

### Test Execution
```bash
# Run all barricade tests
npm test -- barricade

# Run specific test file
npm test -- barricadeRigidBodySolver.test.ts

# Run with verbose output
npm test -- barricadeRigidBodySolver --verbose

# Run in watch mode (auto-rerun on file changes)
npm test -- barricadeRigidBodySolver --watch
```

### Build & Verify
```bash
npm run build  # Must succeed before testing
npm test       # Run full test suite
```

### Current Solver Status

As of 2026-09-03:
- **Phase 1-5**: Complete (solver, constraints, collision detection)
- **Phase 6**: Complete (test suite + debug infrastructure)
- **Phase 6b+**: Pending (integration and tuning)
- **Overall**: Ready for integration testing

## Questions?

See the barricade implementation docs:
- `docs/barricade-rewrite-project.md` - Project scope
- Test suite comments in `barricadeRigidBodySolver.test.ts`
