import * as THREE from 'three';
import { Palette, PaletteCategory, PaletteColor } from "../../../config/palettes/palette";
import { PITCH_STICK_AFT_UNITS, PITCH_STICK_FWD_UNITS } from '../../../defs';
import { formatF16ThrottleHud } from '../../../physics/f16Engine';
import { CanvasPainter } from "../../../render/screen/canvasPainter";
import { Font, TextAlignment } from "../../../render/screen/text";
import { calculatePitchRoll, FORWARD, UP, vectorHeading } from '../../../utils/math';
import { Entity } from "../../entity";
import { Scene, SceneLayers } from "../../scene";
import { updateTargetCamera } from '../../utils';
import { WeaponsTarget } from '../weaponsTarget';
import { PlayerEntity } from "../player";
import { formatHeading, getAircraftDeviceStatusPosition, getOverlayLayout, renderAircraftDeviceStatus } from './overlayUtils';
import { EnuBasis, worldToGeodetic } from '../../../terrain/geodesy';
import { MapTileSource, MovingMapRenderer } from './movingMap';

/** Where the moving map reads its chart from: the terrain's frame and its cover rasters. */
export interface MovingMapSource {
    basis: EnuBasis;
    coverTextures: MapTileSource;
}



/**
 * MFD1 is the tactical display: a heading-up radar scope centred on the
 * aircraft that plots every designatable target -- the same list, in the same
 * order, that the target-cycling key walks. A blip straight above the ownship
 * marker is dead ahead, and the designated target is boxed.
 */

/** Scope range ladder (Km); the smallest ring holding the lock is used. */
const TACTICAL_RANGES_KM = [5, 10, 20, 40, 80];

/** Scope range (Km) used while nothing is designated. */
export const TACTICAL_DEFAULT_RANGE_KM = 20;

/**
 * Seconds between rescans of the scene for designatable targets. Contact
 * positions are read every frame; only the list itself is rebuilt on this
 * interval, since scanning the scene by tag walks every entity.
 */
const TACTICAL_SCAN_INTERVAL = 0.5;

/** Where a contact sits on the scope, in pixels from its centre. */
export interface TacticalPlot {
    x: number;
    y: number;
    /** The contact is past the outer ring, and pinned to the rim. */
    offScope: boolean;
}

/** Smallest ladder range that holds a lock at `lockRangeKm` (Km). */
export function tacticalScopeRange(lockRangeKm: number | undefined): number {
    if (lockRangeKm === undefined) {
        return TACTICAL_DEFAULT_RANGE_KM;
    }
    for (const range of TACTICAL_RANGES_KM) {
        if (lockRangeKm <= range) {
            return range;
        }
    }
    return TACTICAL_RANGES_KM[TACTICAL_RANGES_KM.length - 1];
}

/**
 * Plots a contact on the heading-up scope. `dx` / `dz` are the world offsets
 * from the aircraft in metres, `headingDeg` is the aircraft heading, and
 * `radius` the outer ring in pixels. Ahead of the aircraft plots up the screen,
 * so screen Y grows downwards as in the rest of the overlay.
 */
export function plotTacticalContact(dx: number, dz: number, headingDeg: number,
    rangeKm: number, radius: number): TacticalPlot {

    const heading = headingDeg * Math.PI / 180;
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    // World (x east, -z north) into the scope frame: ahead is up, right is right.
    const ahead = dx * sinH - dz * cosH;
    const right = dx * cosH + dz * sinH;
    const distance = Math.hypot(right, ahead);
    if (distance < 1) {
        return { x: 0, y: 0, offScope: false };
    }
    const scopeDistance = distance * radius / (rangeKm * 1000);
    const offScope = scopeDistance > radius;
    const plotted = offScope ? radius : scopeDistance;
    return {
        x: right / distance * plotted,
        y: -ahead / distance * plotted,
        offScope,
    };
}

