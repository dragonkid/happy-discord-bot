import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getVersion } from '../version.js';
import { readDaemonState, writeDaemonState, isDaemonRunning } from './daemon.js';

const PKG_NAME = 'happy-discord-bot';

export function checkForUpdate(currentVersion: string): string | null {
    try {
        const latest = execFileSync('npm', ['view', PKG_NAME, 'version'], { encoding: 'utf-8' }).trim();
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

function getStateDir(): string {
    return process.env.BOT_STATE_DIR || join(homedir(), '.happy-discord-bot');
}

export async function performDiscordUpdate(targetVersion: string): Promise<boolean> {
    try {
        execFileSync('npm', ['install', '-g', `${PKG_NAME}@${targetVersion}`], { stdio: 'pipe' });
    } catch {
        return false;
    }

    const cliPath = join(import.meta.dirname, '..', 'cli.js');
    const stateDir = getStateDir();
    const readyFile = join(stateDir, 'update-ready');

    const child = spawn(process.execPath, [cliPath, 'start', '--update-handoff', String(process.pid)], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, BOT_STATE_DIR: stateDir },
    });
    child.unref();

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            readFileSync(readyFile, 'utf-8');
            try { unlinkSync(readyFile); } catch { /* ignore */ }
            return true;
        } catch { /* not ready yet */ }
        await new Promise((r) => setTimeout(r, 500));
    }

    try { process.kill(child.pid!, 'SIGTERM'); } catch { /* ignore */ }
    return false;
}

export async function handleUpdate(_args: string[]): Promise<void> {
    const currentVersion = getVersion();
    console.log(`Current version: v${currentVersion}`);
    console.log('Checking for updates...');

    const latest = checkForUpdate(currentVersion);

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

        const cliPath = join(import.meta.dirname, '..', 'cli.js');
        const child = spawn(process.execPath, [cliPath, 'start'], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, BOT_STATE_DIR: stateDir },
        });
        child.unref();

        writeDaemonState(stateDir, {
            pid: child.pid!,
            startTime: new Date().toISOString(),
            version: latest,
        });

        console.log(`Daemon restarted (PID ${child.pid}).`);
    }
}
