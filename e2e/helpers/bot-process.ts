import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { waitFor, waitForExit } from './wait.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');

export class BotProcess {
    private proc: ChildProcess | null = null;
    private logs: string[] = [];
    private lastEnv: Record<string, string> = {};

    /**
     * Start the bot as a subprocess.
     */
    async start(env: Record<string, string>): Promise<void> {
        if (this.proc) throw new Error('Bot already running');

        this.logs = [];
        this.lastEnv = env;

        const merged = { ...process.env, ...env };
        this.proc = spawn('npx', ['tsx', 'src/index.ts'], {
            cwd: PROJECT_ROOT,
            env: merged,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.proc.stdout?.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n').filter(Boolean);
            for (const line of lines) {
                this.logs.push(line);
            }
        });

        this.proc.stderr?.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n').filter(Boolean);
            for (const line of lines) {
                this.logs.push(`[stderr] ${line}`);
            }
        });

        this.proc.on('exit', (code) => {
            console.log(`[BotProcess] exited with code ${code}`);
            this.proc = null;
        });

        await this.waitForLog('[Discord] Bot online', 30_000);
        console.log('[BotProcess] Bot is online');
    }

    /**
     * Stop the bot gracefully via SIGINT.
     */
    async stop(): Promise<void> {
        if (!this.proc) return;
        this.proc.kill('SIGINT');
        try {
            await waitForExit(this.proc, 10_000);
        } catch {
            this.proc?.kill('SIGKILL');
        }
        this.proc = null;
    }

    /**
     * Restart the bot (stop + start with same or overridden env).
     */
    async restart(envOverrides?: Record<string, string>): Promise<void> {
        await this.stop();
        await this.start({ ...this.lastEnv, ...envOverrides });
    }

    /**
     * Check if any log line contains the pattern.
     */
    hasLog(pattern: string): boolean {
        return this.logs.some((line) => line.includes(pattern));
    }

    /**
     * Wait for a log line matching the pattern to appear.
     */
    async waitForLog(pattern: string, timeout: number): Promise<string> {
        return waitFor(
            () => this.logs.find((line) => line.includes(pattern)),
            {
                timeout,
                interval: 500,
                label: `log "${pattern}"`,
                context: () => `Last 10 logs:\n${this.logs.slice(-10).join('\n')}`,
            },
        );
    }

    /**
     * Get all captured logs.
     */
    getLogs(): readonly string[] {
        return this.logs;
    }

    /**
     * Get logs captured after a certain index.
     */
    getLogsSince(index: number): readonly string[] {
        return this.logs.slice(index);
    }

    /**
     * Current log count (use as checkpoint before an action).
     */
    get logCount(): number {
        return this.logs.length;
    }
}
