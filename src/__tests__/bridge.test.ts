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
    const sessionKeys = new Map<string, any>();
    return {
        on: vi.fn(),
        getSessionEncryption: vi.fn((sessionId: string) => sessionKeys.get(sessionId)),
        getRegisteredSessionIds: vi.fn(() => Array.from(sessionKeys.keys())),
        registerSessionEncryption: vi.fn((sessionId: string, encryption: any) => {
            sessionKeys.set(sessionId, encryption);
        }),
        removeSessionKey: vi.fn((sessionId: string) => {
            sessionKeys.delete(sessionId);
        }),
        request: vi.fn().mockResolvedValue(new Response(JSON.stringify({
            messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: Date.now(), updatedAt: Date.now() }],
        }))),
        sessionRPC: vi.fn().mockResolvedValue({}),
        machineRPC: vi.fn().mockResolvedValue({ sessionId: 'new-sess-id' }),
    } as unknown as HappyClient;
}

function makeMockDiscord(): DiscordBot {
    return {
        send: vi.fn().mockResolvedValue([{ id: 'todo-msg-1' }]),
        sendWithButtons: vi.fn().mockResolvedValue({}),
        sendWithAttachmentAndButtons: vi.fn().mockResolvedValue({}),
        sendTyping: vi.fn().mockResolvedValue(undefined),
        reactToMessage: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
        editMessage: vi.fn().mockResolvedValue(undefined),
        pinMessage: vi.fn().mockResolvedValue(undefined),
        unpinMessage: vi.fn().mockResolvedValue(undefined),
        sendToThread: vi.fn().mockResolvedValue([{ id: 'thread-msg-1' }]),
        sendToThreadWithButtons: vi.fn().mockResolvedValue({}),
        sendToThreadWithAttachment: vi.fn().mockResolvedValue({}),
        sendTypingInThread: vi.fn().mockResolvedValue(undefined),
        reactInThread: vi.fn().mockResolvedValue(undefined),
        removeReactionInThread: vi.fn().mockResolvedValue(undefined),
        editMessageInThread: vi.fn().mockResolvedValue(undefined),
        pinMessageInThread: vi.fn().mockResolvedValue(undefined),
        unpinMessageInThread: vi.fn().mockResolvedValue(undefined),
        createThread: vi.fn().mockResolvedValue('thread-1'),
        archiveThread: vi.fn().mockResolvedValue(undefined),
        deleteThread: vi.fn().mockResolvedValue(undefined),
        listThreads: vi.fn().mockResolvedValue([]),
    } as unknown as DiscordBot;
}

