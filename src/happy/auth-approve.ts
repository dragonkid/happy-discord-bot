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

interface AuthRequestStatus {
    status: 'not_found' | 'pending' | 'authorized';
    supportsV2: boolean;
}

/**
 * Approve a terminal auth request.
 * Flow: check status → encrypt secret for ephemeral key → POST /v1/auth/response.
 * Uses v1 response (secret only) since bot has no contentDataKey.
 */
export async function approveTerminalAuth(
    serverUrl: string,
    token: string,
    secret: Uint8Array,
    ephemeralPublicKey: Uint8Array,
): Promise<void> {
    const publicKeyBase64 = encodeBase64(ephemeralPublicKey);
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };

    // Check request status first
    const statusRes = await fetch(
        `${serverUrl}/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
    );
    if (!statusRes.ok) {
        throw new Error(`Status check failed: ${statusRes.status} ${statusRes.statusText}`);
    }
    const { status } = await statusRes.json() as AuthRequestStatus;

    if (status === 'authorized') return;
    if (status === 'not_found') {
        throw new Error('Auth request not found or expired. Please re-run `happy auth` on the target machine.');
    }

    // Encrypt secret for the ephemeral public key (v1 format: 32-byte secret)
    const encrypted = libsodiumEncryptForPublicKey(secret, ephemeralPublicKey);

    const res = await fetch(`${serverUrl}/v1/auth/response`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            publicKey: publicKeyBase64,
            response: encodeBase64(encrypted),
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
        throw new Error(`Approve failed: ${res.status} ${res.statusText}${truncated ? ` — ${truncated}` : ''}`);
    }
}
