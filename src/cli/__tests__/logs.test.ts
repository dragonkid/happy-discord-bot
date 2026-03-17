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

    it('prints error and exits with 1 when log file does not exist', async () => {
        vi.mocked(existsSync).mockReturnValue(false);
        const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

        await handleLogs();

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No log file found'));
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(spawn).not.toHaveBeenCalled();
        logSpy.mockRestore();
        exitSpy.mockRestore();
    });

    it('spawns tail -f and resolves when child closes', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        const handlers: Record<string, (...args: unknown[]) => void> = {};
        vi.mocked(spawn).mockReturnValue({
            on: vi.fn((event: string, cb: (...args: unknown[]) => void) => { handlers[event] = cb; }),
        } as any);

        const promise = handleLogs();
        // Simulate child close
        handlers['close']!();
        await promise;

        expect(spawn).toHaveBeenCalledWith(
            'tail',
            ['-f', expect.stringContaining('daemon.log')],
            expect.objectContaining({ stdio: 'inherit' }),
        );
    });
});
