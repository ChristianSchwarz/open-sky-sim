import * as THREE from 'three';
import { ConfigService } from '../../../config/configService';
import { Palette, PaletteCategory, PaletteColor } from "../../../config/palettes/palette";
import { COCKPIT_FOV, PITCH_STICK_AFT_UNITS, PITCH_STICK_FWD_UNITS } from '../../../defs';
import { CanvasPainter } from "../../../render/screen/canvasPainter";
import { Font, TextAlignment } from "../../../render/screen/text";
import { FlightModels, HUDFocusMode, UnitSystems } from '../../../state/gameDefs';
import { calculatePitchRoll, clamp, FORWARD, toDegrees, toRadians, UP, vectorHeading } from '../../../utils/math';
import { computeMachNumber } from '../../../physics/aeroUtils';
import { FcsPitchLimiter } from '../../../physics/fm2/fcs';
import { Entity } from "../../entity";
import { Scene, SceneLayers } from "../../scene";
import { WeaponsTarget } from '../weaponsTarget';
import { PlayerEntity } from "../player";
import {
    computeGunPipperWorldPoint,
    GUN_AIM_DEFAULT_RANGE_M,
    GUN_MUZZLE_OFFSET,
} from '../../../weapons/gunPipper';
import { formatHeading, getOverlayLayout, getOverlayLogicalHeight, getOverlayTickStep, OverlayLayout } from './overlayUtils';
import { DisplayUnits } from './displayUnits';
import {
    aoaIndexerCue,
    carrierApproachTargetSink,
    carrierApproachTargetSpeed,
    computeIlsDeviation,
    ILS_GLIDESLOPE_DEG,
    isIlsApproachTarget,
} from './approachAids';


const ALTITUDE_HEIGHT = 32;
const ALTITUDE_HALF_HEIGHT = ALTITUDE_HEIGHT / 2;

const HEADING_WIDTH = 26;
// Do not change these...
const HEADING_HALF_WIDTH = HEADING_WIDTH / 2;
const HEADING_SPACING = 5;
const HEADING_STEP = 5;

const AIRSPEED_HEIGHT = 32;
const AIRSPEED_HALF_HEIGHT = AIRSPEED_HEIGHT / 2;

const AOA_STALL_DEG = 22;

const LADDER_EXTRA_MARKERS = 2;
const LADDER_HORIZON_HALF_GAP = 12;
const LADDER_SIZE = 100;
const LADDER_WIDTH = 164;
const LADDER_HEIGHT = 70;
// Do not change these...
const LADDER_SIZE_HALF = Math.floor(LADDER_SIZE / 2);
const LADDER_HALF_WIDTH = Math.floor(LADDER_WIDTH / 2);
const LADDER_HALF_HEIGHT = Math.floor(LADDER_HEIGHT / 2);

const TARGET_HALF_WIDTH = 8; // Pixels

/** Matches player gun muzzle velocity in game.ts / combat sim. */
const GUN_MUZZLE_VELOCITY_MPS = 1000;

/** Short HUD tag for each pitch AoA/g limiter strategy (keys 1/2/3). */
const FCS_MODE_LABELS: Record<number, string> = {
    [FcsPitchLimiter.SOFT]: 'FCS1 SOFT',
    [FcsPitchLimiter.PREDICTIVE]: 'FCS2 PRED',
    [FcsPitchLimiter.SMOOTH]: 'FCS3 SMTH',
};

//const HALF_CHAR = Math.floor(CHAR_HEIGHT / 2);


export class HUDEntity implements Entity {

    private displayUnits: DisplayUnits;
    private readonly onUnitSystemChange = (system: UnitSystems) => {
        this.displayUnits.setSystem(system);
    };

    constructor(private actor: PlayerEntity, private readonly config: ConfigService) {
        this.displayUnits = new DisplayUnits(config.unitSystem.getActive());
        config.unitSystem.addChangeListener(this.onUnitSystemChange);
    }

    private heading: number = 0; // degrees, 0 is North, increases CW
    private altitude: number = 0; // display units (m or ft)
    /** The same altitude in metres, for the physics readouts that want SI. */
    private altitudeM: number = 0;
    private renderFps: number = 0;
    private speed: number = 0; // display units (km/h or kt)
    private verticalSpeed: number = 0; // m/s or ft/min
    private velocityDirection: THREE.Vector3 = new THREE.Vector3();
    private weaponsTarget: WeaponsTarget | undefined;
    private stallStatus: number = -1; // [-1,1]. Values >= 0 indicate stall
    private angleOfAttack: number = 0; // radians
    private loadFactorG: number = 1;
    private machNumber: number = 0;
    private isLanded: boolean = true;
    private isAutopilotEnabled: boolean = false;
    private hasGun: boolean = false;
    private gunAmmo: number = 0;
    private healthFraction: number = 1;
    private pitch: number = 0; // radians
    private roll: number = 0; // radians
    private pitchInput: number = 0; // [-1, 1]
    private rollInput: number = 0; // [-1, 1]
    private yawInput: number = 0; // [-1, 1]
    private elevatorLimitHigh: number = 1; // [-1, 1] nose-up elevator-command clamp
    private elevatorLimitLow: number = -1; // [-1, 1] nose-down elevator-command clamp
    private elapsed: number = 0; // Seconds
    private lastRenderTime: number = 0;

    private _v = new THREE.Vector3();
    private _w = new THREE.Vector3();
    private _aim = new THREE.Vector3();
    private _plane = new THREE.Plane();

    readonly tags: string[] = [];

    enabled: boolean = true;

    init(scene: Scene): void {
        //
    }

    update(delta: number): void {
        this.weaponsTarget = this.actor.weaponsTarget;

        this.stallStatus = this.actor.stallStatus;
        this.angleOfAttack = this.actor.angleOfAttack;
        this.loadFactorG = this.actor.loadFactorG;
        this.isLanded = this.actor.isLanded;
        this.isAutopilotEnabled = this.actor.isAutopilotEnabled;
        this.hasGun = this.actor.hasGun;
        this.gunAmmo = this.actor.gunAmmo;
        this.healthFraction = this.actor.healthFraction;

        this.pitchInput = this.actor.pitchInput;
        this.rollInput = this.actor.rollInput;
        this.yawInput = this.actor.yawInput;
        this.elevatorLimitHigh = this.actor.elevatorLimitHigh;
        this.elevatorLimitLow = this.actor.elevatorLimitLow;

        this.elapsed += delta;
    }

