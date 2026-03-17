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

const { parseAuthUrl, approveTerminalAuth } = await import('../auth-approve.js');

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

    describe('approveTerminalAuth', () => {
        const mockStatusResponse = (status: string, supportsV2 = false) => ({
            ok: true,
            json: async () => ({ status, supportsV2 }),
        } as Response);

        it('checks status then sends v1 encrypted response', async () => {
            vi.mocked(globalThis.fetch)
                .mockResolvedValueOnce(mockStatusResponse('pending'))
                .mockResolvedValueOnce({ ok: true } as Response);

            await approveTerminalAuth(
                'https://api.test.com',
                'tok-123',
                new Uint8Array(32),
                new Uint8Array(32),
            );

            // First call: status check
            expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toMatch(
                /\/v1\/auth\/request\/status\?publicKey=/,
            );

            // Second call: approve via /v1/auth/response
            expect(vi.mocked(globalThis.fetch).mock.calls[1][0]).toBe(
                'https://api.test.com/v1/auth/response',
            );
            const callBody = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[1][1]!.body as string);
            expect(callBody).toHaveProperty('publicKey');
            expect(callBody).toHaveProperty('response');
        });

        it('returns early when status is authorized', async () => {
            vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockStatusResponse('authorized'));

            await approveTerminalAuth('https://api.test.com', 'tok', new Uint8Array(32), new Uint8Array(32));

            // Only one fetch call (status check), no approve call
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });

        it('throws when status is not_found', async () => {
            vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockStatusResponse('not_found'));

            await expect(
                approveTerminalAuth('https://api.test.com', 'tok', new Uint8Array(32), new Uint8Array(32)),
            ).rejects.toThrow('Auth request not found or expired');
        });

        it('throws on approve server error', async () => {
            vi.mocked(globalThis.fetch)
                .mockResolvedValueOnce(mockStatusResponse('pending'))
                .mockResolvedValueOnce({
                    ok: false,
                    status: 403,
                    statusText: 'Forbidden',
                    text: async () => 'not allowed',
                } as Response);

            await expect(
                approveTerminalAuth('https://api.test.com', 'tok', new Uint8Array(32), new Uint8Array(32)),
            ).rejects.toThrow('Approve failed: 403 Forbidden');
        });

        it('truncates long error body to 200 chars', async () => {
            const longBody = 'x'.repeat(300);
            vi.mocked(globalThis.fetch)
                .mockResolvedValueOnce(mockStatusResponse('pending'))
                .mockResolvedValueOnce({
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                    text: async () => longBody,
                } as Response);

            await expect(
                approveTerminalAuth('https://api.test.com', 'tok', new Uint8Array(32), new Uint8Array(32)),
            ).rejects.toThrow('...');
        });

        it('throws on status check failure', async () => {
            vi.mocked(globalThis.fetch).mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            } as Response);

            await expect(
                approveTerminalAuth('https://api.test.com', 'tok', new Uint8Array(32), new Uint8Array(32)),
            ).rejects.toThrow('Status check failed: 500');
        });
    });
});
