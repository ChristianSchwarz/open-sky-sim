import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PaletteCategory } from '../../../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from "../../materials/materials";
import { updateUniforms } from '../../utils';
import { SUN_UNIFORMS, SUN_VISIBILITY } from '../../materials/shaders/sun';
import { Model, ModelLibBuilder } from "../models";
import { mergeGeometries } from './vegetationModelBuilder';

/** Share of its light a cloud keeps when the sun is wholly hidden from the viewer. */
const HIDDEN_SUN_CLOUD_LIGHT = 0.35;

/** Light a solid cloud keeps with the sun hidden: a dim, slightly blue skylight. */
const HIDDEN_SUN_SKYLIGHT = new THREE.Vector3(0.3, 0.3, 0.38);

type BeforeRender = THREE.Object3D['onBeforeRender'];
type BeforeRenderArgs = Parameters<typeof updateUniforms>;

/**
 * One of a material's colour uniforms, with the undimmed value kept beside it.
 *
 * The palette rewrites the uniform in place whenever it changes, so the base is
 * re-read from the material whenever it holds something other than what this
 * last wrote.
 */
class DimmedColour {
    readonly base = new THREE.Color();
    private readonly applied = new THREE.Color(NaN, NaN, NaN);

    constructor(readonly target: THREE.Color) {}

    refresh(): void {
        if (!this.target.equals(this.applied)) {
            this.base.copy(this.target);
        }
    }

    write(colour: THREE.Color): void {
        this.target.copy(colour);
        this.applied.copy(colour);
    }
}

/** Per-material state, found from the material a draw is actually given. */
const hazeStates = new WeakMap<THREE.Material, DimmedColour[]>();

/**
 * A before-render hook for the unshaded haze puffs: dims their palette colours
 * by the same factor the solid body's light falls by. It works on the material
 * the draw passes in, not the one the builder made, since a pass may swap or
 * clone materials.
 */
function sunVisibleColours(): BeforeRender {
    const scratch = new THREE.Color();
    const hook = function (this: THREE.Mesh, ...args: BeforeRenderArgs) {
        const material = args[4] as THREE.ShaderMaterial;
        let slots = hazeStates.get(material);
        if (slots === undefined) {
            slots = ['color', 'colorSecondary'].map(n => new DimmedColour(material.uniforms[n].value));
            hazeStates.set(material, slots);
        }
        const scale = HIDDEN_SUN_CLOUD_LIGHT + (1 - HIDDEN_SUN_CLOUD_LIGHT) * SUN_VISIBILITY.value;
        for (const s of slots) {
            s.refresh();
            s.write(scratch.copy(s.base).multiplyScalar(scale));
        }
        updateUniforms.apply(this, args);
    } as BeforeRender;
    return Object.assign(hook, { keepOnClone: true });
}

interface SolidCloudState {
    direct: THREE.Vector3;
    tint: THREE.Vector3;
    ambient: THREE.Vector3;
    shade: THREE.Vector2;
    lit: DimmedColour;
    shadow: DimmedColour;
}

const solidStates = new WeakMap<THREE.Material, SolidCloudState>();

/**
 * A before-render hook that lights the solid cloud with the sun scaled by how
 * much of it the viewer can see (SUN_VISIBILITY), leaving every other material
 * on the shared sun uniforms untouched.
 *
 * The material gets private copies of the direct-beam uniforms, rewritten each
 * draw from the shared ones, so the time of day still drives them.
 */
