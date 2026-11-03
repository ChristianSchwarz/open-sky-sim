import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** Spawn options that make a child its own process group on POSIX (see killTree.mjs). */
export declare const SPAWN_GROUP: Pick<SpawnOptions, 'detached'>;
/** Kill a child and every process under it, synchronously. */
export declare function killTree(child: ChildProcess | number | undefined): void;
/** Kill every child tree of this process, synchronously. */
export declare function killChildTrees(): void;
