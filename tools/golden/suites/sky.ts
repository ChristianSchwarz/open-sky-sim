/**
 * Sky fixtures (workstream J, CPU half): the sun's path and the state
 * setSunTime derives, the atmosphere ray march, the sky model's slot gains and
 * dome shade, the daytime palette blend, and the sky dome / sun glare vertex
 * buffers and colours the game repaints when the sun moves.
 */
import * as THREE from 'three';
import {
    EARTH_ATMOSPHERE, miePhase, multipleScatteringTable, rayleighPhase, sampleAtmosphere, skyRadiance,
    sunTransmittance, AtmosphereSample,
} from '../../../src/script/scene/atmosphere/atmosphere';
import { domeShade, skyFor, SkySample } from '../../../src/script/scene/atmosphere/skyModel';
import {
    formatSunTime, setSunTime, SHADOW_MIN_SUN_Y, SUN_DIRECTION, SUN_STATE, SUN_UNIFORMS, sunDirectionAt,
    sunElevationAt, sunVisibilityFor, DEFAULT_SUN_HOURS,
} from '../../../src/script/scene/materials/shaders/sun';
import { blendPalettes, daytimePalette } from '../../../src/script/config/palettes/daytimePalette';
import { HDNoonPalette } from '../../../src/script/config/palettes/hd-noon';
import { HDMidnightPalette } from '../../../src/script/config/palettes/hd-midnight';
import { HDNightVisionPalette } from '../../../src/script/config/palettes/hd-nightvision';
import { Palette } from '../../../src/script/config/palettes/palette';
import { paintSkyDome, SkyDomeModelLibBuilder, skyDomeOf } from '../../../src/script/scene/models/lib/skyDomeModelBuilder';
import { paintSunBloom, placeSun, SunModelLibBuilder } from '../../../src/script/scene/models/lib/sunModelBuilder';
import { SceneMaterialManager } from '../../../src/script/scene/materials/materials';
import { arr, Rng, SuiteOutput } from '../lib';

const v3 = (v: THREE.Vector3) => [v.x, v.y, v.z];

function atmosphereJson(s: AtmosphereSample) {
    return {
        zenith: s.zenith, horizonSunward: s.horizonSunward, horizonOpposite: s.horizonOpposite,
        sunDisc: s.sunDisc, sunward: s.sunward, directIrradiance: s.directIrradiance, skyIrradiance: s.skyIrradiance,
    };
}

function skyJson(s: SkySample) {
    return {
        elevationDeg: s.elevationDeg, nightMix: s.nightMix, zenith: s.zenith, horizon: s.horizon,
        horizonSunward: s.horizonSunward, haze: s.haze, cloud: s.cloud, sunDisc: s.sunDisc, ground: s.ground,
        water: s.water, directTint: s.directTint, ambientTint: s.ambientTint,
    };
}

function paletteJson(p: Palette) {
    return { colors: p.colors, values: p.values, time: p.time, light: p.light };
}

/** Times of day the dome and glare are painted at: noon-ish, afternoon, golden hour, sunset, twilight, night, dawn. */
const PAINT_HOURS = [14, 12, 16.5, 17.5, 17.9, 18.1, 18.4, 18.9, 0, 5.85, 6.3, 7.1];

