/**
 * Writes the procedurally generated species tree billboard sprites to disk.
 *
 * Unlike the per-area bake stages under tools/bake_planet_*.ts, this has no
 * geographic input: it is a pure function of the species table in
 * tools/bake/treeSprites.ts, so it only needs to be re-run when that table
 * changes (new species, new silhouette, new colours), not per imported area.
 *
 * Usage:
 *   node --import tsx tools/bake_tree_sprites.ts [--out DIR]
 *
 *     --out DIR   where to write <species>-<view>.svg   (default assets/trees)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SPECIES_SPECS, Species, TREE_VIEWS, generateTreeSprite, speciesSpriteFileName } from './bake/treeSprites';

function parseArgs(argv: string[]): { out: string } {
    let out = 'assets/trees';
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') {
            out = argv[++i];
        }
    }
    return { out };
}

function main() {
    const { out } = parseArgs(process.argv.slice(2));
    fs.mkdirSync(out, { recursive: true });

    let count = 0;
    for (const species of Object.keys(SPECIES_SPECS).map(Number) as Species[]) {
        for (const view of TREE_VIEWS) {
            const svg = generateTreeSprite(species, view);
            const filePath = path.join(out, speciesSpriteFileName(species, view));
            fs.writeFileSync(filePath, svg, 'utf8');
            count++;
        }
    }
    console.log(`Wrote ${count} tree sprites (${Object.keys(SPECIES_SPECS).length} species x ${TREE_VIEWS.length} views) to ${out}`);
}

main();
