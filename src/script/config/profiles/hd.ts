import { TextEffect } from "../../render/screen/text";
import { HDMidnightPalette } from "../palettes/hd-midnight";
import { HDNightVisionPalette } from "../palettes/hd-nightvision";
import { HDNoonPalette } from "../palettes/hd-noon";
import { DisplayShading, FogQuality, TechProfile } from "./profile";

export const HDProfile: TechProfile = {
    textEffect: TextEffect.BOLD,
    shading: DisplayShading.FULL,
    fogQuality: FogQuality.HIGH,
    noonPalette: HDNoonPalette,
    midnightPalette: HDMidnightPalette,
    nightVisionPalette: HDNightVisionPalette
}