// Pixels
export function CockpitMFDSize(height: number, width?: number): number {
    const byHeight = Math.floor(height / 3.333);
    if (width === undefined) {
        return byHeight;
    }
    const maxByWidth = Math.floor((width - 2) / 2);
    const maxByHeight = Math.floor(height - 2);
    return Math.max(1, Math.min(byHeight, maxByWidth, maxByHeight));
}

// Pixels
export function CockpitMFD1X(width: number, height: number, size: number): number {
    return 1;
}

// Pixels
export function CockpitMFD1Y(width: number, height: number, size: number): number {
    return Math.max(1, height - size - 1);
}

// Pixels
export function CockpitMFD2X(width: number, height: number, size: number): number {
    return Math.max(1, width - size - 1);
}

// Pixels
export function CockpitMFD2Y(width: number, height: number, size: number): number {
    return Math.max(1, height - size - 1);
}

export class CockpitEntity implements Entity {

    constructor(private actor: PlayerEntity,
        private camera: THREE.PerspectiveCamera,
        private targetCamera: THREE.PerspectiveCamera,
        private readonly mapSource?: MovingMapSource) {
        this.movingMap = mapSource === undefined ? undefined : new MovingMapRenderer(mapSource.coverTextures);
    }

    private readonly movingMap: MovingMapRenderer | undefined;
    /** The tactical display draws the moving map under its scope. */
    private movingMapShown: boolean = false;

    /** Whether the aircraft carries a chart to show at all. */
    get movingMapAvailable(): boolean {
        if (this.movingMap === undefined || this.mapSource === undefined) {
            return false;
        }
        const range = this.mapSource.coverTextures.zoomRange;
        return range.max >= range.min;
    }

    get movingMapEnabled(): boolean {
        return this.movingMapShown && this.movingMapAvailable;
    }

    /** The MFD's map option; a no-op without a chart to show. */
    setMovingMapEnabled(on: boolean): void {
        this.movingMapShown = on && this.movingMapAvailable;
    }

    private aiPitch: number = 0;
    private aiRoll: number = 0;

    private ownHeading: number = 0;
    /** Designatable targets plotted on the tactical display. */
    private readonly contacts: WeaponsTarget[] = [];
    private contactScanTimer: number = 0;
    private weaponsTarget: WeaponsTarget | undefined;
    private weaponsTargetRange: number = 0; // Km
    private weaponsTargetBearing: number = 0; // degrees, 0 is North, increases CW
    private weaponsTargetZoomFactor: number = 1; // Times standard FOV
    private weaponsTargetAirborne: boolean = false;
    // Enemy direction as seen down the aircraft's longitudinal axis (cockpit
    // frame): a unit screen vector plus an off-boresight amount in [0, 1].
    private weaponsTargetDirX: number = 0;
    private weaponsTargetDirY: number = 0;
    private weaponsTargetOffAxis: number = 0;
    private weaponsTargetSpeedMps: number = 0;
    private weaponsTargetLoadG: number = 1;
    private weaponsTargetHealth: number = 1;
    private weaponsTargetStickPitch: number = 0;
    private weaponsTargetStickRoll: number = 0;
    private weaponsTargetThrottle: number = 0;

    private _v = new THREE.Vector3();
    private _w = new THREE.Vector3();
    private _q = new THREE.Quaternion();

    readonly tags: string[] = [];

    enabled: boolean = true;

    init(scene: Scene): void {
        //
    }

    update(delta: number): void {
        this.weaponsTarget = this.actor.weaponsTarget;

        this.contactScanTimer -= delta;
        if (this.contactScanTimer <= 0) {
            this.contactScanTimer = TACTICAL_SCAN_INTERVAL;
            this.actor.collectWeaponsTargets(this.contacts);
        }
    }

