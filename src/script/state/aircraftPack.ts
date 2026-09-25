import { unzipSync } from 'fflate';
import * as THREE from 'three';

const PACK_PREFIX = 'pack:';

export function isPackUrl(url: string): boolean {
    return url.startsWith(PACK_PREFIX);
}

export function parsePackUrl(url: string): { packId: string; path: string } {
    const rest = url.slice(PACK_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
        throw new Error(`Invalid pack URL: ${url}`);
    }
    return { packId: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

export function toPackUrl(packId: string, path: string): string {
    return `${PACK_PREFIX}${packId}/${path}`;
}

function mimeForPath(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    if (ext === 'gltf') {
        return 'model/gltf+json';
    }
    if (ext === 'glb') {
        return 'model/gltf-binary';
    }
    return 'application/octet-stream';
}

class AircraftPack {
    readonly id: string;
    private readonly files = new Map<string, ArrayBuffer>();
    private readonly blobUrls = new Map<string, string>();

    constructor(id: string, files: Map<string, ArrayBuffer>) {
        this.id = id;
        this.files = files;
    }

    has(path: string): boolean {
        return this.files.has(path);
    }

    getText(path: string): string {
        const data = this.files.get(path);
        if (!data) {
            throw new Error(`Missing pack file "${path}" in ${this.id}`);
        }
        return new TextDecoder().decode(data);
    }

    getBlobUrl(path: string): string {
        let url = this.blobUrls.get(path);
        if (url) {
            return url;
        }
        const data = this.files.get(path);
        if (!data) {
            throw new Error(`Missing pack file "${path}" in ${this.id}`);
        }
        url = URL.createObjectURL(new Blob([data], { type: mimeForPath(path) }));
        this.blobUrls.set(path, url);
        return url;
    }

    createLoadingManager(): THREE.LoadingManager {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
            const name = url.split('/').pop() ?? url;
            if (this.files.has(name)) {
                return this.getBlobUrl(name);
            }
            if (this.files.has(url)) {
                return this.getBlobUrl(url);
            }
            return url;
        });
        return manager;
    }
}

class AircraftPackStore {
    private packs = new Map<string, AircraftPack>();

    get(packId: string): AircraftPack | undefined {
        return this.packs.get(packId);
    }

    register(pack: AircraftPack): void {
        this.packs.set(pack.id, pack);
    }

    async loadFromUrl(id: string, url: string): Promise<AircraftPack> {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const buf = await res.arrayBuffer();
        const files = unzipPack(buf);
        const pack = new AircraftPack(id, files);
        this.register(pack);
        return pack;
    }
}

function unzipPack(data: ArrayBuffer): Map<string, ArrayBuffer> {
    const files = new Map<string, ArrayBuffer>();
    const unzipped = unzipSync(new Uint8Array(data));
    for (const [name, content] of Object.entries(unzipped)) {
        files.set(name, content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
    }
    return files;
}

export const aircraftPackStore = new AircraftPackStore();
