import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', () => ({
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
}));

vi.mock('../vendor/encryption.js', () => ({
    encodeBase64: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString('base64')),
}));

const { readBotCredentials, writeBotCredentials, removeBotCredentials } = await import('../credentials.js');

describe('credentials', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('readBotCredentials', () => {
        it('returns parsed credentials when file exists', () => {
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
                token: 'tok-abc',
                secret: 'c2VjcmV0',
            }));
            const result = readBotCredentials('/tmp/state');
            expect(result).toEqual({ token: 'tok-abc', secret: 'c2VjcmV0' });
        });

        it('returns null when file does not exist', () => {
            vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
            expect(readBotCredentials('/tmp/state')).toBeNull();
        });

        it('returns null when file has invalid JSON', () => {
            vi.mocked(fs.readFileSync).mockReturnValue('not json');
            expect(readBotCredentials('/tmp/state')).toBeNull();
        });

        it('returns null when token is missing', () => {
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ secret: 's' }));
            expect(readBotCredentials('/tmp/state')).toBeNull();
        });

        it('returns null when secret is missing', () => {
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: 't' }));
            expect(readBotCredentials('/tmp/state')).toBeNull();
        });
    });

    describe('writeBotCredentials', () => {
        it('creates directory and writes file with correct permissions', () => {
            const secret = new Uint8Array([1, 2, 3]);
            writeBotCredentials('/tmp/state', 'my-token', secret);

            expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/state', { recursive: true, mode: 0o700 });
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                expect.stringContaining('credentials.json'),
                expect.stringContaining('my-token'),
                { mode: 0o600 },
            );
        });
    });

    describe('removeBotCredentials', () => {
        it('returns true when file is deleted', () => {
            vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
            expect(removeBotCredentials('/tmp/state')).toBe(true);
        });

        it('returns false when file does not exist', () => {
            vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
            expect(removeBotCredentials('/tmp/state')).toBe(false);
        });
    });
});
