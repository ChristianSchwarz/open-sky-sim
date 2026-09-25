import * as THREE from 'three';
import {
    SCENE_DEPTH_CEILING, SCENE_DEPTH_PACK_FRAGMENT, SCENE_DEPTH_UNIFORMS,
} from '../scene/materials/shaders/sceneDepth';

/**
 * Resolves the depth a scene pass just wrote into a colour texture a later pass
 * in the *same* target can sample.
 *
 * The copy is what makes this necessary at all. A pass drawing into a target
 * cannot sample that target's own depth attachment - it is a feedback loop, and
 * undefined at best - so the depth is read once, linearised, and written
 * somewhere else before the pass that wants it runs.
 *
 * Linearising here rather than in the client is deliberate: the curve depends on
 * the far plane of the camera that *wrote* the depth, which is not the camera
 * the client is drawn with. The sun's glare rides the rotation-only background
 * camera while the depth under it came from the main one.
 */

const RESOLVE_VERTEX_PROGRAM = `
  precision highp float;

  varying vec2 vUv;
  void main() {
    vUv = uv;
    // A unit quad straight to clip space; no camera is involved.
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
  }
`;

const RESOLVE_FRAGMENT_PROGRAM = `
  precision highp float;

  uniform sampler2D uDepth;
  uniform float uLogCurve;
  uniform float uInvFar;
  uniform float uCeiling;
  varying vec2 vUv;
${SCENE_DEPTH_PACK_FRAGMENT}
  void main() {
    float depth = texture2D(uDepth, vUv).x;
    // Every material in the scene pass writes the logarithmic depth Three sets
    // up: gl_FragDepth = log2(1 + w) / log2(far + 1), with w the view-axis
    // distance (see shaders/logDepth.ts). Invert it. The buffer's clear value
    // of 1 lands exactly on the far plane, which is what marks open sky.
    float w = exp2(depth * uLogCurve) - 1.0;
    gl_FragColor = vec4(packUnit(min(w * uInvFar, uCeiling)), 1.0);
  }
`;

export class SceneDepthPass {

    /**
     * One copy per source target. Keyed by the target rather than shared,
     * because the player view and the weapons-target MFD are different sizes
     * and both carry a glare; one shared copy would be resized twice a frame.
     */
    private readonly copies: Map<THREE.WebGLRenderTarget, THREE.WebGLRenderTarget> = new Map();
    private readonly scene = new THREE.Scene();
    /** Identity: the quad is already in clip space. */
    private readonly camera = new THREE.Camera();
    private readonly material: THREE.ShaderMaterial;

    constructor() {
        this.material = new THREE.ShaderMaterial({
            vertexShader: RESOLVE_VERTEX_PROGRAM,
            fragmentShader: RESOLVE_FRAGMENT_PROGRAM,
            uniforms: {
                uDepth: { value: null },
                uLogCurve: { value: 1 },
                uInvFar: { value: 1 },
                uCeiling: { value: SCENE_DEPTH_CEILING },
            },
            depthTest: false,
            depthWrite: false,
        });
        this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material));
    }

    /**
     * Resolves `source`'s depth and points {@link SCENE_DEPTH_UNIFORMS} at the
     * result. `far` is the far plane of the camera whose pass wrote that depth,
     * which sets the logarithmic curve it has to be read back through.
     *
     * Leaves the bound render target as it found it: layers after the first on
     * a target never rebind it themselves, so anything that borrows the binding
     * mid-frame has to give it back.
     */
    resolve(renderer: THREE.WebGLRenderer, source: THREE.WebGLRenderTarget, far: number): void {
        const depth = source.depthTexture;
        if (!depth) {
            return;
        }
        const copy = this.copyFor(source);

        this.material.uniforms.uDepth.value = depth;
        this.material.uniforms.uLogCurve.value = Math.log2(far + 1);
        this.material.uniforms.uInvFar.value = 1 / far;

        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(copy);
        renderer.render(this.scene, this.camera);
        renderer.setRenderTarget(previous);

        SCENE_DEPTH_UNIFORMS.uSceneDepth.value = copy.texture;
        SCENE_DEPTH_UNIFORMS.uSceneDepthSize.value.set(copy.width, copy.height);
        SCENE_DEPTH_UNIFORMS.uSceneFar.value = far;
    }

    private copyFor(source: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
        let copy = this.copies.get(source);
        if (copy === undefined) {
            copy = new THREE.WebGLRenderTarget(source.width, source.height, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat,
                // Nothing is tested or stencilled against the copy; it is a
                // buffer that happens to be drawn into.
                depthBuffer: false,
                stencilBuffer: false,
            });
            this.copies.set(source, copy);
        } else if (copy.width !== source.width || copy.height !== source.height) {
            copy.setSize(source.width, source.height);
        }
        return copy;
    }
}
