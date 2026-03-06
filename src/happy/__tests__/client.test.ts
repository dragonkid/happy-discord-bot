import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HappyClient } from '../client.js';
import type { Config } from '../../vendor/config.js';
import type { Credentials } from '../../vendor/credentials.js';
import type { RawSession, SessionEncryption } from '../../vendor/api.js';

// --- Mock socket.io-client ---

const mockSocket = {
    on: vi.fn(),
    onAny: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    emitWithAck: vi.fn(),
    timeout: vi.fn(),
};
// timeout() returns an object with emitWithAck
mockSocket.timeout.mockReturnValue({ emitWithAck: mockSocket.emitWithAck });

vi.mock('socket.io-client', () => ({
    io: vi.fn(() => mockSocket),
}));

// --- Mock vendor modules ---

vi.mock('../../vendor/api.js', () => ({
    resolveSessionEncryption: vi.fn(
        (session: RawSession, _creds: Credentials): SessionEncryption => ({
            key: new Uint8Array(32),
            variant: session.dataEncryptionKey ? 'dataKey' : 'legacy',
        }),
    ),
}));

vi.mock('../../vendor/encryption.js', () => ({
    encrypt: vi.fn((_key: Uint8Array, _variant: string, data: unknown) => {
        return new TextEncoder().encode(JSON.stringify(data));
    }),
    decrypt: vi.fn((_key: Uint8Array, _variant: string, data: Uint8Array) => {
        try {
            return JSON.parse(new TextDecoder().decode(data));
        } catch {
            return null;
        }
    }),
    encodeBase64: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString('base64')),
    decodeBase64: vi.fn((str: string) => new Uint8Array(Buffer.from(str, 'base64'))),
}));

// --- Test fixtures ---

const testConfig: Config = {
    serverUrl: 'https://test.example.com',
    homeDir: '/tmp/.happy',
    credentialPath: '/tmp/.happy/agent.key',
};

const testCredentials: Credentials = {
    token: 'test-token',
    secret: new Uint8Array(32),
    contentKeyPair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(32),
    },
};

function makeRawSession(id: string, hasDataKey = true): RawSession {
    return {
        id,
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: '',
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: hasDataKey ? 'fakeEncryptedKey' : null,
    };
}

// --- Tests ---

