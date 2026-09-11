import * as THREE from 'three';
import { Palette, PaletteCategory, PaletteColor } from "../../../config/palettes/palette";
import { CanvasPainter } from "../../../render/screen/canvasPainter";
import { Font, TextAlignment } from "../../../render/screen/text";
import { Entity } from "../../entity";
import { Scene, SceneLayers } from "../../scene";
import { getOverlayLayout } from './overlayUtils';

interface DrawStatsEntry {
    calls: number;
    triangles: number;
}

interface TerrainStatsShape {
    drawn: number;
    triangles: number;
    detailScale: number;
    frameEmaMs: number;
    /** Which tier answered the last CPU height query: fine | coarse | none. */
    heightTier?: string;
    queued?: number;
    inflight?: number;
    cacheBytes?: number;
    aborted?: number;
    failed?: number;
    uploadMs?: number;
    pendingUploads?: number;
    triangleBudgetHit?: boolean;
}

/** Frame-time EMA smoothing factor — same order as the terrain LOD governor's own. */
const FRAME_EMA_ALPHA = 0.1;

/**
 * F9-toggled on-screen readout of the live perf diagnostics already wired up
 * via globalThis.__drawStats (renderer.ts) and __terrainStats (planet/debug.ts)
 * but previously only inspectable through devtools — surfaces them in-game so
 * LOD/culling changes can be sanity-checked without a debugger attached.
 */
export class PerfHudEntity implements Entity {

    private frameEmaMs: number = 1000 / 60;

    readonly tags: string[] = [];

    enabled: boolean = true;

    init(scene: Scene): void {
        //
    }

    update(delta: number): void {
        const ms = delta * 1000;
        this.frameEmaMs += (ms - this.frameEmaMs) * FRAME_EMA_ALPHA;
    }

    render3D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Map<string, THREE.Scene>, palette: Palette): void {
        // Nothing
    }

    render2D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Set<string>, painter: CanvasPainter, palette: Palette): void {
        if (!lists.has(SceneLayers.Overlay)) return;

        const layoutScale = getOverlayLayout(targetWidth, targetHeight).layoutScale;
        const font = layoutScale > 1 ? Font.HUD_MEDIUM : Font.HUD_SMALL;
        const hudColor = PaletteColor(palette, PaletteCategory.HUD_TEXT);
        const lineHeight = font.charHeight + 2;

        const lines: string[] = [];
        const fps = this.frameEmaMs > 0 ? 1000 / this.frameEmaMs : 0;
        lines.push(`${fps.toFixed(0)} FPS ${this.frameEmaMs.toFixed(1)}ms`);

        const kernelStats = (globalThis as Record<string, unknown>).__kernelStats as { updateMs: number; renderMs: number } | undefined;
        if (kernelStats) {
            lines.push(`LOG ${kernelStats.updateMs.toFixed(1)} RND ${kernelStats.renderMs.toFixed(1)}ms`);
        }

        // Totals across every render pass; the per-pass breakdown is still
        // on globalThis.__drawStats / __gpuStats for devtools.
        const drawStats = (globalThis as Record<string, unknown>).__drawStats as Record<string, DrawStatsEntry> | undefined;
        if (drawStats) {
            let calls = 0;
            let triangles = 0;
            for (const entry of Object.values(drawStats)) {
                calls += entry.calls;
                triangles += entry.triangles;
            }
            lines.push(`${calls} DRW ${(triangles / 1000).toFixed(1)}K TRI`);
        }

        const terrainStats = (globalThis as Record<string, unknown>).__terrainStats as TerrainStatsShape | undefined;
        if (terrainStats) {
            const budgetSuffix = terrainStats.triangleBudgetHit ? ' BUDGET' : '';
            lines.push(`TER ${terrainStats.drawn}T ${(terrainStats.triangles / 1000).toFixed(1)}K`
                + ` D${terrainStats.detailScale.toFixed(2)}${budgetSuffix}`);
            // Streaming health: queue should drain, cache should plateau, tier must not change.
            const mb = (terrainStats.cacheBytes ?? 0) / 1048576;
            const failSuffix = (terrainStats.failed ?? 0) > 0 ? ` F${terrainStats.failed}` : '';
            lines.push(`Q${terrainStats.queued ?? 0} ${mb.toFixed(0)}MB ${terrainStats.heightTier ?? '?'}${failSuffix}`);
        }

        // Top-right, on a black box so it stays legible over bright sky/terrain.
        const pad = 2;
        const textWidth = (line: string) => line.length * font.charWidth + Math.max(0, line.length - 1) * font.charSpacing;
        const boxWidth = Math.max(...lines.map(textWidth)) + pad * 2;
        const boxHeight = lines.length * lineHeight + pad * 2;
        const right = targetWidth - pad;
        painter.setBackground('#000000');
        painter.rectangle(targetWidth - boxWidth, 0, boxWidth, boxHeight, true);

        let y = pad + 1;
        for (const line of lines) {
            painter.text(font, right, y, line, hudColor, TextAlignment.RIGHT);
            y += lineHeight;
        }
    }
}
