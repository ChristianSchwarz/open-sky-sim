/**
 * The handful of `expect(...).toX` matchers the wreck, fire and marks tests use,
 * so they run under the project's own test runner (`node --test`) with a
 * readable failure message. Self-contained (it throws plain errors, which
 * node:test reports as failures), so it type-checks like any other source file.
 */

function fail(message: string): never {
    throw new Error(message);
}

function show(v: unknown): string {
    try {
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
    } catch {
        return String(v);
    }
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
        return true;
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) {
        return false;
    }
    return ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function expect(actual: unknown) {
    const num = (): number => {
        if (typeof actual !== 'number') {
            fail(`expected a number but got ${show(actual)}`);
        }
        return actual as number;
    };
    return {
        /** Object.is equality, as in jest/vitest. */
        toBe(expected: unknown): void {
            if (!Object.is(actual, expected)) {
                fail(`expected ${show(actual)} to be ${show(expected)}`);
            }
        },
        toEqual(expected: unknown): void {
            if (!deepEqual(actual, expected)) {
                fail(`expected ${show(actual)} to equal ${show(expected)}`);
            }
        },
        toBeGreaterThan(n: number): void {
            if (!(num() > n)) {
                fail(`expected ${num()} to be greater than ${n}`);
            }
        },
        toBeGreaterThanOrEqual(n: number): void {
            if (!(num() >= n)) {
                fail(`expected ${num()} to be greater than or equal to ${n}`);
            }
        },
        toBeLessThan(n: number): void {
            if (!(num() < n)) {
                fail(`expected ${num()} to be less than ${n}`);
            }
        },
        toBeLessThanOrEqual(n: number): void {
            if (!(num() <= n)) {
                fail(`expected ${num()} to be less than or equal to ${n}`);
            }
        },
        /** Within half of 10^-digits, as in jest/vitest (default 2 digits). */
        toBeCloseTo(n: number, digits = 2): void {
            const limit = 10 ** -digits / 2;
            if (!(Math.abs(num() - n) < limit)) {
                fail(`expected ${num()} to be close to ${n} (within ${limit})`);
            }
        },
        toBeDefined(): void {
            if (actual === undefined) {
                fail('expected a value, got undefined');
            }
        },
        toBeUndefined(): void {
            if (actual !== undefined) {
                fail(`expected undefined but got ${show(actual)}`);
            }
        },
    };
}
