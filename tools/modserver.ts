// Local dev server for retroflightsim.
//
// Serves the built `dist/` folder statically and adds the F10 upload endpoint:
//   POST /api/preview-mod  (scan a mod .zip and list aircraft + liveries)
//   POST /api/import-mod   (import selected aircraft from a preview token)
// and the F9 terrain area import (tools/areaImport.ts):
//   GET  /api/osm/:z/:x/:y   OpenStreetMap tiles for the area picker
//   GET  /api/areas          areas the baked pyramid holds
//   POST /api/import-area    start a bake; GET the same path + /:id for progress
//   POST /api/delete-area    remove a baked area (same progress stream)
//
// Multi-plane mod packs are split by Unity livery material: each aircraft becomes
// its own .aircraft.pack so liveries stay separate in the spawn menu.

import express, { Request, Response } from 'express';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { unzipSync } from 'fflate';
import {
    areasHandler, importStream, osmTile, startDelete, startImport,
} from './areaImport';

const PROJECT_ROOT = path.dirname(__dirname);
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets');
const IMPORTS_DIR = path.join(PROJECT_ROOT, 'tools', 'mods', 'imports');
const IMPORTS_PREFIX = 'tools/mods/imports';
const UPLOADS_DIR = path.join(PROJECT_ROOT, 'tools', 'mods', 'uploads');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const PORT = Number(process.env.PORT) || 8020;

interface ImportConfig {
    name?: string;
    bundle: string;
    out: string;
    includeMaterials?: string[];
    includeRoots?: Array<string | number>;
    companionMaterials?: string[];
    dedupeParts?: boolean;
    rescueGlassUnderRoot?: boolean;
    rescueGlassGlobal?: boolean;
    rescueCockpit?: boolean;
    rescueNozzleUnderRoot?: boolean;
    rescueNozzleGlobal?: boolean;
    rescueMaterialsUnderRoot?: boolean;
    skipClutter?: boolean;
    bitmapLivery?: boolean;
    grayscale?: boolean | { lo: number; hi: number };
    flyable?: Record<string, unknown>;
    [key: string]: unknown;
}

interface DiscoveredPlane {
    material: string;
    name: string;
    partCount?: number;
    bodyParts?: number;
    /** Unity path ID — string to preserve values beyond JS MAX_SAFE_INTEGER. */
    transformRoot?: string | number;
    includeRoots?: Array<string | number>;
    companionMaterials?: string[];
}

interface CatalogAircraft {
    canonicalName: string;
    displayName: string;
    category?: string;
    description?: string;
    modelPath?: string;
    spawnOffset?: number;
    spawnRotation?: number;
    dotColors?: [number, number, number];
    /** False for TCA AI-only / scenery airframes not listed in flyables.json. */
    playerFlyable?: boolean;
}

interface ModCatalog {
    modName?: string;
    modId?: string;
    aircraft: CatalogAircraft[];
}

interface PlaneImportPlan {
    modId: string;
    idSlug: string;
    name: string;
    displayName: string;
    material: string | null;
    category?: string;
    description?: string;
    sourceMaterial?: string;
    confidence?: number;
    spawnOffset?: number;
    spawnRotation?: number;
    dotColors?: [number, number, number];
    includeRoots?: Array<string | number>;
    companionMaterials?: string[];
}

interface AircraftImportChoice {
    key: string;
    canonicalName: string;
    displayName: string;
    category?: string;
    description?: string;
    liveries: Array<{
        material: string;
        label: string;
        confidence: number;
        includeRoots?: Array<string | number>;
        companionMaterials?: string[];
    }>;
    defaultMaterial: string;
}

interface ImportSelection {
    key: string;
    material: string;
    enabled: boolean;
}

interface ModPreview {
    token: string;
    baseSlug: string;
    originalName: string;
    zipPath: string;
    embedded: Partial<ImportConfig> | null;
    catalog: ModCatalog | null;
    discovered: DiscoveredPlane[];
    choices: AircraftImportChoice[];
}

interface ImportedAircraft {
    id: string;
    name: string;
    packUrl: string;
}

interface AircraftManifestListMeta {
    name?: string;
    displayName?: string;
    canonicalName?: string;
    sourceMod?: string;
    sourceModId?: string;
    sourceMaterial?: string;
}

const upload = multer({ storage: multer.memoryStorage() });

function slugify(name: string): string {
    const base = path.basename(name, path.extname(name));
    const slug = base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return slug || 'mod';
}

function prettyName(name: string): string {
    const base = path.basename(name, path.extname(name));
    const cleaned = base.replace(/[_\-]+/g, ' ').trim();
    return cleaned || 'Imported Aircraft';
}

function uniqueModId(slug: string): string {
    let id = slug;
    let n = 2;
    while (
        fs.existsSync(path.join(IMPORTS_DIR, `${id}.aircraft.json`))
        || fs.existsSync(path.join(ASSETS_DIR, `${id}.aircraft.json`))
    ) {
        id = `${slug}_${n++}`;
    }
    return id;
}

function manifestPathForId(id: string): string | null {
    const imported = path.join(IMPORTS_DIR, `${id}.aircraft.json`);
    if (fs.existsSync(imported)) {
        return imported;
    }
    const shipped = path.join(ASSETS_DIR, `${id}.aircraft.json`);
    if (fs.existsSync(shipped)) {
        return shipped;
    }
    return null;
}

