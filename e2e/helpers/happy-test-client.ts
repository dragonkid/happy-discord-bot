import { HappyClient } from '../../src/happy/client.js';
import { loadConfig as loadHappyConfig } from '../../src/vendor/config.js';
import { readCredentials, type Credentials } from '../../src/vendor/credentials.js';
import { decodeBase64, deriveContentKeyPair } from '../../src/vendor/encryption.js';
import { listActiveSessions, type DecryptedSession } from '../../src/vendor/api.js';
import type { Config as HappyConfig } from '../../src/vendor/config.js';
import { waitFor } from './wait.js';

export interface SpawnSessionResult {
    type: 'success' | 'requestToApproveDirectoryCreation' | 'error';
    sessionId?: string;
    errorMessage?: string;
    directory?: string;
}

function loadCredentials(config: HappyConfig): Credentials {
    const envToken = process.env.HAPPY_TOKEN;
    const envSecret = process.env.HAPPY_SECRET;

    if (envToken && envSecret) {
        const secret = decodeBase64(envSecret);
        const contentKeyPair = deriveContentKeyPair(secret);
        return { token: envToken, secret, contentKeyPair };
    }

    const fileCreds = readCredentials(config);
    if (fileCreds) return fileCreds;

    throw new Error('No Happy credentials found.');
}

export class HappyTestClient {
    private client: HappyClient;
    private happyConfig: HappyConfig;
    private credentials: Credentials;
    private connected = false;

    constructor() {
        this.happyConfig = loadHappyConfig();
        this.credentials = loadCredentials(this.happyConfig);
        this.client = new HappyClient(this.happyConfig, this.credentials);
    }

    /**
     * Connect to relay and wait for connection.
     */
    async start(): Promise<void> {
        this.client.on('connected', () => {
            this.connected = true;
        });
        this.client.on('disconnected', () => {
            this.connected = false;
        });

        this.client.connect();

        await waitFor(() => this.connected, {
            timeout: 15_000,
            label: 'Happy relay connection',
        });

        console.log('[HappyTestClient] Connected to relay');
    }

    /**
     * List active sessions (uses REST API, not Socket.IO).
     */
    async listSessions(): Promise<DecryptedSession[]> {
        return listActiveSessions(this.happyConfig, this.credentials);
    }

    /**
     * Register encryption keys for sessions (needed for RPC).
     */
    registerSessionKeys(sessions: DecryptedSession[]): void {
        for (const session of sessions) {
            this.client.registerSessionEncryption(session.id, session.encryption);
        }
    }

    /**
     * Extract machineId from a session's metadata.
     */
    extractMachineId(session: DecryptedSession): string {
        const metadata = session.metadata as Record<string, unknown> | undefined;
        const machineId = metadata?.machineId as string | undefined;
        if (!machineId) {
            throw new Error(`No machineId in session ${session.id} metadata`);
        }
        return machineId;
    }

    /**
     * Spawn a new CLI session via machineRPC.
     */
    async spawnSession(machineId: string, directory: string): Promise<string> {
        const result = await this.client.machineRPC<SpawnSessionResult>(
            machineId,
            'spawn-happy-session',
            {
                directory,
                agent: 'claude',
                approvedNewDirectoryCreation: true,
            },
        );

        if (result.type === 'success' && result.sessionId) {
            console.log(`[HappyTestClient] Spawned session: ${result.sessionId}`);
            return result.sessionId;
        }

        throw new Error(`Failed to spawn session: ${JSON.stringify(result)}`);
    }

    /**
     * Approve a permission request via sessionRPC.
     */
    async approvePermission(
        sessionId: string,
        requestId: string,
        options?: { mode?: string; allowTools?: string[] },
    ): Promise<void> {
        await this.client.sessionRPC(sessionId, 'permission', {
            id: requestId,
            approved: true,
            ...options,
        });
        console.log(`[HappyTestClient] Approved permission ${requestId}`);
    }

    /**
     * Deny a permission request via sessionRPC.
     */
    async denyPermission(sessionId: string, requestId: string, reason?: string): Promise<void> {
        await this.client.sessionRPC(sessionId, 'permission', {
            id: requestId,
            approved: false,
            reason,
        });
        console.log(`[HappyTestClient] Denied permission ${requestId}`);
    }

    /**
     * Get the underlying HappyClient.
     */
    get raw(): HappyClient {
        return this.client;
    }

    /**
     * Disconnect from relay.
     */
    close(): void {
        this.client.close();
    }
}
