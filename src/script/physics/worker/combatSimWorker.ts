import * as THREE from 'three';
import { CombatSim } from '../sim/combatSim';
import { Faction } from '../../weapons/combatant';
import { SimToWorkerMessage } from '../sim/simTypes';
import {
    aircraftBank,
    projectileBank,
    publishSharedBanks,
    sharedBackBank,
    SimSharedViews,
    wrapSimSharedState,
} from '../sim/simSharedState';

/**
 * Worker entry hosting the authoritative {@link CombatSim}. Receives control
 * inputs and discrete events from the main thread and returns one snapshot per
 * physics pump. When a SharedArrayBuffer is attached, pose floats are published
 * there and only cold fields ride on postMessage.
 */
const sim = new CombatSim();
let shared: SimSharedViews | undefined;

const v = new THREE.Vector3();
const q = new THREE.Quaternion();
const v2 = new THREE.Vector3();

self.onmessage = (event: MessageEvent<SimToWorkerMessage>) => {
    try {
        handleMessage(event.data);
    } catch (err) {
        const e = err as Error;
        self.postMessage({ type: 'error', message: `${e?.name}: ${e?.message}`, stack: e?.stack });
    }
};

function handleMessage(data: SimToWorkerMessage): void {
    switch (data.type) {
        case 'init':
            break;
        case 'attachSharedState':
            shared = wrapSimSharedState(data.buffer);
            break;
        case 'setWorld':
            sim.setWorld(data.world);
            break;
        case 'setHeightField':
            sim.setHeightField(data.config);
            break;
        case 'heightTiles':
            sim.applyHeightTiles(data.update);
            break;
        case 'setArrestorCables':
            sim.setArrestorCables(data.cables);
            break;
        case 'setBarricades':
            sim.setBarricades(data.barricades);
            break;
        case 'setCarrierMeshOrigins':
            sim.setCarrierMeshOrigins(data.origins);
            break;
        case 'setCarrierVelocity':
            sim.setCarrierVelocity(data.velocity[0], data.velocity[1], data.velocity[2]);
            break;
        case 'addAircraft':
            sim.addAircraft(data.desc);
            break;
        case 'removeAircraft':
            sim.removeAircraft(data.id);
            break;
        case 'setEnabled':
            sim.setEnabled(data.id, data.enabled);
            break;
        case 'setControlMode':
            sim.setControlMode(data.id, data.control);
            break;
        case 'setTarget':
            sim.setTarget(data.id, data.targetId);
            break;
        case 'setFormationLead':
            sim.setFormationLead(data.id, data.leadId);
            break;
        case 'setTargetFaction':
            sim.setTargetFaction(data.id, data.faction);
            break;
        case 'setPhase':
            sim.setPhase(data.id, data.phase);
            break;
        case 'setPilotOptions':
            sim.setPilotOptions(data.id, data.options);
            break;
        case 'respawn':
            sim.respawn(data.id, data.spawn);
            break;
        case 'reset':
            sim.resetAircraft(
                data.id,
                v.fromArray(data.position),
                q.fromArray(data.quaternion),
                v2.fromArray(data.velocity),
                data.landed, data.throttle, data.model);
            break;
        case 'setAircraftConfig':
            sim.setAircraftConfig(data.id, data.aircraftConfig, data.model, data.collision);
            break;
        case 'setCollision':
            sim.setCollision(data.id, data.collision);
            break;
        case 'setPosition':
            sim.setPosition(data.id, v.fromArray(data.position));
            break;
        case 'setQuaternion':
            sim.setQuaternion(data.id, q.fromArray(data.quaternion));
            break;
        case 'setVelocity':
            sim.setVelocity(data.id, v.fromArray(data.velocity));
            break;
        case 'syncEffectiveThrottle':
            sim.syncEffectiveThrottle(data.id, data.throttle);
            break;
        case 'snapPhysicsState':
            sim.snapPhysicsState(data.id);
            break;
        case 'setExternalState':
            sim.setExternalState(
                data.id, data.enabled, data.faction as Faction,
                v.fromArray(data.position), v2.fromArray(data.velocity), data.alive);
            break;
        case 'clearExternalState':
            sim.clearExternalState(data.id);
            break;
        case 'keyDown':
            sim.keyDown(data.id, data.key, data.repeat);
            break;
        case 'keyUp':
            sim.keyUp(data.id, data.key);
            break;
        case 'setKeyboardLayout':
            sim.setKeyboardLayout(data.layoutId);
            break;
        case 'gamepadAxes':
            sim.gamepadAxes(data.id, data.pitch, data.roll, data.yaw, data.throttle, data.connected);
            break;
        case 'inputBlur':
            sim.inputBlur(data.id);
            break;
        case 'setInputEnabled':
            sim.setInputEnabled(data.id, data.enabled);
            break;
        case 'setForceVectorsRequested':
            sim.setForceVectorsRequested(data.id, data.want);
            break;
        case 'step': {
            const t0 = performance.now();
            sim.step(data.delta, data.inputs);
            const workerStepMs = performance.now() - t0;
            if (shared) {
                const back = sharedBackBank(shared);
                const snapshot = sim.encodeSnapshotInto(
                    aircraftBank(shared, back),
                    projectileBank(shared, back),
                );
                const seq = publishSharedBanks(
                    shared, snapshot.ids.length, snapshot.projectileCount,
                );
                self.postMessage({
                    type: 'state',
                    shared: true,
                    seq,
                    ids: snapshot.ids,
                    forceVectors: snapshot.forceVectors,
                    maneuverLabels: snapshot.maneuverLabels,
                    hits: snapshot.hits,
                    workerStepMs,
                });
            } else {
                const snapshot = sim.encodeSnapshot();
                self.postMessage(
                    { type: 'state', shared: false, ...snapshot, workerStepMs },
                    {
                        transfer: [
                            snapshot.aircraft.buffer,
                            snapshot.projectiles.buffer,
                        ] as Transferable[],
                    });
            }
            break;
        }
    }
}
