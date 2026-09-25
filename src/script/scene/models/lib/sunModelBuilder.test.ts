import * as THREE from 'three';
import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { daytimePalette } from '../../../config/palettes/daytimePalette';
import { HDMidnightPalette } from '../../../config/palettes/hd-midnight';
import { HDNoonPalette } from '../../../config/palettes/hd-noon';
import { PaletteCategory, PaletteColor } from '../../../config/palettes/palette';
import { DisplayShading, FogQuality } from '../../../config/profiles/profile';
import { SceneMaterialManager } from '../../materials/materials';
import { COCKPIT_FOV, H_RES, V_RES } from '../../../defs';
import { DEFAULT_SUN_HOURS, setSunTime, SUN_DIRECTION } from '../../materials/shaders/sun';
import { paintSunBloom, placeSun, SUN_DISTANCE, SUN_SET_ELEVATION_DEG, SunModelLibBuilder } from './sunModelBuilder';
import { SCENE_DEPTH_UNIFORMS } from '../../materials/shaders/sceneDepth';
import { SimpleEntity } from '../../entities/simpleEntity';
import { SceneLayers } from '../../scene';

afterEach(() => setSunTime(DEFAULT_SUN_HOURS));

/**
 * The two halves of the sun, as the model splits them.
 *
 * They live in different LOD collections because they are drawn in different
 * passes: the disc goes behind the terrain, the glare in front of it.
 */
function build(): { disc: THREE.Mesh; glare: THREE.Mesh; } {
    const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
    const lod = new SunModelLibBuilder('sun').build(materials).lod[0];
    assert.strictEqual(lod.flats.length, 1, 'the disc should be the only flat');
    assert.strictEqual(lod.volumes.length, 1, 'the glare should be a single mesh');
    return { disc: lod.flats[0] as THREE.Mesh, glare: lod.volumes[0] as THREE.Mesh };
}

/** Every vertex of `mesh` as (apparent diameter in degrees, falloff, cap). */
function falloffByAngle(mesh: THREE.Mesh): { deg: number; falloff: number; cap: boolean; }[] {
    const position = mesh.geometry.getAttribute('position');
    const falloff = mesh.geometry.getAttribute('skyFalloff');
    const cap = mesh.geometry.getAttribute('skyCap');
    assert.ok(falloff, 'the glare carries no falloff ramp');
    assert.ok(cap, 'the glare carries no cap flag');
    const samples: { deg: number; falloff: number; cap: boolean; }[] = [];
    for (let v = 0; v < position.count; v++) {
        const radius = Math.hypot(position.getX(v), position.getY(v));
        samples.push({
            deg: 2 * Math.atan(radius / SUN_DISTANCE) * THREE.MathUtils.RAD2DEG,
            falloff: falloff.getX(v),
            cap: cap.getX(v) > 0.5,
        });
    }
    return samples.sort((a, b) => a.deg - b.deg);
}

/** Apparent diameter of a mesh at {@link SUN_DISTANCE}, in degrees. */
function apparentDiameterDeg(mesh: THREE.Mesh): number {
    return 2 * Math.atan(radiusOf(mesh) / SUN_DISTANCE) * THREE.MathUtils.RAD2DEG;
}

/** Furthest any vertex reaches from the mesh's own centre. */
function radiusOf(mesh: THREE.Mesh): number {
    mesh.geometry.computeBoundingSphere();
    return mesh.geometry.boundingSphere!.radius;
}

/** Closest any vertex comes to the centre: 0 for a solid disc. */
function innerRadiusOf(mesh: THREE.Mesh): number {
    const position = mesh.geometry.getAttribute('position');
    let closest = Infinity;
    for (let v = 0; v < position.count; v++) {
        closest = Math.min(closest, Math.hypot(position.getX(v), position.getY(v)));
    }
    return closest;
}

