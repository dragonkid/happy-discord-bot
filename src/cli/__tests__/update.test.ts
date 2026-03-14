import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
    execFile: vi.fn(),
    spawn: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        readFileSync: vi.fn(actual.readFileSync),
        unlinkSync: vi.fn(actual.unlinkSync),
    };
});

vi.mock('../../version.js', () => ({
    getVersion: vi.fn(() => '0.1.0'),
}));

const { checkForUpdate, performDiscordUpdate, handleUpdate } = await import('../update.js');

describe('checkForUpdate', () => {
    it('returns null when already on latest', async () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(null, { stdout: '0.1.0\n', stderr: '' });
            return undefined as any;
        });
        expect(await checkForUpdate('0.1.0')).toBeNull();
    });

    it('returns latest version when update available', async () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(null, { stdout: '0.2.0\n', stderr: '' });
            return undefined as any;
        });
        expect(await checkForUpdate('0.1.0')).toBe('0.2.0');
    });

    it('returns null on registry error', async () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(new Error('network'));
            return undefined as any;
        });
        expect(await checkForUpdate('0.1.0')).toBeNull();
    });

    it('returns null when registry returns invalid semver', async () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(null, { stdout: 'not-a-version\n', stderr: '' });
            return undefined as any;
        });
        expect(await checkForUpdate('0.1.0')).toBeNull();
    });

    it('trims whitespace from registry output', async () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(null, { stdout: '  0.3.0  \n', stderr: '' });
            return undefined as any;
        });
        expect(await checkForUpdate('0.1.0')).toBe('0.3.0');
    });

    it('handles pre-release versions', async () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(null, { stdout: '0.2.0-beta.1\n', stderr: '' });
            return undefined as any;
        });
        expect(await checkForUpdate('0.1.0')).toBe('0.2.0-beta.1');
    });
});

describe('performDiscordUpdate', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        process.env.BOT_STATE_DIR = '/tmp/update-test-' + Date.now();
    });

    afterEach(() => {
        delete process.env.BOT_STATE_DIR;
    });

    it('returns false when npm install fails', async () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(new Error('npm install failed'));
            return undefined as any;
        });

        expect(await performDiscordUpdate('0.2.0')).toBe(false);
    });

    it('returns false when spawn produces no pid', async () => {
        // npm install succeeds
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(null, { stdout: '', stderr: '' });
            return undefined as any;
        });
        // resolveNewCliPath
        vi.mocked(execFileSync).mockReturnValue('/usr/local\n');
        // spawn returns no pid
        vi.mocked(spawn).mockReturnValue({ pid: undefined, unref: vi.fn() } as any);

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await performDiscordUpdate('0.2.0')).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith('Failed to spawn new process');
        consoleSpy.mockRestore();
    });

    it('returns true when ready file appears', async () => {
        // npm install succeeds
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(null, { stdout: '', stderr: '' });
            return undefined as any;
        });
        vi.mocked(execFileSync).mockReturnValue('/usr/local\n');
        vi.mocked(spawn).mockReturnValue({ pid: 12345, unref: vi.fn() } as any);

        // Simulate ready file appearing on second poll
        let readCount = 0;
        vi.mocked(fs.readFileSync).mockImplementation((path: any, ..._args: any[]) => {
            if (typeof path === 'string' && path.includes('update-ready')) {
                readCount++;
                if (readCount < 2) throw new Error('ENOENT');
                return String(process.pid);
            }
            throw new Error('ENOENT');
        });
        vi.mocked(fs.unlinkSync).mockImplementation(() => {});

        expect(await performDiscordUpdate('0.2.0')).toBe(true);
    });

    it('times out and kills child when ready file never appears', async () => {
        // npm install succeeds
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(null, { stdout: '', stderr: '' });
            return undefined as any;
        });
        vi.mocked(execFileSync).mockReturnValue('/usr/local\n');

        const killSpy = vi.fn();
        vi.mocked(spawn).mockReturnValue({ pid: 12345, unref: vi.fn() } as any);

        // readFileSync always throws (no ready file)
        vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

        // Override Date.now to simulate timeout
        const realNow = Date.now;
        let callCount = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => {
            callCount++;
            // First call sets deadline, second call exceeds it
            return callCount <= 1 ? realNow() : realNow() + 31_000;
        });

        const origKill = process.kill;
        process.kill = killSpy as any;

        const result = await performDiscordUpdate('0.2.0');

        process.kill = origKill;

        expect(result).toBe(false);
        expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    });
});

describe('handleUpdate', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        process.env.BOT_STATE_DIR = '/tmp/update-test-' + Date.now();
    });

    afterEach(() => {
        delete process.env.BOT_STATE_DIR;
    });

    it('prints "Already on latest" when no update available', async () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            cb(new Error('not found'));
            return undefined as any;
        });

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleUpdate([]);

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Already on latest'));
        logSpy.mockRestore();
    });

    it('reports update failure when npm install fails', async () => {
        // checkForUpdate returns new version
        let callCount = 0;
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
            callCount++;
            if (callCount === 1) {
                cb(null, { stdout: '0.2.0\n', stderr: '' });
            } else {
                cb(new Error('install failed'));
            }
            return undefined as any;
        });
        // runNpmInstall uses execFileSync
        vi.mocked(execFileSync).mockImplementation(() => { throw new Error('install failed'); });

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

        await handleUpdate([]);

        expect(errorSpy).toHaveBeenCalledWith('Update failed. Current version unchanged.');
        expect(exitSpy).toHaveBeenCalledWith(1);

        logSpy.mockRestore();
        errorSpy.mockRestore();
        exitSpy.mockRestore();
    });
});
