import * as THREE from 'three';
import { ConfigService } from '../../../config/configService';
import { Palette, PaletteCategory, PaletteColor } from "../../../config/palettes/palette";
import { CanvasPainter } from "../../../render/screen/canvasPainter";
import { Font, TextAlignment } from "../../../render/screen/text";
import { FORWARD, vectorHeading } from '../../../utils/math';
import { Entity } from "../../entity";
import { Scene, SceneLayers } from "../../scene";
import { WeaponsTarget } from '../weaponsTarget';
import { UnitSystems } from '../../../state/gameDefs';
import { PlayerEntity } from "../player";
import { DisplayUnits } from './displayUnits';
import { getOverlayLayout } from './overlayUtils';


export class ExteriorDataEntity implements Entity {

    private displayUnits: DisplayUnits;
    private readonly onUnitSystemChange = (system: UnitSystems) => {
        this.displayUnits.setSystem(system);
    };

    constructor(private actor: PlayerEntity, config: ConfigService) {
        this.displayUnits = new DisplayUnits(config.unitSystem.getActive());
        config.unitSystem.addChangeListener(this.onUnitSystemChange);
    }

    private heading: number = 0; // degrees, 0 is North, increases CW
    private altitude: number = 0; // display units
    private speed: number = 0; // display units
    private weaponsTarget: WeaponsTarget | undefined;

    private tmpVector = new THREE.Vector3();

    readonly tags: string[] = [];

    enabled: boolean = true;

    init(scene: Scene): void {
        //
    }

    update(delta: number): void {
        this.weaponsTarget = this.actor.weaponsTarget;
    }

    private refreshVisualState(): void {
        const displayQuat = this.actor.getDisplayQuaternion();
        const displayVel = this.actor.getDisplayVelocity();

        this.altitude = this.displayUnits.altitudeFromMeters(this.actor.getDisplayAltitude());

        this.tmpVector.copy(FORWARD)
            .applyQuaternion(displayQuat)
            .setY(0)
            .normalize();
        this.heading = vectorHeading(this.tmpVector);

        this.speed = this.displayUnits.speedFromMps(displayVel.length());
    }

    render3D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Map<string, THREE.Scene>, palette: Palette): void {
        // Nothing
    }

    render2D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Set<string>, painter: CanvasPainter, palette: Palette): void {
        if (!lists.has(SceneLayers.Overlay)) return;

        this.refreshVisualState();

        const layoutScale = getOverlayLayout(targetWidth, targetHeight).layoutScale;

        const font = layoutScale > 1 ? Font.HUD_LARGE : Font.HUD_SMALL;
        const hudColor = PaletteColor(palette, PaletteCategory.HUD_TEXT);

        painter.setColor(hudColor);

        const halfWidth = targetWidth / 2;

        const headingX = halfWidth - (font.charWidth + font.charSpacing) * 19;
        const airspeedX = halfWidth - (font.charWidth + font.charSpacing) * 5;
        const altitudeX = halfWidth + (font.charWidth + font.charSpacing) * 12;
        const navY = targetHeight - font.charHeight * 2;

        const targetInfoX = halfWidth;
        const targetInfoY = navY - font.charHeight * 2;

        this.renderAltitude(altitudeX, navY, painter, hudColor, font);
        this.renderHeading(headingX, navY, painter, hudColor, font);
        this.renderAirSpeed(airspeedX, navY, painter, hudColor, font);
        this.renderTargetInfo(targetInfoX, targetInfoY, painter, hudColor, font);
    }

    private renderAltitude(x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        painter.text(font, x, y, `ALT ${this.altitude.toFixed(0)} ${this.displayUnits.altitudeUnitLabel()}`, hudColor, TextAlignment.LEFT);
    }

    private renderHeading(x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        painter.text(font, x, y, `Heading ${this.heading.toFixed(0)}`, hudColor, TextAlignment.LEFT);
    }

    private renderAirSpeed(x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        painter.text(font, x, y, `SPD ${Math.floor(this.speed).toFixed(0)} ${this.displayUnits.speedUnitLabel()}`, hudColor, TextAlignment.LEFT);
    }

    private renderTargetInfo(x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        if (this.weaponsTarget) {
            painter.text(font, x, y, `${this.weaponsTarget.targetType} at ${this.weaponsTarget.targetLocation}`, hudColor, TextAlignment.CENTER);
        }
    }
}