    private refreshVisualState(): void {
        const displayPos = this.actor.getDisplayPosition();
        const displayQuat = this.actor.getDisplayQuaternion();

        const prjForward = this.actor
            .getDisplayWorldDirection(this._v)
            .setY(0)
            .normalize();
        this.ownHeading = vectorHeading(prjForward);

        [this.aiPitch, this.aiRoll] = calculatePitchRoll({
            quaternion: displayQuat,
            getWorldDirection: (v) => this.actor.getDisplayWorldDirection(v),
        });

        if (this.weaponsTarget !== undefined) {
            this.weaponsTargetAirborne = this.weaponsTarget.airborne;

            this._v
                .copy(this.weaponsTarget.position)
                .sub(displayPos);
            this.weaponsTargetRange = this._v.length() / 1000.0;

            this._v
                .setY(0)
                .normalize();
            this.weaponsTargetBearing = vectorHeading(this._v);

            // Enemy direction rotated into the aircraft body frame so the pointer
            // reflects the cockpit view down the longitudinal axis: +X is right,
            // +Y is up, +Z is forward (nose).
            this._w
                .copy(this.weaponsTarget.position)
                .sub(displayPos)
                .applyQuaternion(this._q.copy(displayQuat).invert());
            const perp = Math.hypot(this._w.x, this._w.y);
            if (perp > 1e-3) {
                this.weaponsTargetDirX = -this._w.x / perp;
                this.weaponsTargetDirY = -this._w.y / perp;
            } else {
                this.weaponsTargetDirX = 0;
                this.weaponsTargetDirY = 0;
            }
            this.weaponsTargetOffAxis = Math.min(1, Math.atan2(perp, this._w.z) / (Math.PI / 2));

            this.weaponsTargetZoomFactor = updateTargetCamera(this.actor, this.camera, this.targetCamera);

            this.weaponsTargetSpeedMps = this.weaponsTarget.targetSpeedMps ?? 0;
            this.weaponsTargetLoadG = this.weaponsTarget.targetLoadFactorG ?? 1;
            this.weaponsTargetHealth = this.weaponsTarget.targetHealthFraction ?? 1;
            this.weaponsTargetStickPitch = this.weaponsTarget.targetStickPitch ?? 0;
            this.weaponsTargetStickRoll = this.weaponsTarget.targetStickRoll ?? 0;
            this.weaponsTargetThrottle = this.weaponsTarget.targetThrottle ?? 0;
        }
    }

