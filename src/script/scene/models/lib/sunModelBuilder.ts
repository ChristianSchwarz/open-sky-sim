import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PaletteCategory } from '../../../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from "../../materials/materials";
import { updateUniforms } from '../../utils';
import { Model, ModelLibBuilder } from "../models";
import {
    createSkyMaterial, makeSkyPainter, paintDirections,
} from './skyDomeModelBuilder';
import { Palette } from '../../../config/palettes/palette';

/**
 * Distance the disc is parked at, in the background-sky camera's space. That
 * camera sits at the origin and only copies the main camera's rotation, so
 * anything here is effectively at infinity however far the player flies.
 *
 * Kept small on purpose. Fog is applied by distance, and while the sun's
 * categories fall through to the sparse FOG_TERRAIN density rather than the
 * thick FOG_SKY one, the night-vision profiles are dense enough to visibly wash
 * a disc parked out at tens of thousands of units. At this range no profile
 * fogs it by more than a percent or two.
 */
export const SUN_DISTANCE = 500;

/**
 * Apparent diameter of the disc, in degrees. The real sun spans 0.53, which at
 * a 50 degree vertical FOV over 200 scanlines is a pixel and a half:
 * technically right and visually absent. Every sim of the era drew it several
 * times oversize, and so does this - about four times, which lands it around
 * 9 px at 320x200 and 18 px at 640x400.
 */
export const DISC_DIAMETER_DEG = 2.2;

/**
 * How far the glare reaches, as an apparent diameter in degrees.
 *
 * Far wider than the disc, which is the point of an aureole: what you actually
 * see around a low sun is light scattered by the air between you and it,
 * spreading many times the sun's own width.
 */
const GLARE_DIAMETER_DEG = 16.0;

/**
 * How hard the sky is driven at the glare's brightest, right at the sun's limb.
 * The ramp falls from here to 1 - plain sky - at the outer edge.
 */
const GLARE_OVERBRIGHT = 2.6;

/**
 * Radial steps across the glare, which is what the falloff is sampled at.
 *
 * It was three fixed rings at fixed stipple densities before, in the era's own
 * idiom, and it read as three hard concentric bands rather than as a glow -
 * exactly the contouring the sky's own dither exists to break up. One annulus
 * carrying a ramp costs a third of the draw calls and has no steps in it at
 * all; with this many subdivisions the interpolation is finer than the 4x4
 * stipple can resolve anyway.
 */
const GLARE_RADIAL_STEPS = 12;

/**
 * How far past white the disc itself is driven before the tone curve sees it.
 *
 * Enough that every channel clips, which is what makes it read as a light
 * rather than as a coloured shape. Left at the palette's own value it was a
 * saturated yellow against a nearly white sky and looked *dimmer* than the sky
 * it was lighting - a saturated colour always does. The steps above carry the
 * same figure outwards so the bloom fades from white at the core to the sun's
 * own colour at its edge, which is one light source, not two.
 */
const DISC_OVERBRIGHT = 6.0;

/**
 * Segment counts. Low enough that the silhouette is visibly faceted at the
 * sizes above, which is the point: a perfect circle would read as a modern
 * sprite dropped into a flat-shaded scene.
 */
const DISC_SEGMENTS = 12;
const GLARE_SEGMENTS = 12;

/**
 * How far inside the disc's radius the glare's cap meets its ring. Just enough
 * that the two overlap by a fraction of a pixel instead of leaving a hairline
 * of background between the ring and the disc.
 */
const GLARE_INNER_OVERLAP = 0.98;

/**
 * How much more of the aureole reaches the eye than the fog's own extinction
 * over the same path.
 *
 * The veil in front of a ridge is airlight, which is what FOG_TERRAIN already
 * measures - so the glare is driven by that density rather than by a reach of
 * its own, and a hazy palette gets a hazy aureole for free. But fog is
 * broadband extinction averaged over every direction, while an aureole is the
 * Mie forward lobe: within a few degrees of the sun the air scatters an order
 * of magnitude more light towards the eye than that average. Hence a gain, not
 * a second density.
 *
 * At the blended dusk density this puts half the aureole in at about 10 km,
 * which leaves a near ridge cleanly silhouetted and a far one sitting inside
 * the glow. It is the one number to turn if the balance reads wrong.
 */
const GLARE_VEIL_GAIN = 12;

/**
 * Draw order, which matters only against the sky dome: nothing in either pass
 * writes depth, and the dome leaves this at its default 0. The disc and the
 * glare no longer contend, being one mesh each in two different passes.
 */
const DISC_RENDER_ORDER = 1;
const GLARE_RENDER_ORDER = 1;

/**
 * Elevation below which the disc is hidden: half its own apparent diameter
 * under the horizon, i.e. the moment its upper limb finishes setting.
 */
export const SUN_SET_ELEVATION_DEG = -DISC_DIAMETER_DEG / 2;