function unzipModBuffer(zipBuffer: Buffer): Record<string, Uint8Array> {
    return unzipSync(new Uint8Array(zipBuffer));
}

function findEmbeddedConfig(files: Record<string, Uint8Array>): Partial<ImportConfig> | null {
    try {
        for (const entry of Object.keys(files)) {
            if (path.basename(entry).toLowerCase() === 'retroflight.json') {
                const text = Buffer.from(files[entry]).toString('utf-8');
                return JSON.parse(text) as Partial<ImportConfig>;
            }
        }
    } catch (err) {
        console.warn('[modserver] could not scan zip for embedded config:', (err as Error).message);
    }
    return null;
}

function parseJsonLoose(text: string): unknown {
    const withoutBom = text.replace(/^\uFEFF/, '');
    const withoutTrailingCommas = withoutBom
        .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(withoutTrailingCommas);
}

function normalizeName(value: string): string {
    return value
        .toLowerCase()
        .replace(/\.[0-9]+$/g, '')
        .replace(/\b(material|mat|palette|pallete)\b/g, '')
        // Collapse hyphenated airframe tokens ("E-3" -> "e3") before spaces
        // are normalized, so catalog "E3 Sentry" matches material "E-3 Mat".
        .replace(/([a-z])-+(?=\d)/g, '$1')
        .replace(/(\d)-+(?=[a-z])/g, '$1')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function tokenizeName(value: string): Set<string> {
    return new Set(normalizeName(value).split(/\s+/g).filter(Boolean));
}

function materialLooksLikeNoise(material: string): boolean {
    const n = normalizeName(material);
    return [
        'light',
        'screen',
        'shared cockpit',
        'cockpit',
        'formation',
        'gbu',
        'shadow',
    ].some(noise => n.includes(noise));
}

function readZipText(files: Record<string, Uint8Array>, entry: string): string | null {
    const data = files[entry];
    if (!data) return null;
    return Buffer.from(data).toString('utf-8');
}

function zipEntryByName(files: Record<string, Uint8Array>, matcher: (normalized: string) => boolean): string | null {
    for (const entry of Object.keys(files)) {
        const normalized = entry.replace(/\\/g, '/').toLowerCase();
        if (matcher(normalized)) {
            return entry;
        }
    }
    return null;
}

function catalogEntryFromSources(
    canonicalName: string,
    db: Record<string, unknown> | undefined,
    a2: Record<string, unknown> | undefined,
    playerFlyable: boolean,
): CatalogAircraft {
    const displayName = (typeof a2?.DisplayName === 'string' && a2.DisplayName)
        || (typeof db?.DisplayName === 'string' && db.DisplayName)
        || canonicalName;
    const category = (typeof db?.Filter === 'string' && db.Filter)
        || (typeof a2?.TargetType === 'string' ? a2.TargetType : undefined);
    const description = (typeof db?.Description === 'string' ? db.Description : undefined);
    const modelPath = (typeof a2?.ModelPath === 'string' ? a2.ModelPath : undefined);
    const spawnOffset = typeof a2?.SpawnOffset === 'number' ? a2.SpawnOffset : undefined;
    const spawnRotation = typeof a2?.SpawnRotation === 'number' ? a2.SpawnRotation : undefined;
    const dotRaw = a2?.DotColors;
    const dotColors = Array.isArray(dotRaw) && dotRaw.length >= 3
        ? [Number(dotRaw[0]), Number(dotRaw[1]), Number(dotRaw[2])] as [number, number, number]
        : undefined;
    return {
        canonicalName,
        displayName,
        category,
        description,
        modelPath,
        spawnOffset,
        spawnRotation,
        dotColors,
        playerFlyable,
    };
}

function extractModCatalog(files: Record<string, Uint8Array>): ModCatalog | null {
    try {
        const modEntry = zipEntryByName(files, name => name.endsWith('/mod.json') || name === 'mod.json');
        const flyablesEntry = zipEntryByName(files, name => name.endsWith('/data/flyables.json'));
        const dbEntry = zipEntryByName(files, name => name.endsWith('/data/database/aircraft.json'));
        const aircraft2Entries = Object.keys(files)
            .filter(name => name.replace(/\\/g, '/').toLowerCase().includes('/data/aircraft2/') && name.toLowerCase().endsWith('.json'));

        // Prefer flyables when present, but still catalog AI-only / scenery
        // airframes that only appear in Aircraft2 or database/aircraft.json.
        if (!flyablesEntry && !dbEntry && aircraft2Entries.length === 0) {
            return null;
        }

        const modJsonText = modEntry ? readZipText(files, modEntry) : null;
        const flyablesText = flyablesEntry ? readZipText(files, flyablesEntry) : null;
        const dbText = dbEntry ? readZipText(files, dbEntry) : null;

        const modJson = modJsonText ? parseJsonLoose(modJsonText) as Record<string, unknown> : {};
        const flyables = flyablesText
            ? parseJsonLoose(flyablesText) as Array<Record<string, unknown>>
            : [];
        const database = dbText ? parseJsonLoose(dbText) as Array<Record<string, unknown>> : [];

        const dbByName = new Map<string, Record<string, unknown>>();
        for (const row of database) {
            const name = typeof row.Name === 'string' ? row.Name : '';
            if (name) dbByName.set(normalizeName(name), row);
        }

        const aircraft2ByName = new Map<string, Record<string, unknown>>();
        for (const entry of aircraft2Entries) {
            const txt = readZipText(files, entry);
            if (!txt) continue;
            try {
                const row = parseJsonLoose(txt) as Record<string, unknown>;
                const name = typeof row.Name === 'string' ? row.Name : '';
                if (name) aircraft2ByName.set(normalizeName(name), row);
            } catch {
                // Skip malformed sidecar files; keep catalog extraction resilient.
            }
        }

        const aircraftByKey = new Map<string, CatalogAircraft>();

        for (const flyable of flyables) {
            const canonicalName = typeof flyable.Name === 'string' ? flyable.Name : '';
            if (!canonicalName) continue;
            const key = normalizeName(canonicalName);
            aircraftByKey.set(key, catalogEntryFromSources(
                canonicalName,
                dbByName.get(key),
                aircraft2ByName.get(key),
                true,
            ));
        }

        for (const [key, a2] of aircraft2ByName) {
            if (aircraftByKey.has(key)) continue;
            const canonicalName = typeof a2.Name === 'string' ? a2.Name : '';
            if (!canonicalName) continue;
            aircraftByKey.set(key, catalogEntryFromSources(
                canonicalName,
                dbByName.get(key),
                a2,
                false,
            ));
        }

        for (const [key, db] of dbByName) {
            if (aircraftByKey.has(key)) continue;
            const canonicalName = typeof db.Name === 'string' ? db.Name : '';
            if (!canonicalName) continue;
            aircraftByKey.set(key, catalogEntryFromSources(
                canonicalName,
                db,
                aircraft2ByName.get(key),
                false,
            ));
        }

        const aircraft = [...aircraftByKey.values()];
        if (!aircraft.length) return null;
        return {
            modName: typeof modJson?.DisplayName === 'string' ? modJson.DisplayName : undefined,
            modId: typeof modJson?.Id === 'string' ? modJson.Id : undefined,
            aircraft,
        };
    } catch {
        return null;
    }
}

function scoreCatalogMatch(plane: DiscoveredPlane, aircraft: CatalogAircraft): number {
    // When discover splits a shared-material foreign hull (name from companions,
    // e.g. "AC-208"), match on that name — not the borrowed livery material.
    const renamed = normalizeName(plane.name) !== normalizeName(plane.material);
    const planeLabel = renamed ? plane.name : `${plane.name} ${plane.material}`;
    const planeNorm = normalizeName(planeLabel);
    const aircraftNorm = normalizeName(`${aircraft.canonicalName} ${aircraft.displayName}`);
    if (!planeNorm || !aircraftNorm) return 0;
    let score = 0;
    if (planeNorm === aircraftNorm) score += 10;
    if (planeNorm.includes(aircraftNorm) || aircraftNorm.includes(planeNorm)) score += 5;

    const planeTokens = tokenizeName(planeLabel);
    const aircraftTokens = tokenizeName(`${aircraft.canonicalName} ${aircraft.displayName}`);
    let overlap = 0;
    for (const token of planeTokens) {
        if (aircraftTokens.has(token)) {
            overlap++;
            continue;
        }
        for (const at of aircraftTokens) {
            if (token.length >= 3 && at.length >= 3 && (token.startsWith(at) || at.startsWith(token))) {
                overlap++;
                break;
            }
        }
    }
    score += overlap * 2;

    if (aircraft.modelPath) {
        const modelBase = path.basename(aircraft.modelPath, path.extname(aircraft.modelPath));
        const modelNorm = normalizeName(modelBase);
        if (modelNorm && (planeNorm.includes(modelNorm) || modelNorm.includes(planeNorm))) {
            score += 4;
        }
    }
    return score;
}

function discoveryIdentity(plane: DiscoveredPlane): string {
    const roots = plane.includeRoots?.length
        ? plane.includeRoots.join('-')
        : (plane.transformRoot != null ? String(plane.transformRoot) : '');
    return roots ? `${plane.material}::${roots}` : plane.material;
}

function planFromDiscovered(
    plane: DiscoveredPlane,
    baseSlug: string,
    extras: Partial<PlaneImportPlan> = {},
): PlaneImportPlan {
    const rootTag = plane.includeRoots?.[0] != null ? `_r${plane.includeRoots[0]}` : '';
    const nameSlug = slugify(plane.name);
    const matSlug = slugify(plane.material);
    return {
        modId: uniqueModId(`${baseSlug}_${nameSlug || matSlug}${rootTag}`),
        idSlug: nameSlug || matSlug,
        name: plane.name,
        displayName: plane.name === plane.material
            ? `${plane.name} (${plane.material})`
            : plane.name,
        material: plane.material,
        sourceMaterial: plane.material,
        includeRoots: plane.includeRoots,
        companionMaterials: plane.companionMaterials,
        confidence: 0.5,
        ...extras,
    };
}

function buildAllLiveryPlans(
    discovered: DiscoveredPlane[],
    catalog: ModCatalog | null,
    baseSlug: string,
): PlaneImportPlan[] {
    const filtered = discovered.filter(p => !materialLooksLikeNoise(p.material));
    if (!catalog) {
        return filtered
            .map((plane) => planFromDiscovered(plane, baseSlug))
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    const plans: PlaneImportPlan[] = [];
    for (const plane of filtered) {
        let best: { score: number; aircraft: CatalogAircraft } | null = null;
        for (const aircraft of catalog.aircraft) {
            const score = scoreCatalogMatch(plane, aircraft);
            if (!best || score > best.score) {
                best = { score, aircraft };
            }
        }

        if (!best || best.score < 2) {
            plans.push(planFromDiscovered(plane, baseSlug, {
                confidence: Number((Math.min(1, (best?.score ?? 0) / 12)).toFixed(3)),
            }));
            continue;
        }

        const { score, aircraft } = best;
        const idSlug = slugify(aircraft.canonicalName);
        const matSlug = slugify(plane.material);
        const rootTag = plane.includeRoots?.[0] != null ? `_r${plane.includeRoots[0]}` : '';
        const display = aircraft.displayName || aircraft.canonicalName;
        const liveryLabel = plane.name !== plane.material && plane.name !== display
            ? plane.name
            : plane.material;
        plans.push({
            modId: uniqueModId(`${baseSlug}_${idSlug}_${matSlug}${rootTag}`),
            idSlug,
            name: aircraft.canonicalName,
            displayName: `${display} (${liveryLabel})`,
            material: plane.material,
            category: aircraft.category,
            description: aircraft.description,
            sourceMaterial: plane.material,
            confidence: Number((Math.min(1, score / 12)).toFixed(3)),
            spawnOffset: aircraft.spawnOffset,
            spawnRotation: aircraft.spawnRotation,
            dotColors: aircraft.dotColors,
            includeRoots: plane.includeRoots,
            companionMaterials: plane.companionMaterials,
        });
    }
    return plans.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** @deprecated Use buildAllLiveryPlans — kept as alias for one-livery-per-type callers. */
function buildPlanesFromCatalog(
    discovered: DiscoveredPlane[],
    catalog: ModCatalog | null,
    baseSlug: string,
): PlaneImportPlan[] {
    return buildAllLiveryPlans(discovered, catalog, baseSlug);
}

function buildAircraftChoices(
    discovered: DiscoveredPlane[],
    catalog: ModCatalog | null,
): AircraftImportChoice[] {
    const filtered = discovered.filter(p => !materialLooksLikeNoise(p.material));
    if (!catalog) {
        return filtered.map((plane) => ({
            key: `id:${slugify(discoveryIdentity(plane))}`,
            canonicalName: plane.name,
            displayName: plane.name,
            liveries: [{
                material: plane.material,
                label: plane.material,
                confidence: 0.5,
                includeRoots: plane.includeRoots,
                companionMaterials: plane.companionMaterials,
            }],
            defaultMaterial: plane.material,
        })).sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    const byAircraft = new Map<string, {
        aircraft: CatalogAircraft;
        liveries: Map<string, {
            score: number;
            includeRoots?: Array<string | number>;
            companionMaterials?: string[];
            label: string;
        }>;
    }>();

    for (const plane of filtered) {
        let best: { score: number; aircraft: CatalogAircraft } | null = null;
        for (const aircraft of catalog.aircraft) {
            const score = scoreCatalogMatch(plane, aircraft);
            if (!best || score > best.score) {
                best = { score, aircraft };
            }
        }
        if (!best || best.score < 2) {
            const key = `id:${slugify(discoveryIdentity(plane))}`;
            byAircraft.set(key, {
                aircraft: {
                    canonicalName: plane.name,
                    displayName: plane.name,
                },
                liveries: new Map([[discoveryIdentity(plane), {
                    score: best?.score ?? 0,
                    includeRoots: plane.includeRoots,
                    companionMaterials: plane.companionMaterials,
                    label: plane.material,
                }]]),
            });
            continue;
        }
        const key = normalizeName(best.aircraft.canonicalName);
        let entry = byAircraft.get(key);
        if (!entry) {
            entry = { aircraft: best.aircraft, liveries: new Map() };
            byAircraft.set(key, entry);
        }
        const liveryKey = discoveryIdentity(plane);
        const prev = entry.liveries.get(liveryKey);
        if (!prev || best.score > prev.score) {
            entry.liveries.set(liveryKey, {
                score: best.score,
                includeRoots: plane.includeRoots,
                companionMaterials: plane.companionMaterials,
                label: plane.material,
            });
        }
    }

    const choices: AircraftImportChoice[] = [];
    for (const [key, { aircraft, liveries }] of byAircraft) {
        const sorted = [...liveries.entries()]
            .sort((a, b) => b[1].score - a[1].score)
            .map(([, meta]) => ({
                material: meta.label,
                label: meta.label,
                confidence: Number((Math.min(1, meta.score / 12)).toFixed(3)),
                includeRoots: meta.includeRoots,
                companionMaterials: meta.companionMaterials,
            }));
        choices.push({
            key,
            canonicalName: aircraft.canonicalName,
            displayName: aircraft.displayName || aircraft.canonicalName,
            category: aircraft.category,
            description: aircraft.description,
            liveries: sorted,
            defaultMaterial: sorted[0].material,
        });
    }
    return choices.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function buildPlanesFromSelections(
    choices: AircraftImportChoice[],
    selections: ImportSelection[],
    catalog: ModCatalog | null,
    baseSlug: string,
): PlaneImportPlan[] {
    const choiceByKey = new Map(choices.map(c => [c.key, c]));
    const enabled = selections.filter(s => s.enabled);
    const enabledByCanon = new Map<string, number>();
    for (const sel of enabled) {
        const choice = choiceByKey.get(sel.key);
        if (!choice) continue;
        const canon = normalizeName(choice.canonicalName);
        enabledByCanon.set(canon, (enabledByCanon.get(canon) ?? 0) + 1);
    }

    const plans: PlaneImportPlan[] = [];
    for (const sel of enabled) {
        const choice = choiceByKey.get(sel.key);
        if (!choice) continue;
        const livery = choice.liveries.find(l => l.material === sel.material);
        if (!livery) continue;

        const aircraft = catalog?.aircraft.find(
            a => normalizeName(a.canonicalName) === normalizeName(choice.canonicalName),
        );
        const idSlug = slugify(choice.canonicalName);
        const matSlug = slugify(sel.material);
        const canon = normalizeName(choice.canonicalName);
        const variantImport = (enabledByCanon.get(canon) ?? 0) > 1 || choice.liveries.length > 1;
        const rootTag = livery.includeRoots?.[0] != null ? `_r${livery.includeRoots[0]}` : '';
        const modIdBase = variantImport
            ? `${baseSlug}_${idSlug}_${matSlug}${rootTag}`
            : `${baseSlug}_${idSlug}${rootTag}`;
        const liverySuffix = choice.liveries.length > 1 ? ` (${livery.label})` : '';

        plans.push({
            modId: uniqueModId(modIdBase),
            idSlug,
            name: choice.canonicalName,
            displayName: `${choice.displayName}${liverySuffix}`,
            material: sel.material,
            category: aircraft?.category ?? choice.category,
            description: aircraft?.description ?? choice.description,
            sourceMaterial: sel.material,
            confidence: livery.confidence,
            spawnOffset: aircraft?.spawnOffset,
            spawnRotation: aircraft?.spawnRotation,
            dotColors: aircraft?.dotColors,
            includeRoots: livery.includeRoots,
            companionMaterials: livery.companionMaterials,
        });
    }
    return plans;
}

function previewPathForToken(token: string): string {
    return path.join(UPLOADS_DIR, `${token}.preview.json`);
}

function loadPreview(token: string): ModPreview | null {
    const previewPath = previewPathForToken(token);
    if (!fs.existsSync(previewPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(previewPath, 'utf-8')) as ModPreview;
    } catch {
        return null;
    }
}

function savePreview(preview: ModPreview): void {
    fs.writeFileSync(previewPathForToken(preview.token), JSON.stringify(preview, null, 2));
}

async function executeImport(
    preview: ModPreview,
    planes: PlaneImportPlan[],
    log: string[],
): Promise<ImportedAircraft[]> {
    if (planes.length === 0) {
        throw new Error('No aircraft selected for import.');
    }

    const stamp = preview.token.split('-').pop() ?? String(Date.now());
    const configs = planes.map((plane) => buildPlaneConfig(
        preview.zipPath,
        plane,
        preview.embedded,
        preview.catalog,
    ));
    const batchPath = path.join(UPLOADS_DIR, `${preview.baseSlug}-${stamp}.batch.json`);
    await importPlaneConfigsBatch(configs, batchPath, log);

    const modIds = planes.map((plane) => plane.modId);
    const pack = await runPython([
        'tools/pack_aircraft_mods.py',
        '--imports-only',
        '--only',
        ...modIds,
    ]);
    log.push(`\n$ python tools/pack_aircraft_mods.py\n${pack.stdout}${pack.stderr}`);
    if (pack.code !== 0) {
        throw new Error('pack_aircraft_mods.py failed');
    }

    const imported: ImportedAircraft[] = [];
    for (const plane of planes) {
        const manifestPath = path.join(IMPORTS_DIR, `${plane.modId}.aircraft.json`);
        const packPath = path.join(DIST_DIR, 'assets', `${plane.modId}.aircraft.pack`);
        if (!fs.existsSync(manifestPath) || !fs.existsSync(packPath)) {
            continue;
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { name?: string };
        imported.push({
            id: plane.modId,
            name: manifest.name || plane.displayName || plane.name,
            packUrl: `assets/${plane.modId}.aircraft.pack`,
        });
    }
    if (imported.length === 0) {
        throw new Error('Import produced no aircraft packs (the mod may not be a supported plane bundle).');
    }
    return imported;
}

interface PythonResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

function runPython(args: string[]): Promise<PythonResult> {
    return new Promise((resolve) => {
        const child = spawn(PYTHON, args, { cwd: PROJECT_ROOT });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => resolve({ code: -1, stdout, stderr: stderr + `\n${err.message}` }));
        child.on('close', (code: number | null) => resolve({ code, stdout, stderr }));
    });
}

function parseJsonPreservingLargeInts(text: string): unknown {
    // JS Number cannot represent Unity 64-bit path IDs exactly. Quote any bare
    // integer outside the safe range so JSON.parse keeps the full digits.
    const quoted = text.replace(
        /(^|[:\[,]\s*)(-?(?:0|[1-9]\d{15,}))(?=\s*[,\]}])/gm,
        '$1"$2"',
    );
    return JSON.parse(quoted);
}

async function discoverPlanes(bundlePath: string): Promise<DiscoveredPlane[]> {
    const result = await runPython(['tools/import_mod.py', '--bundle', bundlePath, '--discover']);
    if (result.code !== 0) {
        throw new Error(`discover failed: ${result.stderr || result.stdout}`);
    }
    const text = result.stdout.trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) {
        throw new Error(`discover returned invalid JSON: ${text}`);
    }
    try {
        return parseJsonPreservingLargeInts(text.slice(start, end + 1)) as DiscoveredPlane[];
    } catch {
        throw new Error(`discover returned invalid JSON: ${text}`);
    }
}

function buildSpawnFromPlan(plane: PlaneImportPlan): Record<string, unknown> | undefined {
    const spawn: Record<string, unknown> = {};
    if (plane.spawnOffset !== undefined) {
        spawn.offset = plane.spawnOffset;
    }
    if (plane.spawnRotation !== undefined) {
        spawn.rotation = plane.spawnRotation;
    }
    if (plane.dotColors !== undefined) {
        spawn.dotColors = plane.dotColors;
    }
    return Object.keys(spawn).length > 0 ? spawn : undefined;
}

function buildPlaneConfig(
    bundlePath: string,
    plane: PlaneImportPlan,
    embedded: Partial<ImportConfig> | null,
    catalog: ModCatalog | null,
): ImportConfig {
    const multiPlane = plane.material !== null;
    const collectionPack = (catalog?.aircraft.length ?? 0) > 5;
    const base: ImportConfig = embedded
        ? { ...embedded, bundle: bundlePath }
        : {
            bundle: bundlePath,
            groundDistance: 2.0,
            scale: 1.0,
            swatchMax: 64,
            bitmapLivery: true,
            glassColor: 'GLASS',
            glassAutoAlpha: true,
            skipMaterials: ['ShadowDepthOffset', 'Shadow'],
        };

    const catalogSpawn = buildSpawnFromPlan(plane);
    const flyable: Record<string, unknown> = {
        ...(base.flyable ?? {}),
        outPrefix: `${IMPORTS_PREFIX}/${plane.modId}`,
    };
    if (catalogSpawn) {
        flyable.spawn = { ...((base.flyable?.spawn as Record<string, unknown>) ?? {}), ...catalogSpawn };
    }

    return {
        ...base,
        id: plane.modId,
        name: plane.displayName || plane.name,
        displayName: plane.displayName,
        canonicalName: plane.name,
        category: plane.category,
        description: plane.description,
        sourceMaterial: plane.sourceMaterial,
        sourceMod: catalog?.modName ?? prettyName(path.basename(bundlePath)),
        sourceModId: catalog?.modId,
        importMeta: {
            confidence: plane.confidence ?? 0,
            discoveredFrom: plane.sourceMaterial ?? null,
        },
        bundle: bundlePath,
        out: `${IMPORTS_PREFIX}/${plane.modId}_static.gltf`,
        flyable,
        ...(multiPlane ? {
            collectionPack,
            includeMaterials: [plane.material!],
            ...(plane.includeRoots?.length ? { includeRoots: plane.includeRoots } : {}),
            ...(plane.companionMaterials?.length
                ? { companionMaterials: plane.companionMaterials }
                : {}),
            dedupeParts: true,
            skipClutter: false,
            bitmapLivery: true,
            rescueGlassUnderRoot: true,
            rescueGlassGlobal: !collectionPack,
            rescueCockpit: true,
            rescueCockpitGlobal: !collectionPack,
            rescueNozzleUnderRoot: true,
            rescueNozzleGlobal: !collectionPack,
            rescueCollisionUnderRoot: true,
            rescueCollisionGlobal: !collectionPack,
            rescueMaterialsUnderRoot: false,
        } : {}),
    };
}

function listAircraftPacks(): ImportedAircraft[] {
    const distAssets = path.join(DIST_DIR, 'assets');
    if (!fs.existsSync(distAssets)) {
        return [];
    }
    const deduped = new Map<string, { entry: ImportedAircraft; mtimeMs: number }>();
    for (const file of fs.readdirSync(distAssets)) {
        if (!file.endsWith('.aircraft.pack')) {
            continue;
        }
        const id = file.slice(0, -'.aircraft.pack'.length);
        const packPath = path.join(distAssets, file);
        const stat = fs.statSync(packPath);
        let name = id;
        let dedupeKey = id;
        const manifestPath = manifestPathForId(id);
        if (manifestPath) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as AircraftManifestListMeta;
            name = manifest.displayName ?? manifest.name ?? id;
            // Re-imports produce suffixed ids (_2, _3, ...). Collapse identical
            // aircraft/material variants and keep only the newest pack in the menu.
            if (manifest.canonicalName || manifest.sourceModId || manifest.sourceMod || manifest.sourceMaterial) {
                dedupeKey = [
                    manifest.sourceModId ?? manifest.sourceMod ?? '',
                    manifest.canonicalName ?? name,
                    manifest.sourceMaterial ?? '',
                ].join('::');
            }
        }
        // Bust browser cache when a pack is rebuilt (same URL otherwise sticks).
        const packUrl = `assets/${file}?v=${Math.floor(stat.mtimeMs)}`;
        const entry = { id, name, packUrl };
        const prev = deduped.get(dedupeKey);
        if (!prev || stat.mtimeMs > prev.mtimeMs) {
            deduped.set(dedupeKey, { entry, mtimeMs: stat.mtimeMs });
        }
    }
    return [...deduped.values()].map(v => v.entry).sort((a, b) => a.name.localeCompare(b.name));
}

async function importPlaneConfigsBatch(
    configs: ImportConfig[],
    batchPath: string,
    log: string[],
): Promise<void> {
    fs.writeFileSync(batchPath, JSON.stringify({ configs }, null, 2));
    const imp = await runPython(['tools/import_mod.py', '--batch', batchPath]);
    log.push(`$ python tools/import_mod.py --batch ${path.basename(batchPath)}\n${imp.stdout}${imp.stderr}`);
    if (imp.code !== 0) {
        throw new Error('import_mod.py batch failed');
    }
}

const LIVE_RELOAD = process.env.LIVE_RELOAD === '1';

const LIVE_RELOAD_SCRIPT = `<script>
(() => {
  const es = new EventSource('/__live_reload');
  es.onmessage = () => window.location.reload();
})();
</script>`;

let liveReloadClients: Response[] = [];

function notifyLiveReload(): void {
    for (const client of liveReloadClients) {
        client.write('data: reload\n\n');
    }
}

function watchBundleForReload(): void {
    const bundlePath = path.join(DIST_DIR, 'bundle.js');
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const startWatching = () => {
        fs.watch(bundlePath, () => {
            clearTimeout(debounce);
            debounce = setTimeout(notifyLiveReload, 150);
        });
        console.log('Live reload enabled — browser refreshes when bundle.js rebuilds');
    };

    if (fs.existsSync(bundlePath)) {
        startWatching();
        return;
    }

    const dirWatcher = fs.watch(DIST_DIR, () => {
        if (!fs.existsSync(bundlePath)) {
            return;
        }
        dirWatcher.close();
        startWatching();
    });
}

const app = express();

if (LIVE_RELOAD) {
    app.get('/__live_reload', (req: Request, res: Response) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.flushHeaders();
        liveReloadClients.push(res);
        req.on('close', () => {
            liveReloadClients = liveReloadClients.filter((client) => client !== res);
        });
    });

    app.use((req: Request, res: Response, next) => {
        if (req.method !== 'GET' || (req.path !== '/' && req.path !== '/index.html')) {
            next();
            return;
        }

        const indexPath = path.join(DIST_DIR, 'index.html');
        if (!fs.existsSync(indexPath)) {
            next();
            return;
        }

        const html = fs.readFileSync(indexPath, 'utf8');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Cache-Control', 'no-store');
        if (!html.includes('</body>')) {
            res.type('html').send(html);
            return;
        }

        res.type('html').send(html.replace('</body>', `${LIVE_RELOAD_SCRIPT}</body>`));
    });
}

// Terrain area import (F9 in the app). See tools/areaImport.ts.
app.get('/api/osm/:z/:x/:y', osmTile);
app.get('/api/areas', areasHandler);
app.post('/api/import-area', express.json(), startImport);
app.post('/api/delete-area', express.json(), startDelete);
app.get('/api/import-area/:id', importStream);

app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, server: 'modserver', previewMod: true });
});