describe('SunModelLibBuilder', () => {

    it('fades the glare out linearly with angle from the sun', () => {
        // The whole point of carrying a ramp rather than stacking rings. Three
        // fixed stipple densities read as three hard concentric bands - the
        // very contouring the sky's dither exists to break up - so the falloff
        // is one straight line from the sun's limb to the outer edge, sampled
        // finely enough that the 4x4 stipple cannot resolve the steps in it.
        // The ring only: the cap over the disc is deliberately flat at the
        // limb's own value, and is gated on occlusion rather than on angle.
        const samples = falloffByAngle(build().glare).filter(s => !s.cap);

        const inner = samples[0];
        const outer = samples[samples.length - 1];
        assert.ok(Math.abs(inner.falloff - 1) < 1e-6,
            `the glare starts at ${inner.falloff} rather than full`);
        assert.ok(Math.abs(outer.falloff) < 1e-6,
            `the glare ends at ${outer.falloff} rather than nothing`);

        // Straight, not merely monotonic: every sample has to sit on the line
        // between those two ends. A curve would still pass a monotonic check.
        for (const { deg, falloff } of samples) {
            const expected = (outer.deg - deg) / (outer.deg - inner.deg);
            assert.ok(Math.abs(falloff - expected) < 1e-3,
                `at ${deg.toFixed(2)} deg the ramp is ${falloff}, not ${expected}`);
        }

        // ...and sampled at enough radii that the line is not a step in
        // disguise: the stipple resolves 17 levels, so fewer than that many
        // distinct values would band.
        const levels = new Set(samples.map(s => s.falloff.toFixed(4))).size;
        assert.ok(levels >= 10, `only ${levels} distinct steps across the glare`);
    });

    it('draws the glare above the sky dome', () => {
        // Nothing in either sky pass writes depth, so paint order is all there
        // is. The dome leaves renderOrder at its default 0.
        const { disc, glare } = build();
        assert.ok(glare.renderOrder > 0, `glare ${glare.renderOrder}`);
        assert.ok(disc.renderOrder > 0, `disc ${disc.renderOrder}`);
    });

    it('lets the glare over the scene while the disc stays behind it', () => {
        // The point of the split. Glare is light scattered out of the air
        // between the viewer and the sun, so a ridge across the sun does not
        // hide the aureole - it sits inside it. The disc is the one part that
        // really is behind the ridge, which is why it alone is left in the
        // background pass and depth-tested there.
        const { glare } = build();
        assert.strictEqual(glare.material.depthTest, false,
            'the glare would be occluded by the terrain');
        assert.strictEqual(glare.material.depthWrite, false,
            'the glare would occlude what is drawn after it');
    });

    it('caps the glare over the disc, for the shader to gate', () => {
        // The glare is drawn after the disc rather than under it, so it must not
        // stipple over the one thing in the frame that has to stay clean - but
        // it cannot simply leave a hole either, because once terrain has taken
        // the disc that hole shows the ground at the brightest point of the sky.
        // So the cap is geometry that is always there and drawn only where the
        // depth under it says the disc is gone. Everything here is what the
        // shader's `skyCap` branch needs to be able to make that call.
        const { disc, glare } = build();
        const discRadius = radiusOf(disc);
        const samples = falloffByAngle(glare);

        assert.strictEqual(innerRadiusOf(glare), 0,
            'the cap leaves a hole and the ground will show through it');

        const cap = samples.filter(s => s.cap);
        const ring = samples.filter(s => !s.cap);
        assert.ok(cap.length > 0, 'there is no cap to fill the disc with');

        // The cap covers the disc and stops just inside it, so the two overlap
        // rather than meeting exactly and leaving a hairline of background.
        const capRadius = SUN_DISTANCE * Math.tan(
            cap[cap.length - 1].deg / 2 * THREE.MathUtils.DEG2RAD);
        assert.ok(capRadius < discRadius, `cap ${capRadius} exposes the disc ${discRadius}`);
        assert.ok(capRadius > discRadius * 0.9,
            `cap ${capRadius} is far enough inside ${discRadius} to show stipple`);

        // The cap's rim and the ring's inner rim are the same circle. A gap
        // would show as a ring of background; an overlap would gate the two
        // sides of one seam differently.
        assert.ok(Math.abs(ring[0].deg - cap[cap.length - 1].deg) < 1e-6,
            `ring starts at ${ring[0].deg} but the cap ends at ${cap[cap.length - 1].deg}`);

        // Flat at the limb's value across the cap: the aureole is still rising
        // as it goes in, so anything less would dip at the very centre.
        for (const { deg, falloff } of cap) {
            assert.ok(Math.abs(falloff - 1) < 1e-6,
                `the cap dips to ${falloff} at ${deg.toFixed(2)} deg`);
        }
    });

    it('veils the glare against the scene instead of replacing it', () => {
        // The aureole is light scattered by the air *in front of* what the pixel
        // shows, so how much of it survives depends on how much air that is. The
        // shader needs the scene's own depth to know, and only the glare compiles
        // that branch - the dome shares the program and has no use for it.
        const { glare } = build();
        const material = glare.material as THREE.ShaderMaterial;

        assert.ok('SKY_GLARE' in (material.defines ?? {}),
            'the glare will draw at full strength over the terrain');
        assert.ok(material.uniforms.uSceneDepth, 'the glare cannot see what it covers');
        assert.strictEqual(material.uniforms.uSceneDepth, SCENE_DEPTH_UNIFORMS.uSceneDepth,
            'the glare holds its own copy and the pass will never reach it');
    });

    it('takes the veil density from the palette the terrain was fogged with', () => {
        // Same airlight, so the same number: a ridge that has receded into haze
        // sits inside the glow, and one that has not is silhouetted against it.
        // Deriving it separately would let the two disagree at exactly the
        // distances where the difference is visible.
        const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
        const model = new SunModelLibBuilder('sun').build(materials);
        const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);
        paintSunBloom(model, HDNoonPalette, HDMidnightPalette, 0, SUN_DIRECTION, palette);

        const glare = model.lod[0].volumes[0] as THREE.Mesh;
        const density =
            (glare.material as THREE.ShaderMaterial).uniforms.uVeilDensity.value as number;
        const fog = palette.values[PaletteCategory.FOG_TERRAIN];
        assert.ok(density > 0, `the glare would vanish over every surface at ${density}`);
        assert.ok(density > fog,
            `the aureole is the forward lobe, not the average: ${density} vs fog ${fog}`);
        // Tied to the palette rather than to a reach of its own, so a hazy
        // profile gets a hazy aureole without a second number to keep in step.
        assert.ok(Math.abs(density / fog - Math.round(density / fog)) < 1e-9,
            `${density} is not a clean multiple of the fog density ${fog}`);
    });

    it('draws the disc small and the glare spread wide around it', () => {
        // The glare reaches many times the sun own width, which is what an
        // aureole is; the disc sits inside it.
        const built = build();
        const sizes = [built.glare, built.disc].map(apparentDiameterDeg);
        for (let i = 1; i < sizes.length; i++) {
            assert.ok(sizes[i] < sizes[i - 1], `sizes ${sizes}`);
        }

        const disc = sizes[sizes.length - 1];
        // Oversize versus the real 0.53 degrees, or it would be a pixel and a
        // half at 320x200 — but not so large it reads as a moon.
        assert.ok(disc > 1.5 && disc < 4, `disc ${disc} deg`);
        // The aureole is glare spread by the air, so it reaches several times
        // the sun's own width rather than merely fringing it.
        assert.ok(sizes[0] > 4 * disc, `corona ${sizes[0]} vs disc ${disc}`);
    });

    it('drives the disc past white and the glare only part of the way', () => {
        // A palette entry stops at #ffffff, which is nowhere near enough for a
        // light: the sun at sunset is a deeply reddened orange whose blue is
        // all but zero, so nothing could take it to white and it read as a dull
        // yellow blob against a paler sky. The disc is driven far enough past
        // the top that every channel clips. The glare climbs towards its own
        // peak along the ramp, which the shader mixes from 1 - plain sky, so
        // the outer edge cannot come out brighter than the sky it fades into.
        const { disc, glare } = build();

        const discOverbright =
            (disc.material as THREE.ShaderMaterial).uniforms.overbright.value as number;
        assert.ok(discOverbright >= 5, `the disc will not clip to white at x${discOverbright}`);

        const peak =
            (glare.material as THREE.ShaderMaterial).uniforms.uSkyOverbright.value as number;
        assert.ok(peak > 1, `the glare is no brighter than the sky at x${peak}`);
        assert.ok(peak < discOverbright, 'the glare must not match the core');
    });

    it('paints the glare as sky and leaves the disc solid', () => {
        // The glare carries vertex colours from the dome's own painter, so it
        // agrees with the sky it sits in by construction rather than by two
        // sets of constants being kept in step. Every attempt to derive it
        // separately left a visible seam.
        const { disc, glare } = build();

        assert.strictEqual(
            (disc.material as THREE.ShaderMaterial).uniforms.alphaDither.value, 0,
            'the disc itself must be opaque');
        assert.ok(glare.geometry.getAttribute('skyColor'), 'the glare carries no sky colours');
    });

    it('hides the disc once its upper limb is under the horizon', () => {
        const disc = apparentDiameterDeg(build().disc);
        assert.ok(SUN_SET_ELEVATION_DEG < 0, `${SUN_SET_ELEVATION_DEG}`);
        assert.ok(Math.abs(SUN_SET_ELEVATION_DEG + disc / 2) < 0.05,
            `cutoff ${SUN_SET_ELEVATION_DEG} vs half-diameter ${disc / 2}`);
    });
});

