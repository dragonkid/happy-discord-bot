import { randomUUID } from 'node:crypto';
import type { HappyClient } from './happy/client.js';
import type { DiscordBot } from './discord/bot.js';
import type { BotConfig } from './config.js';
import { encrypt, encodeBase64, decrypt, decodeBase64 } from './vendor/encryption.js';
import { listActiveSessions, type DecryptedSession } from './vendor/api.js';

export class Bridge {
    private readonly happy: HappyClient;
    private readonly discord: DiscordBot;
    private readonly config: BotConfig;
    private activeSessionId: string | null = null;

    constructor(happy: HappyClient, discord: DiscordBot, config: BotConfig) {
        this.happy = happy;
        this.discord = discord;
        this.config = config;
    }

    setActiveSession(sessionId: string): void {
        this.activeSessionId = sessionId;
    }

    get activeSession(): string | null {
        return this.activeSessionId;
    }

    async sendMessage(text: string): Promise<void> {
        const sessionId = this.requireActiveSession();
        const enc = this.happy.getSessionEncryption(sessionId);
        if (!enc) {
            throw new Error(`No encryption key for session ${sessionId}`);
        }

        const content = {
            role: 'user' as const,
            content: { type: 'text' as const, text },
            meta: { sentFrom: 'happy-discord-bot' as const },
        };

        const encrypted = encodeBase64(encrypt(enc.key, enc.variant, content));
        const localId = randomUUID();

        const resp = await this.happy.request(
            `/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ localId, content: encrypted }],
                }),
            },
        );

        if (!resp.ok) {
            throw new Error(`Failed to send message: ${resp.status} ${resp.statusText}`);
        }
    }

    async start(): Promise<void> {
        const sessions = await this.loadSessions();

        // Auto-select latest active session by activeAt
        if (sessions.length > 0) {
            const latest = sessions.reduce((a, b) => (a.activeAt > b.activeAt ? a : b));
            this.activeSessionId = latest.id;
        }

        // Listen for updates
        this.happy.on('update', (data) => this.processUpdate(data));
    }

    async listSessions(): Promise<DecryptedSession[]> {
        return this.loadSessions();
    }

    /** Process a raw update from the Happy relay. Public for testing. */
    processUpdate(data: unknown): void {
        const update = data as { body?: { t?: string; sid?: string; message?: unknown } };
        const body = update?.body;
        if (!body?.t) return;

        if (body.t === 'new-message' && body.sid && body.message) {
            this.handleNewMessage(body.sid, body.message).catch((err) => {
                console.error('[Bridge] Error handling new message:', err);
            });
        }
        // update-session: Phase 5
    }

    async stopSession(): Promise<void> {
        const sessionId = this.requireActiveSession();
        await this.happy.sessionRPC(sessionId, 'abort', {});
    }

    async compactSession(): Promise<void> {
        await this.sendMessage('/compact');
    }

    private async loadSessions(): Promise<DecryptedSession[]> {
        const sessions = await listActiveSessions(this.config.happy, this.config.credentials);
        // Register encryption keys from DecryptedSession (which has .encryption field)
        for (const session of sessions) {
            this.happy.registerSessionEncryption(session.id, session.encryption);
        }
        return sessions;
    }

    private async handleNewMessage(sessionId: string, raw: unknown): Promise<void> {
        const msg = raw as {
            id: string;
            content: { c: string; t: string };
        };

        const enc = this.happy.getSessionEncryption(sessionId);
        if (!enc) {
            console.warn(`[Bridge] No key for session ${sessionId}, skipping message`);
            return;
        }

        const decrypted = decrypt(enc.key, enc.variant, decodeBase64(msg.content.c));
        if (!decrypted) {
            console.error(`[Bridge] Failed to decrypt message ${msg.id}`);
            return;
        }

        const record = decrypted as { role?: string; content?: unknown };

        // Skip user messages (own echoes)
        if (record.role === 'user') return;

        // Handle agent output
        if (record.role === 'agent') {
            const agentContent = record.content as { type?: string; data?: unknown };
            if (agentContent?.type === 'output') {
                const outputData = agentContent.data as {
                    type?: string;
                    message?: { content?: Array<{ type: string; text?: string }> };
                };
                if (outputData?.type === 'assistant' && outputData.message?.content) {
                    const textBlocks = outputData.message.content
                        .filter((block) => block.type === 'text' && block.text)
                        .map((block) => block.text!);
                    const text = textBlocks.join('');
                    if (text) {
                        await this.discord.send(text);
                    }
                }
            }
        }
    }

    private requireActiveSession(): string {
        if (!this.activeSessionId) {
            throw new Error('No active session. Use /sessions to check available sessions.');
        }
        return this.activeSessionId;
    }
}
