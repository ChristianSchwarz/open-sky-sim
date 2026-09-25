/**
 * Re-exports the canonical tree sprite generator.
 *
 * The generator lives under src/script (`scene/vegetation/treeSprites.ts`)
 * rather than here, because the runtime also needs it — to rasterise the same
 * silhouettes into the atlas texture it binds (see `treeAtlas.ts`) — and
 * src/'s tsconfig `rootDir` forbids the reverse import. Bake tools already
 * import from src/ elsewhere (e.g. tools/bake_planet_mesh.ts); this just
 * follows that direction.
 */
export * from '../../src/script/scene/vegetation/treeSprites';
