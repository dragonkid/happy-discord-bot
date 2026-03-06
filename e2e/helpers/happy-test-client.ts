import { HappyClient } from '../../src/happy/client.js';
import { loadConfig, type Config } from '../../src/vendor/config.js';
import { readCredentials, type Credentials } from '../../src/vendor/credentials.js';
import { deriveContentKeyPair, decodeBase64 } from '../../src/vendor/encryption.js';
import { listActiveSessions, deleteSession as apiDeleteSession } from '../../src/vendor/api.js';
import { waitFor } from './wait.js';
import type { PermissionResponse } from '../../src/happy/types.js';

export class HappyTestClient {
    private client: HappyClient;
    private readonly happyConfig: Config;
    private readonly credentials: Credentials;
    private connected = false;

    constructor() {
        this.happyConfig = loadConfig();

        const envToken = process.env.HAPPY_TOKEN;
        const envSecret = process.env.HAPPY_SECRET;
        if (envToken && envSecret) {
            const secret = decodeBase64(envSecret);
            this.credentials = { token: envToken, secret, contentKeyPair: deriveContentKeyPair(secret) };
        } else {
            const fileCreds = readCredentials(this.happyConfig);
            if (!fileCreds) throw new Error('No Happy credentials found');
            this.credentials = fileCreds;
        }

        this.client = new HappyClient(this.happyConfig, this.credentials);
    }

    async start(): Promise<void> {
        this.client.on('connected', () => { this.connected = true; });
        this.client.on('disconnected', () => { this.connected = false; });
        this.client.connect();
        await waitFor(() => this.connected, { timeout: 15_000, label: 'Happy relay connection' });
        console.log('[HappyTestClient] Connected to relay');
    }

    async registerSession(sessionId: string): Promise<void> {
        const sessions = await listActiveSessions(this.happyConfig, this.credentials);
        for (const s of sessions) {
            this.client.registerSessionEncryption(s.id, s.encryption);
        }
        const found = sessions.find(s => s.id === sessionId);
        if (!found) throw new Error(`Session ${sessionId} not found in active sessions`);
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        options?: { mode?: string; allowTools?: string[]; answers?: Record<string, string> },
    ): Promise<void> {
        const response: PermissionResponse = {
            id: requestId,
            approved: true,
            ...(options?.mode && { mode: options.mode as PermissionResponse['mode'] }),
            ...(options?.allowTools && { allowTools: options.allowTools }),
            ...(options?.answers && { answers: options.answers }),
        };
        await this.client.sessionRPC(sessionId, 'permission', response);
        console.log(`[HappyTestClient] Approved permission ${requestId}`);
    }

    async denyPermission(sessionId: string, requestId: string, reason?: string): Promise<void> {
        const response: PermissionResponse = {
            id: requestId,
            approved: false,
            ...(reason && { reason }),
        };
        await this.client.sessionRPC(sessionId, 'permission', response);
        console.log(`[HappyTestClient] Denied permission ${requestId}`);
    }

    async killSession(sessionId: string): Promise<void> {
        await this.client.sessionRPC(sessionId, 'killSession', {});
        console.log(`[HappyTestClient] Killed session ${sessionId.slice(0, 8)}`);
    }

    async deleteSession(sessionId: string): Promise<void> {
        await apiDeleteSession(this.happyConfig, this.credentials, sessionId);
        console.log(`[HappyTestClient] Deleted session ${sessionId.slice(0, 8)}`);
    }

    async listSessionIds(): Promise<string[]> {
        const sessions = await listActiveSessions(this.happyConfig, this.credentials);
        return sessions.map(s => s.id);
    }

    close(): void {
        this.client.close();
    }
}