/** Half-angle in degrees to a radius at {@link SUN_DISTANCE}. */
function radiusForDiameter(diameterDeg: number): number {
    return SUN_DISTANCE * Math.tan(diameterDeg / 2 * THREE.MathUtils.DEG2RAD);
}

/** The inverse: the apparent diameter a radius at {@link SUN_DISTANCE} spans. */
function diameterForRadius(radius: number): number {
    return 2 * Math.atan(radius / SUN_DISTANCE) * THREE.MathUtils.RAD2DEG;
}

/** The model is built in the XY plane, so its face normal is +Z. */
const MODEL_NORMAL = new THREE.Vector3(0, 0, 1);
const towardsCamera = new THREE.Vector3();

/**
 * Parks the sun `sunDir` points at, writing into `position` / `quaternion`.
 *
 * Both are in the background-sky camera's space, where the camera is pinned at
 * the origin, so the disc goes out along the sun direction and its normal comes
 * straight back down it.
 */
export function placeSun(sunDir: THREE.Vector3, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    position.copy(sunDir).multiplyScalar(SUN_DISTANCE);
    quaternion.setFromUnitVectors(MODEL_NORMAL, towardsCamera.copy(sunDir).negate());
}

/**
 * The sun: a faceted disc inside a stippled glare that fades linearly out.
 *
 * The two halves are drawn in different passes, and the model keeps them in
 * separate LOD collections so that whoever builds the entity can say so. The
 * disc goes into the background-sky layer, which the terrain pass paints over,
 * so it really does set behind the horizon. The corona goes into the foreground
 * one, which runs after the scene: glare is scattered out of the air between
 * the viewer and the sun, so it lies over the terrain rather than behind it.
 *
 * The model is built facing +Z; whoever places it owns pointing that normal
 * back down the sun direction (see Game.updateSunEntity).
 */
export class SunModelLibBuilder implements ModelLibBuilder {

    constructor(public type: string) { }

    build(materials: SceneMaterialManager): Model {
        // The glare is sky, so it is drawn as sky: vertex-coloured from the
        // same painter the dome uses. Painted rather than palette-driven
        // because the two have to agree exactly - a glare whose colour is
        // derived any other way shows a seam against the sky it sits in.
        const glare = buildGlare();

        // The disc itself keeps the palette entry: driven far past white by its
        // overbright, every channel clips, and what is left is a hole in the
        // sky rather than a colour at all.
        const model: Model = {
            lod: [{ flats: [this.buildDisc(materials)], volumes: [glare] }],
            animations: [],
            maxSize: 2 * radiusForDiameter(GLARE_DIAMETER_DEG),
            center: new THREE.Vector3(),
        };
        return model;
    }

    private buildDisc(materials: SceneMaterialManager): THREE.Mesh {
        const geometry = new THREE.CircleGeometry(radiusForDiameter(DISC_DIAMETER_DEG), DISC_SEGMENTS);
        const mesh = new THREE.Mesh(geometry, materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SKY_SUN,
            depthWrite: false,
            shaded: false,
            alphaDither: 0,
            overbright: DISC_OVERBRIGHT,
            colorDither: false,
        }));
        mesh.name = 'sunDisc';
        mesh.renderOrder = DISC_RENDER_ORDER;
        mesh.onBeforeRender = updateUniforms;
        return mesh;
    }
}

/**
 * Scratch view directions for the glare, one per vertex, rebuilt every repaint.
 *
 * Module-level rather than stored on the mesh because there is one sun, and
 * because userData is the wrong place for a typed array: Object3D.clone()
 * round-trips it through JSON, and ModelManager clones every mesh it hands out,
 * so what came back was a plain object that merely happened to still index.
 */
let glareDirections = new Float32Array(0);

/**
 * The glare: one vertex-coloured disc facing +Z, like the dome's shell.
 *
 * It is built as a cap inside a ring rather than as one solid disc, because the
 * two are gated differently. The ring is the aureole proper. The cap is the part
 * that lies over the sun's own disc, and it draws only where something in the
 * scene has taken that disc: with the disc visible it has to stay out of the
 * way, and with the disc behind a ridge it has to fill in, or the brightest
 * point in the sky is a hole showing the ground. Which of the two applies is a
 * per-pixel question about the depth under it, so it is asked in the shader off
 * a `skyCap` flag rather than decided here.
 *
 * That gate is also why the cap is not simply left out: an annulus is right only
 * for as long as the disc is there to fill it, and around sunset it is not.
 *
 * The cap's rim is pulled very slightly inside the disc's own radius so the two
 * overlap rather than meeting at a seam, and everything is built on the same
 * segment count so the vertices line up around that rim.
 *
 * The falloff is linear in *angle* rather than in the mesh's own radius. Across
 * eight degrees the two are within a percent of each other, but the angle is
 * what an observer actually sees, and it is the one that stays right if the
 * reach is ever widened.
 */
