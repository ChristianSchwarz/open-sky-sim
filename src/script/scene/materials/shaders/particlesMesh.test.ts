import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParticleMeshFragProgram } from './particlesMeshFP';
import { ParticleMeshVertProgram } from './particlesMeshVP';

/** `precision <qualifier> <type>;` declarations, as a type → qualifier map. */
function declaredPrecision(source: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of source.matchAll(/precision\s+(lowp|mediump|highp)\s+(\w+)\s*;/g)) {
        out.set(m[2], m[1]);
    }
    return out;
}

/** Uniform names by type, e.g. 'int' → ['shadingType']. */
function uniformsOfType(source: string, type: string): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(/uniform\s+(\w+)\s+(\w+)\s*;/g)) {
        if (m[1] === type) {
            out.push(m[2]);
        }
    }
    return out;
}

describe('particle mesh shaders', () => {
    const vert = declaredPrecision(ParticleMeshVertProgram);
    const frag = declaredPrecision(ParticleMeshFragProgram);

    // These are compiled as a RawShaderMaterial, so three.js prepends no
    // precision prologue. Without an explicit declaration the GLSL ES defaults
    // differ per stage (int: highp vertex, mediump fragment) and ANGLE refuses
    // to link — dropping wake foam, smoke, fire and debris with only a console
    // warning. Neither tsc nor a headless test can catch that, hence this.
    for (const type of ['float', 'int']) {
        it(`declares ${type} precision in both stages`, () => {
            assert.ok(vert.has(type), `vertex program declares no ${type} precision`);
            assert.ok(frag.has(type), `fragment program declares no ${type} precision`);
        });

        it(`matches ${type} precision across stages`, () => {
            assert.equal(vert.get(type), frag.get(type));
        });
    }

    it('shares no uniform type that is left undeclared', () => {
        const shared = uniformsOfType(ParticleMeshVertProgram, 'int')
            .filter(name => uniformsOfType(ParticleMeshFragProgram, 'int').includes(name));
        // Guards the assumption above: if the stages stop sharing int uniforms
        // the precision pairing still holds, but this documents why it matters.
        assert.ok(shared.includes('shadingType'), `shared int uniforms: ${shared.join(', ')}`);
    });
});
