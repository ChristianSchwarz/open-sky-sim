/**
 * Step cost of FM3 against FM2, airborne with the stick moving.
 *
 * Bundle first — under `node --import tsx` physics code runs ~50x slower:
 *
 *     node_modules/.bin/esbuild tools/fm3/bench.ts --bundle --platform=node --outfile=<tmp>/bench.cjs
 *     node <tmp>/bench.cjs
 */
import * as THREE from 'three';
import { FlightModel } from '../../src/script/physics/model/flightModel';
import { Fm2FlightModel } from '../../src/script/physics/model/fm2FlightModel';
import { Fm3FlightModel } from '../../src/script/physics/model/fm3FlightModel';

const DT = 1 / 120;

function spawn(model: FlightModel): void {
    model.reset();
    model.position.set(0, 3000, 0);
    model.quaternion.identity();
    model.velocityVector = new THREE.Vector3(0, 0, 200);
    model.setLanded(false);
    model.setLandingGearDeployed(false);
    model.setFlapsExtended(false);
    model.setThrottle(0.8);
    model.syncEffectiveThrottle();
    model.snapPhysicsState();
}

function run(model: FlightModel, steps: number): void {
    spawn(model);
    for (let i = 0; i < steps; i++) {
        if (i % 1200 === 0) spawn(model);
        model.setPitch(0.5 * Math.sin(i * 0.01));
        model.setRoll(0.3 * Math.sin(i * 0.013));
        model.step(DT);
    }
}

function bench(name: string, model: FlightModel): number {
    run(model, 20000);
    const steps = 120000;
    const t0 = performance.now();
    run(model, steps);
    const us = (performance.now() - t0) / steps * 1000;
    console.log(`${name}: ${us.toFixed(2)} µs/step, ${(us * 120 / 1000).toFixed(2)} ms per simulated second`);
    return us;
}

const fm2 = bench('FM2', new Fm2FlightModel());
const fm3 = bench('FM3', new Fm3FlightModel());
console.log(`FM3 / FM2: ${(fm3 / fm2).toFixed(1)}x`);
