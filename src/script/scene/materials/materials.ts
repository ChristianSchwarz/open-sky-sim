import * as THREE from 'three';
import { ShaderMaterial } from 'three';
import { FogColorCategory, FogValueCategory, PALETTE_FX_PREFIX, Palette, PaletteCategory, PaletteColor, PaletteColorShade } from "../../config/palettes/palette";
import { DisplayShading, FogQuality } from '../../config/profiles/profile';
import { KernelTask } from '../../core/kernel';
import { assertExpr } from '../../utils/asserts';
import { ConstantFragProgram } from './shaders/constantFP';
import { DepthFragProgram } from './shaders/depthFP';
import { FlatVertProgram, HighpFlatVertProgram } from './shaders/flatVP';
import { ImpostorVertProgram } from './shaders/impostorVP';
import { TreeBillboardFragProgram } from './shaders/treeBillboardFP';
import { TreeBillboardVertProgram } from './shaders/treeBillboardVP';
import { LineVertProgram } from './shaders/lineVP';
import { ParticleMeshFragProgram } from './shaders/particlesMeshFP';
import { ParticleMeshVertProgram } from './shaders/particlesMeshVP';
import { PointVertProgram } from './shaders/pointVP';
import { ShadedVertProgram } from './shaders/shadedVP';
import { RIVER_MAX_STRETCH, RIVER_MIN_HALF_PIXELS, RiverVertProgram } from './shaders/riverVP';
import { TerrainFragProgram } from './shaders/terrainFP';
import {
    TERRAIN_CLASS_COUNT, TERRAIN_SWATCH_COUNT, TERRAIN_TONE_COUNT, TerrainVertProgram,
} from './shaders/terrainVP';
import { SUN_UNIFORMS } from './shaders/sun';
import { LANDUSE_BLEND_DEFAULT } from '../../terrain/tones';
import { makeNoCoverTexture } from '../../terrain/coverTextures';

export enum SceneMaterialPrimitiveType {
    MESH,
    LINE,
    POINT,
    PARTICLE_MESH,
    IMPOSTOR,
    TREE_BILLBOARD,
}

export type SceneMaterialProperties = SceneMaterialCommonProperties & (
    SceneMaterialMeshProperties |
    SceneMaterialLineProperties |
    SceneMaterialPointProperties |
    SceneMaterialParticleMeshProperties |
    SceneMaterialImpostorProperties |
    SceneMaterialTreeBillboardProperties
);

interface SceneMaterialCommonProperties {
    category: PaletteCategory;
    depthWrite: boolean;
    /**
     * Literal CSS colour (e.g. '#b5b4ba') that overrides the palette lookup for
     * this material. Used by models that carry their own per-polygon colours
     * (e.g. an imported mod, whose livery comes from a palette-swatch texture)
     * instead of mapping to a PaletteCategory. `category` is still used for fog.
     */
    rawColor?: string;
    /** true = force dither, false = solid primary, undefined = category default. */
    colorDither?: boolean;
}

/**
 * Turns a shaded mesh material into the terrain one: colour comes from the
 * mesh's own baked cover attributes rather than from this material's category.
 *
 * The material still owns everything else a terrain surface needs to match its
 * surroundings - the sun, the fog, the resolution snapping - so this is a
 * variant of the shaded material rather than a separate system.
 */
export interface TerrainMaterialSpec {
    /**
     * Palette category per land tone, index 0 being the first land tone. Read
     * on every palette change, so time of day reaches the LANDCOVER and HYBRID
     * modes the same way it reaches everything else.
     */
    toneCategories: readonly PaletteCategory[];
    /** Land tone index per cover class, in the same 0-based basis as above. */
    classTones: readonly number[];
    /** `#rrggbb` colours the SWATCH mode snaps to, from the bake manifest. */
    swatches: readonly string[];
    /** HYBRID mode: how many shade bands, and how far they reach either way. */
    shadeSteps: number;
    shadeRange: number;
    /** The bake's mean sRGB luminance, and one standard deviation of it. */
    shadeMid: number;
    shadeSpread: number;
}

