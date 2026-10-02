#!/usr/bin/env node
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scheduleBuild } from './autoBuild.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const children = [];

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

function spawnChild(command, args, env = process.env) {
    const child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env,
    });
    children.push(child);
    return child;
}

function watchDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return;
    }

    fs.watch(dirPath, { recursive: true }, (_eventType, fileName) => {
        if (!fileName) {
            return;
        }
        scheduleBuild(path.join(dirPath, fileName));
    });
}

function shutdown() {
    console.log('\n[dev] shutting down...');
    for (const child of children) {
        child.kill();
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A blank checkout: node packages first (everything below runs through them),
// then the Python ones the terrain bake needs - the dev server bakes missing
// terrain on its own at startup (see tools/areaImport.ts, ensureTerrain).
if (!fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', '.package-lock.json'))) {
    console.log('[dev] installing node packages...');
    await runCommand('npm', ['install']);
}

const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const PY_MODULES = ['numpy', 'rasterio', 'requests', 'shapely', 'osmium'];
const pyCheck = spawnSync(PYTHON, ['-c', `import ${PY_MODULES.join(', ')}`], { cwd: PROJECT_ROOT });
if (pyCheck.error) {
    console.warn(`[dev] ${PYTHON} not found - terrain cannot be baked. Install Python 3 or set PYTHON.`);
} else if (pyCheck.status !== 0) {
    console.log('[dev] installing Python packages for the terrain bake...');
    await runCommand(PYTHON, ['-m', 'pip', 'install', '-r', 'tools/requirements.txt']);
}

console.log('[dev] initial build...');
await runCommand('npm', ['run', 'build']);

console.log('[dev] starting webpack watch + dev server with live reload');
console.log('[dev] open http://localhost:8020 — saves rebuild and refresh the browser');

spawnChild('npx', ['webpack', '--mode=development', '--watch']);
spawnChild('npx', ['tsx', 'tools/modserver.ts'], {
    ...process.env,
    PYTHON,
    LIVE_RELOAD: '1',
});

watchDirectory(path.join(PROJECT_ROOT, 'assets'));
watchDirectory(path.join(PROJECT_ROOT, 'tools', 'mods', 'imports'));
