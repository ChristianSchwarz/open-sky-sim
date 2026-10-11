/**
 * Flyable aircraft defs (workstream I): manifestToDef over real mod pack
 * manifests (a twin-jet with animated gear, a swing-wing, a big jet without
 * gear animation), the built-in F-22, and the arrestor hook each flies with
 * (flightConfigWithArrestorHook). Manifests are stored with their collision
 * triangles dropped (the AABB, which the hook reads, is kept), so the
 * fixture does not need the packs; skipped packs are reported, not faked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { AircraftManifest, buildF22Def, manifestToDef } from '../../../src/script/state/aircraftRegistry';
import { arrestorHookPlacementForAircraft, flightConfigWithArrestorHook } from '../../../src/script/scene/entities/arrestorCables';
import { FlyableAircraftDef } from '../../../src/script/scene/entities/aircraftDef';
import { SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

/** Pack ids by a fragment of their file name, in the repo's dist/assets. */
const PACKS = ['su_33_su_33', 'f_14a_f_14a', 'e3_sentry_e_3', 'mirage_2000_5f'];

function defJson(def: FlyableAircraftDef) {
    const hook = arrestorHookPlacementForAircraft(def);
    return {
        id: def.id, name: def.name, canonicalName: def.canonicalName ?? null, modelName: def.modelName ?? null,
        liveryName: def.liveryName ?? null, body: def.body, shadow: def.shadow, gear: def.gear ?? null,
        gearAnimated: def.gearAnimated ?? false, collision: def.collision ?? null,
        cockpitOffset: def.cockpitOffset, wingtips: def.fx?.wingtips ?? null, nozzles: def.fx?.nozzles ?? null,
        nozzleRadius: def.fx?.nozzleRadius ?? null, swingWings: def.swingWings ?? null,
        surfaces: def.surfaces.map(s => ({
            role: s.role, model: s.model, pivot: s.pivot, axis: s.axis, control: s.control, sign: s.sign,
            rangeRad: s.rangeRad, sweepParent: s.sweepParent ?? null,
        })),
        hookTip: hook.tip,
        hookHinge: hook.hinge,
        flightHook: flightConfigWithArrestorHook(def).hook,
    };
}

export function aircraftSuite(ctx: SuiteContext): SuiteOutput {
    const dir = path.resolve(ctx.terrainRoot, '../../dist/assets');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.aircraft.pack')).sort() : [];
    const packs = PACKS.map(fragment => {
        const file = files.find(f => f.includes(fragment));
        if (!file) throw new Error(`aircraft suite: no pack matching ${fragment} in ${dir}`);
        const id = file.replace(/\.aircraft\.pack$/, '');
        const zip = unzipSync(new Uint8Array(fs.readFileSync(path.join(dir, file))));
        const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json'])) as AircraftManifest;
        const def = manifestToDef(id, manifest);
        // The pack keeps file references by basename; the def here carries them as written.
        const trimmed = {
            ...manifest,
            collisionMesh: manifest.collisionMesh
                ? { triangles: [], aabb: manifest.collisionMesh.aabb }
                : manifest.collisionMesh,
        };
        return { id, manifest: trimmed, def: defJson(def) };
    });
    return {
        files: [{
            file: 'aircraft.json',
            data: {
                notes: 'manifestToDef(id, manifest) per pack (collision triangles dropped from the stored manifest; '
                    + 'the hook reads only the AABB); file references are compared by basename.',
                f22: defJson(buildF22Def()),
                packs,
            },
        }],
    };
}