describe('HappyClient', () => {
    let client: HappyClient;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSocket.connected = true;
        mockSocket.timeout.mockReturnValue({ emitWithAck: mockSocket.emitWithAck });
        client = new HappyClient(testConfig, testCredentials);
    });

    describe('connect', () => {
        it('creates Socket.IO connection with correct options', async () => {
            const { io } = await import('socket.io-client');
            client.connect();

            expect(io).toHaveBeenCalledWith('https://test.example.com', {
                path: '/v1/updates',
                auth: { token: 'test-token', clientType: 'user-scoped' },
                transports: ['websocket'],
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                reconnectionAttempts: Infinity,
            });
        });

        it('registers event handlers', () => {
            client.connect();

            expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
            expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
            expect(mockSocket.on).toHaveBeenCalledWith('connect_error', expect.any(Function));
            expect(mockSocket.onAny).toHaveBeenCalledWith(expect.any(Function));
        });

        it('is idempotent — calling twice does not create a second socket', async () => {
            const { io } = await import('socket.io-client');
            client.connect();
            client.connect();

            expect(io).toHaveBeenCalledTimes(1);
        });

        it('emits connected event on socket connect', () => {
            const handler = vi.fn();
            client.on('connected', handler);
            client.connect();

            const connectCallback = mockSocket.on.mock.calls.find(
                (call: unknown[]) => call[0] === 'connect',
            )?.[1];
            connectCallback?.();

            expect(handler).toHaveBeenCalledOnce();
        });

        it('emits disconnected event with reason', () => {
            const handler = vi.fn();
            client.on('disconnected', handler);
            client.connect();

            const disconnectCallback = mockSocket.on.mock.calls.find(
                (call: unknown[]) => call[0] === 'disconnect',
            )?.[1];
            disconnectCallback?.('io server disconnect');

            expect(handler).toHaveBeenCalledWith('io server disconnect');
        });

        it('emits connect_error event on error', () => {
            const handler = vi.fn();
            client.on('connect_error', handler);
            client.connect();

            const errorCallback = mockSocket.on.mock.calls.find(
                (call: unknown[]) => call[0] === 'connect_error',
            )?.[1];
            const error = new Error('connection refused');
            errorCallback?.(error);

            expect(handler).toHaveBeenCalledWith(error);
        });

        it('forwards update events via onAny', () => {
            const handler = vi.fn();
            client.on('update', handler);
            client.connect();

            const onAnyCallback = mockSocket.onAny.mock.calls[0][0];
            onAnyCallback('update', { body: { t: 'new-message' } });

            expect(handler).toHaveBeenCalledWith({ body: { t: 'new-message' } });
        });

        it('ignores non-update events in onAny', () => {
            const handler = vi.fn();
            client.on('update', handler);
            client.connect();

            const onAnyCallback = mockSocket.onAny.mock.calls[0][0];
            onAnyCallback('heartbeat', {});

            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe('close', () => {
        it('disconnects and nulls socket', () => {
            client.connect();
            client.close();

            expect(mockSocket.disconnect).toHaveBeenCalledOnce();
            expect(client.connected).toBe(false);
        });

        it('is safe to call when not connected', () => {
            expect(() => client.close()).not.toThrow();
        });
    });

    describe('connected', () => {
        it('returns false when no socket', () => {
            expect(client.connected).toBe(false);
        });

        it('reflects socket.connected state', () => {
            client.connect();
            mockSocket.connected = true;
            expect(client.connected).toBe(true);

            mockSocket.connected = false;
            expect(client.connected).toBe(false);
        });
    });

    describe('session encryption key management', () => {
        it('registers and retrieves session key', () => {
            const session = makeRawSession('sess-1');
            client.registerSessionKey(session);

            const enc = client.getSessionEncryption('sess-1');
            expect(enc).toBeDefined();
            expect(enc!.variant).toBe('dataKey');
        });

        it('registers legacy session key when no dataEncryptionKey', () => {
            const session = makeRawSession('sess-legacy', false);
            client.registerSessionKey(session);

            const enc = client.getSessionEncryption('sess-legacy');
            expect(enc).toBeDefined();
            expect(enc!.variant).toBe('legacy');
        });

        it('registers multiple session keys', () => {
            const sessions = [makeRawSession('s1'), makeRawSession('s2'), makeRawSession('s3')];
            client.registerSessionKeys(sessions);

            expect(client.getSessionEncryption('s1')).toBeDefined();
            expect(client.getSessionEncryption('s2')).toBeDefined();
            expect(client.getSessionEncryption('s3')).toBeDefined();
        });

        it('returns undefined for unknown session', () => {
            expect(client.getSessionEncryption('nonexistent')).toBeUndefined();
        });

        it('registers encryption directly without raw session', () => {
            const enc = { key: new Uint8Array(32), variant: 'dataKey' as const };
            client.registerSessionEncryption('direct-sess', enc);
            expect(client.getSessionEncryption('direct-sess')).toBe(enc);
        });

        it('removes session key', () => {
            client.registerSessionKey(makeRawSession('sess-1'));
            expect(client.getSessionEncryption('sess-1')).toBeDefined();

            client.removeSessionKey('sess-1');
            expect(client.getSessionEncryption('sess-1')).toBeUndefined();
        });
    });

    describe('sessionRPC', () => {
        it('throws when no encryption key for session', async () => {
            client.connect();
            await expect(
                client.sessionRPC('unknown-session', 'permission', {}),
            ).rejects.toThrow('No encryption key for session unknown-session');
        });

        it('throws when not connected', async () => {
            client.registerSessionKey(makeRawSession('sess-1'));
            await expect(
                client.sessionRPC('sess-1', 'permission', {}),
            ).rejects.toThrow('Not connected');
        });

        it('encrypts params, sends RPC, decrypts result', async () => {
            client.connect();
            client.registerSessionKey(makeRawSession('sess-1'));

            const responseData = { approved: true };
            const encodedResponse = Buffer.from(
                JSON.stringify(responseData),
            ).toString('base64');

            mockSocket.emitWithAck.mockResolvedValueOnce({
                ok: true,
                result: encodedResponse,
            });

            const result = await client.sessionRPC('sess-1', 'permission', {
                id: 'req-1',
                approved: true,
            });

            expect(result).toEqual(responseData);
            expect(mockSocket.emitWithAck).toHaveBeenCalledWith('rpc-call', {
                method: 'sess-1:permission',
                params: expect.any(String),
            });
        });

        it('throws on RPC failure', async () => {
            client.connect();
            client.registerSessionKey(makeRawSession('sess-1'));

            mockSocket.emitWithAck.mockResolvedValueOnce({
                ok: false,
                error: 'session not found',
            });

            await expect(
                client.sessionRPC('sess-1', 'permission', {}),
            ).rejects.toThrow('RPC failed [sess-1:permission]: session not found');
        });

        it('returns undefined when RPC returns no result (void handler)', async () => {
            client.connect();
            client.registerSessionKey(makeRawSession('sess-1'));

            mockSocket.emitWithAck.mockResolvedValueOnce({
                ok: true,
                result: undefined,
            });

            const result = await client.sessionRPC('sess-1', 'permission', {});
            expect(result).toBeUndefined();
        });

        it('returns undefined when decryption fails (void handler encrypted undefined)', async () => {
            client.connect();
            client.registerSessionKey(makeRawSession('sess-1'));

            // CLI encrypts undefined for void handlers; decrypt returns null
            const corruptData = Buffer.from('not-valid-json').toString('base64');
            mockSocket.emitWithAck.mockResolvedValueOnce({
                ok: true,
                result: corruptData,
            });

            const result = await client.sessionRPC('sess-1', 'permission', {});
            expect(result).toBeUndefined();
        });
    });

    describe('machineRPC', () => {
        it('uses legacy encryption with account secret', async () => {
            client.connect();

            const { encrypt } = await import('../../vendor/encryption.js');
            const responseData = { machines: [] };
            const encodedResponse = Buffer.from(
                JSON.stringify(responseData),
            ).toString('base64');

            mockSocket.emitWithAck.mockResolvedValueOnce({
                ok: true,
                result: encodedResponse,
            });

            const result = await client.machineRPC('machine-1', 'list', {});

            expect(result).toEqual(responseData);
            expect(encrypt).toHaveBeenCalledWith(
                testCredentials.secret,
                'legacy',
                {},
            );
            expect(mockSocket.emitWithAck).toHaveBeenCalledWith('rpc-call', {
                method: 'machine-1:list',
                params: expect.any(String),
            });
        });

        it('throws when not connected', async () => {
            await expect(
                client.machineRPC('machine-1', 'list', {}),
            ).rejects.toThrow('Not connected');
        });

        it('uses machineKey with dataKey variant when available', async () => {
            const machineKey = new Uint8Array(32).fill(0xab);
            const clientWithMachineKey = new HappyClient(testConfig, {
                ...testCredentials,
                machineKey,
            });
            clientWithMachineKey.connect();

            const { encrypt } = await import('../../vendor/encryption.js');
            const responseData = { sessionId: 'new-sess-123' };
            const encodedResponse = Buffer.from(
                JSON.stringify(responseData),
            ).toString('base64');

            mockSocket.emitWithAck.mockResolvedValueOnce({
                ok: true,
                result: encodedResponse,
            });

            const result = await clientWithMachineKey.machineRPC('machine-1', 'spawn', {});

            expect(result).toEqual(responseData);
            expect(encrypt).toHaveBeenCalledWith(machineKey, 'dataKey', {});
        });
    });

    describe('request', () => {
        it('sends HTTP request with auth header', async () => {
            const mockFetch = vi.fn().mockResolvedValue(new Response('{}'));
            vi.stubGlobal('fetch', mockFetch);

            await client.request('/v1/sessions');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://test.example.com/v1/sessions',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer test-token',
                    }),
                }),
            );

            vi.unstubAllGlobals();
        });

        it('preserves custom headers but Authorization always wins', async () => {
            const mockFetch = vi.fn().mockResolvedValue(new Response('{}'));
            vi.stubGlobal('fetch', mockFetch);

            await client.request('/v1/sessions', {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer attacker-token',
                },
            });

            const calledHeaders = mockFetch.mock.calls[0][1].headers;
            expect(calledHeaders.Authorization).toBe('Bearer test-token');
            expect(calledHeaders['Content-Type']).toBe('application/json');

            vi.unstubAllGlobals();
        });

        it('passes through method and body', async () => {
            const mockFetch = vi.fn().mockResolvedValue(new Response('{}'));
            vi.stubGlobal('fetch', mockFetch);

            await client.request('/v3/sessions/123/messages', {
                method: 'POST',
                body: JSON.stringify({ messages: [] }),
            });

            expect(mockFetch).toHaveBeenCalledWith(
                'https://test.example.com/v3/sessions/123/messages',
                expect.objectContaining({
                    method: 'POST',
                    body: '{"messages":[]}',
                }),
            );

            vi.unstubAllGlobals();
        });
    });
});