    private refreshVisualState(): void {
        const now = performance.now();
        if (this.lastRenderTime > 0) {
            const frameDtMs = now - this.lastRenderTime;
            const instantFps = 1000 / frameDtMs;
            this.renderFps = this.renderFps > 0
                ? this.renderFps * 0.9 + instantFps * 0.1
                : instantFps;
        }
        this.lastRenderTime = now;

        const displayQuat = this.actor.getDisplayQuaternion();
        const displayVel = this.actor.getDisplayVelocity();

        // Height above the ellipsoid, not scene Y: the two only agree at the play
        // area's origin, and diverge by over a kilometre at the edge of a large one.
        this.altitudeM = this.actor.getDisplayAltitude();
        this.altitude = Math.round(
            this.displayUnits.altitudeFromMeters(this.altitudeM) * 10) / 10;

        this._v.copy(FORWARD)
            .applyQuaternion(displayQuat)
            .setY(0)
            .normalize();
        this.heading = vectorHeading(this._v);

        [this.pitch, this.roll] = calculatePitchRoll({
            quaternion: displayQuat,
            getWorldDirection: (v) => this.actor.getDisplayWorldDirection(v),
        });

        this.speed = this.displayUnits.speedFromMps(displayVel.length());
        this.verticalSpeed = this.displayUnits.verticalSpeedFromMps(displayVel.y);

        if (displayVel.lengthSq() > 1e-6) {
            this.velocityDirection.copy(displayVel).normalize();
        }

        this.machNumber = computeMachNumber(displayVel.length(), this.altitudeM);
    }

