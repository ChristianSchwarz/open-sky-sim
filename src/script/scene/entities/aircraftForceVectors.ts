import * as THREE from 'three';
import { PaletteCategory } from '../../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { ForceVectorKind, ForceVectorSample } from '../../physics/model/flightModel';
import { attachToRenderList } from '../../render/renderList';

/** Metres of arrow drawn per newton of force. Tunable for legibility. */
const FORCE_SCALE = 0.0004;
/** Longest arrow shaft (m); very large components are clamped to this. */
const MAX_LEN = 30;
/** Axis components below this magnitude (N) are not drawn. */
const MIN_FORCE_N = 50;
/** Vertices per arrow polyline: shaft tip + two arrowhead barbs. */
const VERTS_PER_ARROW = 5;

type Axis = 'x' | 'y' | 'z';

/** One colour per force kind so lift, drag, thrust and weight are distinct. */
const KIND_COLORS: Record<ForceVectorKind, string> = {
    lift: '#55ff55', // green — aerodynamic lift
    drag: '#ff5555', // red — aerodynamic drag
    thrust: '#55ccff', // cyan — engine thrust
    weight: '#ffcc33', // amber — gravity
};

const KIND_ORDER: ForceVectorKind[] = ['lift', 'drag', 'thrust', 'weight'];

const AXIS_DIRS: Record<Axis, THREE.Vector3> = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1),
};


/**
 * Debug overlay that draws, for every body part reported by the flight model,
 * its force resolved into three body-axis arrows (fore/aft, lateral, vertical).
 * Arrows are coloured by force KIND — lift (green), drag (red), thrust (cyan) and
 * weight (amber) — so each surface shows its lift and drag separately, and the
 * component on each axis is read from the individual arrow directions. All
 * samples are body-frame; the arrows live under one root transformed by the
 * aircraft's display pose so they track the airframe exactly.
 */
export class AircraftForceVectors {
    private readonly root = new THREE.Object3D();
    private readonly materials: Map<ForceVectorKind, THREE.Material> = new Map();
    private readonly pool: THREE.Line[] = [];
    private activeCount = 0;

    // Scratch vectors reused each frame.
    private readonly _origin = new THREE.Vector3();
    private readonly _dir = new THREE.Vector3();
    private readonly _perp = new THREE.Vector3();
    private readonly _tip = new THREE.Vector3();
    private readonly _back = new THREE.Vector3();
    private readonly _ref = new THREE.Vector3();

    constructor(private readonly materialManager: SceneMaterialManager) {
        KIND_ORDER.forEach(kind => {
            this.materials.set(kind, this.materialManager.build({
                type: SceneMaterialPrimitiveType.LINE,
                category: PaletteCategory.LIGHT_YELLOW,
                rawColor: KIND_COLORS[kind],
                depthWrite: false,
            }));
        });
    }

    private acquire(index: number): THREE.Line {
        let line = this.pool[index];
        if (!line) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VERTS_PER_ARROW * 3), 3));
            line = new THREE.Line(geometry, this.materials.get('lift'));
            line.onBeforeRender = updateUniforms;
            this.pool[index] = line;
        }
        return line;
    }

    /**
     * Fill a pooled arrow from `origin` along `axis` with a signed magnitude
     * (newtons), coloured for `kind`. Returns false when the component is too
     * small to draw.
     */
    private emitAxis(origin: THREE.Vector3, axis: Axis, component: number, kind: ForceVectorKind): boolean {
        const force = Math.abs(component);
        if (force < MIN_FORCE_N) {
            return false;
        }

        let len = force * FORCE_SCALE;
        if (len > MAX_LEN) {
            len = MAX_LEN;
        }

        // Signed direction along the body axis.
        this._dir.copy(AXIS_DIRS[axis]).multiplyScalar(Math.sign(component) || 1);
        this._tip.copy(origin).addScaledVector(this._dir, len);

        // Arrowhead: two short barbs swept back from the tip.
        const headLen = Math.min(len * 0.25, 2.0);
        const headWidth = headLen * 0.5;
        this._ref.set(0, 1, 0);
        if (Math.abs(this._dir.dot(this._ref)) > 0.95) {
            this._ref.set(1, 0, 0);
        }
        this._perp.crossVectors(this._dir, this._ref).normalize();
        this._back.copy(this._tip).addScaledVector(this._dir, -headLen);

        const line = this.acquire(this.activeCount++);
        line.material = this.materials.get(kind)!;
        const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        attr.setXYZ(0, origin.x, origin.y, origin.z);
        attr.setXYZ(1, this._tip.x, this._tip.y, this._tip.z);
        attr.setXYZ(2,
            this._back.x + this._perp.x * headWidth,
            this._back.y + this._perp.y * headWidth,
            this._back.z + this._perp.z * headWidth);
        attr.setXYZ(3, this._tip.x, this._tip.y, this._tip.z);
        attr.setXYZ(4,
            this._back.x - this._perp.x * headWidth,
            this._back.y - this._perp.y * headWidth,
            this._back.z - this._perp.z * headWidth);
        attr.needsUpdate = true;

        this.root.add(line);
        return true;
    }

    update(position: THREE.Vector3, quaternion: THREE.Quaternion, samples: ForceVectorSample[]): void {
        this.root.position.copy(position);
        this.root.quaternion.copy(quaternion);
        this.root.clear();
        this.activeCount = 0;

        for (const sample of samples) {
            const kind = sample.kind ?? 'lift';
            this._origin.fromArray(sample.origin);
            this.emitAxis(this._origin, 'x', sample.vec[0], kind);
            this.emitAxis(this._origin, 'y', sample.vec[1], kind);
            this.emitAxis(this._origin, 'z', sample.vec[2], kind);
        }
    }

    addToRenderList(listId: string, lists: Map<string, THREE.Scene>): void {
        if (this.activeCount === 0) {
            return;
        }
        const list = lists.get(listId);
        if (!list) {
            return;
        }
        attachToRenderList(list, this.root);
    }
}
