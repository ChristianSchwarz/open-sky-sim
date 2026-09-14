import { TextEffect } from "../../render/screen/text";
import { Palette } from "../palettes/palette";
export enum DisplayShading {
    DUOTONE,
    STATIC,
    DYNAMIC,
    FULL,
}

export enum FogQuality {
    NONE, // Disabled
    LOW, // Plane
    HIGH // Sphere
}

export interface TechProfile {
    textEffect: TextEffect;
    shading: DisplayShading;
    fogQuality: FogQuality;
    noonPalette: Palette;
    midnightPalette: Palette;
    nightVisionPalette?: Palette;
}