app.get('/api/aircraft-packs', (_req: Request, res: Response) => {
    res.json(listAircraftPacks());
});

app.post('/api/preview-mod', upload.single('mod'), async (req: Request, res: Response) => {
    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'No file uploaded (expected field "mod").' });
    }

    const originalName = req.file.originalname || 'mod.zip';
    const baseSlug = slugify(originalName);

    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const stamp = Date.now();
    const token = `${baseSlug}-${stamp}`;
    const zipPath = path.join(UPLOADS_DIR, `${token}.zip`);
    fs.writeFileSync(zipPath, req.file.buffer);

    const zipFiles = unzipModBuffer(req.file.buffer);
    const embedded = findEmbeddedConfig(zipFiles);
    const catalog = extractModCatalog(zipFiles);

    try {
        if (embedded?.includeMaterials?.length) {
            const name = embedded.name ?? prettyName(originalName);
            const choices: AircraftImportChoice[] = [{
                key: slugify(name),
                canonicalName: name,
                displayName: name,
                liveries: [{
                    material: embedded.includeMaterials[0],
                    label: embedded.includeMaterials[0],
                    confidence: 1,
                }],
                defaultMaterial: embedded.includeMaterials[0],
            }];
            const preview: ModPreview = {
                token,
                baseSlug,
                originalName,
                zipPath,
                embedded,
                catalog,
                discovered: [],
                choices,
            };
            savePreview(preview);
            return res.json({
                ok: true,
                token,
                modName: catalog?.modName ?? prettyName(originalName),
                liveryCount: 1,
            });
        }

        const discovered = await discoverPlanes(zipPath);
        const choices = buildAircraftChoices(discovered, catalog);
        if (choices.length === 0) {
            return res.status(400).json({
                ok: false,
                error: 'No aircraft liveries found in this mod.',
            });
        }

        const plans = buildAllLiveryPlans(discovered, catalog, baseSlug);
        const preview: ModPreview = {
            token,
            baseSlug,
            originalName,
            zipPath,
            embedded,
            catalog,
            discovered,
            choices,
        };
        savePreview(preview);

        return res.json({
            ok: true,
            token,
            modName: catalog?.modName ?? prettyName(originalName),
            liveryCount: plans.length,
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: (err as Error).message });
    }
});

