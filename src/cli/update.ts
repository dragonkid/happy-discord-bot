import { execFileSync, execFile, spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getVersion } from '../version.js';
import { getStateDir } from '../state-dir.js';
import { readDaemonState, writeDaemonState, isDaemonRunning, removeDaemonState } from './daemon.js';

const execFileAsync = promisify(execFile);
const PKG_NAME = 'happy-discord-bot';
const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

export async function checkForUpdate(currentVersion: string): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('npm', ['view', PKG_NAME, 'version']);
        const latest = stdout.trim();
        if (!SEMVER_RE.test(latest)) return null;
        return latest !== currentVersion ? latest : null;
    } catch {
        return null;
    }
}

function runNpmInstall(version: string): boolean {
    try {
        console.log(`Installing ${PKG_NAME}@${version}...`);
        execFileSync('npm', ['install', '-g', `${PKG_NAME}@${version}`], { stdio: 'inherit' });
        return true;
    } catch {
        return false;
    }
}

/** Resolve the newly installed cli.js path via npm global prefix */
function resolveNewCliPath(): string {
    const prefix = execFileSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf-8' }).trim();
    return join(prefix, 'lib', 'node_modules', PKG_NAME, 'dist', 'cli.js');
}

export async function performDiscordUpdate(targetVersion: string): Promise<boolean> {
    try {
        await execFileAsync('npm', ['install', '-g', `${PKG_NAME}@${targetVersion}`]);
    } catch {
        return false;
    }

    const cliPath = resolveNewCliPath();
    const stateDir = getStateDir();
    const readyFile = join(stateDir, 'update-ready');

    const child = spawn(process.execPath, [cliPath, 'start', '--update-handoff', String(process.pid)], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, BOT_STATE_DIR: stateDir },
    });
    child.unref();

    if (!child.pid) {
        console.error('Failed to spawn new process');
        return false;
    }

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            readFileSync(readyFile, 'utf-8');
            try { unlinkSync(readyFile); } catch { /* ignore */ }
            return true;
        } catch { /* not ready yet */ }
        await new Promise((r) => setTimeout(r, 500));
    }

    try { process.kill(child.pid, 'SIGTERM'); } catch { /* ignore */ }
    return false;
}

export async function handleUpdate(_args: string[]): Promise<void> {
    const currentVersion = getVersion();
    console.log(`Current version: v${currentVersion}`);
    console.log('Checking for updates...');

    const latest = await checkForUpdate(currentVersion);

    if (!latest) {
        console.log(`Already on latest version (v${currentVersion}).`);
        return;
    }

    console.log(`New version available: v${latest}`);

    if (!runNpmInstall(latest)) {
        console.error('Update failed. Current version unchanged.');
        process.exit(1);
    }

    console.log(`Updated to v${latest}.`);

    const stateDir = getStateDir();
    if (isDaemonRunning(stateDir)) {
        const oldState = readDaemonState(stateDir)!;
        console.log(`Restarting daemon (PID ${oldState.pid})...`);

        process.kill(oldState.pid, 'SIGTERM');

        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            try { process.kill(oldState.pid, 0); await new Promise(r => setTimeout(r, 200)); }
            catch { break; }
        }

        const cliPath = resolveNewCliPath();
        const child = spawn(process.execPath, [cliPath, 'start'], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, BOT_STATE_DIR: stateDir },
        });
        child.unref();

        if (!child.pid) {
            removeDaemonState(stateDir);
            console.error('Failed to spawn new daemon process. Run `happy-discord-bot daemon start` to restart manually.');
            process.exit(1);
        }

        writeDaemonState(stateDir, {
            pid: child.pid,
            startTime: new Date().toISOString(),
            version: latest,
        });

        console.log(`Daemon restarted (PID ${child.pid}).`);
    }
}