type SceneMaterialMeshProperties = {
    type: SceneMaterialPrimitiveType.MESH;
} & (
        {
            shaded: true;
            /** Present on the terrain land material only. */
            terrain?: TerrainMaterialSpec;
            /**
             * Discard fragments with world Y below this (metres). Used to hide
             * ship hull below the waterline. Omit / undefined = no clip.
             */
            clipBelowY?: number;
        }
        |
        {
            shaded: false;
            highp?: boolean;
            /**
             * Widen a baked centreline into a ribbon, holding a floor in
             * pixels. Terrain watercourses only — see RiverVertProgram.
             */
            river?: boolean;
            /** Screen-space ordered dither opacity (0 = opaque, 0.5 ≈ half transparent). */
            alphaDither?: number;
            /**
             * Multiplier applied before the tone curve, for surfaces that are
             * brighter than a palette entry can say. Default 1.
             *
             * A palette colour tops out at #ffffff, which is nowhere near
             * enough for a light source: the sun's disc at sunset is a deeply
             * reddened orange whose blue channel is all but zero, so no
             * exposure could ever drive it to white and it read as a dull
             * yellow blob against a paler sky. Scaled up first, it clips the
             * way a light actually does - every channel, white at the core -
             * while the corona around it takes a smaller factor and keeps the
             * colour, which is the same light spread thinner.
             */
            overbright?: number;
        }
    );

interface SceneMaterialPointProperties {
    type: SceneMaterialPrimitiveType.POINT;
}

interface SceneMaterialLineProperties {
    type: SceneMaterialPrimitiveType.LINE;
}

interface SceneMaterialParticleMeshProperties {
    type: SceneMaterialPrimitiveType.PARTICLE_MESH;
    /**
     * Minimum projected height in pixels. Distant particles are enlarged to this
     * size so small world-space chips stay visible. 0 = off.
     */
    minPixels?: number;
}

/** Camera-facing billboard used as a distant vegetation impostor. */
interface SceneMaterialImpostorProperties {
    type: SceneMaterialPrimitiveType.IMPOSTOR;
}

/**
 * Camera-facing billboard sampling a species' 4-view tree atlas (see
 * treeAtlas.ts) instead of a flat palette colour.
 */
interface SceneMaterialTreeBillboardProperties {
    type: SceneMaterialPrimitiveType.TREE_BILLBOARD;
    map: THREE.Texture;
}

export type SceneMaterialUniforms = SceneFlatMaterialUniforms | SceneShadedMaterialUniforms;

interface SceneFlatMaterialUniforms {
    overbright: { value: number; };
    halfWidth: { value: number; };
    halfHeight: { value: number; };
    vCameraPos: { value: THREE.Vector3; };
    vCameraNormal: { value: THREE.Vector3; };
    vCameraD: { value: number; };
    shadingType: { value: number; };
    color: { value: THREE.Color; };
    colorSecondary: { value: THREE.Color; };
    fogDensity: { value: number; };
    fogColor: { value: THREE.Color; };
    fogType: { value: number; };
    alphaDither: { value: number; };
    colorDither: { value: number; };
    [uniform: string]: THREE.IUniform<any>;
}

interface SceneShadedMaterialUniforms {
    halfWidth: { value: number; };
    halfHeight: { value: number; };
    distance: { value: number; };
    shadingType: { value: number; };
    color: { value: THREE.Color; };
    colorSecondary: { value: THREE.Color; };
    fogDensity: { value: number; };
    fogColor: { value: THREE.Color; };
    normalModelMatrix: { value: THREE.Matrix3; };
    /** World-Y clip; very negative = disabled. */
    clipBelowY: { value: number; };
    [uniform: string]: THREE.IUniform<any>;
}

export type SceneMaterialData = SceneCommonMaterialData & (SceneFlatMaterialData | SceneShadedMaterialData);

interface SceneCommonMaterialData {
    category: PaletteCategory;
    rawColor?: string;
    depthWrite: boolean;
    particles: boolean;
    line: boolean;
    point: boolean;
    fog: FogQuality;
    shading: DisplayShading;
    ramp?: THREE.Color[]; // Particle materials only
}

interface SceneFlatMaterialData {
    shaded: false;
    highp: boolean;
}

interface SceneShadedMaterialData {
    shaded: true;
    /** Absolute ENU Y waterline clip (metres); adjusted by RENDER_ORIGIN each draw. */
    clipBelowYAbs: number;
    terrain?: TerrainMaterialSpec;
}