    render3D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Map<string, THREE.Scene>, palette: Palette): void {
        // Nothing
    }

    render2D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Set<string>, painter: CanvasPainter, palette: Palette): void {
        if (!lists.has(SceneLayers.Overlay)) return;

        this.refreshVisualState();

        const layout = getOverlayLayout(targetWidth, targetHeight);
        const { detailScale, layoutScale } = layout;
        const tickStep = getOverlayTickStep(layout);

        const font = layoutScale > 1 ? Font.HUD_LARGE : Font.HUD_SMALL;
        const fontSmall = layoutScale > 1 ? Font.HUD_MEDIUM : Font.HUD_SMALL;
        const hudColor = PaletteColor(palette, PaletteCategory.HUD_TEXT);
        const hudSecondaryColor = PaletteColor(palette, PaletteCategory.HUD_TEXT_SECONDARY);
        const hudWarnColor = PaletteColor(palette, PaletteCategory.HUD_TEXT_WARN);
        const hudLimitColor = PaletteColor(palette, PaletteCategory.LIGHT_RED);
        painter.setColor(hudColor);

        const halfWidth = targetWidth / 2;
        const halfHeight = targetHeight / 2;
        // Padlock: camera looks at the target, but the entire HUD stays glued to
        // the aircraft combiner (boresight). Offset the whole HUD as one block
        // so a high target leaves it at the bottom of the view.
        const [hudX, hudY] = this.projectBoresight(halfWidth, halfHeight, camera);
        const dx = hudX - halfWidth;
        const dy = hudY - halfHeight;
        const ladderSpread = layoutScale > 1 ? Math.max(1.5, layoutScale / detailScale) : 1;

        const geomScale = layoutScale / detailScale;

        // Target box stays on the gazed-at target (screen centre while padlocked).
        this.renderTarget(targetWidth, targetHeight, halfWidth, halfHeight, painter, camera, geomScale);

        // Everything below is airframe-fixed and moves with (dx, dy).
        this.renderPitchLadder(layout, hudX, hudY, painter, hudColor, hudSecondaryColor, fontSmall);

        const altitudeX = hudX + Math.ceil((LADDER_HALF_WIDTH + 6) * ladderSpread);
        const altitudeY = hudY;
        if (this.actor.hudFocusMode === HUDFocusMode.DISABLED) {
            this.renderAltitude(layout, tickStep, altitudeX, altitudeY, targetWidth, painter, hudColor, font, fontSmall);
        } else {
            this.renderAltitudeFocusMode(altitudeX, altitudeY, painter, hudColor, font);
        }

        const headingX = hudX;
        const headingY = hudY - layoutScale * (LADDER_HALF_HEIGHT + 2);
        if (this.actor.hudFocusMode !== HUDFocusMode.FULL) {
            this.renderHeading(layout, headingX, headingY, painter, hudColor, font);
        } else {
            this.renderHeadingFocusMode(headingX, headingY, painter, hudColor, font);
        }

        const airSpeedX = hudX - Math.floor((LADDER_HALF_WIDTH + 6) * ladderSpread);
        const airSpeedY = hudY;
        if (this.actor.hudFocusMode === HUDFocusMode.DISABLED) {
            this.renderAirSpeed(layout, tickStep, airSpeedX, airSpeedY, painter, hudColor, font, fontSmall);
        } else {
            this.renderAirSpeedFocusMode(airSpeedX, airSpeedY, painter, hudColor, font);
        }

        const throttleX = airSpeedX - (font.charWidth + font.charSpacing) * 4 - 1;
        const throttleY = headingY - font.charHeight - 3;
        this.renderThrottle(throttleX, throttleY, painter, hudColor, font);

        if (this.isAutopilotEnabled) {
            painter.text(font, throttleX, throttleY - font.charHeight - 2, 'AP', hudColor);
        }

        this.renderFlightDataIndicators(layout, airSpeedX, airSpeedY, painter, hudColor, hudWarnColor, fontSmall);
        this.renderAoaIndexer(airSpeedX, airSpeedY, geomScale, painter, hudColor, hudWarnColor, hudSecondaryColor, palette);

        const stickArm = Math.max(8, Math.round(11 * geomScale));
        const stickGap = Math.round(10 * geomScale);
        const stickLabelMargin = (fontSmall.charWidth + fontSmall.charSpacing) * 4 + 6;
        // Keep stick glued to the altitude tape — do not clamp to the screen edge
        // or the HUD stops moving as one rigid airframe block.
        const stickCenterX = altitudeX + stickLabelMargin + stickGap + stickArm;
        const stickCenterY = hudY;
        this.renderStickIndicator(stickCenterX, stickCenterY, stickArm, geomScale, painter, hudColor, hudSecondaryColor, hudLimitColor, fontSmall);

        this.renderGunReticle(dx, dy, targetHeight, painter, geomScale, hudColor, hudWarnColor, font);
        // FPM / gun pipper live on the combiner glass: project in the nose frame, then
        // apply the same padlock HUD offset as the rest of the symbology.
        const ilsTarget = isIlsApproachTarget(this.weaponsTarget);
        if (ilsTarget && this.weaponsTarget) {
            this.renderIlsIndicator(
                targetWidth, targetHeight, halfWidth, halfHeight, dx, dy,
                painter, camera, geomScale, hudColor, hudSecondaryColor, palette,
            );
            this.renderApproachTargets(
                layout, airSpeedX, airSpeedY, painter, hudColor, hudSecondaryColor, fontSmall,
            );
        } else {
            this.renderGunAimIndicator(targetWidth, targetHeight, halfWidth, halfHeight, dx, dy, painter, camera, geomScale, hudColor);
        }
        this.renderBoresight(hudX, hudY, painter, geomScale, hudColor);
        this.renderFlightPathMarker(
            targetWidth, targetHeight, halfWidth, halfHeight, dx, dy,
            painter, camera, geomScale, ilsTarget, hudColor, hudSecondaryColor, palette,
        );
        this.renderStallWarning(layout, airSpeedX, airSpeedY, painter, hudColor, hudWarnColor, font);

        if (this.actor.hudFocusMode === HUDFocusMode.DISABLED) {
            this.renderStallStatus(layout, airSpeedX, airSpeedY, painter, hudColor, hudWarnColor);
            this.renderVerticalVelocityIndicator(layout, tickStep, altitudeX, altitudeY, painter, hudColor, hudWarnColor);
        }

        this.renderPerfStats(targetWidth, layoutScale, dx, dy, painter, hudSecondaryColor, fontSmall);
    }

    /**
     * Screen position of the aircraft nose / HUD combiner in the current view.
     * Screen-centre when looking along the nose; shifts with padlock so a high
     * target leaves the whole HUD at the bottom of the view.
     */
    private projectBoresight(halfWidth: number, halfHeight: number, camera: THREE.Camera): [number, number] {
        camera.updateMatrixWorld();
        camera.getWorldDirection(this._v);
        this._plane.setFromNormalAndCoplanarPoint(this._v, camera.position);
        // Project a point well ahead along the nose for a stable NDC sample.
        this._w.copy(camera.position)
            .addScaledVector(this.actor.getDisplayWorldDirection(this._v), 1000);
        if (this._plane.distanceToPoint(this._w) <= 0) {
            return [halfWidth, halfHeight];
        }
        this._w.project(camera);
        return [
            Math.round((this._w.x * halfWidth) + halfWidth),
            Math.round(-(this._w.y * halfHeight) + halfHeight),
        ];
    }

    /**
     * Project a world point as it appears on the airframe HUD glass: nose-camera
     * projection, then the padlock HUD offset (dx, dy).
     */
    private projectOnHudGlass(
        worldPoint: THREE.Vector3,
        camera: THREE.PerspectiveCamera,
        halfWidth: number,
        halfHeight: number,
        dx: number,
        dy: number,
    ): { x: number, y: number } | null {
        const savedQuat = camera.quaternion.clone();
        const savedUp = camera.up.clone();

        camera.up.copy(this.actor.getDisplayWorldUp(this._v));
        camera.quaternion.copy(this.actor.getDisplayQuaternion());
        camera.rotateOnAxis(UP, Math.PI);
        camera.updateMatrixWorld(true);

        camera.getWorldDirection(this._v);
        this._plane.setFromNormalAndCoplanarPoint(this._v, camera.position);
        let result: { x: number, y: number } | null = null;
        if (this._plane.distanceToPoint(worldPoint) > 0) {
            this._w.copy(worldPoint).project(camera);
            result = {
                x: Math.round((this._w.x * halfWidth) + halfWidth + dx),
                y: Math.round(-(this._w.y * halfHeight) + halfHeight + dy),
            };
        }

        camera.quaternion.copy(savedQuat);
        camera.up.copy(savedUp);
        camera.updateMatrixWorld(true);
        return result;
    }

    /**
     * Live perf readout: FPS plus rendered-triangle counts split by category.
     * Terrain and cloud/cirrus triangles are tracked at their own render
     * sites (__terrainStats, __fieldStats); "objects" is the remainder of
     * the exact GPU-reported scene total (__sceneTriangles) after
     * subtracting those two, so the three numbers always add up.
     */
    private renderPerfStats(
        targetWidth: number,
        layoutScale: number,
        dx: number,
        dy: number,
        painter: CanvasPainter,
        hudColor: string,
        font: Font,
    ) {
        const margin = Math.max(4, Math.round(4 * layoutScale));
        const lineHeight = font.charHeight + font.charSpacing;
        const x = targetWidth - margin + dx;

        const terrainStats = (globalThis as Record<string, unknown>).__terrainStats as { triangles: number } | undefined;
        const terrainTriangles = terrainStats?.triangles ?? 0;
        const fieldStats = (globalThis as Record<string, unknown>).__fieldStats as Record<string, number> | undefined;
        const cloudTriangles = (fieldStats?.cloud ?? 0) + (fieldStats?.cirrus ?? 0);
        const sceneTriangles = ((globalThis as Record<string, unknown>).__sceneTriangles as number | undefined) ?? 0;
        const objectTriangles = Math.max(0, sceneTriangles - terrainTriangles - cloudTriangles);

        painter.text(font, x, margin + dy, `${this.renderFps.toFixed(0)}FPS`, hudColor, TextAlignment.RIGHT);
        painter.text(font, x, margin + dy + lineHeight, `OBJ ${(objectTriangles / 1000).toFixed(1)}K`, hudColor, TextAlignment.RIGHT);
        painter.text(font, x, margin + dy + lineHeight * 2, `TER ${(terrainTriangles / 1000).toFixed(1)}K`, hudColor, TextAlignment.RIGHT);
        painter.text(font, x, margin + dy + lineHeight * 3, `CLD ${(cloudTriangles / 1000).toFixed(1)}K`, hudColor, TextAlignment.RIGHT);
    }

    private renderFlightDataIndicators(
        layout: OverlayLayout,
        airSpeedX: number,
        airSpeedY: number,
        painter: CanvasPainter,
        hudColor: string,
        hudWarnColor: string,
        font: Font,
    ) {
        const lineHeight = font.charHeight + font.charSpacing;
        const ladderBottom = airSpeedY + layout.layoutScale * AIRSPEED_HALF_HEIGHT * 2;
        const x = airSpeedX + 9;
        const y = ladderBottom + font.charSpacing + 2;
        const aoaDeg = toDegrees(this.angleOfAttack);

        this.renderFlightDataIndicator(x, y, 'Mach:', this.machNumber.toFixed(1), painter, hudColor, font);
        this.renderFlightDataIndicator(x, y + lineHeight, 'AoA:', aoaDeg.toFixed(0),
            painter, aoaDeg >= AOA_STALL_DEG - 2 ? hudWarnColor : hudColor, font);
        this.renderFlightDataIndicator(x, y + lineHeight * 2, 'G:', this.loadFactorG.toFixed(1),
            painter, this.loadFactorG >= 4 || this.loadFactorG < 0 ? hudWarnColor : hudColor, font);
    }

    private renderFlightDataIndicator(x: number, y: number, label: string, value: string, painter: CanvasPainter, color: string, font: Font) {
        const charStep = font.charWidth + font.charSpacing;
        const valueX = x + charStep * 6;
        painter.text(font, x, y, label, color);
        painter.text(font, valueX, y, value, color);
    }

    private renderAltitude(layout: OverlayLayout, tickStep: number, x: number, y: number, width: number, painter: CanvasPainter, hudColor: string, font: Font, fontSmall: Font) {
        const { detailScale, layoutScale } = layout;
        const altitudeStep = this.displayUnits.altitudeStep;
        const altitudeLowThreshold = this.displayUnits.altitudeLowThreshold;
        const lowp = this.displayUnits.useBarometricAltitude && this.altitude >= altitudeLowThreshold;
        const markerScale = lowp ? 10 : 1;
        const tapeUnit = altitudeStep * markerScale;
        const tapeOrigin = tapeUnit * Math.floor(this.altitude / tapeUnit);
        const scrollOffset = tapeUnit > 0
            ? ((this.altitude - tapeOrigin) / tapeUnit) * tickStep
            : 0;
        const labelInterval = this.displayUnits.altitudeTapeLabelInterval * markerScale;
        const charHeightHalf = Math.trunc(font.charHeight / 2);

        const batch = painter.batch();
        for (let i = ALTITUDE_HALF_HEIGHT * detailScale; i >= -ALTITUDE_HALF_HEIGHT * detailScale; i--) {
            const current = tapeOrigin + i * altitudeStep;
            if (current >= 0 || lowp) {
                const barWidth = this.displayUnits.getAltitudeTickWidth(current, markerScale);
                if (barWidth > 0) {
                    batch.hLine(x, x + barWidth, y - i * tickStep + scrollOffset);
                }
            }
        }
        batch.hLine(x - 5, x - 2, y);
        batch.commit();

        const clip = painter.clip();
        clip.rectangle(x, y - ALTITUDE_HEIGHT * layoutScale, width - x, (ALTITUDE_HEIGHT * 2 + 3) * layoutScale).clip();
        for (let i = detailScale * (ALTITUDE_HALF_HEIGHT + 1) + 1; i >= -detailScale * (ALTITUDE_HALF_HEIGHT + 1) - 1; i--) {
            const current = tapeOrigin + i * altitudeStep;
            if ((current >= 0 || lowp) && current % labelInterval === 0) {
                painter.text(fontSmall,
                    x + 6 + (fontSmall.charWidth + fontSmall.charSpacing) * 3,
                    y - i * tickStep + scrollOffset - charHeightHalf,
                    this.displayUnits.formatAltitudeTape(current, lowp), hudColor, TextAlignment.RIGHT);
            }
        }
        clip.clear();

        painter.text(font, x - 8, y - Math.floor(font.charHeight / 2),
            this.displayUnits.formatAltitudeReadout(this.altitude), hudColor, TextAlignment.RIGHT);
    }

    private renderAltitudeFocusMode(x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        const textX = x + font.charWidth * 4;
        const textY = y - Math.floor(font.charHeight / 2);
        painter.text(font, textX, textY, this.displayUnits.formatAltitudeReadout(this.altitude), hudColor, TextAlignment.RIGHT);
        painter.rectangle(
            textX - ((font.charWidth + font.charSpacing) * 5 + font.charSpacing + 1),
            textY - font.charSpacing * 2 - 1,
            (font.charWidth + font.charSpacing) * 5 + font.charSpacing * 3 + 2,
            2 + font.charSpacing * 4 + font.charHeight);
    }

    private renderVerticalVelocityIndicator(layout: OverlayLayout, tickStep: number, x: number, y: number, painter: CanvasPainter, hudColor: string, hudWarnColor: string) {
        const { layoutScale } = layout;
        const maxPixels = ALTITUDE_HEIGHT * layoutScale;
        const pixelLength = clamp(layoutScale * this.verticalSpeed / this.displayUnits.verticalSpeedBarDivisor, -maxPixels, maxPixels);
        painter.setColor(hudWarnColor);
        painter.vLine(x - 1, y, y - pixelLength);
        painter.setColor(hudColor);
    }

    private renderHeading(layout: OverlayLayout, x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        const { detailScale, layoutScale } = layout;
        const headingSpacing = HEADING_SPACING * layoutScale / detailScale;
        const offset = this.heading % HEADING_SPACING;
        const batch = painter.batch();
        for (let i = -HEADING_HALF_WIDTH; i <= HEADING_HALF_WIDTH; i++) {
            const height = (this.heading + i * HEADING_STEP - offset) % 10 === 0 ? 2 * layoutScale / detailScale : 0;
            batch.vLine(x + i * headingSpacing - offset, y - height, y);
        }
        batch.vLine(x, y + 2 * layoutScale / detailScale, y + 4 * layoutScale / detailScale);
        batch.commit();

        const clip = painter.clip()
            .rectangle(x - HEADING_HALF_WIDTH * headingSpacing - font.charWidth - 1,
                y - font.charHeight - 4 * layoutScale / detailScale,
                HEADING_WIDTH * headingSpacing + 2 * font.charWidth,
                font.charHeight + 3 * layoutScale / detailScale)
            .clip();
        for (let i = -HEADING_HALF_WIDTH - 1 - detailScale; i <= HEADING_HALF_WIDTH + 1 + detailScale; i++) {
            const value = this.heading + i * HEADING_STEP - offset;
            if (value % 45 === 0) {
                painter.text(font,
                    x + i * headingSpacing - offset,
                    y - font.charHeight - 3 * layoutScale / detailScale,
                    formatHeading(value), hudColor, TextAlignment.CENTER);
            }
        }
        clip.clear();
    }

    private renderHeadingFocusMode(x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        const textY = y - font.charHeight;
        painter.text(font,
            x,
            textY,
            formatHeading(this.heading), hudColor, TextAlignment.CENTER);
        painter.rectangle(
            x - (Math.trunc(font.charWidth * 1.5) + 1 + font.charSpacing * 2 + 1),
            textY - font.charSpacing * 2 - 1,
            (font.charWidth + font.charSpacing) * 3 + font.charSpacing * 3 + 2,
            2 + font.charSpacing * 4 + font.charHeight);
    }

    private renderAirSpeed(layout: OverlayLayout, tickStep: number, x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font, fontSmall: Font) {
        const { detailScale, layoutScale } = layout;
        const airspeedStep = this.displayUnits.airspeedStep;
        const airspeedScale = this.displayUnits.airspeedScale;
        const airspeed = airspeedScale * airspeedStep * Math.floor(this.speed / airspeedStep);
        const tmp = 25 * Math.floor(this.speed * 10 / 25);
        const offset = tmp % 50 === 0 ? 0 : 1;
        const labelsRes = detailScale > 1 ? 1000 : 500;
        const charHeightHalf = Math.trunc(font.charHeight / 2);
        const smallCharHeightHalf = Math.trunc(fontSmall.charHeight / 2);

        const batch = painter.batch();
        for (let i = AIRSPEED_HALF_HEIGHT * detailScale; i >= -AIRSPEED_HALF_HEIGHT * detailScale; i--) {
            const current = airspeed + (i * 2 - offset) * airspeedStep * airspeedScale;
            if (current >= 0) {
                let barWidth = 0;
                if (current % 500 === 0) {
                    barWidth = 2;
                } else if (current % 250 === 0) {
                    barWidth = 1;
                }
                batch.hLine(x - barWidth, x, y - i * tickStep + offset);
            }
        }
        batch.hLine(x + 2, x + 5, y);
        batch.commit();

        const clip = painter.clip();
        clip.rectangle(0, y - AIRSPEED_HEIGHT * layoutScale, x, layoutScale * AIRSPEED_HEIGHT * 2 + 3).clip();
        for (let i = detailScale * (AIRSPEED_HALF_HEIGHT + 1) + 1; i >= -detailScale * (AIRSPEED_HALF_HEIGHT + 1) - 1; i--) {
            const current = airspeed + (i * 2 - offset) * airspeedStep * airspeedScale;
            if (current >= 0 && current % labelsRes === 0) {
                painter.text(fontSmall,
                    x - 6,
                    y - i * tickStep + offset - smallCharHeightHalf,
                    (current / airspeedScale).toFixed(0), hudColor, TextAlignment.RIGHT);
            }
        }
        clip.clear();

        painter.text(font,
            x + 9,
            y - charHeightHalf,
            Math.floor(this.speed).toString(),
            hudColor,
            TextAlignment.LEFT);
    }

    private renderAirSpeedFocusMode(x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        const textX = x - font.charWidth * 4;
        const textY = y - Math.trunc(font.charHeight / 2);
        painter.text(font,
            textX,
            y - Math.trunc(font.charHeight / 2),
            Math.floor(this.speed).toString(),
            hudColor,
            TextAlignment.LEFT);

        painter.rectangle(
            textX - (font.charSpacing * 2 + 1),
            textY - font.charSpacing * 2 - 1,
            (font.charWidth + font.charSpacing) * 5 + font.charSpacing * 3 + 2,
            2 + font.charSpacing * 4 + font.charHeight);
    }

    private renderThrottle(x: number, y: number, painter: CanvasPainter, hudColor: string, font: Font) {
        painter.text(font, x, y, this.actor.throttleHudText, hudColor);
    }

    private renderStickIndicator(centerX: number, centerY: number, arm: number, geomScale: number, painter: CanvasPainter, hudColor: string, hudSecondaryColor: string, hudLimitColor: string, font: Font) {
        const rollTravel = arm - Math.max(2, Math.round(2 * geomScale));
        const pitchTotalUnits = PITCH_STICK_FWD_UNITS + PITCH_STICK_AFT_UNITS;
        const pitchTotalSpan = Math.max(arm * 2, Math.round(40 * geomScale));
        const pitchFwdTravel = Math.round(pitchTotalSpan * PITCH_STICK_FWD_UNITS / pitchTotalUnits);
        const pitchAftTravel = pitchTotalSpan - pitchFwdTravel;
        const pitch = this.pitchInput;
        const roll = this.rollInput;
        const yaw = this.yawInput;
        const throttle = this.actor.throttleUnit;
        const crossArm = Math.max(2, Math.round(2 * geomScale));
        const gap = Math.max(2, Math.round(2 * geomScale));

        painter.setColor(hudSecondaryColor);
        painter.batch()
            .hLine(centerX - arm, centerX + arm, centerY)
            .vLine(centerX, centerY - pitchFwdTravel, centerY + pitchAftTravel)
            .commit();

        // Max/min elevator-command clamp lines (where the FCS limits the pitch
        // input). Cross span and stick marker both follow PITCH_STICK_FWD/AFT_UNITS.
        const pitchCmdYOffset = (v: number) => v >= 0 ? v * pitchAftTravel : v * pitchFwdTravel;
        const limitY = (v: number) => Math.max(
            centerY - pitchFwdTravel,
            Math.min(centerY + pitchAftTravel, Math.round(centerY + pitchCmdYOffset(v))),
        );
        const limitHiY = limitY(this.elevatorLimitHigh);
        const limitLoY = limitY(this.elevatorLimitLow);
        painter.setColor(hudLimitColor);
        painter.batch()
            .hLine(centerX - arm, centerX + arm, limitHiY)
            .hLine(centerX - arm, centerX + arm, limitLoY)
            .commit();

        const stickX = centerX + roll * rollTravel;
        const stickY = centerY + pitchCmdYOffset(pitch);
        painter.setColor(hudColor);
        painter.circle(Math.round(stickX), Math.round(stickY), crossArm);

        const rudderY = centerY + pitchAftTravel + gap;
        painter.setColor(hudSecondaryColor);
        painter.hLine(centerX - arm, centerX + arm, rudderY);
        painter.setColor(hudColor);
        painter.vLine(centerX + yaw * (arm - 1), rudderY - 1, rudderY + 1);

        const throttleX = centerX - arm - gap;
        painter.setColor(hudSecondaryColor);
        painter.vLine(throttleX, centerY - arm, centerY + arm);
        painter.setColor(hudColor);
        const throttleY = centerY + arm - 1 - throttle * (arm * 2 - 1);
        painter.hLine(throttleX - 1, throttleX + 1, throttleY);

        const limitersOn = this.actor.fcsLimitersEnabled;
        // FM3 has one control law; the 1/2/3 limiter strategies are FM2's.
        const fm3 = this.config.flightModels.getActiveKey() === FlightModels.FM3;
        const label = limitersOn
            ? (fm3 ? 'FCS FM3' : (FCS_MODE_LABELS[this.actor.fcsPitchLimiterMode] ?? ''))
            : 'FCS OFF';
        const labelColor = limitersOn ? hudColor : hudLimitColor;
        const labelY = rudderY + gap + 2;
        painter.text(font, centerX, labelY, label, labelColor, TextAlignment.CENTER);
    }

    private renderPitchLadder(layout: OverlayLayout, x: number, y: number, painter: CanvasPainter, hudColor: string, hudSecondaryColor: string, font: Font) {
        const { detailScale, layoutScale } = layout;
        const fov = toRadians(COCKPIT_FOV);
        const logicalHeight = getOverlayLogicalHeight(layout);
        const current = toDegrees(-this.pitch) / 10 * detailScale;
        const minMarker = Math.max(Math.ceil(current) - LADDER_EXTRA_MARKERS * detailScale, -9 * detailScale);
        const maxMarker = Math.min(Math.floor(current) + LADDER_EXTRA_MARKERS * detailScale, 9 * detailScale);

        painter.setColor(hudSecondaryColor);

        const ladderSpread = layoutScale > 1 ? Math.max(1.5, layoutScale / detailScale) : 1;
        const clip = painter.clip()
            .rectangle(x - Math.floor(LADDER_HALF_WIDTH * ladderSpread),
                y - LADDER_HALF_HEIGHT * layoutScale,
                Math.floor(LADDER_WIDTH * ladderSpread),
                (LADDER_HEIGHT + font.charHeight) * layoutScale)
            .clip();

        const geomScale = layoutScale / detailScale;

        for (let i = minMarker; i <= maxMarker; i++) {
            const offset = ((this.pitch + toRadians(i * 10 / detailScale)) / fov) * logicalHeight;
            const center = this._w.set(x, 0, y);

            const normal = this._v.copy(FORWARD)
                .negate()
                .applyAxisAngle(UP, this.roll);
            center.addScaledVector(normal, -offset);

            const ladderHalf = LADDER_SIZE_HALF * geomScale;
            normal.multiplyScalar(ladderHalf);

            const C0_X = center.x + normal.z;
            const C0_Y = center.z + -normal.x;
            const C1_X = center.x + -normal.z;
            const C1_Y = center.z + normal.x;

            normal.divideScalar(ladderHalf);

            const batch = painter.batch();

            if (i >= 0) { // Gap in the middle
                const horizonVerticalOffset = ladderHalf + LADDER_HORIZON_HALF_GAP * geomScale;
                batch.line(
                    C0_X, C0_Y,
                    C1_X + normal.z * horizonVerticalOffset,
                    C1_Y + -normal.x * horizonVerticalOffset
                );
                batch.line(
                    C0_X + -normal.z * horizonVerticalOffset,
                    C0_Y + normal.x * horizonVerticalOffset,
                    C1_X, C1_Y
                );
            } else { // Single line
                batch.line(C0_X, C0_Y, C1_X, C1_Y);
            }
            if (i !== 0) {
                const sign = Math.sign(i);
                const chevron = 5 * geomScale;
                const nX = sign * normal.x * chevron;
                const nY = sign * normal.z * chevron;
                batch.line(C0_X, C0_Y, C0_X + nX, C0_Y + nY);
                batch.line(C1_X, C1_Y, C1_X + nX, C1_Y + nY);
            }
            batch.commit();

            if (i === 0 && detailScale > 1) continue;

            const str = (i === 0) ? '00' : `${Math.round(i * -10 / detailScale)}`;
            const charHeightHalf = Math.trunc(font.charHeight / 2);
            const tX = Math.round(normal.x * charHeightHalf);
            const tY = Math.round(normal.z * charHeightHalf);
            const labelOffset = 2 * (font.charWidth + font.charSpacing) * geomScale;
            const T0_X = Math.floor(normal.z * labelOffset);
            const T0_Y = Math.round(-normal.x * labelOffset);
            const T1_X = Math.floor(-normal.z * labelOffset);
            const T1_Y = Math.round(normal.x * labelOffset);
            painter.text(font, C0_X + tX + T0_X, C0_Y + tY + T0_Y, str, hudSecondaryColor, TextAlignment.CENTER);
            painter.text(font, C1_X + tX + T1_X, C1_Y + tY + T1_Y, str, hudSecondaryColor, TextAlignment.CENTER);
        }
        clip.clear();

        painter.setColor(hudColor);
    }

    private renderTarget(width: number, height: number, halfWidth: number, halfHeight: number, painter: CanvasPainter, camera: THREE.Camera, geomScale: number) {
        if (this.weaponsTarget === undefined) return;

        const targetHalfWidth = Math.round(TARGET_HALF_WIDTH * geomScale);
        const targetWidth = targetHalfWidth * 2 + 1;

        camera.getWorldDirection(this._v);
        this._plane.setFromNormalAndCoplanarPoint(this._v, camera.position);
        if (this._plane.distanceToPoint(this.weaponsTarget.position) > 0) {
            this._v.copy(this.weaponsTarget.position);
            this._v.project(camera);
            const x = Math.round((this._v.x * halfWidth) + halfWidth);
            const y = Math.round(-(this._v.y * halfHeight) + halfHeight);
            if (0 <= x && x < width &&
                0 <= y && y < height) {
                painter.rectangle(x - targetHalfWidth, y - targetHalfWidth, targetWidth, targetWidth);
            }
        }
    }

    /** Gun ammo/hull readout when cannon is armed. */
    private renderGunReticle(
        dx: number, dy: number, targetHeight: number,
        painter: CanvasPainter, geomScale: number, hudColor: string, hudWarnColor: string, font: Font,
    ) {
        if (!this.hasGun) {
            return;
        }

        const lineHeight = font.charHeight + font.charSpacing;
        const x = Math.max(4, Math.round(4 * geomScale)) + dx;
        const y = targetHeight - lineHeight * 2 - 2 + dy;
        const hpPct = Math.round(this.healthFraction * 100);
        painter.text(font, x, y, `GUN ${this.gunAmmo}`, this.gunAmmo > 0 ? hudColor : hudWarnColor, TextAlignment.LEFT);
        painter.text(font, x, y + lineHeight, `HULL ${hpPct}%`, hpPct <= 30 ? hudWarnColor : hudColor, TextAlignment.LEFT);
    }

    /**
     * Gun pipper: circle where rounds are at the current target range, with a
     * single line from the HUD boresight to the pipper.
     */
    private renderGunAimIndicator(
        width: number, height: number, halfWidth: number, halfHeight: number,
        dx: number, dy: number,
        painter: CanvasPainter, camera: THREE.Camera, geomScale: number, hudColor: string,
    ) {
        if (!this.hasGun) {
            return;
        }

        const pos = this.actor.getDisplayPosition();
        const quat = this.actor.getDisplayQuaternion();
        const vel = this.actor.getDisplayVelocity();

        // Same muzzle + velocity model as Gun.tryFire / combat sim.
        this._v.copy(FORWARD).applyQuaternion(quat);
        this._aim.copy(GUN_MUZZLE_OFFSET).applyQuaternion(quat).add(pos);

        let targetPos: THREE.Vector3 | undefined;
        if (this.weaponsTarget) {
            // Scratch target into `_w`, then overwrite with pipper point.
            this._w.copy(this.weaponsTarget.position).add(this.weaponsTarget.localCenter);
            targetPos = this._w;
        }

        computeGunPipperWorldPoint(
            this._w, this._aim, this._v, vel, GUN_MUZZLE_VELOCITY_MPS,
            targetPos, GUN_AIM_DEFAULT_RANGE_M,
        );

        const projected = this.projectOnHudGlass(
            this._w, camera as THREE.PerspectiveCamera, halfWidth, halfHeight, dx, dy,
        );
        if (!projected) {
            return;
        }
        const pipperX = projected.x;
        const pipperY = projected.y;
        if (pipperX < 0 || pipperX >= width || pipperY < 0 || pipperY >= height) {
            return;
        }

        const boreX = Math.round(halfWidth + dx);
        const boreY = Math.round(halfHeight + dy);
        painter.setColor(hudColor);
        painter.batch()
            .line(boreX, boreY, pipperX, pipperY)
            .commit();

        const r = Math.max(3, Math.round(5 * geomScale));
        painter.circle(pipperX, pipperY, r);
        painter.batch()
            .hLine(pipperX - 1, pipperX + 1, pipperY)
            .vLine(pipperX, pipperY - 1, pipperY + 1)
            .commit();
    }

    /**
     * ILS / OLS-style localizer + glideslope when the weapons target is the
     * airfield or carrier. Glideslope uses a meatball between green datum ticks
     * on a fixed 3° path. Replaces the gun pipper for approach.
     */
    private renderIlsIndicator(
        width: number, height: number, halfWidth: number, halfHeight: number,
        dx: number, dy: number,
        painter: CanvasPainter, camera: THREE.Camera, geomScale: number,
        hudColor: string, hudSecondaryColor: string, palette: Palette,
    ) {
        if (!this.weaponsTarget) return;
        const dev = computeIlsDeviation(
            this.actor.getDisplayPosition(),
            this.weaponsTarget.targetType,
            this.weaponsTarget.targetType === 'Carrier' ? this.weaponsTarget.position : undefined,
            this.weaponsTarget.approachRunway,
        );
        if (!dev) return;

        const cx = Math.round(halfWidth + dx);
        const cy = Math.round(halfHeight + dy);
        const u = Math.max(1, Math.round(geomScale));
        const arm = Math.max(18, Math.round(22 * geomScale));
        const tick = Math.max(2, Math.round(3 * geomScale));
        const needleTravel = arm - 2 * u;
        const datumColor = PaletteColor(palette, PaletteCategory.LIGHT_GREEN);
        const ballColor = PaletteColor(palette, PaletteCategory.LIGHT_YELLOW);

        // Reference box + center cross.
        painter.setColor(hudSecondaryColor);
        painter.batch()
            .hLine(cx - arm, cx + arm, cy - arm)
            .hLine(cx - arm, cx + arm, cy + arm)
            .vLine(cx - arm, cy - arm, cy + arm)
            .vLine(cx + arm, cy - arm, cy + arm)
            .hLine(cx - tick, cx + tick, cy)
            .vLine(cx, cy - tick, cy + tick)
            .commit();

        // Green datum lights (OLS reference) flanking the glideslope midline.
        const datumX = arm + Math.round(4 * geomScale);
        painter.setColor(datumColor);
        painter.batch()
            .hLine(cx - datumX - tick, cx - datumX + tick, cy)
            .hLine(cx + datumX - tick, cx + datumX + tick, cy)
            .commit();

        // Localizer (vertical needle).
        const locX = Math.round(cx + dev.localizer * needleTravel);
        painter.setColor(hudColor);
        painter.batch()
            .vLine(locX, cy - arm + u, cy + arm - u)
            .commit();

        // Meatball: yellow ball rides the 3° glideslope relative to the datums.
        const ballY = Math.round(cy - dev.glideslope * needleTravel);
        const ballR = Math.max(2, Math.round(3 * geomScale));
        painter.setColor(ballColor);
        painter.circle(cx, ballY, ballR);

        // Glideslope needle through the ball.
        painter.setColor(hudColor);
        painter.batch()
            .hLine(cx - arm + u, cx + arm - u, ballY)
            .commit();

        void width;
        void camera;
        void height;
    }

    /**
     * Approach cues beside the airspeed tape: target IAS and sink for the groove.
     */
    private renderApproachTargets(
        layout: OverlayLayout,
        airSpeedX: number,
        airSpeedY: number,
        painter: CanvasPainter,
        hudColor: string,
        hudSecondaryColor: string,
        font: Font,
    ) {
        const imperial = this.displayUnits.getSystem() === UnitSystems.IMPERIAL;
        const tgtSpeed = carrierApproachTargetSpeed(imperial);
        const tgtSink = carrierApproachTargetSink(imperial);
        const speedUnit = this.displayUnits.speedUnitLabel();
        const sinkUnit = imperial ? 'FPM' : 'M/S';
        const lineHeight = font.charHeight + font.charSpacing;
        const geomScale = layout.layoutScale / Math.max(1, layout.detailScale);
        const x = airSpeedX - Math.round(14 * geomScale);
        const y = airSpeedY + Math.round(16 * geomScale);

        painter.text(font, x, y, `TGT ${tgtSpeed}${speedUnit}`, hudColor, TextAlignment.RIGHT);
        painter.text(font, x, y + lineHeight, `VS ${tgtSink}${sinkUnit}`, hudSecondaryColor, TextAlignment.RIGHT);
        painter.text(font, x, y + lineHeight * 2, `GS ${ILS_GLIDESLOPE_DEG.toFixed(1)}`, hudSecondaryColor, TextAlignment.RIGHT);
    }

    /**
     * Navy-style AoA indexer: slow (high AoA) / on-speed 8.0°–8.5° / fast.
     * On-speed lights a yellow center donut.
     */
    private renderAoaIndexer(
        airSpeedX: number, airSpeedY: number, geomScale: number,
        painter: CanvasPainter, hudColor: string, hudWarnColor: string, hudSecondaryColor: string,
        palette: Palette,
    ) {
        const u = Math.max(1, Math.round(geomScale));
        const cx = airSpeedX - Math.round(14 * geomScale);
        const cy = airSpeedY;
        const gap = Math.round(7 * geomScale);
        const aoaDeg = toDegrees(this.angleOfAttack);
        const cue = aoaIndexerCue(aoaDeg);
        const nearStall = aoaDeg >= AOA_STALL_DEG - 2;
        const donutColor = PaletteColor(palette, PaletteCategory.LIGHT_YELLOW);

        // Upper chevron (slow / high AoA).
        painter.setColor(cue === 'slow' ? (nearStall ? hudWarnColor : hudColor) : hudSecondaryColor);
        painter.batch()
            .line(cx, cy - gap - 2 * u, cx - 4 * u, cy - gap + 3 * u)
            .line(cx, cy - gap - 2 * u, cx + 4 * u, cy - gap + 3 * u)
            .commit();

        // Center donut (on speed 8.0°–8.5°).
        painter.setColor(cue === 'onSpeed' ? donutColor : hudSecondaryColor);
        const r = Math.max(2, Math.round(3 * geomScale));
        painter.circle(cx, cy, r);

        // Lower chevron (fast / low AoA).
        painter.setColor(cue === 'fast' ? hudColor : hudSecondaryColor);
        painter.batch()
            .line(cx, cy + gap + 2 * u, cx - 4 * u, cy + gap - 3 * u)
            .line(cx, cy + gap + 2 * u, cx + 4 * u, cy + gap - 3 * u)
            .commit();

        painter.setColor(hudColor);
    }

    /** HUD boresight cross at the airframe combiner (gun axis / nozzle aim point). */
    private renderBoresight(hudX: number, hudY: number, painter: CanvasPainter, geomScale: number, hudColor: string) {
        painter.setColor(hudColor);
        const u = geomScale;
        const cx = Math.round(hudX);
        const cy = Math.round(hudY);
        const gap = Math.max(1, Math.round(u));
        const arm = Math.max(4, Math.round(5 * u));
        painter.batch()
            .hLine(cx - arm - gap, cx - gap, cy)
            .hLine(cx + gap, cx + arm + gap, cy)
            .vLine(cx, cy - arm - gap, cy - gap)
            .vLine(cx, cy + gap, cy + arm + gap)
            .commit();
    }

    private renderFlightPathMarker(
        width: number, height: number, halfWidth: number, halfHeight: number,
        dx: number, dy: number,
        painter: CanvasPainter, camera: THREE.Camera, geomScale: number,
        approachAids: boolean,
        hudColor: string,
        hudSecondaryColor: string,
        palette: Palette,
    ) {
        const u = geomScale;
        this._aim.copy(camera.position).add(this.velocityDirection);
        const projected = this.projectOnHudGlass(
            this._aim, camera as THREE.PerspectiveCamera, halfWidth, halfHeight, dx, dy,
        );
        if (!projected) {
            return;
        }
        const { x, y } = projected;
        if (0 <= x && x < width &&
            0 <= y && y < height) {
            painter.batch()
                .hLine(x - u, x + u, y - 2 * u)
                .hLine(x - u, x + u, y + 2 * u)
                .vLine(x - 2 * u, y - u, y + u)
                .vLine(x + 2 * u, y - u, y + u)
                .hLine(x - 5 * u, x - 3 * u, y)
                .hLine(x + 3 * u, x + 5 * u, y)
                .vLine(x, y - 4 * u, y - 3 * u)
                .commit();

            // E-bracket centered on the velocity vector during ILS approach.
            if (approachAids) {
                const cue = aoaIndexerCue(toDegrees(this.angleOfAttack));
                const bracketColor = cue === 'onSpeed'
                    ? PaletteColor(palette, PaletteCategory.LIGHT_YELLOW)
                    : hudSecondaryColor;
                const bx = Math.round(x - 9 * u);
                const arm = Math.round(4 * u);
                const gap = Math.round(5 * u);
                painter.setColor(bracketColor);
                painter.batch()
                    .hLine(bx - arm, bx, y - gap)
                    .hLine(bx - arm, bx, y)
                    .hLine(bx - arm, bx, y + gap)
                    .vLine(bx - arm, y - gap, y + gap)
                    .commit();
                painter.setColor(hudColor);
            }
        }
    }

    private renderStallStatus(layout: OverlayLayout, x: number, y: number, painter: CanvasPainter, hudColor: string, hudWarnColor: string) {
        const HALF_HEIGHT_PIXELS = layout.layoutScale * AIRSPEED_HALF_HEIGHT * 2;
        painter.setColor(hudWarnColor);
        painter.vLine(x + 1, y + HALF_HEIGHT_PIXELS + 1, y + HALF_HEIGHT_PIXELS + 1 - Math.floor((this.stallStatus + 1.0) * (HALF_HEIGHT_PIXELS + 1)));
        painter.setColor(hudColor);
    }

    private renderStallWarning(layout: OverlayLayout, x: number, y: number, painter: CanvasPainter, hudColor: string, hudWarnColor: string, font: Font) {
        const HALF_HEIGHT_PIXELS = layout.layoutScale * AIRSPEED_HALF_HEIGHT * 2;
        painter.setColor(hudWarnColor);
        const blink = Math.round(this.elapsed * 15) % 2 === 0;
        if (this.stallStatus >= 0 && !this.isLanded && blink) {
            painter.text(font, x + 9,
                y + HALF_HEIGHT_PIXELS + 1 - font.charHeight + font.charSpacing,
                'STALL',
                hudWarnColor,
                TextAlignment.LEFT);
        }
        painter.setColor(hudColor);
    }
}