import * as THREE from 'three';

/**
 * Copies one texture into whatever render target is bound, full-screen,
 * resampled by the destination's own filter settings.
 *
 * The one client is the background sky dome (see Renderer.render): it is
 * low-frequency enough, and changes slowly enough (baked per vertex only
 * when the sun moves), to be worth shading at a fraction of the output
 * resolution and upscaling here for a fraction of the fill-rate cost.
 * Modelled on SceneDepthPass - same identity-camera, unit-quad, save/restore
 * pattern - since this is the same kind of one-off auxiliary blit.
 */

const BLIT_VERTEX_PROGRAM = `
  precision highp float;

  varying vec2 vUv;
  void main() {
    vUv = uv;
    // A unit quad straight to clip space; no camera is involved.
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
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
    private readonly scene = new THREE.Scene();
    /** Identity: the quad is already in clip space. */
    private readonly camera = new THREE.Camera();
    private readonly material: THREE.ShaderMaterial;

    constructor() {
        this.material = new THREE.ShaderMaterial({
            vertexShader: BLIT_VERTEX_PROGRAM,
            fragmentShader: BLIT_FRAGMENT_PROGRAM,
            uniforms: {
                uSource: { value: null },
            },
            depthTest: false,
            depthWrite: false,
        });
        this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material));
    }

    /**
     * Draws `source` into `destination`, full-screen. Leaves the render
     * target bound as it found it - same reason as SceneDepthPass.resolve:
     * whatever called this mid-frame has to give the binding back.
     */
    blit(renderer: THREE.WebGLRenderer, source: THREE.Texture, destination: THREE.WebGLRenderTarget): void {
        this.material.uniforms.uSource.value = source;
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(destination);
        renderer.render(this.scene, this.camera);
        renderer.setRenderTarget(previous);
    }
}