function buildGlare(): THREE.Mesh {
    const innerRadius = radiusForDiameter(DISC_DIAMETER_DEG) * GLARE_INNER_OVERLAP;
    const cap = new THREE.CircleGeometry(innerRadius, GLARE_SEGMENTS);
    const ring = new THREE.RingGeometry(innerRadius, radiusForDiameter(GLARE_DIAMETER_DEG),
        GLARE_SEGMENTS, GLARE_RADIAL_STEPS);
    // Merged indexed rather than through the vegetation builder's own helper,
    // which flattens to non-indexed: these vertices are repainted from the sky
    // model whenever the sun moves, and there is no reason to paint each one
    // six times over.
    const capCount = cap.getAttribute('position').count;
    const geometry = mergeGeometries([cap, ring]);
    cap.dispose();
    ring.dispose();

    const position = geometry.getAttribute('position');
    const innerDeg = diameterForRadius(innerRadius);
    const span = GLARE_DIAMETER_DEG - innerDeg;
    const falloff = new Float32Array(position.count);
    const capFlag = new Float32Array(position.count);
    for (let v = 0; v < position.count; v++) {
        const deg = diameterForRadius(Math.hypot(position.getX(v), position.getY(v)));
        // The cap sits inside the ramp's start, where this is already over 1,
        // so the clamp hands it the limb's own value without a special case.
        falloff[v] = THREE.MathUtils.clamp((GLARE_DIAMETER_DEG - deg) / span, 0, 1);
        // By vertex order, not by radius: the cap's rim and the ring's inner rim
        // are the same circle, and a radius test would split that seam and gate
        // the two sides of it differently.
        capFlag[v] = v < capCount ? 1 : 0;
    }
    geometry.setAttribute('skyFalloff', new THREE.BufferAttribute(falloff, 1));
    geometry.setAttribute('skyCap', new THREE.BufferAttribute(capFlag, 1));
    geometry.setAttribute(
        'skyColor', new THREE.BufferAttribute(new Float32Array(position.count * 3), 3));

    const material = createSkyMaterial(GLARE_OVERBRIGHT, THREE.DoubleSide, true);
    // Glare is scattered out of the air in front of whatever is out there, so
    // it is laid over the finished frame rather than tested against it. Its
    // pass runs last, after the terrain has drawn. How much of it survives over
    // any given pixel is the shader's job, off the resolved scene depth: a hard
    // depth test would put the aureole behind a ridge instead of in front of
    // it, and no test at all stipples the ridge away.
    material.depthTest = false;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'sunGlare';
    mesh.renderOrder = GLARE_RENDER_ORDER;
    mesh.frustumCulled = false;
    return mesh;
}

/**
 * Repaints the glare for the sun at `sunDir`, from the sky's own painter.
 *
 * The glare is flat and faces the camera, so its vertices are not sky
 * directions in themselves - they are offsets around the sun. They are turned
 * into directions here, which is what lets every one of them ask the sky what
 * colour it is at that exact bearing and elevation.
 *
 * `active` is the blended palette the scene is being drawn with, for the veil
 * density; the two authored ones are what the sky painter needs.
 */
export function paintSunBloom(
    model: Model, noon: Palette, midnight: Palette, nightMix: number, sunDir: THREE.Vector3,
    active: Palette,
): void {
    const mesh = model.lod[0]?.volumes[0] as THREE.Mesh | undefined;
    if (!mesh) {
        return;
    }
    // How far the aureole reaches in front of the scene, from the blended
    // palette rather than from the two authored ones: this is the same airlight
    // the terrain is fogged by, so it has to be the density the terrain
    // actually used. Set here because this is the one call both the palette and
    // the sun come through.
    (mesh.material as THREE.ShaderMaterial).uniforms.uVeilDensity.value =
        active.values[PaletteCategory.FOG_TERRAIN] * GLARE_VEIL_GAIN;

    const position = mesh.geometry.getAttribute('position');
    if (glareDirections.length !== position.count * 3) {
        glareDirections = new Float32Array(position.count * 3);
    }
    const directions = glareDirections;
    const paint = makeSkyPainter(noon, midnight, nightMix, sunDir);

    // The rings are built in the XY plane and turned to face the camera, so a
    // vertex at (x, y) sits that far across and up from the sun's own bearing.
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    right.set(sunDir.z, 0, -sunDir.x);
    if (right.lengthSq() < 1e-9) {
        right.set(1, 0, 0);
    }
    right.normalize();
    up.crossVectors(sunDir, right).normalize();

    const world = new THREE.Vector3();
    for (let v = 0; v < position.count; v++) {
        world.copy(sunDir)
            .addScaledVector(right, position.getX(v) / SUN_DISTANCE)
            .addScaledVector(up, position.getY(v) / SUN_DISTANCE)
            .normalize();
        directions[v * 3] = world.x;
        directions[v * 3 + 1] = world.y;
        directions[v * 3 + 2] = world.z;
    }
    paintDirections(mesh, directions, paint);
}
