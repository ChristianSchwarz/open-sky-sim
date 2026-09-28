import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(PROJECT_ROOT, '.cursor', '.auto-build-state.json');
const DEBOUNCE_MS = 400;

const WEBPACK_PATTERNS = [
    /^src\//,
    /^webpack\.config\.js$/,
    /^tsconfig\.json$/,
];

const PACK_MODS_PATTERNS = [
    /^assets\//,
    /^tools\/mods\/imports\//,
];

function toProjectRelative(filePath) {
    const absolute = path.isAbsolute(filePath)
        ? filePath
        : path.join(PROJECT_ROOT, filePath);
    return path.relative(PROJECT_ROOT, absolute).replace(/\\/g, '/');
}

export function isBuildRelevant(filePath) {
    const rel = toProjectRelative(filePath);
    if (!rel || rel.startsWith('..')) {
        return false;
    }
    if (rel.startsWith('.cursor/') || rel.startsWith('dist/') || rel.startsWith('node_modules/')
        // Baked terrain, served straight from assets/ - a bake writes thousands of these.
        || rel.startsWith('assets/terrain/') || rel.startsWith('assets/planet/')) {
        return false;
    }
    return WEBPACK_PATTERNS.some((pattern) => pattern.test(rel))
        || PACK_MODS_PATTERNS.some((pattern) => pattern.test(rel));
}

function buildFlagsForFiles(files) {
    let runWebpack = false;
    let runPackMods = false;

    for (const file of files) {
        const rel = toProjectRelative(file);
        if (WEBPACK_PATTERNS.some((pattern) => pattern.test(rel))) {
            runWebpack = true;
        }
        if (PACK_MODS_PATTERNS.some((pattern) => pattern.test(rel))) {
            runPackMods = true;
        }
    }

    return { runWebpack, runPackMods };
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return { files: [], lastEnqueue: 0, building: false, dirty: false };
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: PROJECT_ROOT,
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
        });
    });
}

async function executeBuild(files) {
    const { runWebpack, runPackMods } = buildFlagsForFiles(files);
    if (!runWebpack && !runPackMods) {
        return;
    }

    console.log(`[auto-build] rebuilding after changes to: ${files.join(', ')}`);

    if (runWebpack) {
        await runCommand('npx', ['webpack', '--mode=development']);
    }
    if (runPackMods) {
        await runCommand('npm', ['run', 'pack-mods']);
    }

    console.log('[auto-build] done');
}

async function drainBuildQueue() {
    const state = readState();
    if (state.building) {
        state.dirty = true;
        writeState(state);
        return;
    }

    if (state.files.length === 0) {
        return;
    }

    const files = [...new Set(state.files)];
    state.files = [];
    state.building = true;
    state.dirty = false;
    writeState(state);

    try {
        await executeBuild(files);
    } catch (error) {
        console.error('[auto-build] failed:', error.message);
    }

    const next = readState();
    next.building = false;
    const shouldRebuild = next.dirty;
    next.dirty = false;
    writeState(next);

    if (shouldRebuild) {
        await drainBuildQueue();
    }
}

export function scheduleBuild(filePath) {
    if (!isBuildRelevant(filePath)) {
        return;
    }

    const state = readState();
    state.files.push(toProjectRelative(filePath));
    state.lastEnqueue = Date.now();
    writeState(state);

    setTimeout(() => {
        const current = readState();
        if (Date.now() - current.lastEnqueue < DEBOUNCE_MS) {
            return;
        }
        void drainBuildQueue();
    }, DEBOUNCE_MS);
}

const fileArg = process.argv[2];
if (fileArg) {
    scheduleBuild(fileArg);
}
