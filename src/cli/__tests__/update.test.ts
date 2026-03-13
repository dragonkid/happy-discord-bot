import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
    execFile: vi.fn(),
    spawn: vi.fn(),
}));

const { checkForUpdate } = await import('../update.js');

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