export class SceneMaterialManager implements KernelTask {

    private readonly flatProto: THREE.ShaderMaterial;
    private readonly highpFlatProto: THREE.ShaderMaterial;
    private readonly riverProto: THREE.ShaderMaterial;
    private readonly lineProto: THREE.ShaderMaterial;
    private readonly shadedProto: THREE.ShaderMaterial;
    private readonly terrainProto: THREE.ShaderMaterial;
    /** Bound to uCoverTex on every terrain draw that has no cover texture. */
    private readonly noCoverTexture = makeNoCoverTexture();
    private readonly pointProto: THREE.ShaderMaterial;
    private readonly particleMeshProto: THREE.ShaderMaterial;
    private readonly impostorProto: THREE.ShaderMaterial;
    private readonly treeBillboardProto: THREE.ShaderMaterial;
    private readonly colorCache: ColorCache = new ColorCache();
    private palette: Palette;
    private fog: FogQuality;
    private shading: DisplayShading;
    private materials: THREE.ShaderMaterial[] = [];
    private fxFire: THREE.ShaderMaterial[] = [];

    constructor(palette: Palette, fog: FogQuality, shading: DisplayShading) {
        this.palette = palette;
        this.fog = fog;
        this.shading = shading;

        this.flatProto = new THREE.ShaderMaterial({
            vertexShader: FlatVertProgram,
            fragmentShader: DepthFragProgram,
            side: THREE.FrontSide,
            depthWrite: false,
            userData: {},
            uniforms: {}
        });
        this.highpFlatProto = new THREE.ShaderMaterial({
            vertexShader: HighpFlatVertProgram,
            fragmentShader: DepthFragProgram,
            side: THREE.FrontSide,
            depthWrite: false,
            userData: {},
            uniforms: {}
        });
        this.riverProto = new THREE.ShaderMaterial({
            vertexShader: RiverVertProgram,
            fragmentShader: DepthFragProgram,
            // A stroke has no inside: the ribbon is built from the centreline
            // out, so which way it winds depends on which way the river runs.
            side: THREE.DoubleSide,
            depthWrite: false,
            userData: {},
            uniforms: {}
        });
        this.lineProto = new THREE.ShaderMaterial({
            vertexShader: LineVertProgram,
            fragmentShader: DepthFragProgram,
            side: THREE.FrontSide,
            depthWrite: true,
            userData: {},
            uniforms: {}
        });
        this.shadedProto = new THREE.ShaderMaterial({
            vertexShader: ShadedVertProgram,
            fragmentShader: ConstantFragProgram,
            side: THREE.FrontSide,
            depthWrite: true,
            userData: {},
            uniforms: {}
        });
        this.terrainProto = new THREE.ShaderMaterial({
            vertexShader: TerrainVertProgram,
            fragmentShader: TerrainFragProgram,
            side: THREE.FrontSide,
            depthWrite: true,
            userData: {},
            uniforms: {}
        });
        this.pointProto = new THREE.ShaderMaterial({
            vertexShader: PointVertProgram,
            fragmentShader: DepthFragProgram,
            depthWrite: true,
            userData: {},
            uniforms: {}
        });
        this.particleMeshProto = new THREE.RawShaderMaterial({
            vertexShader: ParticleMeshVertProgram,
            fragmentShader: ParticleMeshFragProgram,
            // Discs are billboarded in view-space XY; FrontSide culls them (normal +Z
            // faces away from the camera). DoubleSide keeps smoke/debris visible.
            side: THREE.DoubleSide,
            depthWrite: true,
            userData: {},
            uniforms: {}
        });
        this.impostorProto = new THREE.ShaderMaterial({
            vertexShader: ImpostorVertProgram,
            fragmentShader: DepthFragProgram,
            side: THREE.DoubleSide,
            depthWrite: true,
            userData: {},
            uniforms: {}
        });
        this.treeBillboardProto = new THREE.ShaderMaterial({
            vertexShader: TreeBillboardVertProgram,
            fragmentShader: TreeBillboardFragProgram,
            side: THREE.DoubleSide,
            depthWrite: true,
            userData: {},
            uniforms: {}
        });
    }

