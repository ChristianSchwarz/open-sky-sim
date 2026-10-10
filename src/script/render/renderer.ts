import * as THREE from 'three';
import { Palette, PaletteCategory, PaletteColor } from '../config/palettes/palette';
import { SceneMaterialManager } from '../scene/materials/materials';
import { Scene, SceneLayers } from '../scene/scene';
import { Entity } from '../scene/entity';
import { assertExpr, assertIsDefined } from '../utils/asserts';
import { getOverlayLayout, getOverlayStrokeWidth } from '../scene/entities/overlay/overlayUtils';
import { CanvasPainter } from './screen/canvasPainter';
import { CanvasDirt, trackCanvasDirt } from './screen/canvasDirt';
import { TextEffect } from './screen/text';
import { beginRenderListPass, pruneRenderList } from './renderList';
import { clearRenderOrigin, setRenderOrigin } from './renderOrigin';
import { BlitPass } from './blitPass';
import { GpuPassTimer } from './gpuPassTimer';
import { SceneDepthPass } from './sceneDepthPass';

export interface RendererOptions {
    textColors?: string[];
    /**
     * Supersampling factor for a WEBGL render target's backing texture. The
     * compositor quad's geometry/position (and therefore compose-space
     * layout) stay at the native size passed to createRenderTarget; only the
     * GPU texture is larger, with a mipmap chain the compose blit's
     * automatic LOD selection samples for a real box-filtered downsample
     * (see setUpscaleFilter()). Ignored for CANVAS targets and clamped to 1
     * on a WebGL1 context. Defaults to 1.
     */
    textureScale?: number;
}

export enum RenderTargetType {
    WEBGL = 'WEBGL',
    CANVAS = 'CANVAS'
}

type RenderTarget = CanvasRenderTarget | WebGLRenderTarget;

interface BaseRenderTarget {
    ready: boolean;
    compositorObj: THREE.Mesh;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface CanvasRenderTarget extends BaseRenderTarget {
    type: RenderTargetType.CANVAS;
    target: THREE.CanvasTexture;
    painter: CanvasPainter;
    /** What the painter drew on, for refreshing `target` in parts (refreshCanvas). */
    dirt: CanvasDirt;
    /**
     * The same canvas as a texture three.js never uploads: the source a part
     * is copied from (copyTextureToTexture uploads straight from the image
     * only for a texture it has not seen).
     */
    source: THREE.CanvasTexture;
}

interface WebGLRenderTarget extends BaseRenderTarget {
    type: RenderTargetType.WEBGL;
    target: THREE.WebGLRenderTarget;
    /** Reapplied to the backing texture size on every resize. */
    textureScale: number;
}

export interface RenderLayer {
    target: string;
    camera: THREE.Camera;
    lists: string[];
    palette?: Palette;
    /** Reuse prior WebGL contents for this target; still compose it. */
    skipRefresh?: boolean;
    /** Override WebGL clear color for this target (e.g. space black). */
    clearColor?: string;
    /**
     * Excludes matching entities from just this layer's render list build —
     * e.g. dropping the cloud/cirrus decks from a secondary camera's pass
     * (weapons-target MFD) that doesn't warrant paying their full LOD/draw
     * cost a second time.
     */
    entityFilter?: (entity: Entity) => boolean;
    /**
     * Resolve the depth already standing in this target before the layer draws,
     * so its materials can sample how far away what they cover is. Set on the
     * foreground sky pass, whose glare veils the scene rather than replacing it.
     *
     * The camera here is the one whose pass *wrote* that depth - the main one -
     * not the layer's own. Its far plane is the curve the log depth has to be
     * read back through, and the background sky camera's is a different number.
     */
    sceneDepthFrom?: THREE.PerspectiveCamera;
}

/**
 * The depth+stencil attachment for a scene target, as a sampleable texture.
 *
 * DEPTH24_STENCIL8 rather than plain depth: the shadow volume pass counts into
 * the stencil, and a target cannot carry a depth texture and a separate stencil
 * renderbuffer at once.
 */
/** The compositor quad for a canvas target, v running top-down like the canvas's rows (flipY off). */
function canvasPlane(width: number, height: number): THREE.PlaneGeometry {
    const plane = new THREE.PlaneGeometry(width, height);
    const uv = plane.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
        uv.setY(i, 1 - uv.getY(i));
    }
    return plane;
}