function sunVisibleUniforms(): BeforeRender {
    const hidden = new THREE.Color();
    const dimmed = new THREE.Color();
    const hook = function (this: THREE.Mesh, ...args: BeforeRenderArgs) {
        const material = args[4] as THREE.ShaderMaterial;
        let st = solidStates.get(material);
        if (st === undefined) {
            st = {
                direct: new THREE.Vector3(),
                tint: new THREE.Vector3(),
                ambient: new THREE.Vector3(),
                shade: new THREE.Vector2(),
                lit: new DimmedColour(material.uniforms.color.value),
                shadow: new DimmedColour(material.uniforms.colorSecondary.value),
            };
            material.uniforms.uSunDirect = { value: st.direct };
            material.uniforms.uSunTint = { value: st.tint };
            material.uniforms.uSunShade = { value: st.shade };
            material.uniforms.uSunAmbient = { value: st.ambient };
            solidStates.set(material, st);
        }
        const v = SUN_VISIBILITY.value;
        // The shared ambient is nearly out by dusk, so scaling it cannot leave a
        // hidden-sun cloud anything: it blends to a fixed cool skylight instead.
        st.ambient.copy(SUN_UNIFORMS.uSunAmbient.value).lerp(HIDDEN_SUN_SKYLIGHT, 1 - v);
        st.direct.copy(SUN_UNIFORMS.uSunDirect.value).multiplyScalar(v);
        st.tint.copy(SUN_UNIFORMS.uSunTint.value).multiplyScalar(v);
        // The duotone modes cut on this scalar pair instead of multiplying, and
        // dusk leaves the ambient weight near 1, which reads as fully lit. Both
        // weights fall with the sun so a hidden sun drops the cloud to its
        // shadow tone, which is then lifted off black below.
        const total = SUN_UNIFORMS.uSunShade.value;
        st.shade.set(total.x * (0.5 + 0.5 * v), total.y * v);
        st.lit.refresh();
        st.shadow.refresh();
        st.lit.write(st.lit.base);
        st.shadow.write(hidden.copy(st.shadow.base).lerp(
            dimmed.copy(st.lit.base).multiplyScalar(HIDDEN_SUN_CLOUD_LIGHT), 1 - v));
        updateUniforms.apply(this, args);
    } as BeforeRender;
    return Object.assign(hook, { keepOnClone: true });
}

/** A single faceted puff within a cloud cluster, in local space (metres). */
export interface CloudPuffLobe {
    x: number;
    y: number;
    z: number;
    r: number;
}

/**
 * Hand-placed lobe clusters, low-poly icosahedrons merged into one mesh —
 * the same "clump of overlapping blobs" trick used for tree canopies
 * (see vegetationModelBuilder.ts), just scaled up and flattened out for
 * puffy, flat-shaded 90s-style cumulus silhouettes.
 */
export const CLOUD_PUFF_SHAPES: Record<string, CloudPuffLobe[]> = {
    small: [
        { x: 0, y: 0, z: 0, r: 110 },
        { x: 95, y: 20, z: 45, r: 85 },
        { x: -90, y: 15, z: -40, r: 80 },
        { x: 15, y: 55, z: -15, r: 70 },
        { x: -50, y: 30, z: 60, r: 65 },
        { x: 70, y: 10, z: -70, r: 60 },
        { x: -30, y: 45, z: 40, r: 55 },
        { x: 110, y: 5, z: -30, r: 50 },
        { x: -100, y: 40, z: 20, r: 55 },
        { x: 40, y: 60, z: -40, r: 48 },
    ],
    medium: [
        { x: -170, y: 0, z: 0, r: 150 },
        { x: 30, y: 30, z: 30, r: 190 },
        { x: 200, y: 8, z: -25, r: 160 },
        { x: 60, y: 85, z: -10, r: 120 },
        { x: -60, y: 60, z: 45, r: 105 },
        { x: -140, y: 40, z: -80, r: 90 },
        { x: 150, y: 60, z: 80, r: 95 },
        { x: 10, y: 120, z: -40, r: 80 },
        { x: 260, y: 30, z: 20, r: 100 },
        { x: -220, y: 15, z: 10, r: 110 },
        { x: 90, y: 30, z: -90, r: 90 },
        { x: 100, y: 100, z: 60, r: 85 },
        { x: -100, y: 90, z: -50, r: 80 },
        { x: 180, y: 100, z: -70, r: 75 },
    ],
    large: [
        { x: -230, y: 0, z: 0, r: 200 },
        { x: 30, y: 15, z: 60, r: 260 },
        { x: 260, y: 8, z: -45, r: 210 },
        { x: 80, y: 120, z: -15, r: 180 },
        { x: -90, y: 170, z: 45, r: 150 },
        { x: 15, y: 250, z: 0, r: 120 },
        { x: -200, y: 60, z: -120, r: 140 },
        { x: 220, y: 70, z: 120, r: 150 },
        { x: -50, y: 220, z: -60, r: 100 },
        { x: 120, y: 280, z: 20, r: 90 },
        { x: 330, y: 30, z: 10, r: 130 },
        { x: -320, y: 20, z: 0, r: 140 },
        { x: 0, y: 40, z: 130, r: 120 },
        { x: -30, y: 40, z: -180, r: 130 },
        { x: 150, y: 150, z: 80, r: 110 },
        { x: -150, y: 140, z: -80, r: 100 },
        { x: 0, y: 200, z: 100, r: 95 },
        { x: 200, y: 40, z: 180, r: 110 },
        { x: -220, y: 40, z: -180, r: 100 },
    ],
};