    build(properties: SceneMaterialProperties): THREE.Material {
        const p = this.sanitiseProperties(properties);
        const data = this.buildData(p, this.palette);
        const material = this.cloneMaterial(p);
        material.depthWrite = p.depthWrite;
        material.userData = data;
        material.uniforms = this.buildUniforms(p);
        this.materials.push(material);
        if (data.category === PaletteCategory.FX_FIRE) {
            this.fxFire.push(material);
        }
        return material;
    }

    update(delta: number) {
        this.updateFxFire();
    }

    private updateFxFire() {
        // Steady two-tone fire. Previously this alternated the whole material
        // between FX_FIRE and FX_FIRE__B at 100Hz, which read as a harsh
        // orange/yellow flicker (most visibly on engine nozzles). Instead we set
        // both tones once and let the shader's ordered dither (colorDither) stipple
        // them per-pixel: a steady retro dither with no temporal flicker.
        const color = this.colorCache.getColor(PaletteColor(this.palette, PaletteCategory.FX_FIRE));
        const colorSecondary = this.colorCache.getColor(PaletteColor(this.palette, PaletteCategory.FX_FIRE__B));
        for (let i = 0; i < this.fxFire.length; i++) {
            const data = this.fxFire[i].userData as SceneMaterialData & { afterburnerThrottleDriven?: boolean };
            if (data.afterburnerThrottleDriven) {
                continue;
            }
            const u = this.fxFire[i].uniforms as SceneMaterialUniforms;
            u.color.value.copy(color);
            u.colorSecondary.value.copy(colorSecondary);
        }
    }

    private sanitiseProperties(properties: SceneMaterialProperties): SceneMaterialProperties {
        if (this.isFx(properties)) {
            return {
                ...properties,
                shaded: false,
                highp: undefined
            } as SceneMaterialProperties;
        }
        return { ...properties };
    }

    private buildData(properties: SceneMaterialProperties, palette: Palette): SceneMaterialData {
        const shaded = properties.type === SceneMaterialPrimitiveType.MESH && properties.shaded;
        return {
            shaded,
            shading: this.shading,
            category: properties.category,
            rawColor: properties.rawColor,
            depthWrite: properties.depthWrite,
            particles: properties.type === SceneMaterialPrimitiveType.PARTICLE_MESH,
            line: properties.type === SceneMaterialPrimitiveType.LINE,
            point: this.isPoint(properties),
            highp: properties.type === SceneMaterialPrimitiveType.MESH && !properties.shaded && properties.highp || false,
            fog: this.fog,
            ...(shaded ? {
                clipBelowYAbs: typeof properties.clipBelowY === 'number' ? properties.clipBelowY : -1e30,
                terrain: properties.terrain,
            } : {}),
            ramp: (properties.type === SceneMaterialPrimitiveType.PARTICLE_MESH && (
                properties.category === PaletteCategory.FX_SMOKE
                || properties.category === PaletteCategory.FX_FIRE
            )) ? [
                this.colorCache.getColor(PaletteColor(palette, properties.category === PaletteCategory.FX_FIRE
                    ? PaletteCategory.FX_FIRE
                    : PaletteCategory.FX_SMOKE)).clone(),
                this.colorCache.getColor(PaletteColor(palette, properties.category === PaletteCategory.FX_FIRE
                    ? PaletteCategory.FX_FIRE__B
                    : PaletteCategory.FX_SMOKE__B)).clone(),
                this.colorCache.getColor(PaletteColor(palette, properties.category === PaletteCategory.FX_FIRE
                    ? PaletteCategory.FX_SMOKE
                    : PaletteCategory.FX_SMOKE__C)).clone(),
            ] : undefined,
        } as SceneMaterialData;
    }

    private categoryUsesColorDither(category: PaletteCategory): boolean {
        // Fire keeps a forced two-tone stipple in every shading mode.
        // Plane/ground shadows use alpha dither for semi-transparency instead.
        return category === PaletteCategory.FX_FIRE;
    }

    private colorDitherUniform(properties: SceneMaterialProperties): number {
        if (properties.colorDither === true) {
            return 1;
        }
        if (properties.colorDither === false) {
            return -1;
        }
        return this.categoryUsesColorDither(properties.category) ? 1 : 0;
    }

