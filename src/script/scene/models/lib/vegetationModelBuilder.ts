import * as THREE from 'three';

export function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
    let totalVertices = 0;
    const nonIndexed: THREE.BufferGeometry[] = [];
    for (const geo of geometries) {
        const flat = geo.index ? geo.toNonIndexed() : geo;
        nonIndexed.push(flat);
        totalVertices += flat.getAttribute('position').count;
    }

    const positions = new Float32Array(totalVertices * 3);
    let offset = 0;
    for (const geo of nonIndexed) {
        const attr = geo.getAttribute('position');
        positions.set(attr.array as Float32Array, offset);
        offset += attr.count * 3;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.computeVertexNormals();
    return merged;
}
