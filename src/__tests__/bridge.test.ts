import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bridge } from '../bridge.js';
import type { HappyClient } from '../happy/client.js';
import type { DiscordBot } from '../discord/bot.js';
import type { BotConfig } from '../config.js';
import type { DecryptedSession } from '../vendor/api.js';

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

    describe('start', () => {
        it('loads active sessions and registers keys', async () => {
            const { listActiveSessions } = await import('../vendor/api.js');
            const mockSessions = [
                { id: 'sess-1', active: true, activeAt: 1000, encryption: { key: new Uint8Array(32), variant: 'dataKey' } },
                { id: 'sess-2', active: true, activeAt: 2000, encryption: { key: new Uint8Array(32), variant: 'dataKey' } },
            ] as unknown as DecryptedSession[];
            vi.mocked(listActiveSessions).mockResolvedValueOnce(mockSessions);

            await bridge.start();

            expect(listActiveSessions).toHaveBeenCalledWith(config.happy, config.credentials);
            expect(bridge.activeSession).toBe('sess-2'); // latest by activeAt
        });

        it('sets no active session when no sessions exist', async () => {
            const { listActiveSessions } = await import('../vendor/api.js');
            vi.mocked(listActiveSessions).mockResolvedValueOnce([]);

            await bridge.start();

            expect(bridge.activeSession).toBeNull();
        });

        it('registers update event listener on happy client', async () => {
            const { listActiveSessions } = await import('../vendor/api.js');
            vi.mocked(listActiveSessions).mockResolvedValueOnce([]);

            await bridge.start();

            expect(happy.on).toHaveBeenCalledWith('update', expect.any(Function));
        });
    });

    describe('listSessions', () => {
        it('returns sessions from API and refreshes keys', async () => {
            const { listActiveSessions } = await import('../vendor/api.js');
            const mockSessions = [
                { id: 'sess-1', active: true, activeAt: 1000, encryption: { key: new Uint8Array(32), variant: 'dataKey' } },
            ] as unknown as DecryptedSession[];
            vi.mocked(listActiveSessions).mockResolvedValueOnce(mockSessions);

            const result = await bridge.listSessions();

            expect(result).toEqual(mockSessions);
            expect(listActiveSessions).toHaveBeenCalled();
        });
    });

    describe('handleUpdate', () => {
        it('decrypts and sends assistant text to Discord', async () => {
            bridge.setActiveSession('sess-1');

            const assistantContent = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [{ type: 'text', text: 'Hello from Claude!' }],
                        },
                    },
                },
            };

            const encrypted = Buffer.from(JSON.stringify(assistantContent)).toString('base64');

            const update = {
                body: {
                    t: 'new-message',
                    sid: 'sess-1',
                    message: {
                        id: 'msg-1',
                        seq: 1,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            };

            bridge.processUpdate(update);

            await vi.waitFor(() => {
                expect(discord.send).toHaveBeenCalledWith('Hello from Claude!');
            });
        });

        it('skips user messages (own messages echoed back)', async () => {
            bridge.setActiveSession('sess-1');

            const userContent = {
                role: 'user',
                content: { type: 'text', text: 'hello' },
            };

            const encrypted = Buffer.from(JSON.stringify(userContent)).toString('base64');

            const update = {
                body: {
                    t: 'new-message',
                    sid: 'sess-1',
                    message: {
                        id: 'msg-2',
                        seq: 2,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            };

            bridge.processUpdate(update);
            await new Promise((r) => setTimeout(r, 50));

            expect(discord.send).not.toHaveBeenCalled();
        });

        it('skips non-text agent content types', async () => {
            bridge.setActiveSession('sess-1');

            const eventContent = {
                role: 'agent',
                content: { type: 'event', id: 'evt-1', data: { type: 'ready' } },
            };

            const encrypted = Buffer.from(JSON.stringify(eventContent)).toString('base64');

            const update = {
                body: {
                    t: 'new-message',
                    sid: 'sess-1',
                    message: {
                        id: 'msg-3',
                        seq: 3,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            };

            bridge.processUpdate(update);
            await new Promise((r) => setTimeout(r, 50));

            expect(discord.send).not.toHaveBeenCalled();
        });

        it('concatenates multiple text blocks from assistant', async () => {
            bridge.setActiveSession('sess-1');

            const assistantContent = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [
                                { type: 'text', text: 'Part 1. ' },
                                { type: 'tool_use', id: 't1', name: 'Read', input: {} },
                                { type: 'text', text: 'Part 2.' },
                            ],
                        },
                    },
                },
            };

            const encrypted = Buffer.from(JSON.stringify(assistantContent)).toString('base64');

            const update = {
                body: {
                    t: 'new-message',
                    sid: 'sess-1',
                    message: {
                        id: 'msg-4',
                        seq: 4,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            };

            bridge.processUpdate(update);

            await vi.waitFor(() => {
                expect(discord.send).toHaveBeenCalledWith('Part 1. Part 2.');
            });
        });

        it('ignores update-session events (Phase 5)', async () => {
            const update = {
                body: { t: 'update-session', id: 'sess-1' },
            };

            bridge.processUpdate(update);
            await new Promise((r) => setTimeout(r, 50));

            expect(discord.send).not.toHaveBeenCalled();
        });

        it('ignores messages from unknown sessions (no key)', async () => {
            vi.mocked(happy.getSessionEncryption).mockReturnValueOnce(undefined);

            const update = {
                body: {
                    t: 'new-message',
                    sid: 'unknown-sess',
                    message: {
                        id: 'msg-5',
                        seq: 5,
                        content: { c: 'encrypted', t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            };

            bridge.processUpdate(update);
            await new Promise((r) => setTimeout(r, 50));

            expect(discord.send).not.toHaveBeenCalled();
        });
    });

    describe('stopSession', () => {
        it('sends abort RPC to active session', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.stopSession();
            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'abort', {});
        });

        it('throws when no active session', async () => {
            await expect(bridge.stopSession()).rejects.toThrow('No active session');
        });
    });

    describe('compactSession', () => {
        it('sends user message with /compact text', async () => {
            bridge.setActiveSession('sess-1');
            const sendSpy = vi.spyOn(bridge, 'sendMessage').mockResolvedValue();
            await bridge.compactSession();
            expect(sendSpy).toHaveBeenCalledWith('/compact');
        });
    });
});