    private buildUniforms(properties: SceneMaterialProperties): SceneMaterialUniforms {
        return {
            ...{
                halfWidth: { value: 0 },
                halfHeight: { value: 0 },
                shadingType: { value: this.shading },
                color: { value: new THREE.Color(properties.rawColor ?? PaletteColor(this.palette, properties.category)) },
                colorSecondary: { value: new THREE.Color(properties.rawColor ?? PaletteColorShade(this.palette, properties.category)) },
                fogType: { value: this.fog },
                fogDensity: { value: this.palette.values[FogValueCategory(properties.category)] },
                fogColor: { value: new THREE.Color(PaletteColor(this.palette, FogColorCategory(properties.category))) },
                alphaDither: {
                    value: properties.type === SceneMaterialPrimitiveType.MESH && !properties.shaded
                        ? (properties.alphaDither ?? 0)
                        : 0,
                },
                overbright: {
                    value: properties.type === SceneMaterialPrimitiveType.MESH && !properties.shaded
                        ? (properties.overbright ?? 1)
                        : 1,
                },
                // Fire renders as a steady two-tone ordered dither (orange/yellow)
                // in every shading mode rather than a temporal colour flip.
                colorDither: {
                    value: this.colorDitherUniform(properties)
                },
                minPixels: {
                    value: properties.type === SceneMaterialPrimitiveType.PARTICLE_MESH
                        ? (properties.minPixels ?? 0)
                        : 0,
                },
                uMinHalfPixels: {
                    value: properties.type === SceneMaterialPrimitiveType.MESH
                        && !properties.shaded && properties.river
                        ? RIVER_MIN_HALF_PIXELS
                        : 0,
                },
                uMaxStretch: { value: RIVER_MAX_STRETCH },
                uRenderOrigin: { value: new THREE.Vector3() },
                // Reference (noon) forest colour, in the same colour space as the
                // palette's, so the tree shader can dim trunks by how much the
                // current palette's forest has darkened against it.
                uNoonForest: { value: new THREE.Color('#2f6b3c') },
                uMap: {
                    value: properties.type === SceneMaterialPrimitiveType.TREE_BILLBOARD
                        ? properties.map
                        : null,
                },
                // Shared by reference: moving the sun (time of day) rewrites
                // these once and every material sees it.
                ...SUN_UNIFORMS,
            },
            ...(properties.type === SceneMaterialPrimitiveType.MESH && properties.shaded) ? {
                distance: { value: 0 },
                normalModelMatrix: { value: new THREE.Matrix3() },
                clipBelowY: {
                    value: typeof properties.clipBelowY === 'number'
                        ? properties.clipBelowY
                        : -1e30,
                },
                ...(properties.terrain ? this.buildTerrainUniforms(properties.terrain) : {}),
            } : {
                vCameraPos: { value: new THREE.Vector3() },
                vCameraNormal: { value: new THREE.Vector3() },
                vCameraD: { value: 0 }
            }
        };
    }

