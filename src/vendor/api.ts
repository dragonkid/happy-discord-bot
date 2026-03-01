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
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

async function handleApiResponse(resp: Response, context: string): Promise<void> {
    if (resp.ok) return;

    const status = resp.status;
    if (status === 401) {
        throw new ApiError('Authentication expired. Run `happy-agent auth login` to re-authenticate.', status);
    }
    if (status === 403) {
        throw new ApiError(`Forbidden: ${context}. Check your account permissions.`, status);
    }
    if (status === 404) {
        throw new ApiError(`Not found: ${context}`, status);
    }
    if (status >= 400 && status < 500) {
        let detail = '';
        try {
            const body = await resp.text();
            if (body) detail = `: ${body}`;
        } catch { /* ignore */ }
        throw new ApiError(`Request failed (${status})${detail}`, status);
    }
    if (status >= 500) {
        throw new ApiError(`Server error (${status}): ${context}`, status);
    }
    throw new ApiError(`Request failed: ${context}`, status);
}

function authHeaders(creds: Credentials): Record<string, string> {
    return { Authorization: `Bearer ${creds.token}` };
}

// --- API functions ---

export async function listSessions(
    config: Config,
    creds: Credentials,
): Promise<DecryptedSession[]> {
    const resp = await fetch(`${config.serverUrl}/v1/sessions`, {
        headers: authHeaders(creds),
    });
    await handleApiResponse(resp, 'listing sessions');
    const data = (await resp.json()) as { sessions: RawSession[] };
    return data.sessions.map(raw => decryptSession(raw, creds));
}

export async function listActiveSessions(
    config: Config,
    creds: Credentials,
): Promise<DecryptedSession[]> {
    const resp = await fetch(`${config.serverUrl}/v2/sessions/active`, {
        headers: authHeaders(creds),
    });
    await handleApiResponse(resp, 'listing active sessions');
    const data = (await resp.json()) as { sessions: RawSession[] };
    return data.sessions.map(raw => decryptSession(raw, creds));
}

export async function createSession(
    config: Config,
    creds: Credentials,
    opts: { tag: string; metadata: unknown },
): Promise<DecryptedSession & { sessionKey: Uint8Array }> {
    const sessionKey = getRandomBytes(32);

    const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, creds.contentKeyPair.publicKey);
    const withVersion = new Uint8Array(1 + encryptedKey.length);
    withVersion[0] = 0x00;
    withVersion.set(encryptedKey, 1);
    const dataEncryptionKeyBase64 = encodeBase64(withVersion);

    const encryptedMetadata = encryptWithDataKey(opts.metadata, sessionKey);
    const metadataBase64 = encodeBase64(encryptedMetadata);

    const resp = await fetch(`${config.serverUrl}/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(creds) },
        body: JSON.stringify({
            tag: opts.tag,
            metadata: metadataBase64,
            dataEncryptionKey: dataEncryptionKeyBase64,
        }),
    });
    await handleApiResponse(resp, 'creating session');
    const data = (await resp.json()) as { session: RawSession };

    const decrypted = decryptSession(data.session, creds);
    return { ...decrypted, sessionKey: decrypted.encryption.key };
}

export async function deleteSession(
    config: Config,
    creds: Credentials,
    sessionId: string,
): Promise<void> {
    const resp = await fetch(`${config.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: authHeaders(creds),
    });
    await handleApiResponse(resp, `deleting session ${sessionId}`);
}

export async function getSessionMessages(
    config: Config,
    creds: Credentials,
    sessionId: string,
    encryption: SessionEncryption,
): Promise<DecryptedMessage[]> {
    const resp = await fetch(
        `${config.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        { headers: authHeaders(creds) },
    );
    await handleApiResponse(resp, `session ${sessionId} messages`);
    const data = (await resp.json()) as { messages: RawMessage[] };

    return data.messages.map(msg => ({
        id: msg.id,
        seq: msg.seq,
        content: decryptField(msg.content.c, encryption),
        localId: msg.localId ?? null,
        createdAt: msg.createdAt,
        updatedAt: msg.updatedAt,
    }));
}