    render3D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Map<string, THREE.Scene>, palette: Palette): void {
        // Nothing
    }

    render2D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Set<string>, painter: CanvasPainter, palette: Palette): void {
        if (!lists.has(SceneLayers.Overlay)) return;

        this.refreshVisualState();

        const layout = getOverlayLayout(targetWidth, targetHeight);
        const { layoutScale } = layout;

        const font = layoutScale > 1 ? Font.HUD_LARGE : Font.HUD_SMALL;
        const hudColor = PaletteColor(palette, PaletteCategory.HUD_TEXT);

        this.renderAttitudeIndicator(targetWidth, targetHeight, painter, palette);

        const MFDSize = CockpitMFDSize(targetHeight, targetWidth);
        this.renderMFD1(
            CockpitMFD1X(targetWidth, targetHeight, MFDSize),
            CockpitMFD1Y(targetWidth, targetHeight, MFDSize),
            MFDSize, painter, palette, font, hudColor);
        this.renderMFD2(
            CockpitMFD2X(targetWidth, targetHeight, MFDSize),
            CockpitMFD2Y(targetWidth, targetHeight, MFDSize),
            MFDSize, painter, hudColor, palette, font);

        const { x: gearX, y: gearY } = getAircraftDeviceStatusPosition(targetHeight, MFDSize, font);
        renderAircraftDeviceStatus(this.actor, gearX, gearY, painter, hudColor, font);
    }

    private renderAttitudeIndicator(targetWidth: number, targetHeight: number, painter: CanvasPainter, palette: Palette) {

        const halfWidth = targetWidth / 2;

        const scale = getOverlayLayout(targetWidth, targetHeight).layoutScale;
        const AI_SIZE = 29 * scale;
        const AI_SIZE_HALF = Math.floor(AI_SIZE / 2);
        const AI_X = halfWidth - AI_SIZE_HALF;
        const AI_Y = targetHeight - AI_SIZE + 1;
        const AI_X_MAX = AI_X + AI_SIZE - 1;
        const AI_Y_MAX = AI_Y + AI_SIZE - 1;
        const AI_CENTER_X = AI_X + AI_SIZE_HALF;
        const AI_CENTER_Y = AI_Y + AI_SIZE_HALF;

        const offset = this.aiPitch / (Math.PI / 2);
        const center = this._w.set(AI_CENTER_X, 0, AI_CENTER_Y);

        const normal = this._v.copy(FORWARD)
            .negate()
            .applyAxisAngle(UP, this.aiRoll);
        center.addScaledVector(normal, -offset * AI_SIZE);

        normal.multiplyScalar(AI_SIZE_HALF);

        const C0_X = Math.floor(center.x + normal.z);
        const C0_Y = Math.round(center.z + -normal.x);
        const C1_X = Math.floor(center.x + -normal.z);
        const C1_Y = Math.round(center.z + normal.x);

        painter.setBackground('#404042');
        painter.rectangle(AI_X - 2, AI_Y - 2, AI_SIZE + 3, AI_SIZE + 3, true);

        const clip = painter.clip().circle(AI_CENTER_X, AI_CENTER_Y, AI_SIZE_HALF).clip();

        const colorGround = PaletteColor(palette, PaletteCategory.COCKPIT_AI_GROUND);
        const colorSky = PaletteColor(palette, PaletteCategory.COCKPIT_AI_SKY);

        painter.setColor(colorGround);

        painter.setBackground(colorSky);
        painter.rectangle(AI_X, AI_Y, AI_SIZE - 1, AI_SIZE - 1, true);

        painter.setBackground(colorGround);
        if (C0_X < C1_X) {
            if (C0_X > AI_X && C0_Y < AI_Y_MAX) {
                painter.rectangle(AI_X, C0_Y, C0_X - AI_X, AI_Y_MAX - C0_Y, true);
            }
            if (C1_X < AI_X_MAX && C1_Y < AI_Y_MAX) {
                painter.rectangle(C1_X + 1, C1_Y, AI_X_MAX - C1_X - 1, AI_Y_MAX - C1_Y, true);
            }
            const C_Y = Math.max(C0_Y, C1_Y);
            if (C1_Y < AI_Y_MAX) {
                painter.rectangle(C0_X, C_Y, C1_X - C0_X + 1, AI_Y_MAX - C_Y, true);
            }
        } else {
            if (C1_X > AI_X && C1_Y > AI_Y) {
                painter.rectangle(AI_X, AI_Y, C1_X - AI_X, C1_Y - AI_Y, true);
            }
            if (C0_X < AI_X_MAX && C0_Y > AI_Y) {
                painter.rectangle(C0_X + 1, AI_Y, AI_X_MAX - C0_X - 1, C0_Y - AI_Y, true);
            }
            const C_Y = Math.min(C0_Y, C1_Y);
            if (C_Y > AI_Y) {
                painter.rectangle(C1_X, AI_Y, C0_X - C1_X + 1, C_Y - AI_Y, true);
            }
        }

        painter.rightTriangle(
            Math.floor(C0_X),
            Math.round(C0_Y),
            Math.floor(C1_X),
            Math.round(C1_Y));

        clip.clear();

        painter.setColor('#ffffff');
        painter.batch()
            .hLine(-1 + AI_CENTER_X - 8, -1 + AI_CENTER_X - 4, AI_CENTER_Y - 2)
            .hLine(AI_CENTER_X + 4, AI_CENTER_X + 8, AI_CENTER_Y - 2)
            .line(-1 + AI_CENTER_X - 4, AI_CENTER_Y - 2, -1 + AI_CENTER_X, AI_CENTER_Y + 2)
            .line(AI_CENTER_X, AI_CENTER_Y + 2, AI_CENTER_X + 4, AI_CENTER_Y - 2)
            .commit();
    }

    /**
     * The tactical display: ownship at the centre of a heading-up scope, range
     * rings on the ladder range that holds the lock, and one blip per
     * designatable target. Contacts past the scope range are drawn as ticks on
     * the rim, so they still read as "out there, that way".
     */
    private renderMFD1(x: number, y: number, size: number, painter: CanvasPainter, palette: Palette, font: Font, hudColor: string) {
        painter.setColor(hudColor);
        painter.rectangle(x - 1, y - 1, size + 2, size + 2);
        painter.setBackground(PaletteColor(palette, PaletteCategory.COCKPIT_MFD_BACKGROUND));
        painter.rectangle(x, y, size, size, true);

        const secondary = PaletteColor(palette, PaletteCategory.HUD_TEXT_SECONDARY);
        const pad = font.charSpacing;
        const line = font.charHeight + font.charSpacing;
        // The bottom band carries the scale and the contact count; the scope
        // gets the rest of the square.
        const radius = Math.max(4, Math.floor((size - line - pad) / 2) - 1);
        const centerX = x + Math.floor(size / 2);
        const centerY = y + pad + radius;
        const rangeKm = tacticalScopeRange(
            this.weaponsTarget !== undefined ? this.weaponsTargetRange : undefined);

        if (this.movingMapEnabled) {
            this.renderMovingMap(x, y, size, centerX, centerY, radius, rangeKm, painter, palette);
            painter.text(font, x + size - pad, y + pad, 'MAP', secondary, TextAlignment.RIGHT);
        }
        this.renderTacticalScope(centerX, centerY, radius, painter, font, hudColor, secondary);
        this.renderTacticalContacts(centerX, centerY, radius, rangeKm, size, painter, hudColor, secondary);
        this.renderTacticalOwnship(centerX, centerY, size, painter, hudColor);

        const textY = y + size - font.charHeight - pad;
        painter.text(font, x + pad, textY, `${rangeKm} KM`, hudColor);
        painter.text(font, x + size - pad, textY,
            `${this.contacts.length} TGT`, secondary, TextAlignment.RIGHT);
    }

    /**
     * The chart under the scope: heading-up, the ownship at the scope centre,
     * the outer ring at the scope range. Clipped to the MFD face so the
     * rotated tiles never spill past its bezel.
     */
    private renderMovingMap(x: number, y: number, size: number, centerX: number, centerY: number,
        radius: number, rangeKm: number, painter: CanvasPainter, palette: Palette) {

        if (this.movingMap === undefined || this.mapSource === undefined) {
            return;
        }
        const p = this.actor.getDisplayPosition();
        const here = worldToGeodetic(this.mapSource.basis, p.x, p.y, p.z);
        const clip = painter.clip().rectangle(x, y, size + 1, size + 1).clip();
        this.movingMap.render(painter, {
            centerX,
            centerY,
            pixelsPerMetre: radius / (rangeKm * 1000),
            halfExtentPx: Math.max(centerX - x, centerY - y, x + size - centerX, y + size - centerY),
            latDeg: here.lat,
            lonDeg: here.lon,
            headingDeg: this.ownHeading,
            waterColor: PaletteColor(palette, PaletteCategory.TERRAIN_WATER),
        });
        clip.clear();
    }

    /** Range rings, boresight cross, and the north index. */
    private renderTacticalScope(centerX: number, centerY: number, radius: number,
        painter: CanvasPainter, font: Font, hudColor: string, secondary: string) {

        painter.setColor(secondary);
        painter.circle(centerX, centerY, radius);
        painter.circle(centerX, centerY, Math.floor(radius / 2));
        painter.batch()
            .vLine(centerX, centerY - radius, centerY + radius)
            .hLine(centerX - radius, centerX + radius, centerY)
            .commit();

        // The scope is heading-up, so north swings around with the aircraft.
        const heading = this.ownHeading * Math.PI / 180;
        const northX = -Math.sin(heading);
        const northY = -Math.cos(heading);
        const tick = Math.max(2, Math.round(radius * 0.16));
        painter.setColor(hudColor);
        painter.line(
            Math.round(centerX + northX * (radius - tick)),
            Math.round(centerY + northY * (radius - tick)),
            Math.round(centerX + northX * radius),
            Math.round(centerY + northY * radius));
        const labelRadius = radius - tick - font.charHeight;
        painter.text(font,
            Math.round(centerX + northX * labelRadius),
            Math.round(centerY + northY * labelRadius - font.charHeight / 2),
            'N', hudColor, TextAlignment.CENTER);
    }

    /** One blip per designatable target, plotted in the heading-up scope frame. */
    private renderTacticalContacts(centerX: number, centerY: number, radius: number, rangeKm: number,
        size: number, painter: CanvasPainter, hudColor: string, secondary: string) {

        const origin = this.actor.getDisplayPosition();
        const blipSize = Math.max(2, Math.min(8, Math.round(size * 0.05)));
        const tick = Math.max(2, Math.round(radius * 0.1));

        for (const contact of this.contacts) {
            const plot = plotTacticalContact(
                contact.position.x - origin.x,
                contact.position.z - origin.z,
                this.ownHeading, rangeKm, radius);
            const selected = contact === this.weaponsTarget;
            const color = selected ? hudColor : secondary;

            if (plot.offScope) {
                // Pinned to the rim: a radial tick on the contact's bearing.
                const inner = (radius - tick) / radius;
                painter.setColor(color);
                painter.line(
                    Math.round(centerX + plot.x * inner),
                    Math.round(centerY + plot.y * inner),
                    Math.round(centerX + plot.x),
                    Math.round(centerY + plot.y));
                continue;
            }

            this.renderTacticalBlip(
                Math.round(centerX + plot.x),
                Math.round(centerY + plot.y),
                blipSize, contact.airborne, selected, painter, color);
        }
    }

    /** Airborne contacts are diamonds, ground installations squares. */
    private renderTacticalBlip(px: number, py: number, blipSize: number, airborne: boolean,
        selected: boolean, painter: CanvasPainter, color: string) {

        const half = Math.max(1, Math.floor(blipSize / 2));
        painter.setColor(color);
        if (airborne) {
            painter.batch()
                .line(px, py - half, px + half, py)
                .line(px + half, py, px, py + half)
                .line(px, py + half, px - half, py)
                .line(px - half, py, px, py - half)
                .commit();
        } else {
            painter.rectangle(px - half, py - half, half * 2 + 1, half * 2 + 1);
        }
        if (selected) {
            const box = half + 2;
            painter.rectangle(px - box, py - box, box * 2 + 1, box * 2 + 1);
        }
    }

    /** Fixed nose-up ownship marker at the centre of the heading-up scope. */
    private renderTacticalOwnship(centerX: number, centerY: number, size: number,
        painter: CanvasPainter, hudColor: string) {

        const arm = Math.max(2, Math.min(6, Math.round(size * 0.05)));
        painter.setColor(hudColor);
        painter.batch()
            .line(centerX, centerY - arm, centerX - arm, centerY + arm)
            .line(centerX, centerY - arm, centerX + arm, centerY + arm)
            .line(centerX - arm, centerY + arm, centerX + arm, centerY + arm)
            .commit();
    }

    private renderMFD2(x: number, y: number, size: number, painter: CanvasPainter, hudColor: string, palette: Palette, font: Font) {
        painter.setColor(hudColor);
        painter.rectangle(x - 1, y - 1, size + 2, size + 2);

        if (this.weaponsTarget === undefined) {
            painter.setBackground(PaletteColor(palette, PaletteCategory.COCKPIT_MFD_BACKGROUND));
            painter.rectangle(x, y, size, size, true);
            painter.text(font, x + font.charSpacing, y + size - font.charHeight - font.charSpacing, 'No target', hudColor);
        } else {
            painter.clear(x, y, size, size);
            const pad = font.charSpacing;
            const line = font.charHeight + font.charSpacing;
            painter.text(font, x + pad, y + pad,
                this.weaponsTarget.targetType, hudColor);
            const locationLine = this.weaponsTargetAirborne
                ? (this.weaponsTarget.targetManeuver ?? this.weaponsTarget.targetLocation)
                : `at ${this.weaponsTarget.targetLocation}`;
            painter.text(font, x + pad, y + pad + line, locationLine, hudColor);
            if (this.weaponsTargetAirborne) {
                this.renderTargetDirectionMarker(x, y, size, painter, hudColor);
                this.renderTargetTelemetry(x, y, size, painter, palette, font, hudColor);
            }
            painter.text(font, x + pad, y + size - 2 * line,
                `BRG ${formatHeading(this.weaponsTargetBearing)}`, hudColor);
            painter.text(font, x + size - pad, y + size - 2 * line,
                `${this.weaponsTargetZoomFactor.toFixed(0)}x`, hudColor, TextAlignment.RIGHT);
            painter.text(font, x + pad, y + size - font.charHeight - pad,
                `Range ${this.weaponsTargetRange.toFixed(1)} KM`, hudColor);
        }
    }

    /** Speed, G, and hull bar for airborne weapons targets. */
    private renderTargetTelemetry(
        x: number, y: number, size: number,
        painter: CanvasPainter, palette: Palette, font: Font, hudColor: string,
    ): void {
        const pad = font.charSpacing;
        const line = font.charHeight + font.charSpacing;
        const warnColor = PaletteColor(palette, PaletteCategory.HUD_TEXT_WARN);
        // Below type/location; leave room for the off-boresight needle.
        let ty = y + pad + line * 2;
        const speedKmh = Math.round(this.weaponsTargetSpeedMps * 3.6);
        painter.text(font, x + pad, ty, `SPD ${speedKmh}`, hudColor);
        ty += line;
        const gColor = this.weaponsTargetLoadG >= 4 || this.weaponsTargetLoadG < 0 ? warnColor : hudColor;
        painter.text(font, x + pad, ty, `G ${this.weaponsTargetLoadG.toFixed(1)}`, gColor);
        ty += line;

        this.renderTargetControls(x, y, size, painter, palette, font, hudColor);

        const barX = x + pad;
        const barY = ty + Math.floor(font.charHeight / 2) - 2;
        const barH = Math.max(3, Math.floor(font.charHeight * 0.55));
        const label = 'HP';
        const labelW = label.length * font.charWidth + Math.max(0, label.length - 1) * font.charSpacing;
        painter.text(font, barX, ty, label, this.weaponsTargetHealth <= 0.3 ? warnColor : hudColor);
        const trackX = barX + labelW + pad;
        // Reserve the right side for the enemy's HUD-style control diagram.
        const controlWidth = Math.max(18, Math.min(48, Math.round(size * 0.28)));
        const trackW = Math.max(8, size - (trackX - x) - controlWidth - pad);
        painter.setColor(hudColor);
        painter.rectangle(trackX, barY, trackW, barH);
        const fillW = Math.max(0, Math.round(trackW * Math.max(0, Math.min(1, this.weaponsTargetHealth))));
        if (fillW > 0) {
            painter.setBackground(this.weaponsTargetHealth <= 0.3 ? warnColor : hudColor);
            painter.rectangle(trackX, barY, fillW, barH, true);
        }

    }

    /**
     * Enemy pitch/roll stick and throttle, using the same visual language as the
     * player's HUD: cross-shaped stick travel, circular stick marker, and a
     * vertical throttle track. The engine label explicitly shows AB1/AB2.
     */
    private renderTargetControls(
        x: number, y: number, size: number,
        painter: CanvasPainter, palette: Palette, font: Font, hudColor: string,
    ): void {
        const pad = font.charSpacing;
        const line = font.charHeight + font.charSpacing;
        const secondary = PaletteColor(palette, PaletteCategory.HUD_TEXT_SECONDARY);
        const arm = Math.max(5, Math.min(18, Math.round(size * 0.09)));
        const gap = Math.max(2, Math.round(arm * 0.3));
        const centerX = x + size - pad - arm - 1;
        const centerY = y + pad + line * 3 + arm;

        const pitchTotalUnits = PITCH_STICK_FWD_UNITS + PITCH_STICK_AFT_UNITS;
        const pitchSpan = arm * 2;
        const pitchFwdTravel = Math.max(2, Math.round(pitchSpan * PITCH_STICK_FWD_UNITS / pitchTotalUnits));
        const pitchAftTravel = Math.max(2, pitchSpan - pitchFwdTravel);
        const rollTravel = Math.max(2, arm - 2);
        const pitch = Math.max(-1, Math.min(1, this.weaponsTargetStickPitch));
        const roll = Math.max(-1, Math.min(1, this.weaponsTargetStickRoll));
        const throttle = Math.max(0, Math.min(1, this.weaponsTargetThrottle));

        painter.setColor(secondary);
        painter.batch()
            .hLine(centerX - arm, centerX + arm, centerY)
            .vLine(centerX, centerY - pitchFwdTravel, centerY + pitchAftTravel)
            .commit();

        const pitchOffset = pitch >= 0 ? pitch * pitchAftTravel : pitch * pitchFwdTravel;
        painter.setColor(hudColor);
        painter.circle(
            Math.round(centerX + roll * rollTravel),
            Math.round(centerY + pitchOffset),
            Math.max(1, Math.round(arm * 0.18)));

        const throttleX = centerX - arm - gap;
        painter.setColor(secondary);
        painter.vLine(throttleX, centerY - arm, centerY + arm);
        painter.setColor(hudColor);
        const throttleY = Math.round(centerY + arm - throttle * arm * 2);
        painter.hLine(throttleX - 1, throttleX + 1, throttleY);

        const throttleLabel = formatF16ThrottleHud(throttle);
        painter.text(font, centerX, centerY + pitchAftTravel + gap,
            throttleLabel, hudColor, TextAlignment.CENTER);
    }

    /**
     * Off-boresight cue in the target MFD: a needle from the MFD centre with a
     * small rectangle at its tip, pointing toward the enemy as seen down the
     * aircraft's longitudinal axis (the cockpit view). The needle grows from the
     * centre (enemy dead ahead) out to the rim (enemy 90° or more off-boresight).
     */
    private renderTargetDirectionMarker(x: number, y: number, size: number, painter: CanvasPainter, hudColor: string) {
        if (this.weaponsTargetOffAxis <= 0) {
            return;
        }
        const centerX = Math.round(x + size / 2);
        const centerY = Math.round(y + size / 2);
        const tipRadius = size * 0.42 * this.weaponsTargetOffAxis;
        const tipX = Math.round(centerX + this.weaponsTargetDirX * tipRadius);
        const tipY = Math.round(centerY + this.weaponsTargetDirY * tipRadius);
        const markerSize = Math.max(3, Math.round(size * 0.1));
        const half = Math.floor(markerSize / 2);
        painter.setColor(hudColor);
        painter.line(centerX, centerY, tipX, tipY);
        painter.rectangle(tipX - half, tipY - half, markerSize, markerSize);
    }
}