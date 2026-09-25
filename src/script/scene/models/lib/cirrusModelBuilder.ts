import * as THREE from 'three';
import { PaletteCategory } from '../../../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from "../../materials/materials";
import { updateUniforms } from '../../utils';
import { Model, ModelLibBuilder } from "../models";
import { mergeGeometries } from './vegetationModelBuilder';

/**
 * A single elongated wisp within a cirrus streak, in local space (metres).
 * Built from a unit icosahedron squashed thin (height) and stretched long
 * (length) — the same "clump of blobs" trick as the cumulus puffs, just
 * anisotropic so it reads as a fibrous streak instead of a round puff.
 */
export interface CirrusWisp {
    x: number;
    y: number;
    z: number;
    length: number; // along X
    width: number; // along Z
    height: number; // along Y — kept thin
}

/**
 * Hand-placed streak clusters for the high-altitude cirrus layer. Unlike the
 * cumulus puffs, these have no flat base — cirrus is thin ice-crystal haze
 * with no real underside to speak of, so every wisp is just a squashed,
 * elongated blob.
 */
export const CIRRUS_STREAK_SHAPES: Record<string, CirrusWisp[]> = {
    thin: [
        { x: 0, y: 0, z: 0, length: 13500, width: 2400, height: 525 },
        { x: 7800, y: 90, z: 675, length: 9300, width: 1800, height: 420 },
        { x: -7050, y: -75, z: -525, length: 8400, width: 1650, height: 390 },
        { x: 3600, y: 45, z: -840, length: 7800, width: 1500, height: 360 },
        { x: -4200, y: -36, z: 780, length: 7200, width: 1440, height: 345 },
        { x: 10200, y: 120, z: -180, length: 6000, width: 1260, height: 300 },
    ],
    wide: [
        { x: 0, y: 0, z: 0, length: 21000, width: 3900, height: 675 },
        { x: 11400, y: 150, z: 975, length: 14250, width: 3000, height: 570 },
        { x: -10800, y: -120, z: -1125, length: 13500, width: 2850, height: 540 },
        { x: 3300, y: 240, z: -2550, length: 10500, width: 2250, height: 450 },
        { x: -5400, y: 60, z: 2100, length: 9600, width: 2040, height: 420 },
        { x: 15600, y: -60, z: -1200, length: 8400, width: 1800, height: 390 },
        { x: -14400, y: 180, z: 900, length: 9000, width: 1950, height: 405 },
        { x: 6600, y: -90, z: 2850, length: 7800, width: 1680, height: 360 },
    ],
};

export class CirrusModelLibBuilder implements ModelLibBuilder {

    constructor(public type: string, private wisps: CirrusWisp[]) { }

    build(materials: SceneMaterialManager): Model {
        if (this.wisps.length === 0) {
            // An "empty" cirrus kind — lets a field's cell variations include
            // gaps of open sky without needing per-cell density logic.
            return {
                lod: [{ flats: [], volumes: [] }],
                animations: [],
                maxSize: 0,
                center: new THREE.Vector3(),
            };
        }

        const geometry = mergeGeometries(this.wisps.map(w => {
            const g = new THREE.IcosahedronGeometry(1, 1);
            g.scale(w.length / 2, w.height / 2, w.width / 2);
            g.translate(w.x, w.y, w.z);
            return g;
        }));
        const mesh = new THREE.Mesh(geometry, materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SKY_CLOUD,
            depthWrite: false,
            shaded: false,
            // Thin, high-altitude streaks — mostly see-through, and dithered
            // with the palette's shadow tone alongside the lit one so they
            // read as fibrous wisps rather than a flat, uniform wash.
            alphaDither: 0.35,
            colorDither: true,
        }));
        mesh.onBeforeRender = updateUniforms;

        let maxRadius = 0;
        let maxY = 0;
        for (const w of this.wisps) {
            const reach = Math.max(w.length, w.width) / 2;
            maxRadius = Math.max(maxRadius, Math.hypot(w.x, w.z) + reach);
            maxY = Math.max(maxY, w.y + w.height / 2);
        }

        return {
            lod: [{
                flats: [],
                volumes: [mesh]
            }],
            animations: [],
            maxSize: 2 * maxRadius,
            center: new THREE.Vector3(0, maxY / 2, 0)
        };
    }
}
