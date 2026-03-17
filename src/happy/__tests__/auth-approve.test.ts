import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../vendor/encryption.js', () => ({
    decodeBase64Url: vi.fn((s: string) => {
        // Return 32 bytes for valid keys
        if (s === 'validkey32bytes_base64url_padded') return new Uint8Array(32);
        return new Uint8Array(Buffer.from(s, 'base64url'));
    }),
    encodeBase64: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString('base64')),
    libsodiumEncryptForPublicKey: vi.fn(() => new Uint8Array(80)),
}));

const { parseAuthUrl, approveAccountAuth } = await import('../auth-approve.js');

describe('auth-approve', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        globalThis.fetch = vi.fn();
    });

    describe('parseAuthUrl', () => {
        it('extracts public key from happy://terminal? URL', () => {
            const key = Buffer.alloc(32, 0xaa).toString('base64url');
            const result = parseAuthUrl(`happy://terminal?${key}`);
            expect(result).toBeInstanceOf(Uint8Array);
            expect(result!.length).toBe(32);
        });

        it('extracts public key from happy:///account? URL', () => {
            const key = Buffer.alloc(32, 0xbb).toString('base64url');
            const result = parseAuthUrl(`happy:///account?${key}`);
            expect(result).toBeInstanceOf(Uint8Array);
            expect(result!.length).toBe(32);
        });

        it('returns null for non-matching URL', () => {
            expect(parseAuthUrl('https://example.com')).toBeNull();
        });

        it('returns null for wrong scheme', () => {
            const key = Buffer.alloc(32).toString('base64url');
            expect(parseAuthUrl(`http://terminal?${key}`)).toBeNull();
        });

        it('returns null for wrong key length', () => {
            const key = Buffer.alloc(16).toString('base64url');
            expect(parseAuthUrl(`happy://terminal?${key}`)).toBeNull();
        });

        it('returns null for empty query', () => {
            expect(parseAuthUrl('happy://terminal?')).toBeNull();
        });

        it('returns null for malformed base64url (decodeBase64Url throws)', async () => {
            const { decodeBase64Url } = await import('../../vendor/encryption.js');
            vi.mocked(decodeBase64Url).mockImplementationOnce(() => { throw new Error('bad base64'); });
            expect(parseAuthUrl('happy://terminal?!!!invalid!!!')).toBeNull();
        });
    });

    describe('approveAccountAuth', () => {
        it('sends encrypted response to server with correct body', async () => {
            vi.mocked(globalThis.fetch).mockResolvedValue({ ok: true } as Response);

            await approveAccountAuth(
                'https://api.test.com',
                'tok-123',
                new Uint8Array(32),
                new Uint8Array(32),
            );

            expect(globalThis.fetch).toHaveBeenCalledWith(
                'https://api.test.com/v1/auth/account/response',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer tok-123',
                        'Content-Type': 'application/json',
                    }),
                }),
            );

            // Verify body contains publicKey and response fields
            const callBody = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
            expect(callBody).toHaveProperty('publicKey');
            expect(callBody).toHaveProperty('response');
            expect(typeof callBody.publicKey).toBe('string');
            expect(typeof callBody.response).toBe('string');
        });

        it('throws on server error', async () => {
            vi.mocked(globalThis.fetch).mockResolvedValue({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                text: async () => 'not allowed',
            } as Response);

            await expect(
                approveAccountAuth('https://api.test.com', 'tok', new Uint8Array(32), new Uint8Array(32)),
            ).rejects.toThrow('Approve failed: 403 Forbidden');
        });

        it('truncates long error body to 200 chars', async () => {
            const longBody = 'x'.repeat(300);
            vi.mocked(globalThis.fetch).mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: async () => longBody,
            } as Response);

            await expect(
                approveAccountAuth('https://api.test.com', 'tok', new Uint8Array(32), new Uint8Array(32)),
            ).rejects.toThrow('...');
        });

        it('handles body read failure gracefully', async () => {
            vi.mocked(globalThis.fetch).mockResolvedValue({
                ok: false,
                status: 502,
                statusText: 'Bad Gateway',
                text: async () => { throw new Error('stream broken'); },
            } as unknown as Response);

            await expect(
                approveAccountAuth('https://api.test.com', 'tok', new Uint8Array(32), new Uint8Array(32)),
            ).rejects.toThrow('Approve failed: 502 Bad Gateway');
        });
    });
});
