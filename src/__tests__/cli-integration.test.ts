/**
 * CLI subprocess integration tests.
 * These spawn `node dist/cli.js` as a child process and verify stdout/stderr/exit codes.
 * Requires `npm run build` before running.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

/** Run CLI with isolated state dir (no real .env loaded) */
function runCli(args: string[], options?: { stateDir?: string; cwd?: string; env?: Record<string, string> }) {
    const stateDir = options?.stateDir ?? join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return execFileAsync(process.execPath, [CLI, ...args], {
        cwd: options?.cwd ?? tmpdir(),
        env: {
            ...process.env,
            BOT_STATE_DIR: stateDir,
            // Clear any inherited env vars that could interfere
            DISCORD_TOKEN: '',
            DISCORD_CHANNEL_ID: '',
            DISCORD_USER_ID: '',
            DISCORD_APPLICATION_ID: '',
            HAPPY_TOKEN: '',
            HAPPY_SECRET: '',
            ...options?.env,
        },
        timeout: 10_000,
    }).then(
        ({ stdout, stderr }) => ({ stdout, stderr, exitCode: 0 }),
        (err: any) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.code ?? 1 }),
    );
}

describe('CLI integration', () => {
    beforeAll(() => {
        // Verify build exists
        expect(existsSync(CLI), `dist/cli.js not found — run 'npm run build' first`).toBe(true);
    });

    // --- T1: version ---
    describe('version', () => {
        it('outputs version with "version" command', async () => {
            const { stdout, exitCode } = await runCli(['version']);
            expect(exitCode).toBe(0);
            expect(stdout.trim()).toMatch(/^happy-discord-bot v\d+\.\d+\.\d+$/);
        });

        it('outputs version with --version flag', async () => {
            const { stdout, exitCode } = await runCli(['--version']);
            expect(exitCode).toBe(0);
            expect(stdout.trim()).toMatch(/^happy-discord-bot v\d+\.\d+\.\d+$/);
        });
    });

    // --- help ---
    describe('help', () => {
        it('outputs usage with "help" command', async () => {
            const { stdout, exitCode } = await runCli(['help']);
            expect(exitCode).toBe(0);
            expect(stdout).toContain('Usage:');
            expect(stdout).toContain('happy-discord-bot');
        });

        it('outputs usage with --help flag', async () => {
            const { stdout, exitCode } = await runCli(['--help']);
            expect(exitCode).toBe(0);
            expect(stdout).toContain('Usage:');
        });

        it('outputs usage with -h flag', async () => {
            const { stdout, exitCode } = await runCli(['-h']);
            expect(exitCode).toBe(0);
            expect(stdout).toContain('Usage:');
        });
    });

    // --- T3: init ---
    describe('init', () => {
        it('exits with message when config already exists', async () => {
            const stateDir = join(tmpdir(), `cli-test-init-${Date.now()}`);
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, '.env'), 'EXISTING=true\n');

            const { stdout, exitCode } = await runCli(['init'], { stateDir });
            expect(exitCode).toBe(0);
            expect(stdout).toContain('Config already exists');

            rmSync(stateDir, { recursive: true, force: true });
        });
    });

    // --- T6: daemon status with stale state ---
    describe('daemon status', () => {
        it('reports stale state file without deleting it', async () => {
            const stateDir = join(tmpdir(), `cli-test-daemon-${Date.now()}`);
            mkdirSync(stateDir, { recursive: true });
            const stateFile = join(stateDir, 'daemon.state.json');
            writeFileSync(stateFile, JSON.stringify({ pid: 99999, startTime: '2026-01-01T00:00:00Z', version: '0.0.1' }));

            const { stdout, exitCode } = await runCli(['daemon', 'status'], { stateDir });
            expect(exitCode).toBe(0);
            expect(stdout).toContain('stale state file');
            // status should NOT delete the file
            expect(existsSync(stateFile)).toBe(true);

            rmSync(stateDir, { recursive: true, force: true });
        });

        it('reports no daemon when state file missing', async () => {
            const stateDir = join(tmpdir(), `cli-test-daemon-empty-${Date.now()}`);
            mkdirSync(stateDir, { recursive: true });

            const { stdout, exitCode } = await runCli(['daemon', 'status'], { stateDir });
            expect(exitCode).toBe(0);
            expect(stdout).toContain('No daemon running');

            rmSync(stateDir, { recursive: true, force: true });
        });

        it('daemon stop cleans up stale state file', async () => {
            const stateDir = join(tmpdir(), `cli-test-daemon-stop-${Date.now()}`);
            mkdirSync(stateDir, { recursive: true });
            const stateFile = join(stateDir, 'daemon.state.json');
            writeFileSync(stateFile, JSON.stringify({ pid: 99999, startTime: '2026-01-01T00:00:00Z', version: '0.0.1' }));

            const { stdout, exitCode } = await runCli(['daemon', 'stop'], { stateDir });
            expect(exitCode).toBe(0);
            expect(stdout).toContain('Cleaning up');
            expect(existsSync(stateFile)).toBe(false);

            rmSync(stateDir, { recursive: true, force: true });
        });
    });

    // --- T7: update (offline, registry unreachable) ---
    describe('update', () => {
        it('reports already on latest when npm view fails', async () => {
            // Point npm to a non-existent registry with minimal timeout
            const { stdout, exitCode } = await runCli(['update'], {
                env: {
                    npm_config_registry: 'http://localhost:1',
                    npm_config_fetch_timeout: '1000',
                    npm_config_fetch_retries: '0',
                },
            });
            expect(exitCode).toBe(0);
            expect(stdout).toContain('Already on latest version');
        }, 15_000);
    });

    // --- T8: deploy-commands without env vars ---
    describe('deploy-commands', () => {
        it('fails with clear error when DISCORD_TOKEN missing', async () => {
            const { stderr, exitCode } = await runCli(['deploy-commands']);
            expect(exitCode).not.toBe(0);
            expect(stderr).toContain('DISCORD_TOKEN is required');
        });
    });

    // --- T13: handoff PID validation ---
    describe('handoff PID validation', () => {
        it('rejects non-numeric PID', async () => {
            const { stderr, exitCode } = await runCli(['start', '--update-handoff', 'abc']);
            expect(exitCode).not.toBe(0);
            expect(stderr).toContain('Invalid --update-handoff PID');
        });

        it('rejects negative PID', async () => {
            const { stderr, exitCode } = await runCli(['start', '--update-handoff', '-1']);
            expect(exitCode).not.toBe(0);
            expect(stderr).toContain('Invalid --update-handoff PID');
        });

        it('rejects missing PID argument', async () => {
            const { stderr, exitCode } = await runCli(['start', '--update-handoff']);
            expect(exitCode).not.toBe(0);
            expect(stderr).toContain('Invalid --update-handoff PID');
        });
    });

    // --- T14: npm pack content ---
    describe('package content', () => {
        it('.npmignore excludes source and test files', () => {
            const npmignore = readFileSync(join(import.meta.dirname, '..', '..', '.npmignore'), 'utf-8');
            expect(npmignore).toContain('src/');
            expect(npmignore).toContain('e2e/');
            expect(npmignore).toContain('__tests__');
            expect(npmignore).toContain('.env*');
            expect(npmignore).toContain('CLAUDE.md');
        });

        it('dist/cli.js exists after build', () => {
            expect(existsSync(CLI)).toBe(true);
        });

        it('package.json has correct bin entry', () => {
            const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf-8'));
            expect(pkg.bin['happy-discord-bot']).toBe('dist/cli.js');
            expect(pkg.files).toEqual(['dist']);
            expect(pkg.engines.node).toBe('>=20');
        });
    });

    // --- T11: handoff ready file protocol ---
    describe('handoff ready file', () => {
        it('new process writes ready file after start with valid handoff PID', async () => {
            // We can't fully test the handoff (requires Discord + Happy connections),
            // but we can verify PID validation passes and process attempts startup.
            // With missing env vars, it will fail at config load — but AFTER PID validation.
            const { stderr, exitCode } = await runCli(['start', '--update-handoff', String(process.pid)]);
            // Should fail at config load, not at PID validation
            expect(exitCode).not.toBe(0);
            expect(stderr).not.toContain('Invalid --update-handoff PID');
            expect(stderr).toContain('config error');
        });
    });

    // --- T14: npm pack content verification ---
    describe('npm pack', () => {
        it('pack dry-run excludes source, e2e, and env files', async () => {
            const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], {
                cwd: join(import.meta.dirname, '..', '..'),
                timeout: 15_000,
            });
            const [result] = JSON.parse(stdout);
            const files: string[] = result.files.map((f: { path: string }) => f.path);

            // Source code, e2e tests, and env files must NOT be included
            expect(files.some((f: string) => f.startsWith('src/'))).toBe(false);
            expect(files.some((f: string) => f.startsWith('e2e/'))).toBe(false);
            expect(files.some((f: string) => f.endsWith('.env') || f.endsWith('.env.example'))).toBe(false);
            expect(files.some((f: string) => f === 'CLAUDE.md')).toBe(false);

            // dist/cli.js must be included
            expect(files).toContain('dist/cli.js');
        });

        it('dist/cli.js has shebang line', () => {
            const firstLine = readFileSync(CLI, 'utf-8').split('\n')[0];
            expect(firstLine).toBe('#!/usr/bin/env node');
        });
    });

    // Note: init file permissions (0o600/0o700) tested in src/cli/__tests__/init.test.ts via unit tests.
    // Subprocess stdin piping to readline is unreliable in vitest, so init creation is not tested here.
});
