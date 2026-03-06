import { describe, it, expect, vi } from 'vitest';
import { commandDefinitions, handleCommand } from '../commands.js';
import type { Bridge } from '../../bridge.js';

// Minimal interaction mock
function mockInteraction(name: string, options: Record<string, string> = {}) {
    return {
        commandName: name,
        user: { id: 'u-1' },
        options: {
            getString: vi.fn((key: string, _required?: boolean) => options[key] ?? null),
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
        sendMessage: vi.fn().mockResolvedValue(undefined),
        stopSession: vi.fn().mockResolvedValue(undefined),
        compactSession: vi.fn().mockResolvedValue(undefined),
        persistModes: vi.fn(),
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
            const interaction = mockInteraction('stop');
            await handleCommand(interaction as any, bridge);

            expect(bridge.stopSession).toHaveBeenCalled();
        });

        it('/compact calls bridge.compactSession', async () => {
            const bridge = makeMockBridge();
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
    });
});
