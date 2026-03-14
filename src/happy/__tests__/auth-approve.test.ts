import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sharp', () => ({
    default: vi.fn(() => ({
        ensureAlpha: vi.fn().mockReturnThis(),
        raw: vi.fn().mockReturnThis(),
        toBuffer: vi.fn().mockResolvedValue({
            data: Buffer.alloc(400), // 10x10 RGBA
            info: { width: 10, height: 10, channels: 4 },
        }),
    })),
}));

vi.mock('../../vendor/encryption.js', () => ({
    decodeBase64Url: vi.fn((s: string) => {
        // Return 32 bytes for valid keys
        if (s === 'validkey32bytes_base64url_padded') return new Uint8Array(32);
        return new Uint8Array(Buffer.from(s, 'base64url'));
    }),
    encodeBase64: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString('base64')),
    libsodiumEncryptForPublicKey: vi.fn(() => new Uint8Array(80)),
}));

const { parseAccountAuthUrl, decodeQrFromImage, approveAccountAuth } = await import('../auth-approve.js');

describe('auth-approve', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        globalThis.fetch = vi.fn();
    });

    describe('parseAccountAuthUrl', () => {
        it('extracts public key from valid URL', () => {
            // 32-byte key base64url encoded
            const key = Buffer.alloc(32, 0xaa).toString('base64url');
            const result = parseAccountAuthUrl(`happy:///account?${key}`);
            expect(result).toBeInstanceOf(Uint8Array);
            expect(result!.length).toBe(32);
        });

        it('returns null for non-matching URL', () => {
            expect(parseAccountAuthUrl('https://example.com')).toBeNull();
        });

        it('returns null for wrong scheme', () => {
            const key = Buffer.alloc(32).toString('base64url');
            expect(parseAccountAuthUrl(`http:///account?${key}`)).toBeNull();
        });

        it('returns null for wrong key length', () => {
            const key = Buffer.alloc(16).toString('base64url');
            expect(parseAccountAuthUrl(`happy:///account?${key}`)).toBeNull();
        });

        it('returns null for empty query', () => {
            expect(parseAccountAuthUrl('happy:///account?')).toBeNull();
        });
    });

    describe('decodeQrFromImage', () => {
        it('returns null when no QR found (mock jsqr returns null)', async () => {
            // jsqr is CJS and require'd in the module — mock via vi.mock doesn't work well for require()
            // The default sharp mock returns a blank image which jsqr won't decode
            const result = await decodeQrFromImage(Buffer.alloc(100));
            expect(result).toBeNull();
        });
    });

    describe('approveAccountAuth', () => {
        it('sends encrypted response to server', async () => {
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
                    }),
                }),
            );
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
    });
});
