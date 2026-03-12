import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn(),
    };
});

const { readDaemonState, writeDaemonState, isDaemonRunning } = await import('../daemon.js');
import type { DaemonState } from '../daemon.js';

describe('daemon state', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('readDaemonState returns null when file missing', () => {
        vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
        expect(readDaemonState('/tmp/test')).toBeNull();
    });

    it('readDaemonState parses valid state', () => {
        const state: DaemonState = { pid: 123, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' };
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
        expect(readDaemonState('/tmp/test')).toEqual(state);
    });

    it('writeDaemonState writes JSON', () => {
        writeDaemonState('/tmp/test', { pid: 123, startTime: '2026-01-01T00:00:00Z', version: '0.1.0' });
        expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('isDaemonRunning returns false when no state file', () => {
        vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
        expect(isDaemonRunning('/tmp/test')).toBe(false);
    });
});