describe('the sun across its two passes', () => {

    /** Names drawn into `layer` when the sun is rendered with only that list. */
    function drawnInto(layer: SceneLayers): string[] {
        const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
        const model = new SunModelLibBuilder('sun').build(materials);
        const entity = new SimpleEntity(model, SceneLayers.BackgroundSky, SceneLayers.ForegroundSky);
        placeSun(SUN_DIRECTION, entity.position, entity.quaternion);

        const camera = new THREE.PerspectiveCamera(COCKPIT_FOV, H_RES / V_RES, 5, 50000);
        camera.lookAt(entity.position);
        camera.updateMatrixWorld(true);

        const list = new THREE.Scene();
        entity.render3D(H_RES, V_RES, camera, new Map([[layer, list]]),
            daytimePalette(HDNoonPalette, HDMidnightPalette));

        const names: string[] = [];
        list.traverse(o => { if ((o as THREE.Mesh).isMesh) names.push(o.name); });
        return names;
    }

    it('sends the disc to the background pass and the glare to the foreground one', () => {
        // Which is the whole reason the two live in separate LOD collections.
        // The background pass is drawn before the terrain, so what goes there
        // sets behind the hills; the foreground pass is drawn after it.
        setSunTime(18);

        const background = drawnInto(SceneLayers.BackgroundSky);
        assert.deepStrictEqual(background, ['sunDisc'],
            `the background pass drew ${background}`);

        const foreground = drawnInto(SceneLayers.ForegroundSky);
        assert.deepStrictEqual(foreground, ['sunGlare'],
            `the foreground pass drew ${foreground}`);
    });
});

