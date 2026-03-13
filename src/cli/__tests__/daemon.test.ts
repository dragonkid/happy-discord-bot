import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', () => ({
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
}));

const { readDaemonState, writeDaemonState, removeDaemonState, isDaemonRunning } = await import('../daemon.js');
import type { DaemonState } from '../daemon.js';

describe('daemon state', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
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