function sceneDepthTexture(width: number, height: number): THREE.DepthTexture {
    const texture = new THREE.DepthTexture(width, height, THREE.UnsignedInt248Type);
    texture.format = THREE.DepthStencilFormat;
    return texture;
}

export class Renderer {
    private container: HTMLElement;
    private renderer: THREE.WebGLRenderer;
    private composeScene: THREE.Scene = new THREE.Scene();
    private composeCamera: THREE.OrthographicCamera;
    private renderTargets: Map<string, RenderTarget> = new Map();
    private palette: Palette;
    private textEffect: TextEffect = TextEffect.NONE;
    private renderLists: Map<string, THREE.Scene>;
    private current3DRenderLists: Map<string, THREE.Scene> = new Map();
    private current2DRenderLists: Set<string> = new Set();
    /** Parent of layer list scenes for a single same-camera WebGL submit. */
    private readonly mergedListScene = new THREE.Scene();
    /** Drawn into a target only to have three.js build its mip chain; see render. */
    private readonly mipmapScene = new THREE.Scene();
    /** Camera-relative offset root: children drawn at world − camera.position. */
    private readonly relativeRoot = new THREE.Group();
    private readonly savedCamPos = new THREE.Vector3();
    private readonly sceneDepthPass = new SceneDepthPass();
    private readonly blitPass = new BlitPass();
    /**
     * One small offscreen buffer per destination target, the background sky
     * dome is shaded into at a fraction of its resolution before being
     * upscaled in - see the BackgroundSky special case in render(). Keyed
     * per target because the player view and the weapons-target MFD are
     * different sizes (same reasoning as SceneDepthPass's own per-source map).
     */
    private readonly backgroundSkyTargets = new Map<string, THREE.WebGLRenderTarget>();
    /**
     * Linear downscale for the background-sky buffer above. The dome is ~16
     * rings of baked vertex colour - already about as low-frequency as scene
     * content gets, and it only repaints when the sun moves - so quartering
     * its resolution (1/16 the fragments) costs nothing visible while cutting
     * the one shader in this renderer that shades every pixel of a full 4K
     * frame for no geometric reason (the dome always fully covers the view).
     * Its output is now a plain gradient rather than a dithered one
     * (skyDomeModelBuilder.ts) specifically so this upscale has no per-pixel
     * dither structure to smear into blocks.
     */
    private static readonly BACKGROUND_SKY_SCALE = 0.25;
    /**
     * The upscaled sky waiting for the next pass into each target that draws
     * anything, by target: drawn there behind the opaque geometry instead of
     * blitted over the whole target first. The blit filled every pixel of
     * the frame (2.6 ms of an ultrawide on an integrated GPU) for the terrain
     * to cover most of them; at the far plane, depth-tested, it shades only
     * what is left of the sky.
     */
    private readonly pendingSky = new Map<string, { texture: THREE.Texture; target: THREE.WebGLRenderTarget }>();
    private renderListGeneration = 0;
    /**
     * Mipmap-based supersample downsampling needs generateMipmap() on a
     * non-power-of-two texture, which WebGL1 does not guarantee. Supersample
     * textureScale is clamped to 1 when this is false.
     */
    private readonly isWebGL2: boolean;
    private readonly gpuTimer: GpuPassTimer;

