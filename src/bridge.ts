import { randomUUID } from 'node:crypto';
import type { HappyClient } from './happy/client.js';
import type { DiscordBot } from './discord/bot.js';
import type { BotConfig } from './config.js';
import { encrypt, encodeBase64 } from './vendor/encryption.js';
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

    private requireActiveSession(): string {
        if (!this.activeSessionId) {
            throw new Error('No active session. Use /sessions to check available sessions.');
        }
        return this.activeSessionId;
    }
}