const importUpload = multer({ storage: multer.memoryStorage() }).fields([{ name: 'mod', maxCount: 1 }]);

app.post('/api/import-mod', importUpload, async (req: Request, res: Response) => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(IMPORTS_DIR, { recursive: true });

    const files = req.files as { mod?: Express.Multer.File[] } | undefined;
    const uploaded = files?.mod?.[0];
    const token = typeof req.body?.token === 'string' ? req.body.token : undefined;
    const log: string[] = [];

    try {
        let preview: ModPreview | null = null;
        if (token) {
            preview = loadPreview(token);
            if (!preview) {
                return res.status(400).json({ ok: false, error: 'Import preview expired or not found. Upload the mod again.' });
            }
        } else if (uploaded) {
            const originalName = uploaded.originalname || 'mod.zip';
            const baseSlug = slugify(originalName);
            const stamp = Date.now();
            const newToken = `${baseSlug}-${stamp}`;
            const zipPath = path.join(UPLOADS_DIR, `${newToken}.zip`);
            fs.writeFileSync(zipPath, uploaded.buffer);
            const zipFiles = unzipModBuffer(uploaded.buffer);
            const embedded = findEmbeddedConfig(zipFiles);
            const catalog = extractModCatalog(zipFiles);
            let discovered: DiscoveredPlane[] = [];
            let choices: AircraftImportChoice[] = [];
            if (embedded?.includeMaterials?.length) {
                const name = embedded.name ?? prettyName(originalName);
                choices = [{
                    key: slugify(name),
                    canonicalName: name,
                    displayName: name,
                    liveries: [{
                        material: embedded.includeMaterials[0],
                        label: embedded.includeMaterials[0],
                        confidence: 1,
                    }],
                    defaultMaterial: embedded.includeMaterials[0],
                }];
            } else {
                discovered = await discoverPlanes(zipPath);
                log.push(`$ python tools/import_mod.py --bundle ... --discover\n${JSON.stringify(discovered, null, 2)}\n`);
                choices = buildAircraftChoices(discovered, catalog);
            }
            preview = {
                token: newToken,
                baseSlug,
                originalName,
                zipPath,
                embedded,
                catalog,
                discovered,
                choices,
            };
        } else {
            return res.status(400).json({ ok: false, error: 'Upload a mod or provide a preview token.' });
        }

        let planes: PlaneImportPlan[];
        const selectionsRaw = req.body?.selections;
        if (typeof selectionsRaw === 'string' && selectionsRaw.length > 0) {
            const selections = JSON.parse(selectionsRaw) as ImportSelection[];
            planes = buildPlanesFromSelections(preview.choices, selections, preview.catalog, preview.baseSlug);
            log.push(`[import] ${planes.length} aircraft selected`);
        } else if (preview.embedded?.includeMaterials?.length) {
            const idSlug = slugify(preview.embedded.name ?? preview.baseSlug);
            planes = [{
                modId: uniqueModId(preview.baseSlug),
                idSlug,
                name: preview.embedded.name ?? prettyName(preview.originalName),
                displayName: preview.embedded.name ?? prettyName(preview.originalName),
                material: null,
                confidence: 1,
            }];
        } else {
            planes = buildAllLiveryPlans(preview.discovered, preview.catalog, preview.baseSlug);
            log.push(`[import] ${planes.length} liveries queued`);
            if (planes.length === 0) {
                planes = [{
                    modId: uniqueModId(preview.baseSlug),
                    idSlug: preview.baseSlug,
                    name: prettyName(preview.originalName),
                    displayName: prettyName(preview.originalName),
                    material: null,
                    confidence: 0,
                }];
            }
        }

        const imported = await executeImport(preview, planes, log);
        return res.json({ ok: true, imported, log: log.join('\n') });
    } catch (err) {
        return res.status(500).json({ ok: false, error: (err as Error).message, log: log.join('\n') });
    }
});

