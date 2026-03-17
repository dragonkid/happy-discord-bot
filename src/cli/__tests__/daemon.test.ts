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

vi.mock('../../credentials.js', () => ({
    readBotCredentials: vi.fn(() => null),
}));

vi.mock('../../vendor/encryption.js', () => ({
    decodeBase64: vi.fn(() => new Uint8Array(32)),
    deriveContentKeyPair: vi.fn(() => ({
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64),
    })),
    encodeBase64: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString('base64')),
}));

vi.mock('../../vendor/config.js', () => ({
    loadConfig: vi.fn(() => ({ serverUrl: 'https://api.test.com' })),
}));

vi.mock('../../vendor/api.js', () => ({
    listSessions: vi.fn(() => Promise.resolve([])),
    listMachines: vi.fn(() => Promise.resolve([])),
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

        it('prints daemon info and Happy Account when running', async () => {
            const state: DaemonState = { pid: process.pid, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['status']);

            expect(logSpy).toHaveBeenCalledWith('Daemon running');
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`PID:     ${process.pid}`));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Version: 0.1.0'));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Started:'));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Log:'));
            // showPairingStatus called (readBotCredentials returns null by default)
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Happy Account'));
            logSpy.mockRestore();
        });
    });

    describe('restart', () => {
        it('stops then starts when daemon is running', async () => {
            // Daemon is "running" (use own PID)
            const stateJson = JSON.stringify({ pid: process.pid, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' });

            // Track whether stop has cleaned up state
            let stopped = false;
            vi.mocked(fs.readFileSync).mockImplementation(() => {
                if (stopped) throw new Error('ENOENT');
                return stateJson;
            });
            vi.mocked(fs.unlinkSync).mockImplementation(() => { stopped = true; });

            // Mock kill: SIGTERM succeeds, then process appears dead
            let killCallCount = 0;
            const origKill = process.kill;
            process.kill = vi.fn((_pid: number, signal?: string | number) => {
                killCallCount++;
                if (signal === 'SIGTERM') return true;
                if (killCallCount <= 2) return true;
                throw new Error('ESRCH');
            }) as any;

            vi.mocked(spawn).mockReturnValue({ pid: 99, unref: vi.fn() } as any);

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['restart']);

            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Daemon stopped'));
            expect(spawn).toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PID 99'));

            process.kill = origKill;
            logSpy.mockRestore();
        });

        it('aborts start when stop times out', async () => {
            const stateJson = JSON.stringify({ pid: process.pid, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' });
            vi.mocked(fs.readFileSync).mockReturnValue(stateJson);
            vi.mocked(spawn).mockClear();

            // Mock kill: SIGTERM succeeds, but process never dies (always alive)
            const origKill = process.kill;
            process.kill = vi.fn(() => true) as any;

            // Speed up the 10s timeout by mocking Date.now
            let now = 1000;
            const origDateNow = Date.now;
            Date.now = () => { now += 5000; return now; }; // jump 5s per call

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await handleDaemon(['restart']);

            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('did not exit within 10s'));
            expect(spawn).not.toHaveBeenCalled(); // should NOT start

            process.kill = origKill;
            Date.now = origDateNow;
            logSpy.mockRestore();
            errorSpy.mockRestore();
        });

        it('just starts when daemon is not running', async () => {
            vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
            vi.mocked(spawn).mockReturnValue({ pid: 77, unref: vi.fn() } as any);

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleDaemon(['restart']);

            expect(spawn).toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PID 77'));
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
