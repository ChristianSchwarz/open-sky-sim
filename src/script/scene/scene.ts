import * as THREE from 'three';
import { CanvasPainter } from '../render/screen/canvasPainter';
import { Entity } from './entity';
import { Palette } from '../config/palettes/palette';


export enum SceneLayers {
    Overlay = 'Overlay',
    BackgroundSky = 'BackgroundSky',
    BackgroundGround = 'BackgroundGround',
    Terrain = 'Terrain',
    EntityFlats = 'EntityFlats',
    EntityVolumes = 'EntityVolumes',
    /** Aircraft VFX (wingtip trails) drawn after terrain and solid meshes. */
    EntityFX = 'EntityFX',
    /**
     * Sky drawn *over* the scene rather than behind it: the sun's glare.
     *
     * Rides the same rotation-only background camera as {@link BackgroundSky},
     * so it is still at infinity, but its pass runs last. Glare is light
     * scattered by the air between the viewer and the sun, so it is in front of
     * whatever else is out there: a ridge across the sun does not hide the
     * aureole, it sits inside it. The disc stays in the background pass,
     * because that genuinely is behind the ridge.
     */
    ForegroundSky = 'ForegroundSky'
}

export class Scene {

    private entities: Entity[] = [];
    private renderFilter: ((entity: Entity) => boolean) | undefined;

    setRenderFilter(filter: ((entity: Entity) => boolean) | undefined): void {
        this.renderFilter = filter;
    }

    update(delta: number) {
        for (let i = 0; i < this.entities.length; i++) {
            const entity = this.entities[i];
            if (entity.enabled) {
                entity.update(delta);
            }
        }
    }

    /**
     * `extraFilter` is a one-off, per-call filter ANDed with the ambient one
     * set via {@link setRenderFilter} — for excluding entities from a single
     * render pass (e.g. a secondary camera) without disturbing the ambient
     * filter other passes in the same frame rely on (showcase mode).
     */
    buildRenderLists(targetWidth: number, targetHeight: number, camera: THREE.Camera, renderLists: Map<string, THREE.Scene>, palette: Palette, extraFilter?: (entity: Entity) => boolean) {
        for (let i = 0; i < this.entities.length; i++) {
            const entity = this.entities[i];
            if (entity.enabled
                && (!this.renderFilter || this.renderFilter(entity))
                && (!extraFilter || extraFilter(entity))) {
                entity.render3D(targetWidth, targetHeight, camera, renderLists, palette);
            }
        }
    }

    paintCanvas(targetWidth: number, targetHeight: number, camera: THREE.Camera, renderLists: Set<string>, painter: CanvasPainter, palette: Palette) {
        for (let i = 0; i < this.entities.length; i++) {
            const entity = this.entities[i];
            if (entity.enabled) {
                entity.render2D(targetWidth, targetHeight, camera, renderLists, painter, palette);
            }
        }
    }

    add(entity: Entity) {
        this.entities.push(entity);
        entity.init(this);
    }

    *listByTag(tag: string) {
        for (let i = 0; i < this.entities.length; i++) {
            const entity = this.entities[i];
            if (entity.tags.includes(tag)) {
                yield entity;
            }
        }
    }

    countByTag(tag: string): number {
        let count = 0;
        for (let i = 0; i < this.entities.length; i++) {
            const entity = this.entities[i];
            if (entity.tags.includes(tag)) {
                count += 1;
            }
        }
        return count;
    }

    entityAtByTag(tag: string, index: number): Entity | undefined {
        let cursor = -1;
        for (let i = 0; i < this.entities.length; i++) {
            const entity = this.entities[i];
            if (entity.tags.includes(tag)) {
                cursor += 1;
                if (cursor === index) {
                    return entity;
                }
            }
        }
    }
}
