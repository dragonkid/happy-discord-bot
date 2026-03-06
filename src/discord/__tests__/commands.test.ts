import { describe, it, expect, vi } from 'vitest';
import { commandDefinitions, handleCommand } from '../commands.js';
import type { Bridge } from '../../bridge.js';

// Minimal interaction mock
function mockInteraction(name: string, options: Record<string, string> = {}, channelId = 'ch-main') {
    return {
        commandName: name,
        channelId,
        user: { id: 'u-1' },
        options: {
            getString: vi.fn((key: string, _required?: boolean) => options[key] ?? null),
            data: [],
        },
        reply: vi.fn().mockResolvedValue(undefined),
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
    };
}

function makeMockBridge(): Bridge {
    return {
        listSessions: vi.fn().mockResolvedValue([]),
        listAllSessions: vi.fn().mockResolvedValue([]),
        createNewSession: vi.fn().mockResolvedValue('new-sess-id'),
        archiveSession: vi.fn().mockResolvedValue('sess-1'),
        deleteSession: vi.fn().mockResolvedValue('sess-1'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        stopSession: vi.fn().mockResolvedValue(undefined),
        compactSession: vi.fn().mockResolvedValue(undefined),
        persistModes: vi.fn(),
        setActiveSession: vi.fn(),
        getSessionByThread: vi.fn().mockReturnValue(null),
        activeSession: null,
        permissions: {
            setMode: vi.fn(),
            mode: 'default',
        },
    } as unknown as Bridge;
}

describe('commands', () => {
    describe('commandDefinitions', () => {
        it('exports an array of slash command JSON objects', () => {
            expect(Array.isArray(commandDefinitions)).toBe(true);
            expect(commandDefinitions.length).toBeGreaterThan(0);
            for (const cmd of commandDefinitions) {
                expect(cmd).toHaveProperty('name');
                expect(cmd).toHaveProperty('description');
            }
        });

        it('includes /sessions command', () => {
            expect(commandDefinitions.find((c: { name: string }) => c.name === 'sessions')).toBeDefined();
        });

        it('includes /send command with message option', () => {
            const send = commandDefinitions.find((c: { name: string }) => c.name === 'send');
            expect(send).toBeDefined();
            expect(send!.options).toBeDefined();
        });
    });

    describe('handleCommand', () => {
        it('/sessions calls bridge.listSessions and formats result', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.listSessions).mockResolvedValueOnce([
                { id: 'sess-1', active: true, activeAt: 1000 },
                { id: 'sess-2', active: true, activeAt: 2000 },
            ] as any);
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-2' });

            const interaction = mockInteraction('sessions');
            await handleCommand(interaction as any, bridge);

            expect(interaction.deferReply).toHaveBeenCalled();
            expect(bridge.listSessions).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('sess-1'),
                    components: expect.any(Array),
                }),
            );
        });

        it('/sessions shows "no active sessions" when empty', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('sessions');
            await handleCommand(interaction as any, bridge);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('No active sessions'),
            );
        });

        it('/send calls bridge.sendMessage', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('send', { message: 'hello' });
            await handleCommand(interaction as any, bridge);

            expect(bridge.sendMessage).toHaveBeenCalledWith('hello');
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('Sent'),
            );
        });

        it('/send replies with error when no message', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('send');
            await handleCommand(interaction as any, bridge);

            expect(interaction.reply).toHaveBeenCalledWith(
                expect.objectContaining({ content: expect.stringContaining('message') }),
            );
        });

        it('/stop calls bridge.stopSession', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1', writable: true });
            const interaction = mockInteraction('stop');
            await handleCommand(interaction as any, bridge);

            expect(bridge.stopSession).toHaveBeenCalledWith('sess-1');
        });

        it('/compact calls bridge.compactSession', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1', writable: true });
            const interaction = mockInteraction('compact');
            await handleCommand(interaction as any, bridge);

            expect(bridge.compactSession).toHaveBeenCalled();
        });

        it('/mode sets permission mode via bridge', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('mode', { mode: 'acceptEdits' });
            await handleCommand(interaction as any, bridge);

            expect(bridge.permissions.setMode).toHaveBeenCalledWith('acceptEdits');
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('acceptEdits'),
            );
        });

        it('unknown command replies with error', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('nonexistent');
            await handleCommand(interaction as any, bridge);

            expect(interaction.reply).toHaveBeenCalledWith(
                expect.objectContaining({ content: expect.stringContaining('Unknown') }),
            );
        });

        it('includes /new command', () => {
            expect(commandDefinitions.find((c: { name: string }) => c.name === 'new')).toBeDefined();
        });

        it('/new shows directory menu when sessions have metadata', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.listAllSessions).mockResolvedValueOnce([
                {
                    id: 'sess-1',
                    activeAt: 3000,
                    metadata: { path: '/Users/user/project', machineId: 'machine-1', host: 'test', version: '0.14.0', os: 'darwin' },
                },
            ] as any);

            const interaction = mockInteraction('new');
            await handleCommand(interaction as any, bridge);

            expect(interaction.deferReply).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Select a directory'),
                    components: expect.any(Array),
                }),
            );
        });

        it('/new shows error when no machines found', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.listAllSessions).mockResolvedValueOnce([]);

            const interaction = mockInteraction('new');
            await handleCommand(interaction as any, bridge);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('No machines found'),
            );
        });

        it('includes /archive command', () => {
            expect(commandDefinitions.find((c: { name: string }) => c.name === 'archive')).toBeDefined();
        });

        it('includes /delete command', () => {
            expect(commandDefinitions.find((c: { name: string }) => c.name === 'delete')).toBeDefined();
        });

        it('/archive calls bridge.archiveSession with active session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            const interaction = mockInteraction('archive');
            await handleCommand(interaction as any, bridge);

            expect(bridge.archiveSession).toHaveBeenCalledWith('sess-1');
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('archived'),
            );
        });

        it('/archive calls bridge.archiveSession with specified session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            vi.mocked(bridge.archiveSession).mockResolvedValue('sess-other');
            const interaction = mockInteraction('archive', { session: 'sess-other' });
            await handleCommand(interaction as any, bridge);

            expect(bridge.archiveSession).toHaveBeenCalledWith('sess-other');
        });

        it('/archive shows error when no active session', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('archive');
            await handleCommand(interaction as any, bridge);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('Failed to archive'),
            );
        });

        it('/delete shows confirmation buttons', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            const interaction = mockInteraction('delete');
            await handleCommand(interaction as any, bridge);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Permanently delete'),
                    components: expect.any(Array),
                }),
            );
        });

        it('/delete shows confirmation for specified session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            const interaction = mockInteraction('delete', { session: 'sess-other' });
            await handleCommand(interaction as any, bridge);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('sess-oth'),
                }),
            );
        });

        it('/delete shows error when no active session', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('delete');
            await handleCommand(interaction as any, bridge);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('Failed'),
            );
        });
    });

    describe('thread-aware command resolution', () => {
        it('/stop in a thread targets that thread session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('stop', {}, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(bridge.stopSession).toHaveBeenCalledWith('thread-sess');
        });

        it('/stop in main channel targets active session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            const interaction = mockInteraction('stop');
            await handleCommand(interaction as any, bridge);
            expect(bridge.stopSession).toHaveBeenCalledWith('active-sess');
        });

        it('/stop with no active session and no thread errors', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('stop');
            await handleCommand(interaction as any, bridge);
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('No active session'),
            );
        });

        it('/archive in a thread targets that thread session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('archive', {}, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(bridge.archiveSession).toHaveBeenCalledWith('thread-sess');
        });

        it('/archive with explicit session param ignores thread context', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('archive', { session: 'explicit-sess' }, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(bridge.archiveSession).toHaveBeenCalledWith('explicit-sess');
        });

        it('/compact in a thread switches active session then compacts', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('compact', {}, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(bridge.setActiveSession).toHaveBeenCalledWith('thread-sess');
            expect(bridge.compactSession).toHaveBeenCalled();
        });

        it('/mode in a thread switches to thread session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('mode', { mode: 'acceptEdits' }, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(bridge.setActiveSession).toHaveBeenCalledWith('thread-sess');
            expect(bridge.permissions.setMode).toHaveBeenCalledWith('acceptEdits');
        });

        it('/delete in a thread targets that thread session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('delete', {}, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('thread-s'),
                }),
            );
        });
    });
});