    private buildTerrainUniforms(spec: TerrainMaterialSpec): Record<string, THREE.IUniform> {
        // Uniform arrays are fixed-length in GLSL, so both tables are padded to
        // the size the shader declares rather than to what this bake happens to
        // use. uSwatchCount is what stops the shader reading the padding.
        const toneColors: THREE.Color[] = [];
        for (let i = 0; i < TERRAIN_TONE_COUNT; i++) {
            const category = spec.toneCategories[i] ?? PaletteCategory.TERRAIN_DEFAULT;
            toneColors.push(this.colorCache.getColor(PaletteColor(this.palette, category)).clone());
        }
        // Vector3, not Color, and on purpose: THREE.Color decodes sRGB to the
        // linear working space, and the shader wants these in the space the
        // bake picked them in. See uSwatch in terrainVP.
        const swatches: THREE.Vector3[] = [];
        for (let i = 0; i < TERRAIN_SWATCH_COUNT; i++) {
            swatches.push(srgbVector(spec.swatches[i]));
        }
        const classTones = new Float32Array(TERRAIN_CLASS_COUNT);
        for (let i = 0; i < TERRAIN_CLASS_COUNT; i++) {
            classTones[i] = spec.classTones[i] ?? 0;
        }
        return {
            uTerrainMode: { value: 0 },
            uToneColor: { value: toneColors },
            uClassTone: { value: classTones },
            uSwatch: { value: swatches },
            uSwatchCount: { value: Math.min(spec.swatches.length, TERRAIN_SWATCH_COUNT) },
            uShadeSteps: { value: spec.shadeSteps },
            uShadeRange: { value: spec.shadeRange },
            uShadeWindow: { value: new THREE.Vector2(spec.shadeMid, spec.shadeSpread) },
            uRawLight: { value: new THREE.Vector3(1, 1, 1) },
            // Share of a land-use facet's Hybrid colour taken from its palette
            // tone; the rest is its sampled colour. See LanduseBlendSetting.
            uLanduseBlend: { value: LANDUSE_BLEND_DEFAULT },
            // The leaf dissolve, per tile, set per draw by the terrain
            // entity's tileBeforeRender. See lodReveal in terrainVP and
            // uDepthPush in logDepth.
            uLodFadeM: { value: 0 },
            uLodFadeCap: { value: 1 },
            uLodFills: { value: 0 },
            uDepthPush: { value: 0 },
            // Land-use regions by size; the entity sets the scale per
            // reconcile from the viewport. See LANDUSE_REVEAL_MIN_PX.
            uSizeRevealScale: { value: 0 },
            // The far cover texture, per tile, set per draw by
            // tileBeforeRender. The sampler always has *a* texture bound -
            // a lone no-data texel - so a draw without one is well-formed.
            uCoverTex: { value: this.noCoverTexture },
            uHasCoverTex: { value: 0 },
            uCoverEnabled: { value: 1 },
            uCoverEast: { value: new THREE.Vector3() },
            uCoverNorth: { value: new THREE.Vector3() },
            uCoverK: { value: 0 },
        };
    }

    private isPoint(properties: SceneMaterialProperties): boolean {
        return properties.type === SceneMaterialPrimitiveType.POINT ||
            properties.category === PaletteCategory.SCENERY_SPECKLE ||
            properties.category === PaletteCategory.LIGHT_RED ||
            properties.category === PaletteCategory.LIGHT_GREEN ||
            properties.category === PaletteCategory.LIGHT_YELLOW;
    }

    private isFx(properties: SceneMaterialProperties): boolean {
        return properties.category.startsWith(PALETTE_FX_PREFIX);
    }

    private cloneMaterial(properties: SceneMaterialProperties): ShaderMaterial {
        if (this.isPoint(properties)) {
            return this.pointProto.clone();
        } else if (properties.type === SceneMaterialPrimitiveType.LINE) {
            return this.lineProto.clone();
        } else if (properties.type === SceneMaterialPrimitiveType.MESH) {
            if (properties.shaded) {
                return properties.terrain ? this.terrainProto.clone() : this.shadedProto.clone();
            } else if (properties.river) {
                return this.riverProto.clone();
            } else if (properties.highp) {
                return this.highpFlatProto.clone();
            } else {
                return this.flatProto.clone();
            }
        } else if (properties.type === SceneMaterialPrimitiveType.PARTICLE_MESH) {
            return this.particleMeshProto.clone();
        } else if (properties.type === SceneMaterialPrimitiveType.IMPOSTOR) {
            return this.impostorProto.clone();
        } else if (properties.type === SceneMaterialPrimitiveType.TREE_BILLBOARD) {
            return this.treeBillboardProto.clone();
        }
        assertExpr(false, 'This should never happen');
    }

