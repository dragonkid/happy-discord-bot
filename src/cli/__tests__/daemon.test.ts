import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';

vi.mock('node:fs', () => ({
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    openSync: vi.fn(() => 3), // fake fd
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('../../version.js', () => ({
    getVersion: vi.fn(() => '0.1.0'),
}));

const { readDaemonState, writeDaemonState, removeDaemonState, isDaemonRunning, handleDaemon } = await import('../daemon.js');
import type { DaemonState } from '../daemon.js';

describe('daemon state', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        process.env.BOT_STATE_DIR = '/tmp/daemon-test';
    });

    afterEach(() => {
        delete process.env.BOT_STATE_DIR;
    });

    it('readDaemonState returns null when file missing', () => {
        vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
        expect(readDaemonState('/tmp/test')).toBeNull();
    });

    it('readDaemonState returns null on invalid JSON', () => {
        vi.mocked(fs.readFileSync).mockReturnValue('not-json');
        expect(readDaemonState('/tmp/test')).toBeNull();
    });

    it('readDaemonState parses valid state', () => {
        const state: DaemonState = { pid: 123, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
        expect(readDaemonState('/tmp/test')).toEqual(state);
    });

    it('writeDaemonState creates dir with 0o700 and file with 0o600', () => {
        writeDaemonState('/tmp/test', { pid: 123, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' });
        expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/test', { recursive: true, mode: 0o700 });
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining('daemon.state.json'),
            expect.any(String),
            { mode: 0o600 },
        );
    });

    it('removeDaemonState deletes the state file', () => {
        removeDaemonState('/tmp/test');
        expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('daemon.state.json'));
    });

    it('removeDaemonState ignores errors when file missing', () => {
        vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
        expect(() => removeDaemonState('/tmp/test')).not.toThrow();
    });

    it('isDaemonRunning returns false when no state file', () => {
        vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
        expect(isDaemonRunning('/tmp/test')).toBe(false);
    });

    it('isDaemonRunning returns false when process is dead', () => {
        const state: DaemonState = { pid: 999999, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
        // PID 999999 almost certainly doesn't exist
        expect(isDaemonRunning('/tmp/test')).toBe(false);
    });

    it('isDaemonRunning returns true for own process', () => {
        const state: DaemonState = { pid: process.pid, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
        expect(isDaemonRunning('/tmp/test')).toBe(true);
    });
});

describe('handleDaemon', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        process.env.BOT_STATE_DIR = '/tmp/daemon-test';
    });

    afterEach(() => {
        delete process.env.BOT_STATE_DIR;
    });

    describe('start', () => {
        it('prints "already running" when daemon is active', async () => {
            // isDaemonRunning: state file exists + process alive (use own PID)
            const state: DaemonState = { pid: process.pid, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['start']);

            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
            expect(spawn).not.toHaveBeenCalled();
            logSpy.mockRestore();
        });

        it('spawns child process and writes state on success', async () => {
            // No existing daemon
            vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
            vi.mocked(spawn).mockReturnValue({ pid: 42, unref: vi.fn() } as any);

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['start']);

            expect(spawn).toHaveBeenCalledWith(
                process.execPath,
                expect.arrayContaining(['start']),
                expect.objectContaining({ detached: true }),
            );
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                expect.stringContaining('daemon.state.json'),
                expect.stringContaining('"pid": 42'),
                expect.any(Object),
            );
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PID 42'));
            logSpy.mockRestore();
        });

        it('exits with 1 when spawn fails (no pid)', async () => {
            vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
            vi.mocked(spawn).mockReturnValue({ pid: undefined, unref: vi.fn() } as any);

            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

            await handleDaemon(['start']);

            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to spawn'));
            expect(exitSpy).toHaveBeenCalledWith(1);
            errorSpy.mockRestore();
            exitSpy.mockRestore();
        });
    });

    describe('stop', () => {
        it('prints "no state found" when no daemon state file', async () => {
            vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['stop']);

            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No daemon state found'));
            logSpy.mockRestore();
        });

        it('cleans up stale state when process is dead', async () => {
            const state: DaemonState = { pid: 999999, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['stop']);

            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stale'));
            expect(fs.unlinkSync).toHaveBeenCalled();
            logSpy.mockRestore();
        });

        it('sends SIGTERM and removes state when process exits', async () => {
            // Use a PID that is alive initially, then dies after kill
            const state: DaemonState = { pid: process.pid, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));

            const killSpy = vi.fn();
            let killCallCount = 0;
            killSpy.mockImplementation((_pid: number, signal?: string | number) => {
                killCallCount++;
                if (signal === 'SIGTERM') return; // first call: SIGTERM
                if (killCallCount <= 2) return; // signal=0 check, still alive
                throw new Error('ESRCH'); // process exited
            });
            const origKill = process.kill;
            process.kill = killSpy as any;

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['stop']);

            expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
            expect(logSpy).toHaveBeenCalledWith('Daemon stopped.');
            expect(fs.unlinkSync).toHaveBeenCalled();

            process.kill = origKill;
            logSpy.mockRestore();
        });
    });

    describe('status', () => {
        it('prints "no daemon running" when no state file', async () => {
            vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['status']);

            expect(logSpy).toHaveBeenCalledWith('No daemon running.');
            logSpy.mockRestore();
        });

        it('prints stale warning when process is dead', async () => {
            const state: DaemonState = { pid: 999999, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['status']);

            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stale'));
            logSpy.mockRestore();
        });

        it('prints daemon info when running', async () => {
            const state: DaemonState = { pid: process.pid, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['status']);

            expect(logSpy).toHaveBeenCalledWith('Daemon running');
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`PID:     ${process.pid}`));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Version: 0.1.0'));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Started:'));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Log:'));
            logSpy.mockRestore();
        });
    });

    describe('unknown subcommand', () => {
        it('prints usage and exits with 1', async () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

            await handleDaemon(['badcmd']);

            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
            expect(exitSpy).toHaveBeenCalledWith(1);
            logSpy.mockRestore();
            exitSpy.mockRestore();
        });
    });
});