function makeMockConfig(): BotConfig {
    return {
        discord: { token: 't', channelId: 'ch-1', userId: 'u-1', requireMention: false },
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
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue(undefined),
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

        // Register common test sessions
        happy.registerSessionEncryption('sess-1', { key: new Uint8Array(32), variant: 'dataKey' as const });
        happy.registerSessionEncryption('sess-2', { key: new Uint8Array(32), variant: 'dataKey' as const });
        happy.registerSessionEncryption('sess-active', { key: new Uint8Array(32), variant: 'dataKey' as const });
        happy.registerSessionEncryption('sess-other', { key: new Uint8Array(32), variant: 'dataKey' as const });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('sendMessage', () => {
        it('throws when session has no encryption key', async () => {
            await expect(bridge.sendMessage('hello', 'unknown-sess')).rejects.toThrow('No encryption key for session');
        });

        it('encrypts and POSTs message to relay', async () => {
            bridge.setActiveSession('sess-1');

            await bridge.sendMessage('hello', 'sess-1');

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

            await bridge.sendMessage('hello', 'sess-1');

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

            await bridge.sendMessage('hello', 'sess-1');

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

        it('uses targetSessionId parameter instead of activeSession when provided', async () => {
            bridge.setActiveSession('sess-active');
            happy.registerSessionEncryption('sess-target', { key: new Uint8Array(32), variant: 'dataKey' as const });

            await bridge.sendMessage('hello', 'sess-target');

            expect(happy.request).toHaveBeenCalledWith(
                '/v3/sessions/sess-target/messages',
                expect.objectContaining({ method: 'POST' }),
            );
        });
    });

    describe('isSessionAvailable', () => {
        it('returns true when session has encryption key registered', () => {
            expect(bridge.isSessionAvailable('sess-1')).toBe(true);
        });

        it('returns false when session has no key', () => {
            expect(bridge.isSessionAvailable('unknown-sess')).toBe(false);
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

        it('resolves prefix to full session ID before calling sessionRPC', async () => {
            bridge.setActiveSession('sess-full-id-abc123');
            bridge.setThread('sess-full-id-abc123', 'thread-1');
            await bridge.stopSession('sess-full');

            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-full-id-abc123', 'abort', {});
        });
    });

    describe('compactSession', () => {
        it('sends user message with /compact text', async () => {
            bridge.setActiveSession('sess-1');
            const sendSpy = vi.spyOn(bridge, 'sendMessage').mockResolvedValue();
            await bridge.compactSession('sess-1', 'msg-123');
            expect(sendSpy).toHaveBeenCalledWith('/compact', 'sess-1');
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

        it('handleAskUserAnswer passes answers in permission RPC', async () => {
            bridge.setActiveSession('sess-1');

            const answers = { 'Database': 'PostgreSQL' };
            await bridge.handleAskUserAnswer('sess-1', 'req-1', answers);

            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'permission', {
                id: 'req-1',
                approved: true,
                answers,
            });
        });

        it('handleAskUserAnswer does not call sendMessage', async () => {
            bridge.setActiveSession('sess-1');

            await bridge.handleAskUserAnswer('sess-1', 'req-1', { 'DB': 'PostgreSQL' });

            expect(happy.request).not.toHaveBeenCalled();
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

    describe('ExitPlanMode handling', () => {
        it('sends plan as file attachment with ExitPlan buttons for ExitPlanMode', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');

            const agentState = {
                requests: {
                    'req-plan': {
                        id: 'req-plan',
                        tool: 'ExitPlanMode',
                        arguments: { plan: 'Step 1: Do thing\nStep 2: Do other' },
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
                expect(discord.sendWithAttachmentAndButtons).toHaveBeenCalled();
            });

            const call = vi.mocked(discord.sendWithAttachmentAndButtons).mock.calls[0];
            expect(call[0]).toContain('Plan Proposal');
            expect(call[1]).toEqual(Buffer.from('Step 1: Do thing\nStep 2: Do other', 'utf-8'));
            expect(call[2]).toBe('plan.md');
        });

        it('handles exit_plan_mode tool name too', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');

            const agentState = {
                requests: {
                    'req-plan-2': {
                        id: 'req-plan-2',
                        tool: 'exit_plan_mode',
                        arguments: { plan: 'My plan' },
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
                expect(discord.sendWithAttachmentAndButtons).toHaveBeenCalled();
            });
        });

        it('sends (empty plan) when plan text is missing', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');

            const agentState = {
                requests: {
                    'req-plan-3': {
                        id: 'req-plan-3',
                        tool: 'ExitPlanMode',
                        arguments: {},
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
                expect(discord.sendWithAttachmentAndButtons).toHaveBeenCalled();
            });

            const call = vi.mocked(discord.sendWithAttachmentAndButtons).mock.calls[0];
            expect(call[1]).toEqual(Buffer.from('(empty plan)', 'utf-8'));
        });

        it('denyPermission passes reason when provided', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.denyPermission('sess-1', 'req-1', 'Please add error handling');

            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'permission', {
                id: 'req-1',
                approved: false,
                reason: 'Please add error handling',
            });
        });

        it('denyPermission omits reason when not provided', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.denyPermission('sess-1', 'req-1');

            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'permission', {
                id: 'req-1',
                approved: false,
            });
        });
    });

    describe('disconnect notifications', () => {
        it('sends disconnect warning to Discord after debounce period', async () => {
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            vi.mocked(happy.on).mockImplementation(((event: string, handler: (...args: unknown[]) => unknown) => {
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
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            vi.mocked(happy.on).mockImplementation(((event: string, handler: (...args: unknown[]) => unknown) => {
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
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            vi.mocked(happy.on).mockImplementation(((event: string, handler: (...args: unknown[]) => unknown) => {
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
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            vi.mocked(happy.on).mockImplementation(((event: string, handler: (...args: unknown[]) => unknown) => {
                handlers.set(event, handler);
                return happy;
            }) as any);

            await bridge.start();

            // Initial connect
            handlers.get('connected')?.();

            expect(discord.send).not.toHaveBeenCalled();
        });
    });

    describe('typing indicator + emoji reactions (ephemeral)', () => {
        function sendEphemeral(sessionId: string, thinking: boolean) {
            bridge.handleEphemeralActivity(sessionId, thinking);
        }

        it('starts typing loop when thinking becomes true', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            sendEphemeral('sess-1', true);
            expect(discord.sendTyping).toHaveBeenCalledOnce();
        });

        it('adds 🤔 emoji when thinking', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            bridge.setLastUserMessageId('msg-u1');
            sendEphemeral('sess-1', true);
            expect(discord.reactToMessage).toHaveBeenCalledWith('msg-u1', '🤔');
        });

        it('removes emoji and stops typing when thinking stops', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            bridge.setLastUserMessageId('msg-u1');
            sendEphemeral('sess-1', true);
            vi.clearAllMocks();
            sendEphemeral('sess-1', false);
            expect(discord.removeReaction).toHaveBeenCalledWith('msg-u1', '🤔');
            expect(discord.sendTyping).not.toHaveBeenCalled();
        });

        it('repeats sendTyping every 8s while thinking', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            sendEphemeral('sess-1', true);
            expect(discord.sendTyping).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(8_000);
            expect(discord.sendTyping).toHaveBeenCalledTimes(2);
            vi.advanceTimersByTime(8_000);
            expect(discord.sendTyping).toHaveBeenCalledTimes(3);
        });

        it('stops typing loop when thinking stops', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            sendEphemeral('sess-1', true);
            expect(discord.sendTyping).toHaveBeenCalledTimes(1);
            sendEphemeral('sess-1', false);
            (discord.sendTyping as any).mockClear();
            vi.advanceTimersByTime(16_000);
            expect(discord.sendTyping).not.toHaveBeenCalled();
        });

        it('skips emoji when no lastUserMessageId', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            sendEphemeral('sess-1', true);
            expect(discord.sendTyping).toHaveBeenCalled();
            expect(discord.reactToMessage).not.toHaveBeenCalled();
        });

        it('stops typing on permission request', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            bridge.setLastUserMessageId('msg-u1');
            sendEphemeral('sess-1', true);
            vi.clearAllMocks();
            // Permission request arrives via agentState
            const agentState = {
                requests: { 'req-1': { tool: 'Bash', arguments: { command: 'ls' }, createdAt: Date.now() } },
            };
            const encrypted = Buffer.from(JSON.stringify(agentState)).toString('base64');
            bridge.processUpdate({
                body: {
                    t: 'update-session',
                    id: 'sess-1',
                    agentState: { version: 1, value: encrypted },
                },
            });
            expect(discord.removeReaction).toHaveBeenCalledWith('msg-u1', '🤔');
            expect(discord.sendTyping).not.toHaveBeenCalled();
        });

        it('processes ephemeral for any session with registered key (not just active)', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            sendEphemeral('sess-other', true);
            expect(discord.sendTyping).toHaveBeenCalled();
        });

        it('deduplicates same thinking state', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            sendEphemeral('sess-1', true);
            vi.clearAllMocks();
            sendEphemeral('sess-1', true);
            expect(discord.reactToMessage).not.toHaveBeenCalled();
            expect(discord.sendTyping).not.toHaveBeenCalled();
        });
    });

    describe('permission mode persistence', () => {
        it('setActiveSession restores saved mode for the new session', () => {
            permissionCache.setMode('acceptEdits');
            permissionCache.saveSession('sess-new');
            permissionCache.reset();
            bridge.setActiveSession('sess-new');
            expect(permissionCache.mode).toBe('acceptEdits');
        });

        it('setActiveSession saves current mode before switching', () => {
            bridge.setActiveSession('sess-1');
            permissionCache.setMode('bypassPermissions');
            bridge.setActiveSession('sess-2');
            // Switching back to sess-1 should restore bypassPermissions
            bridge.setActiveSession('sess-1');
            expect(permissionCache.mode).toBe('bypassPermissions');
        });

        it('setActiveSession preserves allowedTools across switches', () => {
            bridge.setActiveSession('sess-1');
            permissionCache.applyApproval(['Edit', 'Glob']);
            bridge.setActiveSession('sess-2');
            // sess-2 should not have Edit approved
            expect(permissionCache.isAutoApproved('Edit', {})).toBe(false);
            // Switch back — Edit should be restored
            bridge.setActiveSession('sess-1');
            expect(permissionCache.isAutoApproved('Edit', {})).toBe(true);
            expect(permissionCache.isAutoApproved('Glob', {})).toBe(true);
        });

        it('setActiveSession resets to default for session with no saved state', () => {
            bridge.setActiveSession('sess-1');
            permissionCache.setMode('acceptEdits');
            bridge.setActiveSession('sess-unknown');
            expect(permissionCache.mode).toBe('default');
        });

        it('persistModes calls store.save with all session states', async () => {
            const mockStore = { save: vi.fn().mockResolvedValue(undefined), load: vi.fn() };
            bridge.setStore(mockStore as any);
            bridge.setActiveSession('sess-1');
            permissionCache.setMode('acceptEdits');
            permissionCache.applyApproval(['Edit']);
            bridge.persistModes();
            expect(mockStore.save).toHaveBeenCalledWith(expect.objectContaining({
                sessions: expect.objectContaining({
                    'sess-1': expect.objectContaining({
                        mode: 'acceptEdits',
                        allowedTools: expect.arrayContaining(['Edit']),
                    }),
                }),
            }));
        });

        it('persistModes is no-op without store', () => {
            bridge.setActiveSession('sess-1');
            permissionCache.setMode('acceptEdits');
            expect(() => bridge.persistModes()).not.toThrow();
        });
    });

    describe('TodoWrite progress display', () => {
        function sendToolCallStart(sessionId: string, name: string, args: Record<string, unknown>) {
            const content = {
                role: 'session',
                content: {
                    role: 'agent',
                    ev: { t: 'tool-call-start', name, args },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(content)).toString('base64');
            bridge.processUpdate({
                body: {
                    t: 'new-message',
                    sid: sessionId,
                    message: {
                        id: `msg-${Date.now()}`,
                        seq: 1,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            });
        }

        it('sends and pins a formatted todo message on first TodoWrite', async () => {
            bridge.setActiveSession('sess-1');
            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [
                    { id: '1', content: 'Task A', status: 'pending' },
                    { id: '2', content: 'Task B', status: 'in_progress' },
                ],
            });

            await vi.advanceTimersByTimeAsync(0);
            expect(discord.send).toHaveBeenCalledWith(expect.stringContaining('📋 Tasks'));
            expect(discord.pinMessage).toHaveBeenCalledWith('todo-msg-1');
        });

        it('edits existing message on subsequent TodoWrite', async () => {
            bridge.setActiveSession('sess-1');

            // First call — sends new message
            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'pending' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            vi.mocked(discord.send).mockClear();

            // Second call — should edit, not send new
            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'completed' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.send).not.toHaveBeenCalled();
            expect(discord.editMessage).toHaveBeenCalledWith('todo-msg-1', expect.stringContaining('📋 Tasks'));
        });

        it('unpins message when all todos are completed', async () => {
            bridge.setActiveSession('sess-1');

            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'pending' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'completed' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.unpinMessage).toHaveBeenCalledWith('todo-msg-1');
        });

        it('creates new pinned message after previous was unpinned', async () => {
            bridge.setActiveSession('sess-1');

            // First round: all completed immediately — send but don't pin
            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'completed' }],
            });
            await vi.advanceTimersByTimeAsync(0);
            vi.mocked(discord.send).mockClear();
            vi.mocked(discord.pinMessage).mockClear();

            // New round: should send new message + pin again
            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '2', content: 'Task B', status: 'pending' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.send).toHaveBeenCalledWith(expect.stringContaining('📋 Tasks'));
            expect(discord.pinMessage).toHaveBeenCalled();
        });

        it('processes TodoWrite for any session with registered key', async () => {
            bridge.setActiveSession('sess-1');
            sendToolCallStart('sess-other', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task', status: 'pending' }],
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(discord.send).toHaveBeenCalledWith(expect.stringContaining('📋 Tasks'));
            expect(discord.pinMessage).toHaveBeenCalled();
        });

        it('ignores tool-call-start for non-TodoWrite tools', async () => {
            bridge.setActiveSession('sess-1');
            sendToolCallStart('sess-1', 'Bash', { command: 'ls' });
            await vi.advanceTimersByTimeAsync(0);
            expect(discord.pinMessage).not.toHaveBeenCalled();
        });

        it('resets todo state on session switch', async () => {
            bridge.setActiveSession('sess-1');
            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'pending' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            // Switch session
            bridge.setActiveSession('sess-2');

            vi.mocked(discord.send).mockClear();
            vi.mocked(discord.pinMessage).mockClear();

            // New session should get fresh todo state
            sendToolCallStart('sess-2', 'TodoWrite', {
                todos: [{ id: '2', content: 'Task B', status: 'pending' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.send).toHaveBeenCalledWith(expect.stringContaining('📋 Tasks'));
            expect(discord.pinMessage).toHaveBeenCalled();
        });
    });

    describe('createNewSession', () => {
        it('calls machineRPC with spawn-happy-session', async () => {
            bridge.setActiveSession('existing-sess');
            const { listActiveSessions } = await import('../vendor/api.js');
            const newSession = {
                id: 'new-sess-id',
                seq: 1,
                createdAt: 1000,
                updatedAt: 2000,
                active: true,
                activeAt: 2000,
                metadata: { path: '/test/dir' },
                agentState: null,
                dataEncryptionKey: null,
                encryption: { key: new Uint8Array(32), variant: 'dataKey' as const },
            };
            vi.mocked(listActiveSessions).mockResolvedValueOnce([newSession] as DecryptedSession[]);

            const result = await bridge.createNewSession('machine-1', '/test/dir');

            expect(happy.machineRPC).toHaveBeenCalledWith(
                'machine-1',
                'spawn-happy-session',
                { directory: '/test/dir', approvedNewDirectoryCreation: true },
            );
            expect(result).toBe('new-sess-id');
            expect(bridge.activeSession).toBe('new-sess-id');
        });

        it('throws when machineRPC fails', async () => {
            vi.mocked(happy.machineRPC).mockRejectedValueOnce(new Error('machine offline'));

            await expect(bridge.createNewSession('machine-1', '/test/dir')).rejects.toThrow('machine offline');
        });

        it('throws when machineRPC returns undefined (decrypt failure)', async () => {
            vi.mocked(happy.machineRPC).mockResolvedValueOnce(undefined as any);

            await expect(bridge.createNewSession('machine-1', '/test/dir')).rejects.toThrow('Daemon did not return a sessionId');
        });

        it('retries listActiveSessions if new session not found initially', async () => {
            bridge.setActiveSession('existing-sess');
            const { listActiveSessions } = await import('../vendor/api.js');
            const newSession = {
                id: 'new-sess-id',
                seq: 1,
                createdAt: 1000,
                updatedAt: 2000,
                active: true,
                activeAt: 2000,
                metadata: { path: '/test/dir' },
                agentState: null,
                dataEncryptionKey: null,
                encryption: { key: new Uint8Array(32), variant: 'dataKey' as const },
            };
            vi.mocked(listActiveSessions)
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([newSession] as DecryptedSession[]);

            const resultPromise = bridge.createNewSession('machine-1', '/test/dir');
            await vi.advanceTimersByTimeAsync(2000);
            const result = await resultPromise;

            expect(result).toBe('new-sess-id');
            expect(listActiveSessions).toHaveBeenCalledTimes(2);
        });
    });

    describe('listAllSessions', () => {
        it('returns all sessions from listSessions API', async () => {
            const { listSessions } = await import('../vendor/api.js');
            const mockSessions = [
                { id: 'sess-1', activeAt: 1000, encryption: { key: new Uint8Array(32), variant: 'dataKey' } },
            ] as unknown as DecryptedSession[];
            vi.mocked(listSessions).mockResolvedValueOnce(mockSessions);

            const result = await bridge.listAllSessions();

            expect(result).toEqual(mockSessions);
            expect(listSessions).toHaveBeenCalledWith(config.happy, config.credentials);
        });
    });

    describe('Attachment upload', () => {
        const IMAGE_CONTENT_TYPE = 'image/png';
        const PDF_CONTENT_TYPE = 'application/pdf';
        const MAX_SIZE = 10 * 1024 * 1024; // 10MB

        function makeAttachment(overrides: Partial<{
            url: string;
            name: string;
            contentType: string | null;
            size: number;
        }> = {}) {
            return {
                url: overrides.url ?? 'https://cdn.discordapp.com/attachments/123/456/test.png',
                name: overrides.name ?? 'test.png',
                contentType: overrides.contentType ?? IMAGE_CONTENT_TYPE,
                size: overrides.size ?? 1024,
            };
        }

        beforeEach(() => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
            }));

            (happy.sessionRPC as ReturnType<typeof vi.fn>).mockImplementation(
                (_sid: string, method: string) => {
                    if (method === 'writeFile') return Promise.resolve({ success: true, hash: 'abc123' });
                    if (method === 'bash') return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
                    return Promise.resolve({});
                },
            );
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('should upload a single image attachment and return hint', async () => {
            bridge.setActiveSession('sess-1');
            const attachment = makeAttachment();
            const hints = await bridge.uploadAttachments([attachment]);

            expect(hints).toHaveLength(1);
            expect(hints[0]).toContain('[Attached image:');
            expect(hints[0]).toContain('test.png');
            expect(hints[0]).toContain('Read tool');

            expect(happy.sessionRPC).toHaveBeenCalledWith(
                'sess-1', 'bash',
                expect.objectContaining({ command: 'mkdir -p .attachments' }),
            );

            expect(happy.sessionRPC).toHaveBeenCalledWith(
                'sess-1', 'writeFile',
                expect.objectContaining({
                    path: expect.stringContaining('.attachments/'),
                    content: expect.any(String),
                    expectedHash: null,
                }),
            );
        });

        it('should upload a non-image file with correct hint', async () => {
            bridge.setActiveSession('sess-1');
            const attachment = makeAttachment({
                name: 'report.pdf',
                contentType: PDF_CONTENT_TYPE,
            });
            const hints = await bridge.uploadAttachments([attachment]);

            expect(hints).toHaveLength(1);
            expect(hints[0]).toContain('[Attached file:');
            expect(hints[0]).toContain('report.pdf');
        });

        it('should skip attachments exceeding size limit', async () => {
            bridge.setActiveSession('sess-1');
            const attachment = makeAttachment({ size: MAX_SIZE + 1, name: 'huge.png' });
            const hints = await bridge.uploadAttachments([attachment]);

            expect(hints).toHaveLength(1);
            expect(hints[0]).toContain('Skipped');
            expect(hints[0]).toContain('huge.png');
            expect(hints[0]).toContain('exceeds');
        });

        it('should handle download failure gracefully', async () => {
            bridge.setActiveSession('sess-1');
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

            const attachment = makeAttachment({ name: 'missing.png' });
            const hints = await bridge.uploadAttachments([attachment]);

            expect(hints).toHaveLength(1);
            expect(hints[0]).toContain('Failed to download');
            expect(hints[0]).toContain('missing.png');
        });

        it('should handle fetch network error gracefully', async () => {
            bridge.setActiveSession('sess-1');
            vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));

            const attachment = makeAttachment({ name: 'unreachable.png' });
            const hints = await bridge.uploadAttachments([attachment]);

            expect(hints).toHaveLength(1);
            expect(hints[0]).toContain('Failed to download');
            expect(hints[0]).toContain('unreachable.png');
        });

        it('should handle writeFile RPC failure gracefully', async () => {
            bridge.setActiveSession('sess-1');
            (happy.sessionRPC as ReturnType<typeof vi.fn>).mockImplementation(
                (_sid: string, method: string) => {
                    if (method === 'writeFile') return Promise.resolve({ success: false, error: 'disk full' });
                    if (method === 'bash') return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
                    return Promise.resolve({});
                },
            );

            const attachment = makeAttachment({ name: 'fail.png' });
            const hints = await bridge.uploadAttachments([attachment]);

            expect(hints).toHaveLength(1);
            expect(hints[0]).toContain('Failed to upload');
            expect(hints[0]).toContain('fail.png');
        });

        it('should upload multiple attachments in parallel', async () => {
            bridge.setActiveSession('sess-1');
            const attachments = [
                makeAttachment({ name: 'a.png', url: 'https://cdn.example.com/a.png' }),
                makeAttachment({ name: 'b.pdf', contentType: PDF_CONTENT_TYPE, url: 'https://cdn.example.com/b.pdf' }),
            ];
            const hints = await bridge.uploadAttachments(attachments);

            expect(hints).toHaveLength(2);
            const bashCalls = (happy.sessionRPC as ReturnType<typeof vi.fn>).mock.calls
                .filter((call) => call[1] === 'bash');
            expect(bashCalls).toHaveLength(1);
        });

        it('should return empty array when no active session', async () => {
            const attachment = makeAttachment();
            const hints = await bridge.uploadAttachments([attachment]);
            expect(hints).toHaveLength(0);
        });

        it('should sanitize path traversal in filename', async () => {
            bridge.setActiveSession('sess-1');
            const attachment = makeAttachment({ name: '../../../.bashrc' });
            const hints = await bridge.uploadAttachments([attachment]);

            expect(hints).toHaveLength(1);
            expect(hints[0]).toContain('.attachments/');
            expect(hints[0]).not.toContain('../');
            // writeFile path should not contain traversal
            const writeCall = (happy.sessionRPC as ReturnType<typeof vi.fn>).mock.calls
                .find((call) => call[1] === 'writeFile');
            expect(writeCall).toBeDefined();
            expect(writeCall![2].path).not.toContain('..');
        });
    });

    describe('archiveSession', () => {
        it('calls sessionRPC killSession on active session', async () => {
            bridge.setActiveSession('sess-1');
            const result = await bridge.archiveSession();

            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'killSession', {});
            expect(result).toBe('sess-1');
        });

        it('calls sessionRPC killSession on specified session', async () => {
            bridge.setActiveSession('sess-1');
            const result = await bridge.archiveSession('sess-other');

            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-other', 'killSession', {});
            expect(result).toBe('sess-other');
        });

        it('throws when no active session and no sessionId provided', async () => {
            await expect(bridge.archiveSession()).rejects.toThrow('No active session');
        });

        it('resolves prefix to full session ID before calling sessionRPC', async () => {
            bridge.setActiveSession('sess-full-id-abc123');
            bridge.setThread('sess-full-id-abc123', 'thread-1');
            await bridge.archiveSession('sess-full');

            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-full-id-abc123', 'killSession', {});
        });

        it('clears activeSessionId when archiving active session', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.archiveSession('sess-1');
            expect(bridge.activeSession).toBeNull();
        });

        it('does not clear activeSessionId when archiving different session', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.archiveSession('sess-other');
            expect(bridge.activeSession).toBe('sess-1');
        });

        it('removes encryption key after archiving', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.archiveSession('sess-1');
            expect(happy.removeSessionKey).toHaveBeenCalledWith('sess-1');
        });

        it('persists state after archiving', async () => {
            const mockStore = { save: vi.fn().mockResolvedValue(undefined), load: vi.fn() };
            bridge.setStore(mockStore as any);
            bridge.setActiveSession('sess-1');
            await bridge.archiveSession('sess-1');
            expect(mockStore.save).toHaveBeenCalled();
        });
    });

    describe('deleteSession', () => {
        it('calls deleteSession API on active session and clears activeSessionId', async () => {
            bridge.setActiveSession('sess-1');
            const { deleteSession: apiDelete } = await import('../vendor/api.js');

            const result = await bridge.deleteSession();

            expect(apiDelete).toHaveBeenCalledWith(config.happy, config.credentials, 'sess-1');
            expect(result).toBe('sess-1');
            expect(bridge.activeSession).toBeNull();
        });

        it('calls deleteSession API on specified session without clearing active', async () => {
            bridge.setActiveSession('sess-1');
            const { deleteSession: apiDelete } = await import('../vendor/api.js');

            const result = await bridge.deleteSession('sess-other');

            expect(apiDelete).toHaveBeenCalledWith(config.happy, config.credentials, 'sess-other');
            expect(result).toBe('sess-other');
            expect(bridge.activeSession).toBe('sess-1');
        });

        it('throws when no active session and no sessionId provided', async () => {
            await expect(bridge.deleteSession()).rejects.toThrow('No active session');
        });
    });

    describe('Thread routing', () => {
        it('getThreadId returns null for session without thread', () => {
            bridge.setActiveSession('sess-1');
            expect(bridge.getThreadId('sess-1')).toBeNull();
        });

        it('setThread stores mapping and getThreadId returns it', () => {
            bridge.setThread('sess-1', 'thread-1');
            expect(bridge.getThreadId('sess-1')).toBe('thread-1');
        });

        it('getSessionByThread returns sessionId for known thread', () => {
            bridge.setThread('sess-1', 'thread-1');
            expect(bridge.getSessionByThread('thread-1')).toBe('sess-1');
        });

        it('getSessionByThread returns null for unknown thread', () => {
            expect(bridge.getSessionByThread('unknown')).toBeNull();
        });

        it('removeThread clears mapping', () => {
            bridge.setThread('sess-1', 'thread-1');
            bridge.removeThread('sess-1');
            expect(bridge.getThreadId('sess-1')).toBeNull();
            expect(bridge.getSessionByThread('thread-1')).toBeNull();
        });

        it('getThreadMap returns all mappings', () => {
            bridge.setThread('s1', 't1');
            bridge.setThread('s2', 't2');
            expect(bridge.getThreadMap()).toEqual({ s1: 't1', s2: 't2' });
        });

        it('loadThreadMap restores mappings', () => {
            bridge.loadThreadMap({ s1: 't1', s2: 't2' });
            expect(bridge.getThreadId('s1')).toBe('t1');
            expect(bridge.getSessionByThread('t2')).toBe('s2');
        });
    });

    describe('Thread-aware message output', () => {
        it('sends agent text to thread when thread exists (legacy format)', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

            const assistantContent = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [{ type: 'text', text: 'Hello from thread!' }],
                        },
                    },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(assistantContent)).toString('base64');

            bridge.processUpdate({
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
            });

            await vi.waitFor(() => {
                expect(discord.sendToThread).toHaveBeenCalledWith('thread-1', 'Hello from thread!');
            });
            expect(discord.send).not.toHaveBeenCalled();
        });

        it('sends session protocol text to thread when thread exists', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

            const sessionContent = {
                role: 'session',
                content: {
                    role: 'agent',
                    ev: { t: 'text', text: 'Session text in thread' },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(sessionContent)).toString('base64');

            bridge.processUpdate({
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
            });

            await vi.waitFor(() => {
                expect(discord.sendToThread).toHaveBeenCalledWith('thread-1', 'Session text in thread');
            });
            expect(discord.send).not.toHaveBeenCalled();
        });

        it('filters out skill content text events (Base directory for this skill:)', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

            const skillContent = {
                role: 'session',
                content: {
                    role: 'agent',
                    ev: {
                        t: 'text',
                        text: 'Base directory for this skill: /Users/user/.claude/skills/verification-loop\n\n# Verification Loop Skill\n\nA comprehensive verification system...',
                    },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(skillContent)).toString('base64');

            bridge.processUpdate({
                body: {
                    t: 'new-message',
                    sid: 'sess-1',
                    message: {
                        id: 'msg-skill',
                        seq: 10,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            });

            await vi.advanceTimersByTimeAsync(0);
            expect(discord.sendToThread).not.toHaveBeenCalled();
            expect(discord.send).not.toHaveBeenCalled();
        });

        it('forwards normal text that does not start with skill prefix', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

            const normalContent = {
                role: 'session',
                content: {
                    role: 'agent',
                    ev: { t: 'text', text: 'TypeScript project detected. Starting verification.' },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(normalContent)).toString('base64');

            bridge.processUpdate({
                body: {
                    t: 'new-message',
                    sid: 'sess-1',
                    message: {
                        id: 'msg-normal',
                        seq: 11,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            });

            await vi.waitFor(() => {
                expect(discord.sendToThread).toHaveBeenCalledWith(
                    'thread-1',
                    'TypeScript project detected. Starting verification.',
                );
            });
        });

        it('sends agent text to main channel when no thread', async () => {
            bridge.setActiveSession('sess-1');

            const assistantContent = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [{ type: 'text', text: 'Hello from main!' }],
                        },
                    },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(assistantContent)).toString('base64');

            bridge.processUpdate({
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
            });

            await vi.waitFor(() => {
                expect(discord.send).toHaveBeenCalledWith('Hello from main!');
            });
            expect(discord.sendToThread).not.toHaveBeenCalled();
        });

        it('sends permission buttons to thread when thread exists', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

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
                expect(discord.sendToThreadWithButtons).toHaveBeenCalledWith(
                    'thread-1', expect.any(String), expect.any(Array),
                );
            });
            expect(discord.sendWithButtons).not.toHaveBeenCalled();
        });

        it('sends AskUserQuestion buttons to thread when thread exists', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

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
                expect(discord.sendToThreadWithButtons).toHaveBeenCalledWith(
                    'thread-1', expect.stringContaining('Which DB?'), expect.any(Array),
                );
            });
            expect(discord.sendWithButtons).not.toHaveBeenCalled();
        });

        it('sends ExitPlanMode attachment to thread when thread exists', async () => {
            await bridge.start();
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

            const agentState = {
                requests: {
                    'req-plan': {
                        id: 'req-plan',
                        tool: 'ExitPlanMode',
                        arguments: { plan: 'The plan' },
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
                expect(discord.sendToThreadWithAttachment).toHaveBeenCalledWith(
                    'thread-1',
                    expect.stringContaining('Plan Proposal'),
                    expect.any(Buffer),
                    'plan.md',
                    expect.any(Array),
                );
            });
            expect(discord.sendWithAttachmentAndButtons).not.toHaveBeenCalled();
        });
    });

    describe('Thread-aware typing and emoji', () => {
        it('sends typing to thread when active session has thread', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            bridge.handleEphemeralActivity('sess-1', true);

            expect(discord.sendTypingInThread).toHaveBeenCalledWith('thread-1');
            expect(discord.sendTyping).not.toHaveBeenCalled();
        });

        it('sends typing to main channel when no thread', async () => {
            bridge.setActiveSession('sess-1');
            bridge.handleEphemeralActivity('sess-1', true);

            expect(discord.sendTyping).toHaveBeenCalled();
            expect(discord.sendTypingInThread).not.toHaveBeenCalled();
        });

        it('adds thinking emoji in thread when threadId is set via setLastUserMessageId', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            bridge.setLastUserMessageId('msg-u1', 'thread-1');
            bridge.handleEphemeralActivity('sess-1', true);

            expect(discord.reactInThread).toHaveBeenCalledWith('thread-1', 'msg-u1', '🤔');
            expect(discord.reactToMessage).not.toHaveBeenCalled();
        });

        it('removes thinking emoji in thread', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            bridge.setLastUserMessageId('msg-u1', 'thread-1');
            bridge.handleEphemeralActivity('sess-1', true);
            vi.clearAllMocks();
            bridge.handleEphemeralActivity('sess-1', false);

            expect(discord.removeReactionInThread).toHaveBeenCalledWith('thread-1', 'msg-u1', '🤔');
            expect(discord.removeReaction).not.toHaveBeenCalled();
        });

        it('setActiveSession resets lastUserMsgThreadId', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            bridge.setLastUserMessageId('msg-u1', 'thread-1');
            bridge.handleEphemeralActivity('sess-1', true);
            vi.clearAllMocks();

            // Switch session clears thread context
            bridge.setActiveSession('sess-2');
            bridge.setLastUserMessageId('msg-u2');
            bridge.handleEphemeralActivity('sess-2', true);

            // Should use main channel methods since lastUserMsgThreadId was reset
            expect(discord.reactToMessage).toHaveBeenCalledWith('msg-u2', '🤔');
            expect(discord.reactInThread).not.toHaveBeenCalled();
        });
    });

    describe('Thread-aware TodoWrite', () => {
        function sendToolCallStart(sessionId: string, name: string, args: Record<string, unknown>) {
            const content = {
                role: 'session',
                content: {
                    role: 'agent',
                    ev: { t: 'tool-call-start', name, args },
                },
            };
            const encrypted = Buffer.from(JSON.stringify(content)).toString('base64');
            bridge.processUpdate({
                body: {
                    t: 'new-message',
                    sid: sessionId,
                    message: {
                        id: `msg-${Date.now()}`,
                        seq: 1,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            });
        }

        it('sends and pins todo message in thread', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'pending' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.sendToThread).toHaveBeenCalledWith('thread-1', expect.stringContaining('📋 Tasks'));
            expect(discord.pinMessageInThread).toHaveBeenCalledWith('thread-1', 'thread-msg-1');
            expect(discord.send).not.toHaveBeenCalled();
            expect(discord.pinMessage).not.toHaveBeenCalled();
        });

        it('edits todo message in thread on subsequent TodoWrite', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');

            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'pending' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            sendToolCallStart('sess-1', 'TodoWrite', {
                todos: [{ id: '1', content: 'Task A', status: 'completed' }],
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(discord.editMessageInThread).toHaveBeenCalledWith(
                'thread-1', 'thread-msg-1', expect.stringContaining('📋 Tasks'),
            );
            expect(discord.unpinMessageInThread).toHaveBeenCalledWith('thread-1', 'thread-msg-1');
            expect(discord.editMessage).not.toHaveBeenCalled();
            expect(discord.unpinMessage).not.toHaveBeenCalled();
        });
    });

    describe('Thread-aware tool use emoji', () => {
        it('adds tool use emoji in thread', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            bridge.setLastUserMessageId('msg-u1', 'thread-1');

            const content = {
                role: 'session',
                content: { role: 'agent', ev: { t: 'tool-call-start', name: 'Bash', args: {} } },
            };
            const encrypted = Buffer.from(JSON.stringify(content)).toString('base64');
            bridge.processUpdate({
                body: {
                    t: 'new-message',
                    sid: 'sess-1',
                    message: {
                        id: 'msg-t1',
                        seq: 1,
                        content: { c: encrypted, t: 'encrypted' },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    },
                },
            });

            await vi.advanceTimersByTimeAsync(0);
            expect(discord.reactInThread).toHaveBeenCalledWith('thread-1', 'msg-u1', '🔧');
            expect(discord.reactToMessage).not.toHaveBeenCalled();
        });
    });

    describe('persistModes with threads', () => {
        it('persistModes saves thread map', () => {
            const mockStore = { save: vi.fn().mockResolvedValue(undefined), load: vi.fn() };
            bridge.setThread('s1', 't1');
            bridge.setStore(mockStore as any);
            bridge.setActiveSession('sess-1');
            bridge.persistModes();
            expect(mockStore.save).toHaveBeenCalledWith(
                expect.objectContaining({ threads: { s1: 't1' } }),
            );
        });
    });

    describe('ensureThread', () => {
        it('creates thread and stores mapping', async () => {
            bridge.setActiveSession('sess-1');
            const threadId = await bridge.ensureThread('sess-1', { path: '/Users/user/my-project', machineId: 'abc', host: 'macbook' });
            expect(discord.createThread).toHaveBeenCalledWith('my-project @ macbook');
            expect(threadId).toBe('thread-1');
            expect(bridge.getThreadId('sess-1')).toBe('thread-1');
        });

        it('returns existing thread if already mapped', async () => {
            bridge.setThread('sess-1', 'existing-thread');
            const threadId = await bridge.ensureThread('sess-1', { path: '/a/b', machineId: 'x', host: 'y' });
            expect(discord.createThread).not.toHaveBeenCalled();
            expect(threadId).toBe('existing-thread');
        });

        it('uses fallback name for invalid metadata', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.ensureThread('sess-1', null);
            expect(discord.createThread).toHaveBeenCalledWith('session-sess-1');
        });
    });

    describe('Thread lifecycle', () => {
        it('archiveSession archives the thread and removes mapping', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            await bridge.archiveSession('sess-1');
            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'killSession', {});
            expect(discord.archiveThread).toHaveBeenCalledWith('thread-1');
            expect(bridge.getThreadId('sess-1')).toBeNull();
        });

        it('deleteSession deletes the thread and removes mapping', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            await bridge.deleteSession('sess-1');
            expect(discord.deleteThread).toHaveBeenCalledWith('thread-1');
            expect(bridge.getThreadId('sess-1')).toBeNull();
        });

        it('archiveSession without thread still archives session', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.archiveSession('sess-1');
            expect(happy.sessionRPC).toHaveBeenCalledWith('sess-1', 'killSession', {});
            expect(discord.archiveThread).not.toHaveBeenCalled();
        });

        it('deleteSession without thread still deletes session', async () => {
            bridge.setActiveSession('sess-1');
            await bridge.deleteSession('sess-1');
            expect(discord.deleteThread).not.toHaveBeenCalled();
        });

        it('deleteSession clears activeSessionId when deleting active session', async () => {
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            await bridge.deleteSession('sess-1');
            expect(bridge.activeSession).toBeNull();
        });

        it('deleteSession persists modes after cleanup', async () => {
            const mockStore = { save: vi.fn().mockResolvedValue(undefined), load: vi.fn() };
            bridge.setStore(mockStore as any);
            bridge.setActiveSession('sess-1');
            bridge.setThread('sess-1', 'thread-1');
            await bridge.deleteSession('sess-1');
            expect(mockStore.save).toHaveBeenCalled();
        });

        it('deleteSession resolves prefix to full session ID for thread cleanup', async () => {
            bridge.setActiveSession('sess-full-id-abc123');
            bridge.setThread('sess-full-id-abc123', 'thread-1');
            await bridge.deleteSession('sess-full');
            expect(discord.deleteThread).toHaveBeenCalledWith('thread-1');
            expect(bridge.getThreadId('sess-full-id-abc123')).toBeNull();
        });

        it('archiveSession resolves prefix to full session ID for thread archive', async () => {
            bridge.setActiveSession('sess-full-id-abc123');
            bridge.setThread('sess-full-id-abc123', 'thread-1');
            await bridge.archiveSession('sess-full');
            expect(discord.archiveThread).toHaveBeenCalledWith('thread-1');
            expect(bridge.getThreadId('sess-full-id-abc123')).toBeNull();
        });
    });

    describe('cleanupArchivedSessions', () => {
        it('deletes archived sessions and their threads', async () => {
            const { listSessions } = await import('../vendor/api.js');
            const { deleteSession: apiDelete } = await import('../vendor/api.js');
            vi.mocked(listSessions).mockResolvedValueOnce([
                { id: 'active-1', active: true },
                { id: 'archived-1', active: false },
                { id: 'archived-2', active: false },
            ] as any);

            bridge.setActiveSession('active-1');
            bridge.setThread('archived-1', 'thread-a');

            const result = await bridge.cleanupArchivedSessions();
            expect(result.sessions).toBe(2);
            expect(apiDelete).toHaveBeenCalledTimes(2);
            expect(discord.deleteThread).toHaveBeenCalledWith('thread-a');
            expect(bridge.getThreadId('archived-1')).toBeNull();
        });

        it('silences 404 errors from already-deleted sessions', async () => {
            const { listSessions } = await import('../vendor/api.js');
            const { deleteSession: apiDelete } = await import('../vendor/api.js');
            vi.mocked(listSessions).mockResolvedValueOnce([
                { id: 'gone-1', active: false },
            ] as any);
            const err = new Error('Not found') as any;
            err.status = 404;
            vi.mocked(apiDelete).mockRejectedValueOnce(err);

            const result = await bridge.cleanupArchivedSessions();
            expect(result.sessions).toBe(0);
        });

        it('removes orphan threads from thread map', async () => {
            const { listSessions } = await import('../vendor/api.js');
            vi.mocked(listSessions).mockResolvedValueOnce([
                { id: 'active-1', active: true },
            ] as any);

            bridge.setActiveSession('active-1');
            bridge.setThread('active-1', 'thread-active');
            bridge.setThread('stale-1', 'thread-stale');

            const result = await bridge.cleanupArchivedSessions();
            expect(result.threads).toBeGreaterThanOrEqual(1);
            expect(discord.deleteThread).toHaveBeenCalledWith('thread-stale');
            expect(bridge.getThreadId('stale-1')).toBeNull();
            // Active thread should remain
            expect(bridge.getThreadId('active-1')).toBe('thread-active');
        });

        it('scans Discord channel for untracked orphan threads', async () => {
            const { listSessions } = await import('../vendor/api.js');
            vi.mocked(listSessions).mockResolvedValueOnce([
                { id: 'active-1', active: true },
            ] as any);
            bridge.setActiveSession('active-1');
            bridge.setThread('active-1', 'thread-active');

            vi.mocked(discord.listThreads).mockResolvedValueOnce([
                { id: 'thread-active', name: 'active' },
                { id: 'thread-orphan', name: 'orphan' },
            ]);

            const result = await bridge.cleanupArchivedSessions();
            expect(discord.deleteThread).toHaveBeenCalledWith('thread-orphan');
            expect(result.threads).toBeGreaterThanOrEqual(1);
        });

        it('purges stale permission data from cache', async () => {
            const { listSessions } = await import('../vendor/api.js');
            vi.mocked(listSessions).mockResolvedValueOnce([
                { id: 'active-1', active: true },
            ] as any);

            bridge.setActiveSession('active-1');
            bridge.permissions.saveSession('active-1');
            bridge.permissions.saveSession('stale-1');

            await bridge.cleanupArchivedSessions();
            const all = bridge.permissions.getAllSessions();
            expect(all['active-1']).toBeDefined();
            expect(all['stale-1']).toBeUndefined();
        });
    });

    describe('replayPendingPermissions', () => {
        it('replays pending permissions from all sessions on startup', async () => {
            const { listActiveSessions } = await import('../vendor/api.js');
            // start() needs an initial call
            vi.mocked(listActiveSessions).mockResolvedValueOnce([]);
            await bridge.start();

            const sessions = [
                {
                    id: 'sess-1',
                    active: true,
                    activeAt: 1000,
                    agentState: {
                        requests: { 'req-1': { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1000 } },
                    },
                    encryption: { key: new Uint8Array(32), variant: 'dataKey' as const },
                },
                {
                    id: 'sess-2',
                    active: true,
                    activeAt: 2000,
                    agentState: null,
                    encryption: { key: new Uint8Array(32), variant: 'dataKey' as const },
                },
            ] as unknown as DecryptedSession[];
            vi.mocked(listActiveSessions).mockResolvedValueOnce(sessions);

            await bridge.replayPendingPermissions();

            // handlePermissionRequest has a 500ms delay
            await vi.advanceTimersByTimeAsync(600);
            expect(discord.sendWithButtons).toHaveBeenCalledWith(
                expect.stringContaining('Bash'),
                expect.any(Array),
            );
        });

        it('skips sessions with no pending requests', async () => {
            const { listActiveSessions } = await import('../vendor/api.js');
            vi.mocked(listActiveSessions).mockResolvedValueOnce([]);
            await bridge.start();

            const sessions = [
                {
                    id: 'sess-1',
                    active: true,
                    activeAt: 1000,
                    agentState: { requests: {} },
                    encryption: { key: new Uint8Array(32), variant: 'dataKey' as const },
                },
            ] as unknown as DecryptedSession[];
            vi.mocked(listActiveSessions).mockResolvedValueOnce(sessions);

            await bridge.replayPendingPermissions();

            await vi.advanceTimersByTimeAsync(600);
            expect(discord.sendWithButtons).not.toHaveBeenCalled();
        });
    });
});
