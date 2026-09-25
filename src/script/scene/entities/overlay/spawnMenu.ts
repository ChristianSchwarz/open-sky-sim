import * as THREE from 'three';
import { Palette } from '../../../config/palettes/palette';
import { CanvasPainter } from '../../../render/screen/canvasPainter';
import { Entity } from '../../entity';
import { Scene } from '../../scene';


/** Spawn menu state holder; the visible UI is the HTML {@link SpawnPanel}. */
export class SpawnMenuEntity implements Entity {

    afterCrash = false;

    readonly tags: string[] = [];

    enabled = false;

    init(_scene: Scene): void {
        //
    }

    update(_delta: number): void {
        //
    }

    render3D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, _lists: Map<string, THREE.Scene>, _palette: Palette): void {
        //
    }

    render2D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, _lists: Set<string>, _painter: CanvasPainter, _palette: Palette): void {
        //
    }
}
