import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface DaemonState {
    pid: number;
    httpPort: number;
}

interface TrackedSession {
    startedBy: string;
    happySessionId?: string;
    pid: number;
}

export class DaemonClient {
    private port: number | null = null;

    async connect(): Promise<void> {
        const stateFile = join(homedir(), '.happy', 'daemon.state.json');
        if (!existsSync(stateFile)) {
            throw new Error('Happy daemon not running — ~/.happy/daemon.state.json not found');
        }

        const raw = await readFile(stateFile, 'utf-8');
        const state: DaemonState = JSON.parse(raw);

        if (!state.httpPort || !state.pid) {
            throw new Error('Invalid daemon state file — missing httpPort or pid');
        }

        // Verify daemon process is alive
        try {
            process.kill(state.pid, 0);
        } catch {
            throw new Error(`Happy daemon PID ${state.pid} not running — state file is stale`);
        }

        this.port = state.httpPort;
    }

    async spawnSession(directory: string): Promise<string> {
        const result = await this.post('/spawn-session', {
            directory,
            approvedNewDirectoryCreation: true,
        });

        if (result.success && result.sessionId) {
            return result.sessionId as string;
        }

        throw new Error(`Failed to spawn session: ${JSON.stringify(result)}`);
    }

    async stopSession(sessionId: string): Promise<boolean> {
        const result = await this.post('/stop-session', { sessionId });
        return (result.success as boolean) ?? false;
    }

    async listSessions(): Promise<TrackedSession[]> {
        const result = await this.post('/list');
        return (result.children ?? []) as TrackedSession[];
    }

    private async post(path: string, body?: unknown): Promise<Record<string, unknown>> {
        if (!this.port) {
            throw new Error('DaemonClient not connected — call connect() first');
        }

        const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(20_000),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Daemon API ${path} returned HTTP ${response.status}: ${text}`);
        }

        return (await response.json()) as Record<string, unknown>;
    }
}
