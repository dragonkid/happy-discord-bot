import sharp from 'sharp';
import { decodeBase64Url, encodeBase64, libsodiumEncryptForPublicKey } from '../vendor/encryption.js';

// jsqr is CJS with `export default` in .d.ts — NodeNext sees it as namespace
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jsQR: typeof import('jsqr')['default'] = require('jsqr');

/**
 * Parse a happy:///account?<base64url-pubkey> URL and extract the ephemeral public key.
 */
export function parseAccountAuthUrl(url: string): Uint8Array | null {
    const match = url.match(/^happy:\/\/\/account\?(.+)$/);
    if (!match?.[1]) return null;

    try {
        const pubKey = decodeBase64Url(match[1]);
        if (pubKey.length !== 32) return null;
        return pubKey;
    } catch {
        return null;
    }
}

/**
 * Decode a QR code from an image buffer (PNG/JPEG).
 * Returns the decoded text content, or null if no QR code found.
 */
export async function decodeQrFromImage(imageBuffer: Buffer): Promise<string | null> {
    const { data, info } = await sharp(imageBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    const result = jsQR(pixels, info.width, info.height);
    return result?.data ?? null;
}

/**
 * Approve an account auth request by encrypting the secret for the requester's ephemeral public key.
 */
export async function approveAccountAuth(
    serverUrl: string,
    token: string,
    secret: Uint8Array,
    ephemeralPublicKey: Uint8Array,
): Promise<void> {
    const encrypted = libsodiumEncryptForPublicKey(secret, ephemeralPublicKey);

    const res = await fetch(`${serverUrl}/v1/auth/account/response`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
            publicKey: encodeBase64(ephemeralPublicKey),
            response: encodeBase64(encrypted),
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Approve failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
}
