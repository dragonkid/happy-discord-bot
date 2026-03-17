import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { getVersion } from '../version.js';
import { getStateDir } from '../state-dir.js';
import { readBotCredentials } from '../credentials.js';
import { decodeBase64, deriveContentKeyPair } from '../vendor/encryption.js';
import { loadConfig as loadHappyConfig } from '../vendor/config.js';
import { listActiveSessions, type DecryptedSession } from '../vendor/api.js';
import type { SessionMetadata } from '../happy/types.js';

const DAEMON_STATE_FILE = 'daemon.state.json';

export function relativeTime(timestamp: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export interface DaemonState {
    pid: number;
    startTime: string;
    version: string;
}

export function readDaemonState(stateDir: string): DaemonState | null {
    try {
        const raw = readFileSync(join(stateDir, DAEMON_STATE_FILE), 'utf-8');
        return JSON.parse(raw) as DaemonState;
    } catch {
        return null;
    }
}

export function writeDaemonState(stateDir: string, state: DaemonState): void {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, DAEMON_STATE_FILE), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function removeDaemonState(stateDir: string): void {
    try { unlinkSync(join(stateDir, DAEMON_STATE_FILE)); } catch { /* ignore */ }
}

function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

export function isDaemonRunning(stateDir: string): boolean {
    const state = readDaemonState(stateDir);
    if (!state) return false;
    return isProcessAlive(state.pid);
}

export function startDaemon(): void {
    const stateDir = getStateDir();
    if (isDaemonRunning(stateDir)) {
        const state = readDaemonState(stateDir)!;
        console.log(`Daemon already running (PID ${state.pid})`);
        return;
    }

    const cliPath = join(import.meta.dirname, '..', 'cli.js');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const logPath = join(stateDir, 'daemon.log');
    const logFd = openSync(logPath, 'a');

    const child = spawn(process.execPath, [cliPath, 'start'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, BOT_STATE_DIR: stateDir },
    });
    child.unref();

    if (!child.pid) {
        console.error('Failed to spawn daemon process.');
        process.exit(1);
    }

    const state: DaemonState = {
        pid: child.pid,
        startTime: new Date().toISOString(),
        version: getVersion(),
    };
    writeDaemonState(stateDir, state);
    console.log(`Daemon started (PID ${state.pid})`);
}

async function stopDaemon(): Promise<boolean> {
    const stateDir = getStateDir();
    const state = readDaemonState(stateDir);

    if (!state) {
        console.log('No daemon state found.');
        return true;
    }

    if (!isProcessAlive(state.pid)) {
        console.log('Daemon not running (stale state file). Cleaning up.');
        removeDaemonState(stateDir);
        return true;
    }

    process.kill(state.pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID ${state.pid})`);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (!isProcessAlive(state.pid)) {
            removeDaemonState(stateDir);
            console.log('Daemon stopped.');
            return true;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    console.error(`Daemon did not exit within 10s. Try: kill -9 ${state.pid}`);
    return false;
}

function isValidMetadata(m: unknown): m is SessionMetadata {
    return !!m && typeof m === 'object' && 'path' in m && 'machineId' in m && 'host' in m;
}

export async function showPairingStatus(stateDir: string): Promise<void> {
    const botCreds = readBotCredentials(stateDir);
    if (!botCreds) {
        console.log('\nHappy Account');
        console.log('  Not linked. Run `happy-discord-bot auth login`.');
        return;
    }

    console.log('\nHappy Account');
    console.log(`  Status:  Linked (${botCreds.token.slice(0, 8)}...)`);

    let sessions: DecryptedSession[];
    try {
        const secret = decodeBase64(botCreds.secret);
        const contentKeyPair = deriveContentKeyPair(secret);
        const credentials = { token: botCreds.token, secret, contentKeyPair };
        const config = loadHappyConfig();
        sessions = await listActiveSessions(config, credentials);
    } catch (err) {
        console.log(`  Failed to fetch sessions: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    console.log(`  Active sessions: ${sessions.length}`);

    if (sessions.length === 0) {
        console.log('\nNo active sessions.');
        return;
    }

    // Group sessions by machine
    const machines = new Map<string, { host: string; machineId: string; sessions: DecryptedSession[] }>();
    for (const s of sessions) {
        const meta = isValidMetadata(s.metadata) ? s.metadata : null;
        const machineId = meta?.machineId ?? 'unknown';
        const host = meta?.host ?? 'unknown';
        const group = machines.get(machineId) ?? { host, machineId, sessions: [] };
        group.sessions.push(s);
        machines.set(machineId, group);
    }

    console.log('\nConnected Machines');
    for (const { host, machineId, sessions: machineSessions } of machines.values()) {
        console.log(`  ${host} (${machineId})`);
        const sorted = [...machineSessions].sort((a, b) => b.activeAt - a.activeAt);
        for (const s of sorted) {
            const meta = isValidMetadata(s.metadata) ? s.metadata : null;
            const path = meta?.path ?? 'unknown';
            const idPrefix = s.id.slice(0, 7);
            console.log(`    [${idPrefix}] ${path}  ${relativeTime(s.activeAt)}`);
        }
    }
}

async function statusDaemon(): Promise<void> {
    const stateDir = getStateDir();
    const state = readDaemonState(stateDir);

    if (!state) {
        console.log('No daemon running.');
        return;
    }

    if (!isProcessAlive(state.pid)) {
        console.log('Daemon not running (stale state file). Run `happy-discord-bot daemon stop` to clean up.');
        return;
    }

    console.log('Daemon running');
    console.log(`  PID:     ${state.pid}`);
    console.log(`  Version: ${state.version}`);
    console.log(`  Started: ${state.startTime}`);
    console.log(`  Log:     ${join(stateDir, 'daemon.log')}`);

    await showPairingStatus(stateDir);
}

async function restartDaemon(): Promise<void> {
    const stateDir = getStateDir();
    if (isDaemonRunning(stateDir)) {
        const stopped = await stopDaemon();
        if (!stopped) return;
    }
    startDaemon();
}

export async function handleDaemon(args: string[]): Promise<void> {
    const sub = args[0];
    switch (sub) {
        case 'start': startDaemon(); break;
        case 'stop': await stopDaemon(); break;
        case 'restart': await restartDaemon(); break;
        case 'status': await statusDaemon(); break;
        default:
            console.log('Usage: happy-discord-bot daemon <start|stop|restart|status>');
            process.exit(1);
    }
}
