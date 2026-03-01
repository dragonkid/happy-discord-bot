import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import type { Config } from '../vendor/config.js';
import type { Credentials } from '../vendor/credentials.js';
import type { SessionEncryption, RawSession } from '../vendor/api.js';
import { resolveSessionEncryption } from '../vendor/api.js';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '../vendor/encryption.js';
import type { RpcCallPayload, RpcResult } from './types.js';

// --- Typed events ---

interface HappyClientEvents {
    connected: [];
    disconnected: [reason: string];
    connect_error: [error: Error];
    update: [data: unknown];
}

// --- HappyClient ---

export class HappyClient extends EventEmitter<HappyClientEvents> {
    private readonly config: Config;
    private readonly credentials: Credentials;
    private readonly sessionKeys = new Map<string, SessionEncryption>();
    private socket: Socket | null = null;

    constructor(config: Config, credentials: Credentials) {
        super();
        this.config = config;
        this.credentials = credentials;
    }

    // --- Connection ---

    connect(): void {
        if (this.socket) return;

        this.socket = io(this.config.serverUrl, {
            path: '/v1/updates',
            auth: { token: this.credentials.token, clientType: 'user-scoped' },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity,
        });

        this.socket.on('connect', () => this.emit('connected'));
        this.socket.on('disconnect', (reason) => this.emit('disconnected', reason));
        this.socket.on('connect_error', (err) => {
            console.error('[HappyClient] connect_error:', err.message);
            this.emit('connect_error', err);
        });
        this.socket.onAny((event: string, data: unknown) => {
            if (event === 'update') {
                this.emit('update', data);
            }
        });
    }

    close(): void {
        this.socket?.disconnect();
        this.socket = null;
    }

    get connected(): boolean {
        return this.socket?.connected ?? false;
    }

    // --- Session encryption key management ---

    registerSessionKey(session: RawSession): void {
        const encryption = resolveSessionEncryption(session, this.credentials);
        this.sessionKeys.set(session.id, encryption);
    }

    registerSessionKeys(sessions: readonly RawSession[]): void {
        for (const session of sessions) {
            this.registerSessionKey(session);
        }
    }

    getSessionEncryption(sessionId: string): SessionEncryption | undefined {
        return this.sessionKeys.get(sessionId);
    }

    /** Register a pre-resolved encryption key for a session. */
    registerSessionEncryption(sessionId: string, encryption: SessionEncryption): void {
        this.sessionKeys.set(sessionId, encryption);
    }

    removeSessionKey(sessionId: string): void {
        this.sessionKeys.delete(sessionId);
    }

    // --- Encrypted sessionRPC ---

    async sessionRPC<R = unknown, A = unknown>(
        sessionId: string,
        method: string,
        params: A,
    ): Promise<R> {
        const enc = this.sessionKeys.get(sessionId);
        if (!enc) {
            throw new Error(`No encryption key for session ${sessionId}`);
        }
        return this.encryptedRPC<R>(
            `${sessionId}:${method}`,
            params,
            enc.key,
            enc.variant,
        );
    }

    // --- machineRPC ---

    async machineRPC<R = unknown, A = unknown>(
        machineId: string,
        method: string,
        params: A,
    ): Promise<R> {
        return this.encryptedRPC<R>(
            `${machineId}:${method}`,
            params,
            this.credentials.secret,
            'legacy',
        );
    }

    // --- HTTP request ---

    /** Raw HTTP request. Caller is responsible for checking response status. */
    async request(path: string, options?: RequestInit): Promise<Response> {
        return fetch(`${this.config.serverUrl}${path}`, {
            ...options,
            headers: {
                ...options?.headers,
                Authorization: `Bearer ${this.credentials.token}`,
            },
        });
    }

    // --- Internal helpers ---

    private async encryptedRPC<R>(
        method: string,
        params: unknown,
        key: Uint8Array,
        variant: 'legacy' | 'dataKey',
    ): Promise<R> {
        if (!this.socket) {
            throw new Error('Not connected');
        }

        const encrypted = encodeBase64(encrypt(key, variant, params));
        const payload: RpcCallPayload = { method, params: encrypted };
        const result: RpcResult = await this.socket
            .timeout(30_000)
            .emitWithAck('rpc-call', payload);

        if (!result.ok) {
            throw new Error(`RPC failed [${method}]: ${result.error ?? 'unknown error'}`);
        }
        if (!result.result) {
            throw new Error(`RPC returned no result [${method}]`);
        }

        const decrypted = decrypt(key, variant, decodeBase64(result.result));
        if (decrypted === null) {
            throw new Error(`RPC decryption failed [${method}]`);
        }
        return decrypted as R;
    }
}
