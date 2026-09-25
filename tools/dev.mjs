import { spawn } from 'child_process';
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

console.log('[dev] initial build...');
await runCommand('npm', ['run', 'build']);

console.log('[dev] starting webpack watch + dev server with live reload');
console.log('[dev] open http://localhost:8020 — saves rebuild and refresh the browser');

spawnChild('npx', ['webpack', '--mode=development', '--watch']);
spawnChild('npx', ['tsx', 'tools/modserver.ts'], {
    ...process.env,
    LIVE_RELOAD: '1',
});

watchDirectory(path.join(PROJECT_ROOT, 'assets'));
watchDirectory(path.join(PROJECT_ROOT, 'tools', 'mods', 'imports'));
