import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bridge } from '../bridge.js';
import type { HappyClient } from '../happy/client.js';
import type { DiscordBot } from '../discord/bot.js';
import type { BotConfig } from '../config.js';

// --- Mock factories ---

function makeMockHappy(): HappyClient {
    return {
        on: vi.fn(),
        getSessionEncryption: vi.fn().mockReturnValue({
            key: new Uint8Array(32),
            variant: 'dataKey' as const,
        }),
        registerSessionEncryption: vi.fn(),
        request: vi.fn().mockResolvedValue(new Response(JSON.stringify({
            messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: Date.now(), updatedAt: Date.now() }],
        }))),
        sessionRPC: vi.fn().mockResolvedValue({}),
    } as unknown as HappyClient;
}

function makeMockDiscord(): DiscordBot {
    return {
        send: vi.fn().mockResolvedValue([]),
    } as unknown as DiscordBot;
}

function makeMockConfig(): BotConfig {
    return {
        discord: { token: 't', channelId: 'ch-1', userId: 'u-1' },
        happy: { serverUrl: 'https://test.example.com', homeDir: '/tmp', credentialPath: '/tmp/k' },
        credentials: {
            token: 'test-token',
            secret: new Uint8Array(32),
            contentKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
        },
    };
}

// --- Mock vendor modules ---

vi.mock('../vendor/api.js', () => ({
    listActiveSessions: vi.fn().mockResolvedValue([]),
    resolveSessionEncryption: vi.fn(),
}));

vi.mock('../vendor/encryption.js', () => ({
    encrypt: vi.fn((_key: Uint8Array, _variant: string, data: unknown) =>
        new TextEncoder().encode(JSON.stringify(data)),
    ),
    decrypt: vi.fn((_key: Uint8Array, _variant: string, data: Uint8Array) => {
        try { return JSON.parse(new TextDecoder().decode(data)); }
        catch { return null; }
    }),
    encodeBase64: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString('base64')),
    decodeBase64: vi.fn((str: string) => new Uint8Array(Buffer.from(str, 'base64'))),
}));

// --- Tests ---

describe('Bridge', () => {
    let bridge: Bridge;
    let happy: HappyClient;
    let discord: DiscordBot;
    let config: BotConfig;

    beforeEach(() => {
        vi.clearAllMocks();
        happy = makeMockHappy();
        discord = makeMockDiscord();
        config = makeMockConfig();
        bridge = new Bridge(happy, discord, config);
    });

    describe('sendMessage', () => {
        it('throws when no active session', async () => {
            await expect(bridge.sendMessage('hello')).rejects.toThrow('No active session');
        });

        it('encrypts and POSTs message to relay', async () => {
            bridge.setActiveSession('sess-1');

            await bridge.sendMessage('hello');

            expect(happy.request).toHaveBeenCalledWith(
                '/v3/sessions/sess-1/messages',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: expect.stringContaining('"messages"'),
                }),
            );
        });

        it('includes localId in POST body for deduplication', async () => {
            bridge.setActiveSession('sess-1');

            await bridge.sendMessage('hello');

            const body = JSON.parse(
                (happy.request as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
            );
            expect(body.messages).toHaveLength(1);
            expect(body.messages[0]).toHaveProperty('localId');
            expect(body.messages[0]).toHaveProperty('content');
        });

        it('constructs RawRecord with role user and sentFrom meta', async () => {
            bridge.setActiveSession('sess-1');
            const { encrypt } = await import('../vendor/encryption.js');

            await bridge.sendMessage('hello');

            expect(encrypt).toHaveBeenCalledWith(
                expect.any(Uint8Array),
                'dataKey',
                {
                    role: 'user',
                    content: { type: 'text', text: 'hello' },
                    meta: { sentFrom: 'happy-discord-bot' },
                },
            );
        });
    });
});
