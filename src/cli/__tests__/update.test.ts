import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
    execFile: vi.fn(),
    spawn: vi.fn(),
}));

const { checkForUpdate } = await import('../update.js');

describe('checkForUpdate', () => {
    it('returns null when already on latest', () => {
        vi.mocked(execFileSync).mockReturnValue('0.1.0\n');
        expect(checkForUpdate('0.1.0')).toBeNull();
    });

    it('returns latest version when update available', () => {
        vi.mocked(execFileSync).mockReturnValue('0.2.0\n');
        expect(checkForUpdate('0.1.0')).toBe('0.2.0');
    });

    it('returns null on registry error', () => {
        vi.mocked(execFileSync).mockImplementation(() => { throw new Error('network'); });
        expect(checkForUpdate('0.1.0')).toBeNull();
    });
});