    constructor(private materials: SceneMaterialManager, private composeWidth: number, private composeHeight: number, palette: Palette) {
        const container = document.getElementById('container');
        assertIsDefined(container, '<div id="container"> not found');
        this.container = container;
        this.composeCamera = new THREE.OrthographicCamera(-composeWidth / 2, composeWidth / 2, composeHeight / 2, -composeHeight / 2, -10, 10);
        this.palette = palette;
        this.renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true });
        // Cap DPR so HD on high-DPI displays does not explode fill rate.
        this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
        const gl = this.renderer.getContext();
        this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        // Cast is safe: GpuPassTimer only calls WebGL2-only query methods when
        // isWebGL2 is true, which is exactly when `gl` really is one.
        this.gpuTimer = new GpuPassTimer(gl as WebGL2RenderingContext, this.isWebGL2);
        assertExpr(
            this.isWebGL2 || this.renderer.extensions.has('ANGLE_instanced_arrays'),
            'Renderer: instanced rendering requires WebGL2 or the ANGLE_instanced_arrays extension'
        );
        this.renderer.autoClear = false;
        this.renderer.sortObjects = false;
        // Only for the pass that carries a deferred sky (render3D): the
        // traversal order everything relies on, but the sky quad after the
        // geometry that writes depth. Array.prototype.sort is stable.
        this.renderer.setOpaqueSort((a, b) => Renderer.deferredBlitRank(a.material) - Renderer.deferredBlitRank(b.material));
        this.renderer.setTransparentSort(() => 0);
        this.relativeRoot.name = 'CameraRelativeRoot';
        this.updateViewportSize();
        this.container.appendChild(this.renderer.domElement);
        window.addEventListener('resize', this.updateViewportSize.bind(this));

        this.renderLists = new Map(Object.keys(SceneLayers).map(id => ([id, new THREE.Scene()])));

        this.composeCamera.position.setZ(1);
    }

    setPalette(palette: Palette) {
        this.palette = palette;
        this.materials.setPalette(palette);
    }

    setTextEffect(effect: TextEffect) {
        this.textEffect = effect;
    }

    setComposeSize(width: number, height: number) {
        this.composeWidth = width;
        this.composeHeight = height;
        this.updateViewportSize();
    }

    private upscaleLinear = false;

    setUpscaleFilter(linear: boolean) {
        if (this.upscaleLinear === linear) {
            return;
        }
        this.upscaleLinear = linear;
        const filter = linear ? THREE.LinearFilter : THREE.NearestFilter;
        for (const renderTarget of this.renderTargets.values()) {
            const texture = renderTarget.type === RenderTargetType.WEBGL
                ? renderTarget.target.texture
                : renderTarget.target;
            // A supersampled target keeps its mipmap chain here instead of
            // collapsing to a single bilinear tap: at scale 2 the GPU's
            // auto-selected mip level 1 IS the box-filtered average of each
            // 2x2 source block, a real downsample rather than one sample.
            const mipmapped = renderTarget.type === RenderTargetType.WEBGL && renderTarget.textureScale > 1;
            texture.minFilter = mipmapped
                ? (linear ? THREE.LinearMipmapLinearFilter : THREE.NearestMipmapNearestFilter)
                : filter;
            texture.magFilter = filter;
        }
    }

    /**
     * Viewport size in device pixels for HD render targets.
     */
    getMaxViewportResolution(): [number, number] {
        const pixelRatio = this.renderer.getPixelRatio();
        const width = Math.max(1, Math.floor(this.container.clientWidth * pixelRatio));
        const height = Math.max(1, Math.floor(this.container.clientHeight * pixelRatio));
        return [width, height];
    }

    /**
     * `newTextureScale`, if given, replaces a WEBGL target's supersample
     * factor — needed because it can be resolution-dependent (see
     * hdSupersampleScale in game.ts): the same target keeps living across a
     * mid-session window/monitor change, so its scale has to be able to
     * change with it rather than staying pinned to whatever it was created
     * with. Ignored for CANVAS targets.
     */
    resizeRenderTarget(id: string, x: number, y: number, width: number, height: number, newTextureScale?: number) {
        const renderTarget = this.renderTargets.get(id);
        assertIsDefined(renderTarget);

        let scaleChanged = false;
        if (renderTarget.type === RenderTargetType.WEBGL && newTextureScale !== undefined) {
            const scale = newTextureScale > 1 && !this.isWebGL2 ? 1 : newTextureScale;
            scaleChanged = scale !== renderTarget.textureScale;
        }
        if (renderTarget.width === width && renderTarget.height === height
            && renderTarget.x === x && renderTarget.y === y && !scaleChanged) {
            return;
        }

        renderTarget.x = x;
        renderTarget.y = y;
        renderTarget.width = width;
        renderTarget.height = height;
        renderTarget.ready = false;

        if (renderTarget.type === RenderTargetType.WEBGL) {
            if (scaleChanged && newTextureScale !== undefined) {
                renderTarget.textureScale = newTextureScale > 1 && !this.isWebGL2 ? 1 : newTextureScale;
                // Mirrors the mipmapped/not choice createRenderTarget makes:
                // only a supersampled target needs its mipmap chain for the
                // compose blit's box-filtered downsample (setUpscaleFilter).
                const mipmapped = renderTarget.textureScale > 1;
                const texture = renderTarget.target.texture;
                texture.generateMipmaps = mipmapped;
                texture.minFilter = mipmapped
                    ? (this.upscaleLinear ? THREE.LinearMipmapLinearFilter : THREE.NearestMipmapNearestFilter)
                    : (this.upscaleLinear ? THREE.LinearFilter : THREE.NearestFilter);
            }
            renderTarget.target.setSize(Math.round(width * renderTarget.textureScale), Math.round(height * renderTarget.textureScale));
        } else {
            const canvas = renderTarget.target.image as HTMLCanvasElement;
            canvas.width = width;
            canvas.height = height;
            renderTarget.painter.clear();
            renderTarget.dirt.resize(width, height);
            renderTarget.target.needsUpdate = true;
        }

        renderTarget.compositorObj.geometry.dispose();
        renderTarget.compositorObj.geometry = renderTarget.type === RenderTargetType.CANVAS
            ? canvasPlane(width, height)
            : new THREE.PlaneGeometry(width, height);
    }

    render(scene: Scene, renderLayers: RenderLayer[]) {

        let prevPalette = this.palette;
        this.materials.setPalette(this.palette);
        this.composeScene.clear();

        for (const renderTarget of this.renderTargets.values()) {
            renderTarget.ready = false;
        }

        // Raw per-pass CPU wall time (not EMA'd, like __drawStats): this is
        // what a GPU pass timer cannot see - matrix/state updates, buffer
        // list construction, and three.js's own draw-call submission
        // overhead, all of which happen on the CPU before the GPU ever sees
        // a command. Compared against __gpuStats, it says whether a slow
        // pass is a GPU-fill problem or a CPU-submission one.
        const cpuStats: Record<string, number> = {};

        // three.js rebuilds a mipmapped target's whole chain at the end of
        // every render() into it, and the supersampled main target takes four
        // or five of those a frame (sky blit, each layer, the glare's): at
        // 1.5x of an ultrawide that is a 10-megapixel chain built over and
        // over for the one read the compose makes. Held off here and built
        // once below, for the targets something was drawn into.
        const deferredMips: Array<{ owner: RenderTarget; target: THREE.WebGLRenderTarget }> = [];
        for (const renderTarget of this.renderTargets.values()) {
            // By scale, not by the flag, so a frame that threw half way
            // cannot leave a target unmipmapped for good. Same rule as
            // createRenderTarget's: only a supersampled target has a chain.
            if (renderTarget.type === RenderTargetType.WEBGL && renderTarget.textureScale > 1) {
                renderTarget.target.texture.generateMipmaps = false;
                deferredMips.push({ owner: renderTarget, target: renderTarget.target });
            }
        }
        const drawnTargets = new Set<RenderTarget>();

        for (const layer of renderLayers) {
            const palette = layer.palette || this.palette;
            if (palette !== prevPalette) {
                prevPalette = palette;
                this.materials.setPalette(palette);
            }

            const skipRefresh = !!layer.skipRefresh;
            // A target that starts with the sky needs no colour cleared: the
            // deferred sky lands on every pixel nothing else covers.
            const skyFirst = layer.lists.length === 1 && layer.lists[0] === SceneLayers.BackgroundSky;
            const renderTarget = this.prepareRenderTarget(layer.target, palette, !skipRefresh, layer.clearColor, !skyFirst);
            if (skipRefresh) {
                continue;
            }

            const label = `${layer.target}:${layer.lists.join('+')}`;
            const cpuStart = performance.now();
            if (renderTarget.type === RenderTargetType.WEBGL) {
                drawnTargets.add(renderTarget);
                // 2D (CANVAS) passes submit nothing to the GL timeline, so
                // timing them would just measure ~0 - only WEBGL passes are
                // worth the query.
                this.gpuTimer.begin(label);
                if (layer.lists.length === 1 && layer.lists[0] === SceneLayers.BackgroundSky) {
                    this.renderBackgroundSkyDownscaled(renderTarget, scene, layer, palette);
                } else {
                    this.render3D(renderTarget, scene, layer, palette);
                }
                this.gpuTimer.end();
            } else {
                this.render2D(renderTarget, scene, layer, palette);
                this.refreshCanvas(renderTarget);
            }
            cpuStats[label] = performance.now() - cpuStart;
        }
        // A sky no pass drew behind: the whole of it still shows.
        for (const { texture, target } of this.pendingSky.values()) {
            this.blitPass.drawDeferred(this.renderer, texture, target);
        }
        this.pendingSky.clear();

        this.gpuTimer.begin('mipmaps');
        for (const { owner, target } of deferredMips) {
            target.texture.generateMipmaps = true;
            // A target skipped this frame kept last frame's pixels, and its
            // chain still matches them.
            if (drawnTargets.has(owner)) {
                // An empty render is three.js's way to build a target's chain.
                this.renderer.setRenderTarget(target);
                this.renderer.render(this.mipmapScene, this.composeCamera);
            }
        }
        this.gpuTimer.end();

        // Compose all
        this.renderer.setRenderTarget(null);

        this.renderer.setClearColor('#000000');
        this.renderer.clear();
        const composeCpuStart = performance.now();
        this.gpuTimer.begin('compose');
        this.renderer.render(this.composeScene, this.composeCamera);
        this.gpuTimer.end();
        cpuStats.compose = performance.now() - composeCpuStart;
        (globalThis as Record<string, unknown>).__cpuStats = cpuStats;
        this.gpuTimer.poll();
    }

    prepareRenderTarget(target: string, palette: Palette, clear: boolean = true, clearColor?: string, clearColour = true): RenderTarget {
        const renderTarget = this.renderTargets.get(target);
        assertIsDefined(renderTarget);
        if (renderTarget.ready === false) {
            renderTarget.ready = true;
            if (renderTarget.type === RenderTargetType.CANVAS) {
                if (clear) {
                    renderTarget.painter.clear();
                }
            } else {
                renderTarget.compositorObj.position.set(
                    renderTarget.x + renderTarget.width / 2 - this.composeWidth / 2,
                    -renderTarget.y - renderTarget.height / 2 + this.composeHeight / 2,
                    0
                );
                if (clear) {
                    this.renderer.setRenderTarget(renderTarget.target);
                    this.renderer.setClearColor(clearColor ?? PaletteColor(palette, PaletteCategory.BACKGROUND));
                    this.renderer.clear(clearColour, true, true);
                }
            }
            this.composeScene.add(renderTarget.compositorObj);
        }
        return renderTarget;
    }

    render3D(renderTarget: WebGLRenderTarget, scene: Scene, layer: RenderLayer, palette: Palette) {
        if ((layer.camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
            const camera = layer.camera as THREE.PerspectiveCamera;
            const aspect = renderTarget.width / renderTarget.height;
            if (Math.abs(camera.aspect - aspect) > 0.001) {
                camera.aspect = aspect;
                camera.updateProjectionMatrix();
            }
        }

        this.renderListGeneration++;
        this.current3DRenderLists.clear();
        for (const listId of layer.lists) {
            const list = this.renderLists.get(listId);
            assertIsDefined(list);
            beginRenderListPass(list, this.renderListGeneration);
            this.current3DRenderLists.set(listId, list);
        }
        // LOD / culling use absolute ENU camera position.
        scene.buildRenderLists(renderTarget.width, renderTarget.height, layer.camera, this.current3DRenderLists, palette, layer.entityFilter);
        for (const listId of layer.lists) {
            const list = this.current3DRenderLists.get(listId);
            assertIsDefined(list);
            pruneRenderList(list);
        }

        // Before the submit, not after: the layer's own materials sample this.
        // Skipped when the layer drew up empty, which for the glare is every
        // frame between sunset and sunrise - a full-screen resolve per view is
        // not worth paying for a pass with nothing in it.
        if (layer.sceneDepthFrom !== undefined && this.hasAnythingInView(layer)) {
            this.sceneDepthPass.resolve(this.renderer, renderTarget.target, layer.sceneDepthFrom.far);
        }

        const sky = this.pendingSky.get(layer.target);
        if (sky === undefined || !this.hasAnythingToDraw(layer)) {
            this.submitCameraRelative(layer, palette);
            return;
        }
        this.pendingSky.delete(layer.target);
        const list = this.current3DRenderLists.get(layer.lists[0]);
        assertIsDefined(list);
        const quad = this.blitPass.deferredMesh(sky.texture);
        list.add(quad);
        this.renderer.sortObjects = true;
        try {
            this.submitCameraRelative(layer, palette);
        } finally {
            this.renderer.sortObjects = false;
            list.remove(quad);
        }
    }

    /**
     * Opaque draw order for a pass with a deferred sky: what writes depth,
     * then the sky on whatever none of it covered, then what does not write
     * depth (road and river strokes, shadows, stippled cloud haze), which
     * would otherwise be painted over where it lies against the sky.
     */
    private static deferredBlitRank(material: THREE.Material): number {
        if (material.userData.deferredBlit) {
            return 1;
        }
        return material.depthWrite && material.depthTest ? 0 : 2;
    }

    /**
     * Renders a BackgroundSky-only layer (the sky dome) at a fraction of
     * `renderTarget`'s resolution, upscaled in later behind the next pass's
     * opaque geometry (pendingSky), instead of shading the dome at full
     * resolution only to have the terrain pass draw over most of it a moment
     * later. Reuses render3D unchanged: THREE sizes the actual
     * GL viewport from whichever target is bound via setRenderTarget, not
     * from the `renderTarget` wrapper passed in, so pointing that binding at
     * a smaller buffer first is enough - the wrapper's width/height still
     * drive the correct camera aspect and LOD math either way.
     */
    private renderBackgroundSkyDownscaled(renderTarget: WebGLRenderTarget, scene: Scene, layer: RenderLayer, palette: Palette): void {
        const small = this.backgroundSkyTargetFor(layer.target, renderTarget);

        this.renderer.setRenderTarget(small);
        // The layer's own clear colour, or above the air the blit paints the
        // palette's sky blue over the black the target was just cleared to.
        this.renderer.setClearColor(layer.clearColor ?? PaletteColor(palette, PaletteCategory.BACKGROUND));
        this.renderer.clear();
        this.render3D(renderTarget, scene, layer, palette);

        this.renderer.setRenderTarget(renderTarget.target);
        this.pendingSky.set(layer.target, { texture: small.texture, target: renderTarget.target });
    }

    private backgroundSkyTargetFor(key: string, renderTarget: WebGLRenderTarget): THREE.WebGLRenderTarget {
        const width = Math.max(1, Math.round(renderTarget.width * Renderer.BACKGROUND_SKY_SCALE));
        const height = Math.max(1, Math.round(renderTarget.height * Renderer.BACKGROUND_SKY_SCALE));
        let small = this.backgroundSkyTargets.get(key);
        if (small === undefined) {
            small = new THREE.WebGLRenderTarget(width, height, {
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                generateMipmaps: false,
                format: THREE.RGBFormat,
            });
            this.backgroundSkyTargets.set(key, small);
        } else if (small.width !== width || small.height !== height) {
            small.setSize(width, height);
        }
        return small;
    }

    /**
     * Whether anything in this layer's lists can land in its camera's view.
     *
     * The glare is a ring round the sun, so its list is full all day, and the
     * full-screen depth resolve it waits on was paid every frame the sun was
     * behind the camera too: ~3 ms a frame on an integrated GPU at 2x
     * supersample. Same test three.js culls with, a frame early: a mesh whose
     * bounds miss the frustum is not drawn, so its pass needs no depth.
     */
    private hasAnythingInView(layer: RenderLayer): boolean {
        if (!this.hasAnythingToDraw(layer)) {
            return false;
        }
        const camera = layer.camera;
        camera.updateMatrixWorld();
        Renderer._viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        Renderer._frustum.setFromProjectionMatrix(Renderer._viewProjection);
        let inView = false;
        for (const listId of layer.lists) {
            this.current3DRenderLists.get(listId)?.traverseVisible(object => {
                if (inView) {
                    return;
                }
                const mesh = object as THREE.Mesh;
                if (!mesh.isMesh) {
                    // Lines, points and sprites: not worth bounding, assume seen.
                    inView = (object as THREE.Line).isLine || (object as THREE.Points).isPoints
                        || (object as THREE.Sprite).isSprite;
                    return;
                }
                // An instanced mesh's geometry bounds only one instance.
                if (!mesh.frustumCulled || (mesh as THREE.InstancedMesh).isInstancedMesh) {
                    inView = true;
                    return;
                }
                if (mesh.geometry.boundingSphere === null) {
                    mesh.geometry.computeBoundingSphere();
                }
                mesh.updateWorldMatrix(true, false);
                Renderer._sphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld);
                inView = Renderer._frustum.intersectsSphere(Renderer._sphere);
            });
            if (inView) {
                return true;
            }
        }
        return false;
    }
    private static readonly _viewProjection = new THREE.Matrix4();
    private static readonly _frustum = new THREE.Frustum();
    private static readonly _sphere = new THREE.Sphere();

    /** Whether this layer's lists came out of the build with anything in them. */
    private hasAnythingToDraw(layer: RenderLayer): boolean {
        for (const listId of layer.lists) {
            const list = this.current3DRenderLists.get(listId);
            if (list !== undefined && list.children.length > 0) {
                return true;
            }
        }
        return false;
    }

    /** Live diagnostics: draw calls + triangles per layer (__drawStats). */
    private recordDrawStats(layer: RenderLayer): void {
        const stats = ((globalThis as Record<string, unknown>).__drawStats ??= {}) as Record<string, unknown>;
        const triangles = this.renderer.info.render.triangles;
        stats[`${layer.target}:${layer.lists.join('+')}`] = {
            calls: this.renderer.info.render.calls,
            triangles,
        };
        // Main scene pass (terrain + entities combined): exact GPU triangle
        // total, used by the HUD to derive the object/cloud split against the
        // JS-side per-category estimates (__terrainStats, __fieldStats).
        if (layer.lists.includes(SceneLayers.Terrain) && layer.lists.includes(SceneLayers.EntityVolumes)) {
            (globalThis as Record<string, unknown>).__sceneTriangles = triangles;
        }
    }

    /**
     * GPU submit with camera at origin and scene offset by −camera.position so
     * Float32 world matrices stay precise at planetary ranges. Physics positions
     * are unchanged.
     */
    private submitCameraRelative(layer: RenderLayer, palette: Palette): void {
        const cam = layer.camera;
        const rebase = Math.abs(cam.position.x) + Math.abs(cam.position.y) + Math.abs(cam.position.z) > 1e-6;

        if (rebase) {
            this.savedCamPos.copy(cam.position);
            setRenderOrigin(this.savedCamPos);
            cam.position.set(0, 0, 0);
            cam.updateMatrixWorld(true);
            this.relativeRoot.position.set(-this.savedCamPos.x, -this.savedCamPos.y, -this.savedCamPos.z);
            this.mergedListScene.add(this.relativeRoot);
            for (const listId of layer.lists) {
                const list = this.current3DRenderLists.get(listId);
                assertIsDefined(list);
                this.relativeRoot.add(list);
            }
            this.renderer.render(this.mergedListScene, cam);
            this.recordDrawStats(layer);
            while (this.relativeRoot.children.length > 0) {
                this.relativeRoot.remove(this.relativeRoot.children[0]);
            }
            this.mergedListScene.remove(this.relativeRoot);
            cam.position.copy(this.savedCamPos);
            cam.updateMatrixWorld(true);
            clearRenderOrigin();
            return;
        }

        if (layer.lists.length > 1) {
            for (const listId of layer.lists) {
                const list = this.current3DRenderLists.get(listId);
                assertIsDefined(list);
                this.mergedListScene.add(list);
            }
            this.renderer.render(this.mergedListScene, cam);
            while (this.mergedListScene.children.length > 0) {
                this.mergedListScene.remove(this.mergedListScene.children[0]);
            }
            return;
        }

        const only = this.current3DRenderLists.get(layer.lists[0]);
        assertIsDefined(only);
        this.renderer.render(only, cam);
    }

    /**
     * Refresh the canvas's texture where the frame just painted changed it
     * (CanvasDirt), not the whole canvas. Dev aids, from the console:
     * `__debugSkipCanvasUpload = true` freezes the HUD on screen and uploads
     * nothing, `__debugWholeCanvasUpload = true` uploads it whole every frame,
     * as it used to be.
     */
    private refreshCanvas(renderTarget: CanvasRenderTarget): void {
        const debug = globalThis as Record<string, unknown>;
        const rects = renderTarget.dirt.take();
        if (debug.__debugSkipCanvasUpload) {
            return;
        }
        if (rects === undefined || debug.__debugWholeCanvasUpload) {
            renderTarget.target.needsUpdate = true;
            return;
        }
        for (const r of rects) {
            Renderer._region.min.set(r.x, r.y);
            Renderer._region.max.set(r.x + r.width, r.y + r.height);
            Renderer._at.set(r.x, r.y);
            this.renderer.copyTextureToTexture(renderTarget.source, renderTarget.target, Renderer._region, Renderer._at);
        }
    }
    private static readonly _region = new THREE.Box2();
    private static readonly _at = new THREE.Vector2();

    render2D(renderTarget: CanvasRenderTarget, scene: Scene, layer: RenderLayer, palette: Palette) {
        this.current2DRenderLists.clear();
        for (const listId of layer.lists) {
            assertExpr(this.renderLists.has(listId));
            this.current2DRenderLists.add(listId);
        }
        renderTarget.painter.setTextEffect(this.textEffect, PaletteColor(palette, PaletteCategory.HUD_TEXT_EFFECT));
        const overlayLayout = getOverlayLayout(renderTarget.width, renderTarget.height);
        renderTarget.painter.setLineWidth(getOverlayStrokeWidth(overlayLayout));
        scene.paintCanvas(renderTarget.width, renderTarget.height, layer.camera, this.current2DRenderLists, renderTarget.painter, palette);
    }

    createRenderTarget(id: string, type: RenderTargetType, x: number, y: number, width: number, height: number, options?: RendererOptions): void {
        assertExpr(this.renderTargets.has(id) === false, `Render target "${id}" exists already`);

        const ready = false;
        if (type === RenderTargetType.WEBGL) {
            const requestedScale = options?.textureScale ?? 1;
            // Mipmap regeneration on a non-power-of-two target (any real
            // viewport size) is not guaranteed on WebGL1 - fall back to no
            // supersampling there rather than a texture that may fail to
            // mip and render solid black.
            const textureScale = requestedScale > 1 && !this.isWebGL2 ? 1 : requestedScale;
            const textureWidth = Math.round(width * textureScale);
            const textureHeight = Math.round(height * textureScale);
            // A supersampled target needs its mipmap chain so the compose
            // blit's automatic LOD selection lands on a real box-filtered
            // downsample (mip 1 at scale 2) instead of a single bilinear tap
            // of the full-resolution texture - see setUpscaleFilter().
            const mipmapped = textureScale > 1;
            const target = new THREE.WebGLRenderTarget(textureWidth, textureHeight, {
                minFilter: mipmapped ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
                magFilter: THREE.NearestFilter,
                generateMipmaps: mipmapped,
                format: THREE.RGBFormat,
                // Depth as a texture rather than a renderbuffer, so a later
                // pass in this same target can be told what it is covering
                // (SceneDepthPass).
                depthTexture: sceneDepthTexture(textureWidth, textureHeight)
            });
            const compositorObj = new THREE.Mesh(
                new THREE.PlaneGeometry(width, height),
                new THREE.MeshBasicMaterial({ map: target.texture, depthWrite: false })
            );
            compositorObj.position.set(x + width / 2 - this.composeWidth / 2, -y - height / 2 + this.composeHeight / 2, 0);
            const renderTarget: RenderTarget = { type, target, compositorObj, ready, x, y, width, height, textureScale };
            this.renderTargets.set(id, renderTarget);
        } else {
            const { canvas, painter, dirt } = this.setupContext2D(width, height, options);
            assertIsDefined(canvas);
            const target = new THREE.CanvasTexture(canvas, undefined, undefined, undefined, THREE.NearestFilter, THREE.NearestFilter);
            // Rows stored top-down, so a part copies to where it sits on the
            // canvas; the compositor quad's v runs top-down to match.
            target.flipY = false;
            const source = new THREE.CanvasTexture(canvas);
            const compositorObj = new THREE.Mesh(
                canvasPlane(width, height),
                new THREE.MeshBasicMaterial({ map: target, depthWrite: false, transparent: true })
            );
            compositorObj.position.set(x, y, 0);
            const renderTarget: RenderTarget = { type, target, painter, dirt, source, compositorObj, ready, x, y, width, height };
            this.renderTargets.set(id, renderTarget);
        }
    }

    hasRenderTarget(id: string) {
        return this.renderTargets.has(id);
    }

    private setupContext2D(width: number, height: number, options: RendererOptions | undefined): { canvas: HTMLCanvasElement, painter: CanvasPainter, dirt: CanvasDirt } {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d") || undefined;
        if (!ctx) {
            throw Error('Unable to create CanvasRenderingContext2D');
        }
        const dirt = new CanvasDirt(width, height);
        trackCanvasDirt(ctx, dirt);
        const painter = new CanvasPainter(ctx, options?.textColors);
        return { canvas, painter, dirt };
    }

    private updateViewportSize() {
        const viewportWidth = this.container.clientWidth || 1;
        const viewportHeight = this.container.clientHeight || 1;
        const viewportAspect = viewportWidth / viewportHeight;
        const aspect = this.composeWidth / this.composeHeight;
        if (viewportAspect > aspect) {
            const width = viewportAspect / aspect * this.composeWidth;
            this.composeCamera.left = -width / 2;
            this.composeCamera.right = width / 2;
            this.composeCamera.top = this.composeHeight / 2;
            this.composeCamera.bottom = -this.composeHeight / 2;
        } else {
            const height = aspect / viewportAspect * this.composeHeight;
            this.composeCamera.top = height / 2;
            this.composeCamera.bottom = -height / 2;
            this.composeCamera.left = -this.composeWidth / 2;
            this.composeCamera.right = this.composeWidth / 2;
        }
        this.composeCamera.updateProjectionMatrix();
        this.renderer.setSize(viewportWidth, viewportHeight);
    }
}