// Baked terrain pyramid, served straight from the repo rather than copied into
// dist/ on every build (see webpack.config.js). Mounted before the dist static
// handler so it wins for /assets/planet/*.
//
// .ptm tiles and their .ptx texture sidecars are stored gzip-compressed on
// disk and served with
// Content-Encoding: gzip so the browser inflates them in native code off the
// main thread. express.static would otherwise serve them as opaque bytes.
const PLANET_DIR = path.join(PROJECT_ROOT, 'assets', 'planet');
const TERRAIN_DIR = path.join(PROJECT_ROOT, 'assets', 'terrain');
const TERRAIN_MOUNTS: ReadonlyArray<readonly [string, string]> = [
    ['/assets/terrain', TERRAIN_DIR],   // baked .ptm meshes (bake output)
    ['/assets/planet', PLANET_DIR],     // .pdm heights (bake input)
];
for (const [mount, dir] of TERRAIN_MOUNTS) {
    app.use(mount, express.static(dir, {
        fallthrough: false,
        setHeaders(res, filePath) {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            if (filePath.endsWith('.ptm') || filePath.endsWith('.ptx') || filePath.endsWith('.ptr')) {
                res.setHeader('Content-Encoding', 'gzip');
                res.setHeader('Content-Type', 'application/octet-stream');
            }
        },
    }));
}

app.use(express.static(DIST_DIR, {
    index: LIVE_RELOAD ? false : 'index.html',
    setHeaders(res, filePath) {
        // Required for SharedArrayBuffer (combat-sim state mirror).
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.aircraft.pack')) {
            res.setHeader('Cache-Control', 'no-store');
        }
    },
}));

app.listen(PORT, () => {
    console.log(`retroflightsim dev server running at http://localhost:${PORT}`);
    console.log(`Serving ${DIST_DIR}`);
    console.log('Mod import endpoint: POST /api/preview-mod, POST /api/import-mod (F10 in-app upload)');
    if (LIVE_RELOAD) {
        watchBundleForReload();
    }
});
