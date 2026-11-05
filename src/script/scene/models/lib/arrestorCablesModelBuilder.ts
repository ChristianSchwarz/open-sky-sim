/**
 * Four arrestor cables across the carrier's angled landing deck.
 * Built as thin unshaded volume strips so they sit above the Kuznetsov hull
 * mesh (EntityVolumes). Flats would paint first and get overwritten by the deck.
 * Layout matches {@link arrestorCableLocals} so visuals align with trap physics.
 */
import * as THREE from 'three';
import { PaletteCategory } from '../../../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../../materials/materials';
import { updateUniforms } from '../../utils';
import { Model, ModelLibBuilder } from '../models';
import { arrestorCableLocals } from '../../entities/arrestorCables';

/** Cable strip cross-section (m) — thin wire, still readable as a volume. */
const CABLE_WIDTH_M = 0.08;
const CABLE_THICK_M = 0.04;

export class ArrestorCablesModelLibBuilder implements ModelLibBuilder {
    type: string;

    constructor(type: string) {
        this.type = type;
    }

    build(materials: SceneMaterialManager): Model {
        const locals = arrestorCableLocals();
        const mat = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SCENERY_ROAD_MAIN,
            shaded: false,
            depthWrite: true,
        });

        const cables: THREE.Object3D[] = [];
        for (const c of locals) {
            const span = Math.hypot(c.bx - c.ax, c.bz - c.az);
            const geom = new THREE.BoxGeometry(span, CABLE_THICK_M, CABLE_WIDTH_M);
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.set(
                (c.ax + c.bx) * 0.5,
                (c.ay + c.by) * 0.5,
                (c.az + c.bz) * 0.5,
            );
            // BoxGeometry length is local X: yaw it onto the wire (square to the angled deck).
            mesh.rotation.y = Math.atan2(-(c.bz - c.az), c.bx - c.ax);
            mesh.onBeforeRender = updateUniforms;
            cables.push(mesh);
        }

        // End sheaves as small points for LOD readability.
        const pointVerts: number[] = [];
        for (const c of locals) {
            pointVerts.push(c.ax, c.ay, c.az, c.bx, c.by, c.bz);
        }
        const pointGeom = new THREE.BufferGeometry();
        pointGeom.setAttribute('position', new THREE.Float32BufferAttribute(pointVerts, 3));
        const sheaves = new THREE.Points(pointGeom, materials.build({
            type: SceneMaterialPrimitiveType.POINT,
            category: PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD,
            depthWrite: false,
        }));
        sheaves.onBeforeRender = updateUniforms;

        const span = Math.max(
            ...locals.map(c => Math.abs(c.bx - c.ax)),
            Math.abs(locals[0].az - locals[locals.length - 1].az),
        );

        const cloneCable = (src: THREE.Object3D) => {
            const o = src.clone();
            o.onBeforeRender = updateUniforms;
            return o;
        };
        const clonePoints = (src: THREE.Points) => {
            const o = src.clone();
            o.onBeforeRender = updateUniforms;
            return o;
        };

        return {
            lod: [
                { flats: [], volumes: [...cables.map(cloneCable), clonePoints(sheaves)] },
                { flats: [], volumes: cables.map(cloneCable) },
                { flats: [clonePoints(sheaves)], volumes: [] },
            ],
            animations: [],
            maxSize: Math.max(span, 80),
            center: new THREE.Vector3(
                (locals[0].ax + locals[0].bx) * 0.5,
                locals[0].ay,
                (locals[0].az + locals[locals.length - 1].az) * 0.5,
            ),
        };
    }
}