describe('placeSun', () => {

    const place = (hours: number) => {
        setSunTime(hours);
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        placeSun(SUN_DIRECTION, position, quaternion);
        return { position, quaternion };
    };

    it('parks the disc down the sun direction, face-on to the camera', () => {
        for (const hours of [6, 9, 12, 15, 18]) {
            const { position, quaternion } = place(hours);
            assert.ok(Math.abs(position.length() - SUN_DISTANCE) < 1e-6, `${hours}h ${position.length()}`);
            assert.ok(position.clone().normalize().dot(SUN_DIRECTION) > 1 - 1e-6, `${hours}h off-axis`);

            // The camera sits at the origin, so the face normal must come back
            // down the same line or the disc is edge-on and invisible.
            const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
            assert.ok(normal.dot(SUN_DIRECTION) < -(1 - 1e-6), `${hours}h normal ${normal.toArray()}`);
        }
    });

    it('lands the disc dead centre of a camera pointed at it', () => {
        const camera = new THREE.PerspectiveCamera(COCKPIT_FOV, H_RES / V_RES, 5, 50000);
        for (const hours of [7, 12, 17]) {
            const { position } = place(hours);
            camera.position.set(0, 0, 0);
            camera.lookAt(position);
            camera.updateMatrixWorld(true);

            const ndc = position.clone().project(camera);
            assert.ok(Math.hypot(ndc.x, ndc.y) < 1e-5, `${hours}h ndc ${ndc.x},${ndc.y}`);
            assert.ok(ndc.z > -1 && ndc.z < 1, `${hours}h behind the near/far planes: ${ndc.z}`);
        }
    });

    it('puts the disc above the horizon line while the sun is up', () => {
        // Level camera facing the sun's compass bearing: the disc must project
        // into the upper half of the frame whenever the sun is above 0 degrees.
        const camera = new THREE.PerspectiveCamera(COCKPIT_FOV, H_RES / V_RES, 5, 50000);
        for (const hours of [7, 10, 12, 16, 17.5]) {
            const { position } = place(hours);
            camera.position.set(0, 0, 0);
            camera.lookAt(position.x, 0, position.z);
            camera.updateMatrixWorld(true);

            const ndc = position.clone().project(camera);
            assert.ok(ndc.y > 0, `${hours}h should sit above the horizon, ndc.y ${ndc.y}`);
        }
    });
});

