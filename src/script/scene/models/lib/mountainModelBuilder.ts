import * as THREE from 'three';
import { PaletteCategory } from '../../../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from "../../materials/materials";
import { updateUniforms } from '../../utils';
import { Model, ModelLibBuilder } from "../models";


const FACES = 4;

export const HILL_MODEL_BASE_RADIUS = 700;
export const HILL_MODEL_HEIGHT = 300;
export const MOUNTAIN_MODEL_BASE_RADIUS = 1400;
export const MOUNTAIN_MODEL_HEIGHT = 600;
/** Baked into cone mesh geometry in build(); colliders must include the same rotation. */
export const HILL_GEOMETRY_Y_ROT = Math.PI / 4;

export class MountainModelLibBuilder implements ModelLibBuilder {
    type: string;

    constructor(
        type: string,
        private radius: number,
        private height: number,
        private color: PaletteCategory,
        private shaded: boolean = true,
        private dithered: boolean = true,
    ) {
        this.type = type;
    }

    build(materials: SceneMaterialManager): Model {
        const geometry = new THREE.ConeGeometry(this.radius, this.height, FACES, undefined, true).toNonIndexed();
        geometry.computeVertexNormals();
        geometry.translate(0, this.height / 2, 0);
        geometry.rotateY(HILL_GEOMETRY_Y_ROT);
        const mesh = new THREE.Mesh(geometry, materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: this.color,
            depthWrite: true,
            shaded: this.shaded,
            colorDither: this.dithered,
        }));
        mesh.onBeforeRender = updateUniforms;

        // const points = [
        //     new THREE.Vector3(-this.radius + EDGE_PADDING, 0, 0),
        //     new THREE.Vector3(0, this.height + EDGE_PADDING, 0),
        //     new THREE.Vector3(0, 0, this.radius + EDGE_PADDING),
        //     new THREE.Vector3(this.radius + EDGE_PADDING, 0, 0),
        //     new THREE.Vector3(0, this.height + EDGE_PADDING, 0),
        //     new THREE.Vector3(0, 0, -this.radius + EDGE_PADDING)
        // ];
        // const linesGeometry = new THREE.BufferGeometry().setFromPoints(points);
        // const lines = new THREE.Line(linesGeometry, materials.build({
        //     type: SceneMaterialPrimitiveType.LINE,
        //     category: this.color,
        //     depthWrite: true,
        // }));
        // lines.onBeforeRender = updateUniforms;

        return {
            lod: [
                {
                    flats: [],
                    volumes: [mesh/*, lines*/]
                },
                {
                    flats: [],
                    volumes: [mesh]
                }
            ],
            animations: [],
            maxSize: 2 * this.radius,
            center: new THREE.Vector3(0, this.height / 2, 0)
        };
    }
}
