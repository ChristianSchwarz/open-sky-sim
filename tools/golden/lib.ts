/**
 * Shared plumbing for the golden-fixture generator (see tools/golden/README.md).
 *
 * Fixtures are the contract between this TypeScript implementation (the
 * "oracle") and the C#/Unity port: the generator writes inputs together with
 * the oracle's outputs, and the port's tests replay the inputs and compare.
 * Everything here exists to make that file format boring and reproducible.
 */
import { createHash } from 'node:crypto';

/** A suite is one JSON file under tests/golden/. */
export interface SuiteFile {
    /** File name relative to the golden root, e.g. `geodesy.json`. */
    file: string;
    data: unknown;
}

/** A raw file the fixtures depend on (copied verbatim next to the JSON). */
export interface Asset {
    /** Path relative to the golden root, e.g. `tiles/ptm/12_3682_1416.ptm`. */
    file: string;
    bytes: Uint8Array;
}

export interface SuiteOutput {
    files: SuiteFile[];
    assets?: Asset[];
}

/**
 * Deterministic PRNG (mulberry32). Fixture inputs must never come from
 * Math.random, or the generator would not be reproducible and `--check` would
 * flag noise as drift.
 */
export class Rng {
    private s: number;

    constructor(seed: number) {
        this.s = seed >>> 0;
    }

    /** Uniform in [0, 1). */
    next(): number {
        this.s = (this.s + 0x6D2B79F5) >>> 0;
        let t = this.s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    range(lo: number, hi: number): number {
        return lo + (hi - lo) * this.next();
    }

    int(lo: number, hiInclusive: number): number {
        return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
    }

    pick<T>(items: readonly T[]): T {
        return items[this.int(0, items.length - 1)];
    }
}

/** FNV-1a, 32 bit, over raw bytes. Cheap enough to reimplement in any language. */
export function fnv1a32(bytes: Uint8Array): number {
    let h = 0x811C9DC5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

export function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Hex string of a 32 bit value, fixed width, so it is easy to diff. */
export function hex32(n: number): string {
    return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * Encode doubles JSON cannot hold. The C# side reads these strings back:
 * "NaN", "Infinity", "-Infinity". Negative zero is written as 0, which is
 * what JSON.stringify does anyway; no fixture depends on the sign of zero.
 */
function replacer(_key: string, value: unknown): unknown {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
    }
    return value;
}

function isPrimitive(v: unknown): boolean {
    return v === null || typeof v !== 'object';
}

/**
 * Stable, diff-friendly JSON: object keys keep insertion order (suites build
 * them in a fixed order), arrays of primitives stay on one line.
 */
export function stringify(value: unknown): string {
    const lines: string[] = [];
    const write = (v: unknown, indent: string, key: string | undefined): string => {
        const prefix = key === undefined ? '' : `${JSON.stringify(key)}: `;
        const raw = replacer('', v);
        if (isPrimitive(raw)) {
            return `${prefix}${JSON.stringify(raw)}`;
        }
        if (Array.isArray(raw)) {
            if (raw.every(item => isPrimitive(replacer('', item)))) {
                return `${prefix}[${raw.map(item => JSON.stringify(replacer('', item))).join(', ')}]`;
            }
            const inner = raw.map(item => `${indent}  ${write(item, `${indent}  `, undefined)}`);
            return `${prefix}[\n${inner.join(',\n')}\n${indent}]`;
        }
        const entries = Object.entries(raw as Record<string, unknown>).filter(([, x]) => x !== undefined);
        if (entries.length === 0) {
            return `${prefix}{}`;
        }
        const inner = entries.map(([k, x]) => `${indent}  ${write(x, `${indent}  `, k)}`);
        return `${prefix}{\n${inner.join(',\n')}\n${indent}}`;
    };
    lines.push(write(value, '', undefined));
    return `${lines.join('\n')}\n`;
}

/** The value as a plain number array (typed arrays and Vector3 alike). */
export function arr(a: ArrayLike<number>): number[] {
    return Array.from(a);
}

/**
 * Describe a decoded structure without dumping it: scalars verbatim, typed
 * arrays as `{type, length, fnv1a32, head}`, nested objects recursively. The
 * hash is over the array's raw little-endian bytes, which the C# decoder can
 * reproduce from its own NativeArray without caring about element types.
 */
export function describe(value: unknown, headCount = 6, depth = 0): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        const view = value as unknown as { length: number; constructor: { name: string }; byteOffset: number; byteLength: number; buffer: ArrayBufferLike };
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const headSrc = value as unknown as ArrayLike<number>;
        const head: number[] = [];
        for (let i = 0; i < Math.min(headCount, view.length); i++) {
            head.push(headSrc[i]);
        }
        return { type: view.constructor.name, length: view.length, fnv1a32: hex32(fnv1a32(bytes)), head };
    }
    if (value instanceof ArrayBuffer) {
        return { type: 'ArrayBuffer', length: value.byteLength, fnv1a32: hex32(fnv1a32(new Uint8Array(value))) };
    }
    if (Array.isArray(value)) {
        if (value.length > 64 && typeof value[0] === 'object') {
            return { type: 'Array', length: value.length, first: describe(value[0], headCount, depth + 1) };
        }
        return value.map(v => describe(v, headCount, depth + 1));
    }
    if (typeof value === 'object') {
        if (depth > 4) {
            return '[depth]';
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (typeof v === 'function') {
                continue;
            }
            out[k] = describe(v, headCount, depth + 1);
        }
        return out;
    }
    return String(value);
}

export const DEG = Math.PI / 180;
