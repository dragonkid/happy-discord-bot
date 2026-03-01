import type { Config } from './config.js';
import type { Credentials } from './credentials.js';
import {
    decodeBase64,
    encodeBase64,
    decryptBoxBundle,
    decryptWithDataKey,
    decryptLegacy,
    encryptWithDataKey,
    libsodiumEncryptForPublicKey,
    getRandomBytes,
} from './encryption.js';

// --- Types ---

type WireSessionMessage = {
    id: string;
    seq: number;
    localId?: string | null | undefined;
    content: { c: string; t: 'encrypted' };
    createdAt: number;
    updatedAt: number;
};

export type EncryptionVariant = 'legacy' | 'dataKey';

export type SessionEncryption = {
    key: Uint8Array;
    variant: EncryptionVariant;
};

export type RawSession = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
};

export type DecryptedSession = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: unknown;
    agentState: unknown | null;
    dataEncryptionKey: string | null;
    encryption: SessionEncryption;
};

export type RawMessage = WireSessionMessage;

export type DecryptedMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

// --- Session encryption key resolution ---

export function resolveSessionEncryption(
    session: RawSession,
    creds: Credentials,
): SessionEncryption {
    if (session.dataEncryptionKey) {
        const encrypted = decodeBase64(session.dataEncryptionKey);
        // Strip version byte (first byte)
        const bundle = encrypted.slice(1);
        const sessionKey = decryptBoxBundle(bundle, creds.contentKeyPair.secretKey);
        if (!sessionKey) {
            throw new Error(`Failed to decrypt session key for session ${session.id}`);
        }
        return { key: sessionKey, variant: 'dataKey' };
    }
    // Legacy: use account secret directly
    return { key: creds.secret, variant: 'legacy' };
}

// --- Decrypt helpers ---

function decryptField(
    encrypted: string | null,
    encryption: SessionEncryption,
): unknown | null {
    if (!encrypted) return null;
    const data = decodeBase64(encrypted);
    if (encryption.variant === 'dataKey') {
        return decryptWithDataKey(data, encryption.key);
    }
    return decryptLegacy(data, encryption.key);
}

function decryptSession(raw: RawSession, creds: Credentials): DecryptedSession {
    const encryption = resolveSessionEncryption(raw, creds);
    return {
        id: raw.id,
        seq: raw.seq,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        active: raw.active,
        activeAt: raw.activeAt,
        metadata: decryptField(raw.metadata, encryption),
        agentState: decryptField(raw.agentState, encryption),
        dataEncryptionKey: raw.dataEncryptionKey,
        encryption,
    };
}

// --- Error handling ---

class ApiError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

function handleApiError(err: unknown, context: string): never {
    if (err instanceof ApiError) {
        const status = err.status;
        if (status === 401) {
            throw new Error('Authentication expired. Run `happy-agent auth login` to re-authenticate.');
        }
        if (status === 403) {
            throw new Error(`Forbidden: ${context}. Check your account permissions.`);
        }
        if (status === 404) {
            throw new Error(`Not found: ${context}`);
        }
        if (status >= 400 && status < 500) {
            throw new Error(`Request failed (${status}): ${err.message}`);
        }
        if (status >= 500) {
            throw new Error(`Server error (${status}): ${context}`);
        }
        throw new Error(`Request failed: ${err.message}`);
    }
    throw err;
}

function authHeaders(creds: Credentials): Record<string, string> {
    return { Authorization: `Bearer ${creds.token}` };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const resp = await fetch(url, init);
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new ApiError(resp.status, body);
    }
    return resp.json() as Promise<T>;
}

// --- API functions ---

export async function listSessions(
    config: Config,
    creds: Credentials,
): Promise<DecryptedSession[]> {
    let data: { sessions: RawSession[] };
    try {
        data = await fetchJson<{ sessions: RawSession[] }>(
            `${config.serverUrl}/v1/sessions`,
            { headers: authHeaders(creds) },
        );
    } catch (err) {
        handleApiError(err, 'listing sessions');
    }

    return data.sessions.map(raw => decryptSession(raw, creds));
}

export async function listActiveSessions(
    config: Config,
    creds: Credentials,
): Promise<DecryptedSession[]> {
    let data: { sessions: RawSession[] };
    try {
        data = await fetchJson<{ sessions: RawSession[] }>(
            `${config.serverUrl}/v2/sessions/active`,
            { headers: authHeaders(creds) },
        );
    } catch (err) {
        handleApiError(err, 'listing active sessions');
    }

    return data.sessions.map(raw => decryptSession(raw, creds));
}

export async function createSession(
    config: Config,
    creds: Credentials,
    opts: { tag: string; metadata: unknown },
): Promise<DecryptedSession & { sessionKey: Uint8Array }> {
    // Generate random 32-byte per-session AES key
    const sessionKey = getRandomBytes(32);

    // Encrypt session key with content public key, prepend version byte
    const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, creds.contentKeyPair.publicKey);
    const withVersion = new Uint8Array(1 + encryptedKey.length);
    withVersion[0] = 0x00; // version byte
    withVersion.set(encryptedKey, 1);
    const dataEncryptionKeyBase64 = encodeBase64(withVersion);

    // Encrypt metadata with the session key
    const encryptedMetadata = encryptWithDataKey(opts.metadata, sessionKey);
    const metadataBase64 = encodeBase64(encryptedMetadata);

    let data: { session: RawSession };
    try {
        data = await fetchJson<{ session: RawSession }>(
            `${config.serverUrl}/v1/sessions`,
            {
                method: 'POST',
                body: JSON.stringify({
                    tag: opts.tag,
                    metadata: metadataBase64,
                    dataEncryptionKey: dataEncryptionKeyBase64,
                }),
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeaders(creds),
                },
            },
        );
    } catch (err) {
        handleApiError(err, 'creating session');
    }

    const decrypted = decryptSession(data.session, creds);
    return { ...decrypted, sessionKey: decrypted.encryption.key };
}

export async function deleteSession(
    config: Config,
    creds: Credentials,
    sessionId: string,
): Promise<void> {
    try {
        const resp = await fetch(
            `${config.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
            {
                method: 'DELETE',
                headers: authHeaders(creds),
            },
        );
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new ApiError(resp.status, body);
        }
    } catch (err) {
        handleApiError(err, `deleting session ${sessionId}`);
    }
}

export async function getSessionMessages(
    config: Config,
    creds: Credentials,
    sessionId: string,
    encryption: SessionEncryption,
): Promise<DecryptedMessage[]> {
    let data: { messages: RawMessage[] };
    try {
        data = await fetchJson<{ messages: RawMessage[] }>(
            `${config.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
            { headers: authHeaders(creds) },
        );
    } catch (err) {
        handleApiError(err, `session ${sessionId} messages`);
    }

    return data.messages.map(msg => ({
        id: msg.id,
        seq: msg.seq,
        content: decryptField(msg.content.c, encryption),
        localId: msg.localId ?? null,
        createdAt: msg.createdAt,
        updatedAt: msg.updatedAt,
    }));
}