export function skySuite(): SuiteOutput {
    const rng = new Rng(0x5c1e5);

    // --- sun ----------------------------------------------------------------
    const hours: number[] = [];
    for (let h = 0; h <= 24; h += 0.25) hours.push(h);
    hours.push(-3, -0.1, 24.5, 30.25, 49.9, 11.999, 12.001, 6, 18, 5.92, 18.08);
    for (let i = 0; i < 20; i++) hours.push(rng.range(-30, 60));
    const sun = hours.map(h => {
        const raw = sunDirectionAt(h, new THREE.Vector3());
        const elevAt = sunElevationAt(h);
        setSunTime(h);
        return {
            input: h,
            rawDirection: v3(raw),
            elevationAt: elevAt,
            format: formatSunTime(h),
            hours: SUN_STATE.hours,
            elevationDeg: SUN_STATE.elevationDeg,
            dayFactor: SUN_STATE.dayFactor,
            nightMix: SUN_STATE.nightMix,
            shadowStrength: SUN_STATE.shadowStrength,
            direction: v3(SUN_DIRECTION),
            shade: [SUN_UNIFORMS.uSunShade.value.x, SUN_UNIFORMS.uSunShade.value.y],
            ambient: v3(SUN_UNIFORMS.uSunAmbient.value),
            direct: v3(SUN_UNIFORMS.uSunDirect.value),
            tint: v3(SUN_UNIFORMS.uSunTint.value),
        };
    });
    const visibility: number[][] = [];
    for (let i = 0; i < 40; i++) {
        const e = rng.range(-5, 20), s = rng.range(-10, 20), d = rng.pick([2.2, 0.53, 4]);
        visibility.push([e, s, d, sunVisibilityFor(e, s, d)]);
    }

    // --- atmosphere ----------------------------------------------------------
    const phases: number[][] = [];
    for (let i = 0; i <= 20; i++) {
        const c = -1 + i / 10;
        phases.push([c, rayleighPhase(c), miePhase(c, 0.8), miePhase(c, 0.3)]);
    }
    const sampleElevations = [-12, -4, -1, 0, 0.5, 2, 5, 15, 30, 61, 90];
    const samples = sampleElevations.map(e => ({ elevationDeg: e, altitude: 0, sample: atmosphereJson(sampleAtmosphere(e)) }));
    samples.push({ elevationDeg: 10, altitude: 3000, sample: atmosphereJson(sampleAtmosphere(10, 3000)) });
    const msTables = [-3, 4, 45].map(e => {
        const a = e * Math.PI / 180;
        const dir: [number, number, number] = [Math.cos(a), Math.sin(a), 0];
        return { sunDir: dir, table: multipleScatteringTable(EARTH_ATMOSPHERE, dir) };
    });
    const radiances: unknown[] = [];
    for (let i = 0; i < 24; i++) {
        const se = rng.range(-8, 70) * Math.PI / 180;
        const sunDir: [number, number, number] = [Math.cos(se), Math.sin(se), 0];
        const ve = rng.range(-10, 90) * Math.PI / 180, va = rng.range(0, 2 * Math.PI);
        const view: [number, number, number] = [Math.cos(ve) * Math.cos(va), Math.sin(ve), Math.cos(ve) * Math.sin(va)];
        const altitude = rng.pick([0, 0, 1500, 12000]);
        radiances.push({ sunDir, view, altitude, radiance: skyRadiance(EARTH_ATMOSPHERE, altitude, view, sunDir) });
    }
    const transmittances: unknown[] = [];
    for (let i = 0; i < 16; i++) {
        const se = rng.range(-5, 40) * Math.PI / 180;
        const sunDir: [number, number, number] = [Math.cos(se), Math.sin(se), 0];
        const pos: [number, number, number] = [rng.range(-50000, 50000), EARTH_ATMOSPHERE.groundRadius + rng.range(0, 30000), rng.range(-50000, 50000)];
        transmittances.push({ position: pos, sunDir, transmittance: sunTransmittance(EARTH_ATMOSPHERE, pos, sunDir) });
    }

    // --- sky model -----------------------------------------------------------
    const skyElevations: number[] = [];
    for (let e = -30; e <= 90; e += 1.5) skyElevations.push(e);
    skyElevations.push(-0.1, 0.12, 0.13, 61, 3.37, -5.6);
    const skySamples = skyElevations.map(e => ({ input: e, sky: skyJson(skyFor(e)) }));

    const domeShades: number[][] = [];
    const shadeSuns = [-8, -3, -0.6, 0, 1.3, 4, 10, 25, 61, 80];
    const shadeViews = [-5, 0.1, 0.3, 1, 3, 10, 30, 60, 90];
    const shadeAz = [0, 15, 45, 90, 135, 180, -30, 200];
    for (const s of shadeSuns) {
        for (const v of shadeViews) {
            for (const a of shadeAz) {
                const d = domeShade(s, v, a);
                domeShades.push([s, v, a, d.chroma[0], d.chroma[1], d.chroma[2], d.hueWeight, d.brightness]);
            }
        }
    }

    // --- palettes ------------------------------------------------------------
    const paletteHours: number[] = [];
    for (let h = 0; h < 24; h += 0.5) paletteHours.push(h);
    paletteHours.push(17.75, 18.25, 5.75, 6.25, 18.6);
    const daytime = paletteHours.map(h => {
        setSunTime(h);
        return { hours: h, elevationDeg: SUN_STATE.elevationDeg, palette: paletteJson(daytimePalette(HDNoonPalette, HDMidnightPalette)) };
    });
    // The night-vision palette as the night end, to cover the other authored table.
    const nightVision = [-20, -3, 2, 30].map(e => ({
        elevationDeg: e, palette: paletteJson(blendPalettes(HDNoonPalette, HDNightVisionPalette, skyFor(e))),
    }));

    // --- dome and glare ------------------------------------------------------
    const domeModel = new SkyDomeModelLibBuilder('lib:skyDome').build({} as SceneMaterialManager);
    const dome = skyDomeOf(domeModel)!;
    const domeGeometry = dome.mesh.geometry;
    const fakeMaterials = { build: () => new THREE.MeshBasicMaterial() } as unknown as SceneMaterialManager;
    const sunModel = new SunModelLibBuilder('lib:sun').build(fakeMaterials);
    const discMesh = sunModel.lod[0].flats[0] as THREE.Mesh;
    const glareMesh = sunModel.lod[0].volumes[0] as THREE.Mesh;
    const paints = PAINT_HOURS.map(h => {
        setSunTime(h);
        const active = daytimePalette(HDNoonPalette, HDMidnightPalette);
        paintSkyDome(dome, HDNoonPalette, HDMidnightPalette, SUN_STATE.nightMix, SUN_DIRECTION);
        paintSunBloom(sunModel, HDNoonPalette, HDMidnightPalette, SUN_STATE.nightMix, SUN_DIRECTION, active);
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        placeSun(SUN_DIRECTION, position, quaternion);
        return {
            hours: h,
            nightMix: SUN_STATE.nightMix,
            sunDir: v3(SUN_DIRECTION),
            domeColors: arr(domeGeometry.getAttribute('skyColor').array),
            glareColors: arr(glareMesh.geometry.getAttribute('skyColor').array),
            veilDensity: (glareMesh.material as THREE.ShaderMaterial).uniforms.uVeilDensity.value,
            sunPosition: v3(position),
            sunQuaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
        };
    });
    setSunTime(DEFAULT_SUN_HOURS);

    return {
        files: [{
            file: 'sky.json',
            data: {
                suite: 'sky',
                version: 1,
                source: [
                    'src/script/scene/materials/shaders/sun.ts',
                    'src/script/scene/atmosphere/atmosphere.ts',
                    'src/script/scene/atmosphere/skyModel.ts',
                    'src/script/config/palettes/daytimePalette.ts',
                    'src/script/scene/models/lib/skyDomeModelBuilder.ts',
                    'src/script/scene/models/lib/sunModelBuilder.ts',
                ],
                notes: [
                    'Scene axes: +X east, +Y up, +Z south. Hours are local solar time.',
                    'skyFor / domeShade quantise the sun elevation to 0.25 deg; domeShade hue weight uses the raw elevation.',
                    'Palette colours are "#rrggbb" strings (sRGB bytes); unlit categories keep the authored string.',
                    'Dome / glare positions, directions, falloff, cap and colours are float32 (compare exactly).',
                ],
                tolerances: { relative: 1e-12, float32: 0 },
                constants: { shadowMinSunY: SHADOW_MIN_SUN_Y },
                sun,
                visibility,
                phases,
                samples,
                msTables,
                radiances,
                transmittances,
                skySamples,
                domeShades,
                daytime,
                nightVision,
                dome: {
                    positions: arr(domeGeometry.getAttribute('position').array),
                    directions: arr(dome.directions),
                    index: arr(domeGeometry.getIndex()!.array),
                },
                disc: {
                    positions: arr(discMesh.geometry.getAttribute('position').array),
                    index: arr(discMesh.geometry.getIndex()!.array),
                },
                glare: {
                    positions: arr(glareMesh.geometry.getAttribute('position').array),
                    falloff: arr(glareMesh.geometry.getAttribute('skyFalloff').array),
                    cap: arr(glareMesh.geometry.getAttribute('skyCap').array),
                    index: arr(glareMesh.geometry.getIndex()!.array),
                },
                paints,
            },
        }],
    };
}
