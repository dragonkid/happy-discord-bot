import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

const { handleLogs } = await import('../logs.js');

describe('handleLogs', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        process.env.BOT_STATE_DIR = '/tmp/logs-test';
    });

    afterEach(() => {
        delete process.env.BOT_STATE_DIR;
    });

    it('prints error when log file does not exist', async () => {
        vi.mocked(existsSync).mockReturnValue(false);
        const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await handleLogs();

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No log file found'));
        expect(spawn).not.toHaveBeenCalled();
        logSpy.mockRestore();
    });

    it('spawns tail -f on daemon.log when file exists', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const mockOn = vi.fn();
        vi.mocked(spawn).mockReturnValue({ on: mockOn } as any);

        await handleLogs();

        expect(spawn).toHaveBeenCalledWith(
            'tail',
            ['-f', expect.stringContaining('daemon.log')],
            expect.objectContaining({ stdio: 'inherit' }),
        );
    });
});
