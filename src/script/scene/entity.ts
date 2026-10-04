import * as THREE from 'three';
import { FrameShift } from '../terrain/geodesy';
import { CanvasPainter } from '../render/screen/canvasPainter';
import { Palette } from '../config/palettes/palette';
import { Scene } from './scene';

export enum ENTITY_TAGS {
    TARGET = 'TARGET',
    GROUND = 'GROUND',
    AIRCRAFT = 'AIRCRAFT'
}

export interface Entity {
    readonly tags: string[];
    enabled: boolean;
    init(scene: Scene): void;
    update(delta: number): void;
    render3D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Map<string, THREE.Scene>, palette: Palette): void;
    render2D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Set<string>, painter: CanvasPainter, palette: Palette): void;
    /**
     * Carry world-space state into a re-based scene frame (see
     * TerrainEntity.rebaseTo). Absent on entities with none: overlays, and the
     * sky, which stays put in the local sky.
     */
    rebase?(shift: FrameShift): void;
}