/**
 * Squash every vertex below `localFlattenY` (lobe-local space, pre-translate)
 * onto that plane. Lobes anchored at the cluster's lowest point end up as a
 * clean hemisphere-on-a-disk; lobes stacked higher for a towering silhouette
 * fall fully above the cut and stay round, since their underside is buried
 * inside the puffs below anyway. Gives the whole cluster one level, flat
 * underside — like real cumulus — instead of a floating blob.
 */
function flattenBase(geometry: THREE.BufferGeometry, localFlattenY: number): THREE.BufferGeometry {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < localFlattenY) {
            pos.setY(i, localFlattenY);
        }
    }
    pos.needsUpdate = true;
    return geometry;
}

/**
 * Merge lobes into one geometry with smooth, welded per-vertex normals —
 * Gouraud shading for the solid body (lit per-vertex, interpolated across
 * each face) instead of the hard faceted look. `mergeGeometries` (used for
 * the haze puffs and vegetation) concatenates non-indexed positions and
 * computes flat per-face normals, which is right for those unshaded callers
 * but wrong here: welding coincident vertices back into an indexed geometry
 * first lets `computeVertexNormals` average adjacent face normals per shared
 * vertex within each lobe, instead of one flat normal per triangle.
 */
function mergeGeometriesSmooth(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
    let totalVertices = 0;
    const nonIndexed: THREE.BufferGeometry[] = [];
    for (const geo of geometries) {
        const flat = geo.index ? geo.toNonIndexed() : geo;
        nonIndexed.push(flat);
        totalVertices += flat.getAttribute('position').count;
    }
    const positions = new Float32Array(totalVertices * 3);
    let offset = 0;
    for (const geo of nonIndexed) {
        const attr = geo.getAttribute('position');
        positions.set(attr.array as Float32Array, offset);
        offset += attr.count * 3;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const welded = mergeVertices(merged);
    welded.computeVertexNormals();
    return welded;
}

/** Deterministic [0,1) hash — avoids Math.random() so a model's shape is stable across rebuilds. */
function hash01(n: number): number {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
}

/** Half-angle (rad) of the cone around straight-up that the top growth puffs are scattered within. */
const HAZE_SCATTER_HALF_ANGLE = Math.PI * 0.3;
/**
 * Upper theta bound for the side puffs. Kept short of the true horizon
 * (0.5π) — at grazing angles dirY collapses toward 0, so a puff on a lobe
 * near the flat base has nothing to lift it and ends up hugging the
 * underside plane, where its dither stipple reads as holes punched through
 * the flat bottom. Stopping short keeps every side puff meaningfully above
 * its lobe's own centre before the base clamp even has to act.
 */
const HAZE_SIDE_MAX_ANGLE = Math.PI * 0.4;

interface HazeTier {
    puffsPerLobe: number;
    /** Screen-space stipple density: higher = more opaque, lower = more see-through. */
    alphaDither: number;
    distMin: number;
    distMax: number;
    radiusMin: number;
    radiusMax: number;
    /** Angle off straight-up (rad) puffs are scattered within; defaults to [0, HAZE_SCATTER_HALF_ANGLE] (top only). */
    thetaMin?: number;
    thetaMax?: number;
}

/**
 * Density bands, closest/densest to farthest/sparsest — mimics how a real
 * cumulus top softens gradually from the solid body into thin haze rather
 * than cutting off at one uniform transparency.
 */
const HAZE_TIERS: HazeTier[] = [
    { puffsPerLobe: 4, alphaDither: 0.98, distMin: 0.15, distMax: 0.28, radiusMin: 0.45, radiusMax: 0.65 },
    { puffsPerLobe: 4, alphaDither: 0.95, distMin: 0.25, distMax: 0.4, radiusMin: 0.4, radiusMax: 0.6 },
    { puffsPerLobe: 4, alphaDither: 0.88, distMin: 0.35, distMax: 0.5, radiusMin: 0.35, radiusMax: 0.55 },
    { puffsPerLobe: 5, alphaDither: 0.75, distMin: 0.5, distMax: 0.68, radiusMin: 0.3, radiusMax: 0.48 },
    { puffsPerLobe: 5, alphaDither: 0.6, distMin: 0.68, distMax: 0.88, radiusMin: 0.26, radiusMax: 0.42 },
    { puffsPerLobe: 4, alphaDither: 0.45, distMin: 0.88, distMax: 1.08, radiusMin: 0.2, radiusMax: 0.34 },
    { puffsPerLobe: 4, alphaDither: 0.3, distMin: 1.08, distMax: 1.3, radiusMin: 0.15, radiusMax: 0.28 },
    // Outermost: a few faint, thin wisps drifting further out than the rest,
    // detached from the main haze mass.
    { puffsPerLobe: 3, alphaDither: 0.18, distMin: 1.3, distMax: 1.6, radiusMin: 0.12, radiusMax: 0.22 },
    // Side puffs: pick up past the top cone, out toward (but never past) the
    // horizon. The Y-clamp in buildHazeTierGeometry still guarantees these
    // never dip below the cluster's flat underside even at grazing angles.
    { puffsPerLobe: 5, alphaDither: 0.7, distMin: 0.55, distMax: 0.75, radiusMin: 0.28, radiusMax: 0.44, thetaMin: HAZE_SCATTER_HALF_ANGLE, thetaMax: HAZE_SIDE_MAX_ANGLE },
    { puffsPerLobe: 5, alphaDither: 0.5, distMin: 0.75, distMax: 0.98, radiusMin: 0.22, radiusMax: 0.36, thetaMin: HAZE_SCATTER_HALF_ANGLE, thetaMax: HAZE_SIDE_MAX_ANGLE },
    { puffsPerLobe: 4, alphaDither: 0.3, distMin: 0.98, distMax: 1.2, radiusMin: 0.17, radiusMax: 0.28, thetaMin: HAZE_SCATTER_HALF_ANGLE, thetaMax: HAZE_SIDE_MAX_ANGLE },
    { puffsPerLobe: 3, alphaDither: 0.18, distMin: 1.2, distMax: 1.5, radiusMin: 0.14, radiusMax: 0.24, thetaMin: HAZE_SCATTER_HALF_ANGLE, thetaMax: HAZE_SIDE_MAX_ANGLE },
];

/**
 * Extra icosahedron puffs — same construction as the solid lobes, just
 * smaller and scattered over each lobe's top and sides (confined to an angle
 * band off straight-up that never reaches past the horizon, so they never
 * wrap onto the underside). Each puff's own bottom is then clamped to stay
 * at or above the cluster's flat base (`minY`), so a wide-angle puff on a low
 * lobe can never dip below the solid body's underside. Rendered separately
 * per tier with a dithered stipple (see build()) so they read as soft,
 * semi-transparent growth billowing off the cloud, thinning out with
 * distance from the solid body.
 */
function buildHazeTierGeometry(lobes: CloudPuffLobe[], tier: HazeTier, tierIndex: number, minY: number): THREE.BufferGeometry {
    const puffs: THREE.BufferGeometry[] = [];
    const thetaMin = tier.thetaMin ?? 0;
    const thetaMax = tier.thetaMax ?? HAZE_SCATTER_HALF_ANGLE;
    for (let li = 0; li < lobes.length; li++) {
        const l = lobes[li];
        for (let i = 0; i < tier.puffsPerLobe; i++) {
            const seed = li * 131 + tierIndex * 977 + i;
            const theta = thetaMin + hash01(seed * 1.7) * (thetaMax - thetaMin); // angle off straight-up
            const phi = hash01(seed * 3.1 + 11) * Math.PI * 2; // spin around up axis
            const dirX = Math.sin(theta) * Math.cos(phi);
            const dirY = Math.cos(theta);
            const dirZ = Math.sin(theta) * Math.sin(phi);
            const dist = l.r * (tier.distMin + hash01(seed * 5.3 + 3) * (tier.distMax - tier.distMin));
            const puffR = l.r * (tier.radiusMin + hash01(seed * 7.9 + 5) * (tier.radiusMax - tier.radiusMin));
            // 1.6x margin, not just puffR: a puff merely touching minY still
            // shows its dither stipple right on the flat base plane, reading
            // as holes in the underside. This keeps every puff's whole body
            // clear of it with room to spare.
            const puffY = Math.max(l.y + dirY * dist, minY + puffR * 1.6);

            // Detail 0 (20 tri) rather than 1 (80 tri): these puffs are
            // stippled/alpha-discarded and never inspected up close (see
            // SceneryField's clouds lodBias), so the coarser facets are lost
            // in the dither while the 4x triangle cut matters a lot — a
            // nearby large cloud's haze alone can otherwise run into the tens
            // of thousands of triangles (see cloud/cirrus __fieldStats).
            const g = new THREE.IcosahedronGeometry(puffR, 0);
            g.translate(l.x + dirX * dist, puffY, l.z + dirZ * dist);
            puffs.push(g);
        }
    }
    return mergeGeometries(puffs);
}

/**
 * Progressive haze-tier budgets, closest LOD first. Each level also keeps
 * the solid body mesh, so draw calls per instance run 1+N: 1+12, 1+8, 1+3, 1.
 * HAZE_TIERS is ordered densest/closest-to-the-body first, so slicing from
 * the front keeps the puffs that matter most to the silhouette and drops the
 * sparse, faint outer and side tiers first — they're the least noticeable
 * at any distance where LOD would already be kicking in.
 */
const LOD_HAZE_TIER_COUNTS = [HAZE_TIERS.length, 8, 3, 0];

export class CloudModelLibBuilder implements ModelLibBuilder {

    constructor(public type: string, private lobes: CloudPuffLobe[]) { }

    build(materials: SceneMaterialManager): Model {
        if (this.lobes.length === 0) {
            // An "empty" cloud kind — lets a field's cell variations include
            // gaps of open sky without needing per-cell density logic.
            return {
                lod: [{ flats: [], volumes: [] }],
                animations: [],
                maxSize: 0,
                center: new THREE.Vector3(),
            };
        }

        const baseY = Math.min(...this.lobes.map(l => l.y));
        const geometry = mergeGeometriesSmooth(this.lobes.map(l => {
            // Detail 2 (vs. the haze puffs' detail 1) so the solid body's
            // Gouraud shading picks up finer gradients across each lobe —
            // still low-poly, just a denser vertex grain to shade across.
            const g = new THREE.IcosahedronGeometry(l.r, 2);
            flattenBase(g, baseY - l.y);
            g.translate(l.x, l.y, l.z);
            return g;
        }));
        const mesh = new THREE.Mesh(geometry, materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SKY_CLOUD,
            depthWrite: true,
            // Gouraud-shaded like terrain: per-vertex light term, interpolated
            // across each face, rather than a flat billboard fill or hard
            // per-face facets — clouds are real volumes with a sunlit top and
            // a shadowed, flat underside.
            shaded: true,
        }));
        mesh.onBeforeRender = sunVisibleUniforms();

        // Screen-space stipple discard — no real alpha blend pipeline here,
        // just soft, semi-transparent growth puffs over the cloud top, one
        // mesh per density tier since alphaDither is a per-material uniform.
        // These can't use the solid body's per-face lighting (shaded + alpha
        // dither aren't combinable), so colorDither is forced on instead: it
        // stipples in the palette's SKY_CLOUD shadow tone alongside the lit
        // one in every display mode, so the haze reads as sitting partly in
        // the cloud's own shadow rather than a flat, uniformly lit fill.
        const hazeMeshes = HAZE_TIERS.map((tier, i) => {
            const m = new THREE.Mesh(buildHazeTierGeometry(this.lobes, tier, i, baseY), materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category: PaletteCategory.SKY_CLOUD,
                depthWrite: false,
                shaded: false,
                alphaDither: tier.alphaDither,
                colorDither: true,
            }));
            m.onBeforeRender = sunVisibleColours();
            return m;
        });

        // Growth puffs reach up to ~1.6r out from a lobe's centre plus their
        // own ~0.22r radius; pad the bound generously.
        const HAZE_REACH = 1.9;
        let maxRadius = 0;
        let maxY = 0;
        for (const l of this.lobes) {
            maxRadius = Math.max(maxRadius, Math.hypot(l.x, l.z) + l.r * HAZE_REACH);
            maxY = Math.max(maxY, l.y + l.r * HAZE_REACH);
        }

        // Same mesh/hazeMeshes objects are referenced from multiple LOD
        // levels below (e.g. the solid `mesh` is in every level) — safe
        // because a given tier's content is identical wherever it appears,
        // so it doesn't matter which level's group ends up parenting it (see
        // LODHelper.populateGroups); same sharing pattern as the other
        // multi-LOD builders (mountainModelBuilder, skiJumpModelBuilder).
        return {
            lod: LOD_HAZE_TIER_COUNTS.map(count => ({
                flats: [],
                volumes: [mesh, ...hazeMeshes.slice(0, count)]
            })),
            animations: [],
            maxSize: 2 * maxRadius,
            center: new THREE.Vector3(0, maxY / 2, 0)
        };
    }
}
