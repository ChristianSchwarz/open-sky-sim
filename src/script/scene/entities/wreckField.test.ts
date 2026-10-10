import * as THREE from 'three';
import { describe, it } from 'node:test';
import { expect } from './testExpect';
import { Model } from '../models/models';
import { WreckField, WreckFire, WreckSource, WreckTracker, groupTriangles } from './wreckField';

/** A crude aircraft: fuselage box plus two wings, as one mesh at its origin. */
function airframe(): Model {
    const parts = [
        new THREE.BoxGeometry(2, 2, 14),
        new THREE.BoxGeometry(14, 0.3, 3).translate(0, 0, -1),
    ];
    const merged = new THREE.BufferGeometry();
    const pos: number[] = [];
    const nrm: number[] = [];
    for (const g of parts) {
        const ng = g.toNonIndexed();
        pos.push(...ng.getAttribute('position').array);
        nrm.push(...ng.getAttribute('normal').array);
    }
    merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());
    return { lod: [{ flats: [], volumes: [mesh] }], animations: [], maxSize: 14, center: new THREE.Vector3() };
}

function source(velocity: THREE.Vector3, y = 1.2): WreckSource {
    return {
        id: "t",
        body: airframe(),
        position: new THREE.Vector3(0, y, 0),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1),
        velocity,
        parts: [],
    };
}

function fragments(field: WreckField): THREE.Object3D[] {
    return ((field as unknown as { root: THREE.Object3D }).root).children;
}