describe('sun disc colour', () => {

    const sunAt = (hours: number) => {
        setSunTime(hours);
        return PaletteColor(daytimePalette(HDNoonPalette, HDMidnightPalette), PaletteCategory.SKY_SUN);
    };

    it('warms as it drops to the horizon', () => {
        // Taken from the sky beside the sun rather than from the beam that
        // reaches the viewer. Those are different colours - the beam is what
        // survives the path, the aureole is what the path scattered out - and
        // colouring the disc by the beam put an orange sun in a pink sky with
        // a seam where they met. So this warms with the sky, and no longer
        // races ahead of it into deep red.
        const noon = sunAt(12);
        const sunset = sunAt(18);
        assert.ok(redShift(noon, sunset) > 40, `noon ${noon} sunset ${sunset}`);
    });

    it('tracks the sky beside it rather than running redder', () => {
        // The point of the change. The disc is driven past white by its own
        // material, so what this colour actually decides is the bloom - and a
        // bloom that is redder than the sky it fades into shows its edge.
        setSunTime(18);
        const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);
        const sun = PaletteColor(palette, PaletteCategory.SKY_SUN);
        const skyward = PaletteColor(palette, PaletteCategory.FOG_SKY);
        assert.ok(Math.abs(redShift(skyward, sun)) < 90,
            `sun ${sun} has run away from the sky ${skyward}`);
    });
});

/** How much redder `b` is than `a`, as red minus blue. */
function redShift(a: string, b: string): number {
    const channels = (css: string) => {
        const n = parseInt(css.slice(1), 16);
        return [(n >> 16) & 0xff, n & 0xff];
    };
    const [ar, ab] = channels(a);
    const [br, bb] = channels(b);
    return (br - bb) - (ar - ab);
}
