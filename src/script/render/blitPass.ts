import * as THREE from 'three';

/**
 * Copies one texture onto the background of a render target: the pixels
 * whose depth is still the clear value, resampled by the source's filter.
 *
 * The one client is the background sky dome (see Renderer.render): it is
 * low-frequency enough, and changes slowly enough (baked per vertex only
 * when the sun moves), to be worth shading at a fraction of the output
 * resolution and upscaling here for a fraction of the fill-rate cost. And
 * only where it shows: the quad sits at the far plane, depth-tested, drawn
 * after the scene's opaque geometry (see deferredMesh).
 * Modelled on SceneDepthPass - same identity-camera, unit-quad, save/restore
 * pattern - since this is the same kind of one-off auxiliary blit.
 */

const BLIT_VERTEX_PROGRAM = `
  precision highp float;

  varying vec2 vUv;
  void main() {
    vUv = uv;
    // A unit quad straight to clip space at the far plane; no camera is involved.
    gl_Position = vec4(position.xy * 2.0, 1.0, 1.0);
  }
`;

const BLIT_FRAGMENT_PROGRAM = `
  precision highp float;

  uniform sampler2D uSource;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(uSource, vUv);
  }
`;

export class BlitPass {
    /** Holds the quad for a target no scene pass drew into; see drawDeferred. */
    private readonly scene = new THREE.Scene();
    /** Identity: the quad is already in clip space. */
    private readonly camera = new THREE.Camera();
    private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

    constructor() {
        const material = new THREE.ShaderMaterial({
            vertexShader: BLIT_VERTEX_PROGRAM,
            fragmentShader: BLIT_FRAGMENT_PROGRAM,
            uniforms: {
                uSource: { value: null },
            },
            depthTest: true,
            depthFunc: THREE.LessEqualDepth,
            depthWrite: false,
        });
        material.userData.deferredBlit = true;
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        this.quad.frustumCulled = false;
        this.quad.name = 'DeferredBlit';
    }

    /**
     * A quad that copies `source` onto the pixels of the bound target whose
     * depth is still the clear value - the background a scene left showing.
     * Added to that scene, it has to draw after the opaque geometry that
     * writes depth and before anything that does not (see
     * Renderer.deferredBlitRank): a stippled cloud over the sky writes no
     * depth, and the quad would paint over it.
     */
    deferredMesh(source: THREE.Texture): THREE.Mesh {
        this.quad.material.uniforms.uSource.value = source;
        return this.quad;
    }

    /**
     * The quad on its own, for a target whose scene pass never ran. Leaves
     * the render target bound as it found it - same reason as
     * SceneDepthPass.resolve: whatever called this mid-frame has to give the
     * binding back.
     */
    drawDeferred(renderer: THREE.WebGLRenderer, source: THREE.Texture, destination: THREE.WebGLRenderTarget): void {
        const previous = renderer.getRenderTarget();
        this.scene.add(this.deferredMesh(source));
        renderer.setRenderTarget(destination);
        renderer.render(this.scene, this.camera);
        this.scene.remove(this.quad);
        renderer.setRenderTarget(previous);
    }
}