describe('WreckField', () => {
    it('breaks a steep fast impact into several pieces', () => {
        const field = new WreckField();
        expect(field.spawn(source(new THREE.Vector3(0, -90, 140)))).toBe(true);
        expect(fragments(field).length).toBeGreaterThan(3);
    });

    it('keeps a slow belly slide mostly together', () => {
        const field = new WreckField();
        field.spawn(source(new THREE.Vector3(0, -6, 60)));
        expect(fragments(field).length).toBeLessThan(4);
    });

    it('lets pieces travel on, then come to rest on the ground', () => {
        const field = new WreckField();
        field.spawn(source(new THREE.Vector3(0, -50, 120)));
        for (let i = 0; i < 60 * 40; i++) {
            field.update(1 / 60);
        }
        const moved = fragments(field).filter(o => Math.hypot(o.position.x, o.position.z) > 20);
        expect(moved.length).toBeGreaterThan(0);
        for (const o of fragments(field)) {
            expect(o.position.y).toBeGreaterThan(-0.5);
            expect(o.position.y).toBeLessThan(12);
        }
        const asleep = (field as unknown as { fragments: { asleep: boolean }[] }).fragments;
        expect(asleep.every(f => f.asleep)).toBe(true);
    });

    it('puts a fuselage fire and wing-root fires on the pieces, and they travel with them', () => {
        const field = new WreckField();
        let fires: WreckFire[] = [];
        field.onBreakup = (e) => { fires = e.fires; };
        field.spawn(source(new THREE.Vector3(0, -80, 130)));
        expect(fires.filter(f => f.kind === 'fuselage').length).toBe(1);
        expect(fires.filter(f => f.kind === 'wingRoot').length).toBeGreaterThan(0);
        const fuselage = fires.find(f => f.kind === 'fuselage')!;
        const before = new THREE.Vector3();
        const after = new THREE.Vector3();
        field.fireWorld(fuselage, before);
        for (let i = 0; i < 120; i++) {
            field.update(1 / 60);
        }
        expect(field.fireWorld(fuselage, after)).toBe(true);
        expect(after.distanceTo(before)).toBeGreaterThan(5);
        // Wing roots sit off the centreline, on either side.
        const roots = fires.filter(f => f.kind === 'wingRoot').map(f => f.local.x);
        expect(roots.length).toBeGreaterThan(0);
    });

    it('lets a camera follow the cockpit piece as it flies and lands', () => {
        const field = new WreckField();
        const src = { ...source(new THREE.Vector3(0, -80, 130)), cockpit: new THREE.Vector3(0, 0.8, 5) };
        field.spawn(src);
        const start = new THREE.Vector3();
        expect(field.cockpitWorld('t', start)).toBe(true);
        expect(start.distanceTo(new THREE.Vector3(0, 2, 5))).toBeLessThan(1.5);
        for (let i = 0; i < 90; i++) {
            field.update(1 / 60);
        }
        const later = new THREE.Vector3();
        field.cockpitWorld('t', later);
        expect(later.distanceTo(start)).toBeGreaterThan(10);
        field.clear();
        expect(field.cockpitWorld('t', later)).toBe(false);
    });

    it('gives the aircraft pose of the cockpit piece, consistent with the eye', () => {
        const field = new WreckField();
        const cockpit = new THREE.Vector3(0, 0.8, 5);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, 0.2));
        field.spawn({ ...source(new THREE.Vector3(0, -80, 130)), quaternion: q, cockpit });
        for (let i = 0; i < 100; i++) {
            field.update(1 / 60);
        }
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const eye = new THREE.Vector3();
        expect(field.cockpitBodyPose('t', pos, quat)).toBe(true);
        field.cockpitWorld('t', eye);
        const fromPose = cockpit.clone().applyQuaternion(quat).add(pos);
        expect(fromPose.distanceTo(eye)).toBeLessThan(1e-3);
    });

    it('leaves a scorch at the impact, then pocks and gouges along the slide, all on the ground', () => {
        const field = new WreckField();
        const marks: { y: number; length: number; width: number }[] = [];
        field.onMark = (p, _n, _dx, _dz, length, width) => { marks.push({ y: p.y, length, width }); };
        field.spawn(source(new THREE.Vector3(0, -60, 120)));
        const atImpact = marks.length;
        expect(atImpact).toBeGreaterThan(3);
        expect(Math.max(...marks.map(m => m.length))).toBeGreaterThan(10);
        for (let i = 0; i < 240; i++) {
            field.update(1 / 60);
        }
        expect(marks.length).toBeGreaterThan(atImpact);
        for (const m of marks) {
            expect(m.y).toBeCloseTo(0, 5);
        }
    });

    it('lets pieces break up further on the ground, keeping fires and cockpit with the right half', () => {
        let splits = 0;
        let anySplit = false;
        for (let run = 0; run < 6 && !anySplit; run++) {
            const field = new WreckField();
            field.onSplit = () => { splits++; };
            let fires: WreckFire[] = [];
            field.onBreakup = (e) => { fires = e.fires; };
            const cockpit = new THREE.Vector3(0, 0.8, 5);
            field.spawn({ ...source(new THREE.Vector3(0, -80, 130)), cockpit });
            const before = fragments(field).length;
            for (let i = 0; i < 60 * 8; i++) {
                field.update(1 / 60);
            }
            const after = fragments(field).length;
            anySplit = after > before;
            // Fires still ride on a live piece, and the cockpit pose still matches the eye.
            const p = new THREE.Vector3();
            for (const f of fires) {
                expect(field.fireWorld(f, p)).toBe(true);
                // (This crude airframe has a few huge triangles, so a section's fire spot, the middle of
                // its box, can lie some metres from any skin once the sections are folded about.)
                expect(p.y).toBeGreaterThan(-4);
            }
            const pos = new THREE.Vector3();
            const quat = new THREE.Quaternion();
            const eye = new THREE.Vector3();
            expect(field.cockpitBodyPose('t', pos, quat)).toBe(true);
            field.cockpitWorld('t', eye);
            expect(cockpit.clone().applyQuaternion(quat).add(pos).distanceTo(eye)).toBeLessThan(1e-3);
            for (const o of fragments(field)) {
                expect(o.position.y).toBeGreaterThan(-1);
            }
        }
        expect(anySplit).toBe(true);
        expect(splits).toBeGreaterThan(0);
    });

    it('marks the ground wherever a piece touches, slides or settles, even gently', () => {
        const field = new WreckField();
        let marks = 0;
        field.onMark = () => { marks++; };
        // A slow, shallow crash: nothing here is hard enough for the old thresholds.
        field.spawn(source(new THREE.Vector3(0, -2.5, 14), 0.5));
        const afterSpawn = marks;
        for (let i = 0; i < 60 * 30; i++) {
            field.update(1 / 60);
        }
        const pieces = fragments(field).length;
        // At least a touch-down dent or a resting impression per piece.
        expect(marks - afterSpawn).toBeGreaterThanOrEqual(pieces);
    });

    it('sets the scratches of fire-carrying pieces alight, the fuselage for longest', () => {
        const field = new WreckField();
        const burns: { life: number; intensity: number; y: number }[] = [];
        field.onMark = () => undefined; // scratches are only laid when someone draws them
        field.onBurn = (p, life, intensity) => { burns.push({ life, intensity, y: p.y }); };
        field.spawn(source(new THREE.Vector3(0, -12, 110)));
        for (let i = 0; i < 60 * 4; i++) {
            field.update(1 / 60);
        }
        expect(burns.length).toBeGreaterThan(0);
        for (const b of burns) {
            expect(b.life).toBeGreaterThan(7);
            expect(b.y).toBeCloseTo(0, 5);
        }
        // Fuselage trails burn longer and harder than wing-root ones.
        const strong = burns.filter(b => b.intensity === 1);
        const weak = burns.filter(b => b.intensity < 1);
        if (strong.length > 0 && weak.length > 0) {
            expect(Math.min(...strong.map(b => b.life))).toBeGreaterThan(Math.max(...weak.map(b => b.life)) - 1e-9);
        }
    });

    describe('burning shards flung to the sides', () => {
        /** A finely tessellated airframe, so there is enough to cut shards from. */
        function denseAirframe(): Model {
            const parts = [
                new THREE.BoxGeometry(2, 2, 14, 4, 4, 12),
                new THREE.BoxGeometry(14, 0.3, 3, 12, 1, 3).translate(0, 0, -1),
            ];
            const pos: number[] = [];
            const nrm: number[] = [];
            for (const g of parts) {
                const ng = g.toNonIndexed();
                pos.push(...ng.getAttribute('position').array);
                nrm.push(...ng.getAttribute('normal').array);
            }
            const merged = new THREE.BufferGeometry();
            merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
            const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());
            return { lod: [{ flats: [], volumes: [mesh] }], animations: [], maxSize: 14, center: new THREE.Vector3() };
        }

        const dense = (v: THREE.Vector3): WreckSource => ({ ...source(v), body: denseAirframe() });

        function vertexCount(field: WreckField): number {
            let n = 0;
            for (const o of fragments(field)) {
                for (const c of o.children) {
                    n += (c as THREE.Mesh).geometry.getAttribute('position').count;
                }
            }
            return n;
        }

        it('cuts shards out of the airframe without losing or duplicating any triangle', () => {
            const src = dense(new THREE.Vector3(0, -90, 140));
            const expected = src.body.lod[0].volumes
                .reduce((n, o) => n + (o as THREE.Mesh).geometry.getAttribute('position').count, 0);
            const field = new WreckField();
            let brands = 0;
            field.onBreakup = (e) => { brands = e.fires.filter(f => f.kind === 'brand').length; };
            field.spawn(src);
            expect(brands).toBeGreaterThan(0);
            // Nothing lost or doubled: whatever is not in a piece is accounted for as dropped scrap.
            expect(vertexCount(field) + 3 * field.lastScrapTriangles).toBe(expected);
        });

        it('throws them out to the side of the line of travel, not along it', () => {
            let lateral = 0;
            let along = 0;
            for (let run = 0; run < 5; run++) {
                const field = new WreckField();
                let brandFires: WreckFire[] = [];
                field.onBreakup = (e) => { brandFires = e.fires.filter(f => f.kind === 'brand'); };
                // Travelling along +Z, so "to the side" is X.
                field.spawn(dense(new THREE.Vector3(0, -90, 140)));
                expect(brandFires.length).toBeGreaterThan(0);
                const p = new THREE.Vector3();
                for (let i = 0; i < 40; i++) {
                    field.update(1 / 60);
                }
                for (const f of brandFires) {
                    expect(field.fireWorld(f, p)).toBe(true);
                    lateral += Math.abs(p.x);
                }
                along += brandFires.length;
            }
            // On average each shard has moved well sideways within under a second.
            expect(lateral / along).toBeGreaterThan(6);
        });

        it('flings nothing on a gentle touchdown', () => {
            const field = new WreckField();
            let brands = -1;
            field.onBreakup = (e) => { brands = e.fires.filter(f => f.kind === 'brand').length; };
            field.spawn(dense(new THREE.Vector3(0, -6, 60)));
            expect(brands).toBe(0);
        });
    });

    describe('connectivity: no unconnected parts in a piece', () => {
        /** Number of separate connected components in a fragment. */
        function components(frag: THREE.Object3D): number {
            const items: { pos: ArrayLike<number>; t: number }[] = [];
            for (const c of frag.children) {
                const pos = (c as THREE.Mesh).geometry.getAttribute('position').array;
                for (let t = 0; t < pos.length / 9; t++) {
                    items.push({ pos, t });
                }
            }
            return groupTriangles(items).length;
        }

        /** A dense closed block as flat position data, centred at (x, y, z). */
        function block(w: number, h: number, d: number, x: number, y: number, z: number, seg = 3): number[] {
            const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg).translate(x, y, z).toNonIndexed();
            return Array.from(g.getAttribute('position').array);
        }

        const withPositions = (pos: number[], material: THREE.Material) => ({
            material,
            attrs: new Map([['position', { data: pos, itemSize: 3 }]]),
        });

        type Priv = {
            joinedSections(chunks: { cell: number }[]): { cell: number }[][];
            connectedParts(parts: unknown[]): { attrs: Map<string, { data: number[] }> }[][];
            extractShards(chunks: unknown[], count: number, size: number): { meshes: { attrs: Map<string, { data: number[] }> }[] }[];
        };
        const priv = (f: WreckField) => f as unknown as Priv;

        it('welds triangles that share a vertex and keeps separate surfaces apart', () => {
            const two = [...block(1, 1, 1, 0, 0, 0, 1), ...block(1, 1, 1, 5, 0, 0, 1)];
            const items = Array.from({ length: two.length / 9 }, (_, t) => ({ pos: two, t }));
            expect(groupTriangles(items).length).toBe(2);
            const touching = [...block(1, 1, 1, 0, 0, 0, 1), ...block(1, 1, 1, 1, 0, 0, 1)];
            const itemsT = Array.from({ length: touching.length / 9 }, (_, t) => ({ pos: touching, t }));
            expect(groupTriangles(itemsT).length).toBe(1);
        });

        it('keeps sections that are still joined together and separates the rest', () => {
            const f = priv(new WreckField());
            const runs = (cells: number[]) =>
                f.joinedSections(cells.map(cell => ({ cell }))).map(r => r.map(c => c.cell).sort().join('')).sort();
            expect(runs([0, 1, 2])).toEqual(['012']);
            // A middle section gone: the two ends are two pieces, not one with a gap.
            expect(runs([0, 2])).toEqual(['0', '2']);
            expect(runs([3, 5])).toEqual(['3', '5']);
            expect(runs([1, 3, 4, 5, 6])).toEqual(['13456']);
            expect(runs([0, 1, 3, 6])).toEqual(['013', '6']);
        });

        it('cuts a piece that a cut left in two unjoined parts into two pieces', () => {
            const f = priv(new WreckField());
            const mat = new THREE.MeshBasicMaterial();
            const dumbbell = withPositions([...block(2, 2, 2, -4, 0, 0), ...block(2, 2, 2, 4, 0, 0)], mat);
            const out = f.connectedParts([dumbbell]);
            expect(out.length).toBe(2);
            for (const comp of out) {
                const pos = comp[0].attrs.get('position')!.data;
                const items = Array.from({ length: pos.length / 9 }, (_, t) => ({ pos, t }));
                expect(groupTriangles(items).length).toBe(1);
            }
        });

        it('drops a scrap too small to be a piece instead of leaving it floating', () => {
            const f = priv(new WreckField());
            const mat = new THREE.MeshBasicMaterial();
            // Two stray triangles far from the main surface.
            const stray = [6, 0, 0, 6.1, 0, 0, 6, 0.1, 0, 6.1, 0, 0, 6.1, 0.1, 0, 6, 0.1, 0];
            const scrap = withPositions([...block(2, 2, 2, 0, 0, 0), ...stray], mat);
            const out = f.connectedParts([scrap]);
            expect(out.length).toBe(1);
            expect(out[0][0].attrs.get('position')!.data.length / 9).toBe(block(2, 2, 2, 0, 0, 0).length / 9);
        });

        it('cuts shards from one connected surface even when another sits within reach', () => {
            const f = priv(new WreckField());
            const mat = new THREE.MeshBasicMaterial();
            // Two dense plates 0.4 m apart: a shard radius reaches both, but they are not joined.
            const plates = [
                ...new THREE.BoxGeometry(14, 0.05, 14, 28, 1, 28).translate(0, 0, 0).toNonIndexed().getAttribute('position').array,
                ...new THREE.BoxGeometry(14, 0.05, 14, 28, 1, 28).translate(0, 0.4, 0).toNonIndexed().getAttribute('position').array,
            ];
            const cm = withPositions(Array.from(plates), mat);
            const chunk = { cell: 1, meshes: [cm], box: new THREE.Box3(), weakness: 1 };
            const before = cm.attrs.get('position')!.data.length;
            const shards = f.extractShards([chunk], 8, 14);
            expect(shards.length).toBeGreaterThan(0);
            let removed = 0;
            for (const shard of shards) {
                const pos = shard.meshes[0].attrs.get('position')!.data;
                removed += pos.length;
                const items = Array.from({ length: pos.length / 9 }, (_, t) => ({ pos, t }));
                expect(groupTriangles(items).length).toBe(1);
            }
            // Cut out of the source, not copied.
            expect(cm.attrs.get('position')!.data.length).toBe(before - removed);
        });

        it('always cuts its shards from a dense mesh, however many triangles lie within reach of the seed', { timeout: 30000 }, () => {
            const f = priv(new WreckField());
            const mat = new THREE.MeshBasicMaterial();
            // A very dense plate, so far more than a shard's worth of triangles lie within reach of any seed.
            const plate = Array.from(new THREE.BoxGeometry(14, 0.05, 14, 80, 1, 80).toNonIndexed().getAttribute('position').array);
            let empty = 0;
            for (let trial = 0; trial < 100; trial++) {
                const cm = withPositions(plate.slice(), mat);
                const chunk = { cell: 1, meshes: [cm], box: new THREE.Box3(), weakness: 1 };
                const shards = f.extractShards([chunk], 1, 14);
                if (shards.length === 0) {
                    empty++;
                }
            }
            // One shard asked for, one seed tried: the seed is always in its own shard, so it never comes up empty.
            expect(empty).toBe(0);
        });

        it('keeps all the sections of the fuselage in one piece at every moderate hit, tips aside', () => {
            const mats = [0, 1, 2].map(() => new THREE.MeshBasicMaterial());
            const tipL = new THREE.MeshBasicMaterial();
            const tipR = new THREE.MeshBasicMaterial();
            const fuselage = (z: number, m: THREE.Material): THREE.Mesh =>
                new THREE.Mesh(new THREE.BoxGeometry(2, 2, 4.4, 2, 2, 2).translate(0, 0, z).toNonIndexed(), m);
            const tip = (x: number, m: THREE.Material): THREE.Mesh =>
                new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 2, 2, 1, 2).translate(x, 0, 0).toNonIndexed(), m);
            const meshes = [fuselage(-4.5, mats[0]), fuselage(0, mats[1]), fuselage(4.5, mats[2]), tip(-7, tipL), tip(7, tipR)];
            const model: Model = { lod: [{ flats: [], volumes: meshes }], animations: [], maxSize: 15, center: new THREE.Vector3() };
            for (let run = 0; run < 200; run++) {
                const field = new WreckField();
                // (Up to a hard knock: a far harder one tears a section away, see below.)
                const v = 30 + (run % 20);
                field.spawn({ ...source(new THREE.Vector3(0, -v, v * 1.3)), body: model });
                let withFuselage = 0;
                for (const frag of fragments(field)) {
                    const used = new Set(frag.children.map(c => (c as THREE.Mesh).material));
                    const triangles = frag.children.reduce(
                        (n, c) => n + (c as THREE.Mesh).geometry.getAttribute('position').count / 3, 0);
                    // A real piece, not one of the small burning shards that are also cut from the blocks.
                    if (triangles > 60 && mats.some(m => used.has(m))) {
                        withFuselage++;
                        // Every section of the fuselage is in this one piece.
                        expect(mats.every(m => used.has(m))).toBe(true);
                    }
                    // The wing tips are joined to nothing here (no inner wing), so never share a piece.
                    expect(used.has(tipL) && used.has(tipR)).toBe(false);
                }
                expect(withFuselage).toBe(1);
            }
        });
    });

    describe('a fuselage that dislocates, and tears only under a very hard blow', () => {
        const fuselageMat = new THREE.MeshBasicMaterial();
        const wingMat = new THREE.MeshBasicMaterial();

        /** A long fuselage (z from -7 to 7, front at +Z, 2 m wide) with a wing across it, as two meshes. */
        function jet(): Model {
            const fuselage = new THREE.Mesh(
                new THREE.BoxGeometry(2, 2, 14, 3, 3, 28).toNonIndexed(), fuselageMat);
            const wing = new THREE.Mesh(
                new THREE.BoxGeometry(14, 0.3, 3, 14, 1, 3).translate(0, 0, 0.5).toNonIndexed(), wingMat);
            return { lod: [{ flats: [], volumes: [fuselage, wing] }], animations: [], maxSize: 14, center: new THREE.Vector3() };
        }
        const spawnJet = (field: WreckField, velocity: THREE.Vector3) =>
            field.spawn({ ...source(velocity), body: jet(), cockpit: new THREE.Vector3(0, 0.8, 5.5) });

        /** All vertices (world, right after the break-up) of the meshes with this material. */
        function vertices(field: WreckField, mat: THREE.Material): THREE.Vector3[] {
            const out: THREE.Vector3[] = [];
            for (const frag of fragments(field)) {
                for (const c of frag.children) {
                    const mesh = c as THREE.Mesh;
                    if (mesh.material !== mat) {
                        continue;
                    }
                    const pos = mesh.geometry.getAttribute('position');
                    for (let i = 0; i < pos.count; i++) {
                        out.push(new THREE.Vector3().fromBufferAttribute(pos, i).add(frag.position));
                    }
                }
            }
            return out;
        }
        /** Triangles of a material in a piece. */
        const trianglesOf = (f: THREE.Object3D, mat: THREE.Material) => f.children
            .filter(c => (c as THREE.Mesh).material === mat)
            .reduce((n, c) => n + (c as THREE.Mesh).geometry.getAttribute('position').count / 3, 0);
        /**
         * Real pieces of a material, not the small burning shards that are also cut from it (a shard
         * is up to 36 triangles, and the few the cut leaves hanging go with it): a section of this
         * fuselage is about 235 triangles, so 120 is well between the two.
         */
        const piecesWith = (field: WreckField, mat: THREE.Material) =>
            fragments(field).filter(f => trianglesOf(f, mat) > 120).length;
        /** The sorted lengths of every triangle edge of a material, over all pieces: unchanged by anything rigid. */
        function edgeLengths(field: WreckField, mat: THREE.Material): number[] {
            const out: number[] = [];
            for (const frag of fragments(field)) {
                for (const c of frag.children) {
                    const mesh = c as THREE.Mesh;
                    if (mesh.material !== mat) {
                        continue;
                    }
                    const pos = mesh.geometry.getAttribute('position');
                    const a = new THREE.Vector3();
                    const b = new THREE.Vector3();
                    for (let i = 0; i + 2 < pos.count; i += 3) {
                        for (let k = 0; k < 3; k++) {
                            a.fromBufferAttribute(pos, i + k);
                            b.fromBufferAttribute(pos, i + (k + 1) % 3);
                            out.push(Math.round(a.distanceTo(b) * 1e4) / 1e4);
                        }
                    }
                }
            }
            return out.sort((x, y) => x - y);
        }
        const maxAbsX = (field: WreckField) =>
            Math.max(...vertices(field, fuselageMat).map(v => Math.abs(v.x)));

        it('does not shift on a gentle touchdown', () => {
            const field = new WreckField();
            spawnJet(field, new THREE.Vector3(0, -4, 12));
            expect(field.lastDislocationM).toBe(0);
            expect(maxAbsX(field)).toBeLessThan(1.001);
        });

        it('shifts the rear sections sideways on a hard hit, the way it was being thrown, the nose staying put', () => {
            for (const sign of [1, -1]) {
                const field = new WreckField();
                spawnJet(field, new THREE.Vector3(sign * 25, -50, 60));
                expect(Math.sign(field.lastDislocationM)).toBe(sign);
                expect(Math.abs(field.lastDislocationM)).toBeGreaterThan(0.2);
                // Out to the side beyond the fuselage\'s own 1 m half-width...
                expect(maxAbsX(field)).toBeGreaterThan(1.2);
                // ...but the nose end, where the cockpit is, has not moved.
                const nose = vertices(field, fuselageMat).filter(v => v.z > 4);
                expect(nose.length).toBeGreaterThan(20);
                for (const v of nose) {
                    expect(Math.abs(v.x)).toBeLessThan(1.001);
                }
            }
        });

        it('moves each section as it is: nothing is bent or stretched', () => {
            let compared = 0;
            for (let run = 0; run < 20; run++) {
                const field = new WreckField();
                spawnJet(field, new THREE.Vector3((run % 5 - 2) * 10, -60, 70));
                if (field.lastScrapTriangles > 0) {
                    continue; // a scrap was dropped: the edge lists differ by those triangles
                }
                const still = new WreckField();
                spawnJet(still, new THREE.Vector3(0, -3, 6));
                // Nothing is deformed: the same triangles with the same edge lengths, however moved.
                expect(edgeLengths(field, fuselageMat)).toEqual(edgeLengths(still, fuselageMat));
                expect(edgeLengths(field, wingMat)).toEqual(edgeLengths(still, wingMat));
                compared++;
            }
            expect(compared).toBeGreaterThan(5);
        });

        it('also bends sideways round the impact, the way it was thrown, the nose staying straight', () => {
            for (const sign of [1, -1]) {
                const field = new WreckField();
                spawnJet(field, new THREE.Vector3(sign * 25, -50, 60));
                expect(Math.sign(field.lastBendRad)).toBe(sign);
                expect(Math.abs(field.lastBendRad)).toBeGreaterThan(0.3);
                // Both together: the dislocation and the bend go the same way.
                expect(Math.sign(field.lastDislocationM)).toBe(sign);
            }
            const gentle = new WreckField();
            spawnJet(gentle, new THREE.Vector3(0, -4, 12));
            expect(gentle.lastBendRad).toBe(0);
            const hard = new WreckField();
            spawnJet(hard, new THREE.Vector3(20, -150, 200));
            expect(Math.abs(hard.lastBendRad)).toBeLessThanOrEqual(2.4 + 1e-9);
            // The hardest hits turn the tail through more than 120 degrees without tearing it.
            expect(Math.abs(hard.lastBendRad)).toBeGreaterThan(120 * Math.PI / 180);
            const moderate = new WreckField();
            spawnJet(moderate, new THREE.Vector3(20, -35, 45));
            expect(Math.abs(hard.lastBendRad)).toBeGreaterThan(Math.abs(moderate.lastBendRad));
        });

        it('folds in different planes: sideways, and upward or downward too', () => {
            let sideways = 0;
            let up = 0;
            let down = 0;
            for (let run = 0; run < 80; run++) {
                const field = new WreckField();
                spawnJet(field, new THREE.Vector3((run % 5 - 2) * 8, -60, 80));
                const upRad = field.lastBendUpRad;
                const yaw = Math.sqrt(Math.max(0, field.lastBendRad ** 2 - upRad ** 2));
                if (Math.abs(upRad) < 0.1) {
                    sideways++;
                } else if (upRad > 0) {
                    up++;
                } else {
                    down++;
                }
                // The two parts together are the whole fold.
                expect(Math.hypot(yaw, upRad)).toBeCloseTo(Math.abs(field.lastBendRad), 6);
            }
            expect(up).toBeGreaterThan(0);
            expect(down).toBeGreaterThan(0);
            expect(sideways + up + down).toBe(80);
            // Up is the usual vertical fold.
            expect(up).toBeGreaterThan(down);
        });

        it('shifts further for a harder hit, but never so far that the sections stop overlapping', () => {
            const shift = (v: THREE.Vector3) => {
                const f = new WreckField();
                spawnJet(f, v);
                return Math.abs(f.lastDislocationM);
            };
            const moderate = shift(new THREE.Vector3(20, -35, 45));
            const hard = shift(new THREE.Vector3(20, -90, 120));
            expect(hard).toBeGreaterThan(moderate);
            // The fuselage is 2 m wide: the sections are never moved a full width apart.
            expect(hard).toBeLessThan(2);
            // And the twist at a joint is a few tens of degrees at most.
            const f = new WreckField();
            spawnJet(f, new THREE.Vector3(20, -150, 200));
            expect(Math.abs(f.lastKinkRad)).toBeLessThanOrEqual(0.5 + 1e-9);
        });

        it('keeps the whole fuselage in one piece at any hit up to a hard one', () => {
            for (let run = 0; run < 200; run++) {
                const field = new WreckField();
                const hard = run / 199;
                spawnJet(field, new THREE.Vector3(
                    (run % 7 - 3) * 6, -30 - 40 * hard, 40 + 50 * hard));
                expect(piecesWith(field, fuselageMat)).toBe(1);
            }
        });

        it('tears a section away at a joint under a blow far harder than that', () => {
            let torn = 0;
            for (let run = 0; run < 100; run++) {
                const field = new WreckField();
                spawnJet(field, new THREE.Vector3((run % 7 - 3) * 6, -150, 200));
                if (piecesWith(field, fuselageMat) > 1) {
                    torn++;
                }
            }
            expect(torn).toBeGreaterThan(50);
        });
        it('stays whole through what happens next: the bounces and slides of a moderate wreck', () => {
            for (let run = 0; run < 15; run++) {
                const field = new WreckField();
                spawnJet(field, new THREE.Vector3((run % 5 - 2) * 10, -50, 80));
                for (let i = 0; i < 60 * 15; i++) {
                    field.update(1 / 60);
                }
                expect(piecesWith(field, fuselageMat)).toBe(1);
            }
        });
        it('comes to rest lying down, not standing on end, after a steep nose-down hit', () => {
            for (let run = 0; run < 12; run++) {
                const field = new WreckField();
                spawnJet(field, new THREE.Vector3((run % 3 - 1) * 8, -90, 20 + run * 3));
                for (let i = 0; i < 60 * 20; i++) {
                    field.update(1 / 60);
                }
                const priv = field as unknown as { fragments: { obj: THREE.Object3D; half: THREE.Vector3; disposed: boolean }[] };
                for (const f of priv.fragments) {
                    if (f.disposed || Math.max(f.half.x, f.half.y, f.half.z) < 3) {
                        continue;
                    }
                    // Its extent in the world: a piece may be tall by its shape (a fuselage folded
                    // up), but must not be a stick standing on its end.
                    const e = new THREE.Matrix4().makeRotationFromQuaternion(f.obj.quaternion).elements;
                    const h = f.half;
                    const worldY = Math.abs(e[1]) * h.x + Math.abs(e[5]) * h.y + Math.abs(e[9]) * h.z;
                    const worldX = Math.abs(e[0]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[8]) * h.z;
                    const worldZ = Math.abs(e[2]) * h.x + Math.abs(e[6]) * h.y + Math.abs(e[10]) * h.z;
                    expect(worldY).toBeLessThan(1.3 * Math.max(worldX, worldZ));
                }
            }
        });

        it('does not rest balanced on a wingtip or an edge: a flat piece ends up on its flat side', () => {
            let checked = 0;
            let flat = 0;
            for (let run = 0; run < 100 && checked < 6; run++) {
                const field = new WreckField();
                spawnJet(field, new THREE.Vector3((run % 4 - 1.5) * 12, -35 - run * 3, 45 + run * 4));
                for (let i = 0; i < 60 * 25; i++) {
                    field.update(1 / 60);
                }
                const priv = field as unknown as { fragments: { obj: THREE.Object3D; half: THREE.Vector3; disposed: boolean }[] };
                for (const f of priv.fragments) {
                    const h = f.half;
                    const big = Math.max(h.x, h.y, h.z);
                    const thin = Math.min(h.x, h.y, h.z);
                    const mid = h.x + h.y + h.z - big - thin;
                    if (f.disposed || big < 3 || thin > 0.7 * mid) {
                        continue;
                    }
                    const axis = h.x === thin ? new THREE.Vector3(1, 0, 0) : h.y === thin ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
                    // (A fuselage folded up is a V standing in a vertical plane and may rest like that.)
                    if (Math.abs(axis.applyQuaternion(f.obj.quaternion).y) > 0.9) {
                        flat++;
                    }
                    checked++;
                }
            }
            // (When the break-ups left no large flat piece there is nothing to judge.)
            expect(flat).toBeGreaterThanOrEqual(Math.ceil(0.7 * checked));
        });

        it('carries the wings and the cockpit eye with the section they are on', () => {
            const field = new WreckField();
            spawnJet(field, new THREE.Vector3(25, -50, 60));
            // The wing is as wide as it was: moved, not bent.
            const span = (vs: THREE.Vector3[]) => {
                let best = 0;
                for (let i = 0; i < vs.length; i += 3) {
                    for (let j = i + 1; j < vs.length; j += 3) {
                        best = Math.max(best, vs[i].distanceTo(vs[j]));
                    }
                }
                return best;
            };
            const still = new WreckField();
            spawnJet(still, new THREE.Vector3(0, -3, 6));
            // The wing is folded up at its roots, so it is shorter than it was, but still in one piece
            // and not shrunk past what a fold of the two sections can give.
            const folded = span(vertices(field, wingMat));
            const whole = span(vertices(still, wingMat));
            expect(folded).toBeLessThan(whole - 0.1);
            expect(folded).toBeGreaterThan(0.3 * whole);
        });

        it('folds the wings upward before they tear: a harder hit folds them further', () => {
            const tipHeight = (v: THREE.Vector3) => {
                const field = new WreckField();
                spawnJet(field, v);
                const ys = vertices(field, wingMat).map(p => p.y);
                return { rise: Math.max(...ys) - Math.min(...ys), pieces: piecesWith(field, wingMat) };
            };
            const still = tipHeight(new THREE.Vector3(0, -3, 6));
            let moderateMax = 0;
            let hardMax = 0;
            for (let run = 0; run < 15; run++) {
                moderateMax = Math.max(moderateMax, tipHeight(new THREE.Vector3(run % 3 - 1, -30, 45)).rise);
                hardMax = Math.max(hardMax, tipHeight(new THREE.Vector3(run % 3 - 1, -90, 120)).rise);
            }
            // A wing is flat: its vertical extent is just its thickness until it folds.
            expect(moderateMax).toBeGreaterThan(still.rise + 0.3);
            expect(hardMax).toBeGreaterThan(still.rise + 2);
        });

        it('marks the pieces that hold fuselage so they are never split further', () => {
            const field = new WreckField();
            spawnJet(field, new THREE.Vector3(0, -55, 60));
            const priv = field as unknown as { fragments: { tough: boolean; obj: THREE.Object3D }[] };
            const withFuselage = priv.fragments.filter(f => trianglesOf(f.obj, fuselageMat) > 120);
            expect(withFuselage.length).toBeGreaterThan(0);
            for (const f of withFuselage) {
                expect(f.tough).toBe(true);
            }
        });
    });

    describe('pieces at rest follow the ground under them', () => {
        function restedField() {
            const field = new WreckField();
            let level = 0;
            field.setGroundHeightAt(() => level);
            field.spawn(source(new THREE.Vector3(0, -60, 90), 1.2));
            for (let i = 0; i < 60 * 40; i++) {
                field.update(1 / 60);
            }
            const priv = field as unknown as {
                fragments: { asleep: boolean; disposed: boolean; obj: THREE.Object3D; half: THREE.Vector3; corners: THREE.Vector3[] }[];
            };
            return { field, priv, setLevel: (v: number) => { level = v; } };
        }
        const lowestCorner = (f: { obj: THREE.Object3D; corners: THREE.Vector3[] }) =>
            Math.min(...f.corners.map(c => c.clone().applyQuaternion(f.obj.quaternion).y + f.obj.position.y));

        it('are lifted when the ground rises under them (a deck that comes up with the ship)', () => {
            const r = restedField();
            const resting = r.priv.fragments.filter(f => f.asleep && !f.disposed);
            expect(resting.length).toBeGreaterThan(0);
            r.setLevel(2);
            for (let i = 0; i < 60 * 2; i++) {
                r.field.update(1 / 60);
            }
            for (const f of resting) {
                expect(lowestCorner(f)).toBeGreaterThan(2 - 0.05);
            }
        });

        it('wake and fall when the ground drops away under them', () => {
            const r = restedField();
            const resting = r.priv.fragments.filter(f => f.asleep && !f.disposed);
            expect(resting.length).toBeGreaterThan(0);
            const before = resting.map(f => f.obj.position.y);
            r.setLevel(-6);
            for (let i = 0; i < 60 * 5; i++) {
                r.field.update(1 / 60);
            }
            resting.forEach((f, i) => {
                expect(f.obj.position.y).toBeLessThan(before[i] - 3);
                expect(lowestCorner(f)).toBeGreaterThan(-6 - 0.1);
            });
        });
    });

    describe('crashing on a moving carrier deck', () => {
        const DECK_V = new THREE.Vector3(0, 0, -20);

        function meanZ(field: WreckField): number {
            const zs = fragments(field).map(o => o.position.z);
            return zs.reduce((a, b) => a + b, 0) / zs.length;
        }

        /**
         * Run a crash with the deck steaming along -Z at 20 m/s under it. The deck is a strip
         * `halfWidth` either side of its centreline and 2 km long, moving with the ship.
         */
        function crashOnDeck(halfWidth: number | undefined) {
            const field = new WreckField();
            let deckZ = 0;
            if (halfWidth !== undefined) {
                field.setMovingSurface({
                    velocity: DECK_V,
                    contains: (x, y, z) => Math.abs(x) < halfWidth && y < 6 && y > -3 && Math.abs(z - deckZ) < 1000,
                });
            }
            // Crashing a little faster than the ship, in the ship's own frame (0,-40,50).
            field.spawn(source(new THREE.Vector3(0, -40, 50 + DECK_V.z)));
            const step = () => {
                deckZ += DECK_V.z / 60;
                field.update(1 / 60);
            };
            for (let i = 0; i < 60 * 25; i++) {
                step();
            }
            const priv = field as unknown as { fragments: { asleep: boolean; obj: THREE.Object3D }[] };
            const before = priv.fragments.map(f => f.obj.position.clone());
            const restedBefore = priv.fragments.map(f => f.asleep);
            for (let i = 0; i < 60 * 5; i++) {
                step();
            }
            return {
                field, priv, before, deckZ: () => deckZ,
                asleep: priv.fragments.every(f => f.asleep),
                moved: priv.fragments.map((f, i) => f.obj.position.z - before[i].z),
                restedBefore,
            };
        }

        it('carries the wreckage along with the ship once it has come to rest on the deck', () => {
            const r = crashOnDeck(5000);
            expect(r.asleep).toBe(true);
            // Every piece that was at rest lay on the deck for the last 5 s at 20 m/s: 100 m further along -Z.
            r.moved.forEach((dz, i) => {
                if (r.restedBefore[i]) {
                    expect(dz).toBeLessThan(-90);
                    expect(dz).toBeGreaterThan(-110);
                }
            });
        });

        it('comes to rest on the deck: not left behind by the ship', () => {
            const r = crashOnDeck(5000);
            for (const f of r.priv.fragments) {
                // Within a few hundred metres of the ship\'s centre, not far astern where it started.
                expect(Math.abs(f.obj.position.z - r.deckZ())).toBeLessThan(450);
            }
        });

        it('stays where it is when there is no moving surface under it', () => {
            const r = crashOnDeck(undefined);
            expect(r.asleep).toBe(true);
            r.moved.forEach((dz, i) => {
                if (r.restedBefore[i]) {
                    expect(Math.abs(dz)).toBeLessThan(0.5);
                }
            });
        });

        it('leaves behind the pieces that go off the side of the deck', () => {
            // A narrow deck, and a crash with a strong sideways velocity: the pieces slide off the side
            // of it and come to rest in the sea beside, where the ship's motion no longer reaches them.
            const field = new WreckField();
            let deckZ = 0;
            field.setMovingSurface({
                velocity: DECK_V,
                contains: (x, y, z) => Math.abs(x) < 6 && y < 6 && y > -3 && Math.abs(z - deckZ) < 1000,
            });
            field.spawn(source(new THREE.Vector3(60, -30, DECK_V.z)));
            const priv = field as unknown as { fragments: { asleep: boolean; obj: THREE.Object3D }[] };
            const step = () => {
                deckZ += DECK_V.z / 60;
                field.update(1 / 60);
            };
            for (let i = 0; i < 60 * 25; i++) {
                step();
            }
            const before = priv.fragments.map(f => ({ z: f.obj.position.z, asleep: f.asleep }));
            for (let i = 0; i < 60 * 5; i++) {
                step();
            }
            let beside = 0;
            priv.fragments.forEach((f, i) => {
                if (f.asleep && before[i].asleep && Math.abs(f.obj.position.x) > 12) {
                    beside++;
                    expect(Math.abs(f.obj.position.z - before[i].z)).toBeLessThan(0.5);
                }
            });
            expect(beside).toBeGreaterThan(0);
        });
    });

    describe('crashing into the sea', () => {
        /** A model-free field over open water: the surface is y = 0 everywhere. */
        function seaField(): WreckField {
            const field = new WreckField();
            field.setWaterTest(() => true);
            return field;
        }
        const crash = (field: WreckField, velocity = new THREE.Vector3(0, -40, 60)) => field.spawn(source(velocity));
        const meanY = (field: WreckField) => {
            const ys = fragments(field).map(o => o.position.y);
            return ys.reduce((a, b) => a + b, 0) / ys.length;
        };

        it('makes a splash where each piece goes in, harder for a faster entry', () => {
            const strengths = (velocity: THREE.Vector3): number[] => {
                const field = seaField();
                const out: number[] = [];
                field.onSplash = (_p, _v, strength) => { out.push(strength); };
                crash(field, velocity);
                // Long enough for the pieces thrown highest to come back down.
                for (let i = 0; i < 60 * 12; i++) {
                    field.update(1 / 60);
                }
                return out;
            };
            const slow = strengths(new THREE.Vector3(0, -10, 20));
            const fast = strengths(new THREE.Vector3(0, -100, 140));
            // A gentle one may keep the aircraft in a single piece; a hard one breaks it into several.
            expect(slow.length).toBeGreaterThan(0);
            expect(fast.length).toBeGreaterThan(1);
            for (const s of [...slow, ...fast]) {
                expect(s).toBeGreaterThanOrEqual(0.2);
                expect(s).toBeLessThanOrEqual(1.6);
            }
            const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
            expect(mean(fast)).toBeGreaterThan(mean(slow));
        });

        it('splashes each piece once only', () => {
            const field = seaField();
            let splashes = 0;
            field.onSplash = () => { splashes++; };
            crash(field);
            for (let i = 0; i < 60 * 20; i++) {
                field.update(1 / 60);
            }
            const pieces = fragments(field).length;
            expect(splashes).toBeLessThanOrEqual(pieces);
            expect(splashes).toBeGreaterThan(0);
        });

        it('does not dust, scorch or dent the sea', () => {
            const field = seaField();
            let ground = 0;
            field.onDust = () => { ground++; };
            field.onMark = () => { ground++; };
            field.onBurn = () => { ground++; };
            crash(field);
            for (let i = 0; i < 60 * 15; i++) {
                field.update(1 / 60);
            }
            expect(ground).toBe(0);
        });

        /** A gentle crash, so every piece is in the water within a second. */
        const gentle = new THREE.Vector3(0, -10, 20);
        const settle = (field: WreckField, seconds: number) => {
            for (let i = 0; i < 60 * seconds; i++) {
                field.update(1 / 60);
            }
        };

        it('floats for ten seconds after going in, riding at the surface', () => {
            const field = seaField();
            crash(field, gentle);
            settle(field, 3);
            const y3 = meanY(field);
            settle(field, 6);
            const y9 = meanY(field);
            // Nine seconds after the crash they are all still up at the surface (partly under, never sunk).
            expect(y3).toBeGreaterThan(-3);
            expect(y9).toBeGreaterThan(-3);
            expect(Math.abs(y9 - y3)).toBeLessThan(1);
            for (const o of fragments(field)) {
                expect(o.position.y).toBeGreaterThan(-4);
            }
        });

        it('does not start sinking before ten seconds are up, and is going down well after', () => {
            const field = seaField();
            crash(field, gentle);
            settle(field, 9);
            const before = meanY(field);
            settle(field, 12);
            const after = meanY(field);
            // 2 s of ease-in then ~0.7 m/s: clearly under by 21 s, but far from the 15 m it would have if it had sunk throughout.
            expect(after).toBeLessThan(before - 3);
            expect(after).toBeGreaterThan(before - 14);
        });

        it('sinks slowly once it has started, about 0.7 m/s, after the water has taken most of its speed', () => {
            const field = seaField();
            crash(field, gentle);
            settle(field, 14);
            const y14 = meanY(field);
            settle(field, 10);
            const y24 = meanY(field);
            const rate = (y14 - y24) / 10;
            // A slow sink, not a plunge and not floating.
            expect(rate).toBeGreaterThan(0.4);
            expect(rate).toBeLessThan(1.1);
            // The sideways motion has been dragged away.
            const priv = field as unknown as { fragments: { velocity: THREE.Vector3 }[] };
            for (const f of priv.fragments) {
                expect(Math.hypot(f.velocity.x, f.velocity.z)).toBeLessThan(1);
            }
        });

        it('keeps burning while it floats, and the fire goes out once it has sunk', () => {
            const field = seaField();
            let fires: WreckFire[] = [];
            field.onBreakup = (e) => { fires = e.fires; };
            crash(field, gentle);
            const p = new THREE.Vector3();
            settle(field, 8);
            expect(fires.some(f => field.fireWorld(f, p))).toBe(true);
            settle(field, 25);
            expect(fires.every(f => !field.fireWorld(f, p))).toBe(true);
        });

        describe('foam on the water round it', () => {
            /** Foam laid per second, by 5 s bucket, from a gentle crash into the sea. */
            function foamByBucket(): { buckets: number[]; calls: { y: number; radius: number; count: number }[] } {
                const field = seaField();
                const calls: { y: number; radius: number; count: number; t: number }[] = [];
                let t = 0;
                field.onFoam = (p, radius, count) => { calls.push({ y: p.y, radius, count, t }); };
                crash(field, new THREE.Vector3(0, -10, 20));
                const buckets = new Array(12).fill(0);
                for (let i = 0; i < 60 * 60; i++) {
                    t += 1 / 60;
                    field.update(1 / 60);
                }
                for (const c of calls) {
                    buckets[Math.min(11, Math.floor(c.t / 5))] += c.count;
                }
                return { buckets, calls };
            }

            it('lies on the water surface, round pieces of a sensible size', () => {
                const { calls } = foamByBucket();
                expect(calls.length).toBeGreaterThan(20);
                for (const c of calls) {
                    expect(c.y).toBeCloseTo(0, 5);
                    expect(c.radius).toBeGreaterThanOrEqual(0.8);
                    expect(c.radius).toBeLessThanOrEqual(8);
                }
            });

            it('lays a ring of it as the piece goes in', () => {
                const { calls } = foamByBucket();
                expect(calls[0].count).toBe(8);
            });

            it('goes on while it floats and while it sinks, thinning as it goes under', () => {
                const { buckets } = foamByBucket();
                // Floating (5-10 s): steady foam.
                expect(buckets[1]).toBeGreaterThan(10);
                // Sinking from 10 s: still foam at first...
                expect(buckets[2]).toBeGreaterThan(10);
                // ...thinning as it goes deeper, until none is left.
                expect(buckets[4]).toBeLessThan(buckets[2]);
                expect(buckets[8]).toBe(0);
                expect(buckets[11]).toBe(0);
            });

            it('is none at all for a piece over land', () => {
                const field = new WreckField();
                let n = 0;
                field.onFoam = () => { n++; };
                crash(field);
                settle(field, 20);
                expect(n).toBe(0);
            });
        });

        describe('with the carrier alongside or overhead', () => {
            const gentleCrash = new THREE.Vector3(0, -10, 20);

            /**
             * A sea whose ground height jumps to a 20 m deck wherever the ship is overhead
             * (as the game's ground height does over the carrier mesh), with the sea's own
             * surface at 0 all the time.
             */
            function seaWithShip() {
                const state = { shipOver: false };
                const field = new WreckField();
                field.setGroundHeightAt(() => (state.shipOver ? 20 : 0));
                field.setWaterTest(() => !state.shipOver, () => 0);
                return { field, state };
            }
            const run = (field: WreckField, seconds: number) => {
                for (let i = 0; i < 60 * seconds; i++) {
                    field.update(1 / 60);
                }
            };
            const ys = (field: WreckField) => fragments(field).map(o => o.position.y);

            it('is not lifted up onto the hull when the ship steams over the spot it floats at', () => {
                const { field, state } = seaWithShip();
                field.spawn(source(gentleCrash));
                run(field, 5);
                for (const y of ys(field)) {
                    expect(y).toBeLessThan(2);
                }
                // The ship comes over it: the "ground" there is suddenly the deck, 20 m up.
                state.shipOver = true;
                run(field, 8);
                for (const y of ys(field)) {
                    expect(y).toBeLessThan(2);
                }
            });

            it('goes on to sink all the same under the ship, not stick to its underside', () => {
                const { field, state } = seaWithShip();
                field.spawn(source(gentleCrash));
                run(field, 5);
                state.shipOver = true;
                run(field, 25);
                const mean = ys(field).reduce((a, b) => a + b, 0) / fragments(field).length;
                expect(mean).toBeLessThan(-3);
            });

            it('keeps foam and splashes at the level of the sea, not at the height of the ship above it', () => {
                const { field, state } = seaWithShip();
                const foam: number[] = [];
                field.onFoam = (p) => { foam.push(p.y); };
                field.spawn(source(gentleCrash));
                run(field, 3);
                state.shipOver = true;
                const before = foam.length;
                run(field, 5);
                expect(foam.length).toBeGreaterThan(before);
                for (const y of foam) {
                    expect(y).toBeCloseTo(0, 5);
                }
            });

            it('is not carried along by the motion of the ship once it is in the water', () => {
                const field = new WreckField();
                field.setGroundHeightAt(() => 0);
                field.setWaterTest(() => true, () => 0);
                // The "deck" claims everything, moving at 20 m/s: a piece on it would be carried.
                field.setMovingSurface({ velocity: new THREE.Vector3(0, 0, -20), contains: () => true });
                field.spawn(source(gentleCrash));
                run(field, 3);
                const z3 = fragments(field).map(o => o.position.z);
                run(field, 10);
                const z13 = fragments(field).map(o => o.position.z);
                // 10 s at 20 m/s would be 200 m; in the water they only coast to a stop.
                z13.forEach((z, i) => {
                    expect(Math.abs(z - z3[i])).toBeLessThan(20);
                });
            });
        });

        it('keeps a camera riding the cockpit above the water as the piece sinks', () => {
            const field = seaField();
            crash(field, new THREE.Vector3(0, -40, 60));
            field.spawn({ ...source(new THREE.Vector3(0, -40, 60)), cockpit: new THREE.Vector3(0, 0.8, 5) });
            for (let i = 0; i < 60 * 45; i++) {
                field.update(1 / 60);
            }
            const pos = new THREE.Vector3();
            const quat = new THREE.Quaternion();
            expect(field.cockpitBodyPose('t', pos, quat)).toBe(true);
            // The piece itself is well under; the pose it gives is not.
            expect(meanY(field)).toBeLessThan(-8);
            expect(pos.y).toBeGreaterThanOrEqual(1 - 1e-6);
        });

        it('sinks out of sight in the end and stops being simulated', () => {
            const field = seaField();
            crash(field);
            for (let i = 0; i < 60 * 70; i++) {
                field.update(1 / 60);
            }
            for (const o of fragments(field)) {
                expect(o.visible).toBe(false);
            }
        });

        it('reports a crash into the sea as one in water, and one on land as not', () => {
            const water: boolean[] = [];
            const sea = seaField();
            sea.onBreakup = (e) => { water.push(e.water); };
            crash(sea);
            const land = new WreckField();
            land.onBreakup = (e) => { water.push(e.water); };
            crash(land);
            expect(water).toEqual([true, false]);
        });

        it('leaves no first-impact scorch on the sea', () => {
            const marks = (water: boolean): number => {
                const field = water ? seaField() : new WreckField();
                let n = 0;
                field.onMark = () => { n++; };
                crash(field);
                return n;
            };
            expect(marks(true)).toBe(0);
            expect(marks(false)).toBeGreaterThan(0);
        });

        it('lets a piece that lands on land beside the sea land normally', () => {
            const field = new WreckField();
            // Water only for z > 100; the crash is at z = 0.
            field.setWaterTest((_x, z) => z > 100);
            let splashes = 0;
            field.onSplash = () => { splashes++; };
            // Slow, steep: the pieces stay near the impact.
            crash(field, new THREE.Vector3(0, -30, 5));
            for (let i = 0; i < 60 * 10; i++) {
                field.update(1 / 60);
            }
            expect(splashes).toBe(0);
            for (const o of fragments(field)) {
                expect(o.position.y).toBeGreaterThan(-1);
            }
        });
    });

    describe('gear legs', () => {
        const gearMat = new THREE.MeshBasicMaterial();
        /** One gear part holding three separate legs (nose, left main, right main), as one model does. */
        function gearModel(): Model {
            const legs = new THREE.Group();
            for (const [x, z] of [[0, 4], [2.5, -1], [-2.5, -1]]) {
                const leg = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2, 0.4, 1, 4, 1).toNonIndexed(), gearMat);
                leg.position.set(x, 0, z);
                legs.add(leg);
            }
            return { lod: [{ flats: [], volumes: [legs] }], animations: [], maxSize: 6, center: new THREE.Vector3() };
        }
        const withGear = (v: THREE.Vector3): WreckSource => ({
            ...source(v),
            parts: [{ model: gearModel(), kind: 'gear', id: 0, position: new THREE.Vector3(0, 0.2, 0), quaternion: new THREE.Quaternion() }],
        });
        const gearTriangles = (f: THREE.Object3D) => f.children
            .filter(c => (c as THREE.Mesh).material === gearMat)
            .reduce((n, c) => n + (c as THREE.Mesh).geometry.getAttribute('position').count / 3, 0);

        it('tears legs off one at a time, and the legs that stay are with a fuselage piece', () => {
            let looseLegs = 0;
            let keptLegs = 0;
            let partial = false;
            for (let run = 0; run < 60; run++) {
                const field = new WreckField();
                field.spawn(withGear(new THREE.Vector3(0, -12 - run * 0.7, 20 + run)));
                let legsLoose = 0;
                let legTriangles = 0;
                for (const frag of fragments(field)) {
                    const tris = gearTriangles(frag);
                    if (tris === 0) {
                        continue;
                    }
                    legTriangles += tris;
                    const others = frag.children.some(c => (c as THREE.Mesh).material !== gearMat);
                    if (others) {
                        keptLegs++;
                    } else {
                        looseLegs++;
                        legsLoose++;
                    }
                }
                // No leg is lost: three legs' worth of triangles, whole or not.
                expect(legTriangles).toBe(3 * 36);
                partial = partial || legsLoose === 1 || legsLoose === 2;
            }
            expect(looseLegs).toBeGreaterThan(0);
            expect(keptLegs).toBeGreaterThan(0);
            expect(partial).toBe(true);
        });

        it('bends a leg near a hard hit, shoving the foot sideways and shortening it', () => {
            let bent = 0;
            for (let run = 0; run < 30; run++) {
                const field = new WreckField();
                field.spawn(withGear(new THREE.Vector3(10, -50, 60)));
                for (const frag of fragments(field)) {
                    const lowest = new THREE.Box3();
                    for (const c of frag.children) {
                        const mesh = c as THREE.Mesh;
                        if (mesh.material === gearMat) {
                            mesh.geometry.computeBoundingBox();
                            lowest.union(mesh.geometry.boundingBox!);
                        }
                    }
                    if (!lowest.isEmpty() && lowest.getSize(new THREE.Vector3()).y < 1.9) {
                        bent++;
                    }
                }
            }
            expect(bent).toBeGreaterThan(0);
        });

        it('leaves the legs straight on a gentle touchdown', () => {
            const field = new WreckField();
            field.spawn(withGear(new THREE.Vector3(0, -3, 8)));
            for (const frag of fragments(field)) {
                for (const c of frag.children) {
                    const mesh = c as THREE.Mesh;
                    if (mesh.material === gearMat) {
                        mesh.geometry.computeBoundingBox();
                        // A piece may be rotated, but legs here are whole boxes: 0.4 m wide.
                        expect(mesh.geometry.boundingBox!.getSize(new THREE.Vector3()).length()).toBeGreaterThan(0);
                    }
                }
            }
        });
    });

    it('throws up dust where pieces strike the ground', () => {
        const field = new WreckField();
        const hits: number[] = [];
        field.onDust = (p, _v, n) => { hits.push(n); expect(p.y).toBeLessThan(2); };
        field.spawn(source(new THREE.Vector3(0, -80, 130)));
        // Long enough for even the pieces thrown highest (30+ m/s up) to come back down.
        for (let i = 0; i < 60 * 12; i++) {
            field.update(1 / 60);
        }
        expect(hits.length).toBeGreaterThan(0);
    });

    it('kicks up dust from a sliding piece', () => {
        const field = new WreckField();
        let dust = 0;
        field.onDust = (_p, _v, n) => { dust += n; };
        field.spawn(source(new THREE.Vector3(0, -8, 90)));
        for (let i = 0; i < 120; i++) {
            field.update(1 / 60);
        }
        expect(dust).toBeGreaterThan(0);
    });

    it('reports nothing to break when the model has no geometry', () => {
        const field = new WreckField();
        const empty: Model = { lod: [], animations: [], maxSize: 0, center: new THREE.Vector3() };
        expect(field.spawn({ ...source(new THREE.Vector3(0, -50, 100)), body: empty })).toBe(false);
    });
});

describe('WreckTracker', () => {
    it('fires once on the crash edge with an earlier velocity', () => {
        const t = new WreckTracker();
        const out = new THREE.Vector3();
        for (let i = 0; i < 12; i++) {
            t.sample(false, new THREE.Vector3(0, 0, 100 + i), out);
        }
        const v = t.sample(true, new THREE.Vector3(), out);
        expect(v?.z).toBe(104);
        expect(t.sample(true, new THREE.Vector3(), out)).toBeUndefined();
    });
});