    setPalette(palette: Palette) {
        this.palette = palette;

        for (let i = 0; i < this.materials.length; i++) {
            const m = this.materials[i];
            const d = m.userData as SceneMaterialData & { wingtipTrailDriven?: boolean };
            if (d.wingtipTrailDriven) {
                continue;
            }
            const u = m.uniforms as SceneMaterialUniforms;
            const c = d.category;
            if (!d.rawColor) {
                u.color.value.copy(this.colorCache.getColor(PaletteColor(palette, c)));
                u.colorSecondary.value.copy(this.colorCache.getColor(PaletteColorShade(palette, c)));
            } else if (palette.light) {
                // A raw colour opted out of the palette, so the blend above
                // never reaches it: a mod's camo used to stay at noon
                // brightness against a midnight landscape, lit or not. The
                // uniforms are linear light, which is what the factor is in,
                // so it multiplies straight in with no round trip.
                const raw = this.colorCache.getColor(d.rawColor);
                const light = palette.light;
                u.color.value.setRGB(raw.r * light[0], raw.g * light[1], raw.b * light[2]);
                u.colorSecondary.value.copy(u.color.value);
            }
            if (d.shaded && d.terrain) {
                // Two halves, matching what the modes are made of: the tone
                // table follows the blended palette like any authored colour,
                // and the imagery light factor is the raw-colour one above.
                const tones = u.uToneColor.value as THREE.Color[];
                for (let t = 0; t < tones.length; t++) {
                    const category = d.terrain.toneCategories[t] ?? PaletteCategory.TERRAIN_DEFAULT;
                    tones[t].copy(this.colorCache.getColor(PaletteColor(palette, category)));
                }
                const light = palette.light ?? [1, 1, 1];
                (u.uRawLight.value as THREE.Vector3).set(light[0], light[1], light[2]);
            }
            u.fogDensity.value = palette.values[FogValueCategory(c)];
            u.fogColor.value.copy(this.colorCache.getColor(PaletteColor(palette, FogColorCategory(c))));
            if (d.particles && d.ramp) {
                if (d.category === PaletteCategory.FX_SMOKE) {
                    d.ramp[0].copy(this.colorCache.getColor(PaletteColor(palette, PaletteCategory.FX_SMOKE)));
                    d.ramp[1].copy(this.colorCache.getColor(PaletteColor(palette, PaletteCategory.FX_SMOKE__B)));
                    d.ramp[2].copy(this.colorCache.getColor(PaletteColor(palette, PaletteCategory.FX_SMOKE__C)));
                } else if (d.category === PaletteCategory.FX_FIRE) {
                    d.ramp[0].copy(this.colorCache.getColor(PaletteColor(palette, PaletteCategory.FX_FIRE)));
                    d.ramp[1].copy(this.colorCache.getColor(PaletteColor(palette, PaletteCategory.FX_FIRE__B)));
                    d.ramp[2].copy(this.colorCache.getColor(PaletteColor(palette, PaletteCategory.FX_SMOKE)));
                }
            }
        }
        this.updateFxFire();
    }

    // This shouldn't be handled by the material system
    setFog(fog: FogQuality) {
        this.fog = fog;

        for (let i = 0; i < this.materials.length; i++) {
            const m = this.materials[i];
            const d = m.userData as SceneMaterialData;
            d.fog = this.fog;
            const u = m.uniforms as SceneMaterialUniforms;
            u.fogType.value = this.fog;
        }
    }

    // This shouldn't be handled by the material system
    /** Current shading mode. */
    getShadingType(): DisplayShading {
        return this.shading;
    }

    setShadingType(shadingType: DisplayShading) {
        this.shading = shadingType;

        for (let i = 0; i < this.materials.length; i++) {
            const m = this.materials[i];
            const d = m.userData as SceneMaterialData;
            d.shading = shadingType;
            const u = m.uniforms as SceneMaterialUniforms;
            u.shadingType.value = shadingType;
        }
    }
}

/** `#rrggbb` to its raw 0..1 sRGB components, with no colour-space decode. */
function srgbVector(css: string | undefined): THREE.Vector3 {
    const hex = css?.trim().replace(/^#/, '') ?? '';
    if (hex.length !== 6) {
        return new THREE.Vector3(0, 0, 0);
    }
    const n = parseInt(hex, 16);
    if (Number.isNaN(n)) {
        return new THREE.Vector3(0, 0, 0);
    }
    return new THREE.Vector3(
        ((n >> 16) & 0xff) / 255,
        ((n >> 8) & 0xff) / 255,
        (n & 0xff) / 255,
    );
}

class ColorCache {
    private map: Map<string, THREE.Color> = new Map();

    constructor() { }

    getColor(css: string): THREE.Color {
        let c = this.map.get(css);
        if (!c) {
            c = new THREE.Color(css);
            this.map.set(css, c);
        }
        return c;
    }
}