import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bridge } from '../bridge.js';
import type { HappyClient } from '../happy/client.js';
import type { DiscordBot } from '../discord/bot.js';
import type { BotConfig } from '../config.js';
import type { DecryptedSession } from '../vendor/api.js';
import { StateTracker } from '../happy/state-tracker.js';
import { PermissionCache } from '../happy/permission-cache.js';

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
        sendWithButtons: vi.fn().mockResolvedValue({}),
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
    let stateTracker: StateTracker;
    let permissionCache: PermissionCache;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        happy = makeMockHappy();
        discord = makeMockDiscord();
        config = makeMockConfig();
        stateTracker = new StateTracker();
        permissionCache = new PermissionCache();
        bridge = new Bridge(happy, discord, config, stateTracker, permissionCache);
    });

    afterEach(() => {
        vi.useRealTimers();
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
            await vi.advanceTimersByTimeAsync(0);

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
            await vi.advanceTimersByTimeAsync(0);

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
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.send).not.toHaveBeenCalled();
        });
    });

    describe('handleUpdate (update-session)', () => {
        it('decrypts agentState and shows permission buttons', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');

            const agentState = {
                requests: {
                    'req-1': { id: 'req-1', tool: 'Edit', arguments: { file_path: '/x' }, createdAt: 1000 },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(agentState)).toString('base64');

            bridge.processUpdate({
                body: {
                    t: 'update-session',
                    id: 'sess-1',
                    agentState: { version: 1, value: encrypted },
                },
            });

            await vi.waitFor(() => {
                expect(discord.sendWithButtons).toHaveBeenCalled();
            });
        });

        it('auto-approves when PermissionCache matches', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            permissionCache.applyApproval(['Edit']);

            const agentState = {
                requests: {
                    'req-1': { id: 'req-1', tool: 'Edit', arguments: {}, createdAt: 1000 },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(agentState)).toString('base64');

            bridge.processUpdate({
                body: {
                    t: 'update-session',
                    id: 'sess-1',
                    agentState: { version: 1, value: encrypted },
                },
            });

            await vi.waitFor(() => {
                expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'permission', expect.objectContaining({
                    id: 'req-1',
                    approved: true,
                }));
            });

            expect(discord.sendWithButtons).not.toHaveBeenCalled();
        });

        it('ignores update-session without agentState', async () => {
            bridge.processUpdate({
                body: { t: 'update-session', id: 'sess-1' },
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.sendWithButtons).not.toHaveBeenCalled();
        });

        it('ignores update-session for non-active session', async () => {
            bridge.setActiveSession('sess-1');

            const agentState = {
                requests: { 'req-1': { id: 'req-1', tool: 'Edit', arguments: {}, createdAt: 1000 } },
            };
            const encrypted = Buffer.from(JSON.stringify(agentState)).toString('base64');

            bridge.processUpdate({
                body: {
                    t: 'update-session',
                    id: 'sess-other',
                    agentState: { version: 1, value: encrypted },
                },
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.sendWithButtons).not.toHaveBeenCalled();
        });
    });

    describe('approvePermission', () => {
        it('sends permission RPC with approved=true', async () => {
            await bridge.approvePermission('sess-1', 'req-1');
            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'permission', {
                id: 'req-1',
                approved: true,
            });
        });

        it('includes mode and allowTools when provided', async () => {
            await bridge.approvePermission('sess-1', 'req-1', 'acceptEdits', ['Edit']);
            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'permission', {
                id: 'req-1',
                approved: true,
                mode: 'acceptEdits',
                allowTools: ['Edit'],
            });
        });
    });

    describe('denyPermission', () => {
        it('sends permission RPC with approved=false', async () => {
            await bridge.denyPermission('sess-1', 'req-1');
            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'permission', {
                id: 'req-1',
                approved: false,
            });
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

    describe('AskUserQuestion handling', () => {
        it('sends question buttons instead of permission buttons for AskUserQuestion', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');

            const agentState = {
                requests: {
                    'req-1': {
                        id: 'req-1',
                        tool: 'AskUserQuestion',
                        arguments: {
                            questions: [{
                                question: 'Which DB?',
                                header: 'Database',
                                options: [
                                    { label: 'PostgreSQL', description: 'Relational' },
                                    { label: 'MongoDB', description: 'Document' },
                                ],
                                multiSelect: false,
                            }],
                        },
                        createdAt: 1000,
                    },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(agentState)).toString('base64');

            bridge.processUpdate({
                body: {
                    t: 'update-session',
                    id: 'sess-1',
                    agentState: { version: 1, value: encrypted },
                },
            });

            await vi.waitFor(() => {
                expect(discord.sendWithButtons).toHaveBeenCalled();
            });

            const [text] = vi.mocked(discord.sendWithButtons).mock.calls[0];
            expect(text).toContain('Which DB?');
            expect(text).toContain('PostgreSQL');
        });

        it('handleAskUserAnswer approves permission and sends answer message', async () => {
            bridge.setActiveSession('sess-1');

            await bridge.handleAskUserAnswer('sess-1', 'req-1', 'Database: PostgreSQL');

            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'permission', {
                id: 'req-1',
                approved: true,
            });
            expect(happy.request).toHaveBeenCalledWith(
                expect.stringContaining('/messages'),
                expect.any(Object),
            );
        });

        it('toggleMultiSelect toggles option indices', () => {
            const key = 'sess-1:req-1:0';
            const result1 = bridge.toggleMultiSelect(key, 0);
            expect(result1.has(0)).toBe(true);

            const result2 = bridge.toggleMultiSelect(key, 1);
            expect(result2.has(0)).toBe(true);
            expect(result2.has(1)).toBe(true);

            const result3 = bridge.toggleMultiSelect(key, 0);
            expect(result3.has(0)).toBe(false);
            expect(result3.has(1)).toBe(true);
        });

        it('clearMultiSelectState removes state for key', () => {
            const key = 'sess-1:req-1:0';
            bridge.toggleMultiSelect(key, 0);
            bridge.clearMultiSelectState(key);
            const state = bridge.getMultiSelectState(key);
            expect(state.size).toBe(0);
        });
    });

    describe('disconnect notifications', () => {
        it('sends disconnect warning to Discord after debounce period', async () => {
            const handlers = new Map<string, Function>();
            vi.mocked(happy.on).mockImplementation(((event: string, handler: Function) => {
                handlers.set(event, handler);
                return happy;
            }) as any);

            await bridge.start();

            // Simulate disconnect
            handlers.get('disconnected')?.('ping timeout');

            // Not yet — debounce
            expect(discord.send).not.toHaveBeenCalled();

            // After debounce period
            vi.advanceTimersByTime(5000);

            expect(discord.send).toHaveBeenCalledWith(
                expect.stringContaining('disconnected'),
            );
        });

        it('cancels disconnect notification if reconnected within debounce', async () => {
            const handlers = new Map<string, Function>();
            vi.mocked(happy.on).mockImplementation(((event: string, handler: Function) => {
                handlers.set(event, handler);
                return happy;
            }) as any);

            await bridge.start();

            // Mark initial connect done
            handlers.get('connected')?.();

            // Disconnect then quick reconnect
            handlers.get('disconnected')?.('ping timeout');
            vi.advanceTimersByTime(2000);
            handlers.get('connected')?.();

            // After debounce period — should NOT have sent disconnect warning
            vi.advanceTimersByTime(5000);

            const calls = vi.mocked(discord.send).mock.calls;
            expect(calls.every(([msg]) => !msg.includes('disconnected'))).toBe(true);
        });

        it('sends reconnect notice after debounce already fired', async () => {
            const handlers = new Map<string, Function>();
            vi.mocked(happy.on).mockImplementation(((event: string, handler: Function) => {
                handlers.set(event, handler);
                return happy;
            }) as any);

            await bridge.start();

            // Mark initial connect done
            handlers.get('connected')?.();

            // Disconnect and wait for debounce to fire
            handlers.get('disconnected')?.('ping timeout');
            vi.advanceTimersByTime(5000);

            // Now reconnect — debounce already fired, so reconnect notice should be sent
            handlers.get('connected')?.();

            const calls = vi.mocked(discord.send).mock.calls;
            expect(calls.some(([msg]) => msg.includes('reconnected'))).toBe(true);
        });

        it('does not send reconnect notice on initial connect', async () => {
            const handlers = new Map<string, Function>();
            vi.mocked(happy.on).mockImplementation(((event: string, handler: Function) => {
                handlers.set(event, handler);
                return happy;
            }) as any);

            await bridge.start();

            // Initial connect
            handlers.get('connected')?.();

            expect(discord.send).not.toHaveBeenCalled();
        });
    });

    describe('response timeout', () => {
        it('sends warning to Discord when CLI does not respond within 30s', async () => {
            bridge.setActiveSession('sess-1');

            await bridge.sendMessage('hello');

            // Not yet triggered
            expect(discord.send).not.toHaveBeenCalled();

            // Advance past timeout
            vi.advanceTimersByTime(30_000);

            expect(discord.send).toHaveBeenCalledWith(
                expect.stringContaining('CLI appears unresponsive'),
            );
        });

        it('cancels timeout when agentState update is received', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');

            await bridge.sendMessage('hello');

            // Simulate agentState update before timeout
            const agentState = { state: 'thinking' };
            const encrypted = Buffer.from(JSON.stringify(agentState)).toString('base64');
            bridge.processUpdate({
                body: {
                    t: 'update-session',
                    id: 'sess-1',
                    agentState: { version: 1, value: encrypted },
                },
            });

            // Advance past timeout — should NOT trigger warning
            vi.advanceTimersByTime(30_000);

            expect(discord.send).not.toHaveBeenCalled();
        });

        it('cancels timeout when new message is received', async () => {
            bridge.setActiveSession('sess-1');

            await bridge.sendMessage('hello');

            // Simulate incoming message before timeout
            const msgContent = { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } } } };
            const encrypted = Buffer.from(JSON.stringify(msgContent)).toString('base64');
            bridge.processUpdate({
                body: {
                    t: 'new-message',
                    sid: 'sess-1',
                    message: { id: 'msg-1', seq: 1, content: { c: encrypted, t: 'encrypted' }, createdAt: Date.now(), updatedAt: Date.now() },
                },
            });

            // Wait for async handleNewMessage
            await vi.advanceTimersByTimeAsync(0);

            // Advance past timeout — should NOT trigger warning
            vi.advanceTimersByTime(30_000);

            // discord.send was called with the message content, but not with the warning
            const calls = vi.mocked(discord.send).mock.calls;
            expect(calls.every(([msg]) => !msg.includes('unresponsive'))).toBe(true);
        });
    });
});
