import { decodeBase64Url, encodeBase64, libsodiumEncryptForPublicKey } from '../vendor/encryption.js';

/**
 * Parse a happy:// auth URL and extract the ephemeral public key.
 * Supports both formats:
 *   - happy:///account?<base64url-pubkey>  (QR code / mobile app)
 *   - happy://terminal?<base64url-pubkey>  (CLI terminal output)
 */
export function parseAuthUrl(url: string): Uint8Array | null {
    const match = url.match(/^happy:\/\/(?:\/account|terminal)\?(.+)$/);
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
        const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
        throw new Error(`Approve failed: ${res.status} ${res.statusText}${truncated ? ` — ${truncated}` : ''}`);
    }
}
