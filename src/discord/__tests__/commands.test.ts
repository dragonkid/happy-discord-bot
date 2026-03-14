import { describe, it, expect, vi } from 'vitest';
import { commandDefinitions, handleCommand, handleSkillsAutocomplete, handleLoopAutocomplete } from '../commands.js';
import type { Bridge } from '../../bridge.js';

vi.mock('../../happy/usage.js', () => ({
    queryUsage: vi.fn(),
}));

vi.mock('../../cli/update.js', () => ({
    checkForUpdate: vi.fn().mockResolvedValue(null),
    performDiscordUpdate: vi.fn().mockResolvedValue(false),
}));

import { queryUsage } from '../../happy/usage.js';

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
        editReply: vi.fn().mockResolvedValue({ id: 'msg-123' }),
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
        getProjectDirForThread: vi.fn().mockReturnValue(undefined),
        getSessionProjectDir: vi.fn().mockReturnValue(undefined),
        getAllProjectDirs: vi.fn().mockReturnValue([]),
        happyClient: { request: vi.fn() },
        activeSession: null,
        pendingApprove: null,
        setPendingApprove: vi.fn(),
        clearPendingApprove: vi.fn(),
        permissions: {
            setMode: vi.fn(),
            mode: 'default',
        },
        skillRegistry: {
            scanGlobal: vi.fn().mockResolvedValue(undefined),
            scanProject: vi.fn().mockResolvedValue(undefined),
            getForSession: vi.fn().mockReturnValue([]),
            search: vi.fn().mockReturnValue([]),
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
    });

    describe('handleCommand', () => {
        it('/sessions calls bridge.listAllSessions and formats result', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.listAllSessions).mockResolvedValueOnce([
                { id: 'sess-1', active: true, activeAt: 1000, metadata: null },
                { id: 'sess-2', active: true, activeAt: 2000, metadata: null },
            ] as any);
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-2' });

            const interaction = mockInteraction('sessions');
            await handleCommand(interaction as any, bridge);

            expect(interaction.deferReply).toHaveBeenCalled();
            expect(bridge.listAllSessions).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('sess-1'),
                    components: expect.any(Array),
                }),
            );
        });

        it('/sessions marks thread-bound session as current when in a thread', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.listAllSessions).mockResolvedValueOnce([
                { id: 'sess-1', active: true, activeAt: 1000, metadata: null },
                { id: 'sess-2', active: true, activeAt: 2000, metadata: null },
            ] as any);
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            vi.mocked(bridge.getSessionByThread).mockReturnValueOnce('sess-2');

            const interaction = mockInteraction('sessions', {}, 'thread-123');
            await handleCommand(interaction as any, bridge);

            const call = vi.mocked(interaction.editReply).mock.calls[0][0] as { content: string };
            expect(call.content).toContain('sess-2');
            expect(call.content).toMatch(/sess-2.*← current/);
            expect(call.content).not.toMatch(/sess-1.*← current/);
        });

        it('/sessions shows "no sessions found" when empty', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.listAllSessions).mockResolvedValueOnce([]);
            const interaction = mockInteraction('sessions');
            await handleCommand(interaction as any, bridge);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('No sessions found'),
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

        it('/compact in a thread resolves thread session and compacts it', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('compact', {}, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(bridge.setActiveSession).not.toHaveBeenCalled();
            expect(bridge.compactSession).toHaveBeenCalledWith('thread-sess', 'msg-123');
        });

        it('/mode in a thread sets mode without switching active session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('mode', { mode: 'acceptEdits' }, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(bridge.setActiveSession).not.toHaveBeenCalled();
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

    describe('/usage', () => {
        it('includes /usage command definition', () => {
            expect(commandDefinitions.find((c: { name: string }) => c.name === 'usage')).toBeDefined();
        });

        it('queries session usage when in a thread', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess-123');
            vi.mocked(queryUsage).mockResolvedValueOnce({
                usage: [{
                    timestamp: 1709712345,
                    tokens: { total: 5000, input: 2000, output: 3000, cache_creation: 0, cache_read: 0 },
                    cost: { total: 0.08, input: 0.03, output: 0.05 },
                    reportCount: 2,
                }],
                groupBy: 'day',
                totalReports: 2,
            });

            const interaction = mockInteraction('usage', {}, 'thread-1');
            await handleCommand(interaction as any, bridge);

            expect(queryUsage).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ sessionId: 'thread-sess-123' }),
            );
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('5,000'),
            );
        });

        it('queries today usage in main channel with no period', async () => {
            const bridge = makeMockBridge();
            vi.mocked(queryUsage).mockResolvedValueOnce({
                usage: [],
                groupBy: 'hour',
                totalReports: 0,
            });

            const interaction = mockInteraction('usage');
            await handleCommand(interaction as any, bridge);

            expect(queryUsage).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ groupBy: 'hour' }),
            );
        });

        it('queries 7d usage when period specified', async () => {
            const bridge = makeMockBridge();
            vi.mocked(queryUsage).mockResolvedValueOnce({
                usage: [],
                groupBy: 'day',
                totalReports: 0,
            });

            const interaction = mockInteraction('usage', { period: '7d' });
            await handleCommand(interaction as any, bridge);

            expect(queryUsage).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ groupBy: 'day' }),
            );
        });

        it('shows error on API failure', async () => {
            const bridge = makeMockBridge();
            vi.mocked(queryUsage).mockRejectedValueOnce(new Error('Usage query failed (500)'));

            const interaction = mockInteraction('usage');
            await handleCommand(interaction as any, bridge);

            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.stringContaining('Failed'),
            );
        });

        it('queries all-account when period specified even in thread', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess-123');
            vi.mocked(queryUsage).mockResolvedValueOnce({
                usage: [],
                groupBy: 'day',
                totalReports: 0,
            });

            const interaction = mockInteraction('usage', { period: '7d' }, 'thread-1');
            await handleCommand(interaction as any, bridge);

            expect(queryUsage).toHaveBeenCalledWith(
                expect.anything(),
                expect.not.objectContaining({ sessionId: expect.anything() }),
            );
        });
    });

    describe('/skills', () => {
        it('includes skills command in definitions', () => {
            const skillsCmd = commandDefinitions.find((c: { name: string }) => c.name === 'skills');
            expect(skillsCmd).toBeDefined();
        });

        it('lists all skills when no args', async () => {
            const interaction = mockInteraction('skills');
            const bridge = makeMockBridge();
            vi.mocked(bridge.skillRegistry.getForSession as ReturnType<typeof vi.fn>).mockReturnValue([
                { name: 'commit', description: 'Create commit', type: 'command', source: 'personal' },
                { name: 'tdd', description: 'Test driven', type: 'skill', source: 'plugin', pluginName: 'ecc' },
            ]);
            await handleCommand(interaction as any, bridge);
            expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('commit'));
        });

        it('reloads registry when name is reload', async () => {
            const interaction = mockInteraction('skills', { name: 'reload' });
            const bridge = makeMockBridge();
            vi.mocked(bridge.skillRegistry.getForSession as ReturnType<typeof vi.fn>).mockReturnValue([
                { name: 'a', description: 'b', type: 'skill', source: 'personal' },
            ]);
            await handleCommand(interaction as any, bridge);
            expect(bridge.skillRegistry.scanGlobal).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Reloaded'));
        });

        it('sends skill invocation to session', async () => {
            const interaction = mockInteraction('skills', { name: 'commit', args: '-m fix' });
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            await handleCommand(interaction as any, bridge);
            expect(bridge.sendMessage).toHaveBeenCalledWith('/commit -m fix', 'sess-1');
        });

        it('sends skill without args', async () => {
            const interaction = mockInteraction('skills', { name: 'tdd' });
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            await handleCommand(interaction as any, bridge);
            expect(bridge.sendMessage).toHaveBeenCalledWith('/tdd', 'sess-1');
        });

        it('returns error when no active session', async () => {
            const interaction = mockInteraction('skills', { name: 'commit' });
            const bridge = makeMockBridge();
            await handleCommand(interaction as any, bridge);
            expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('No active session'));
        });
    });

    describe('/update', () => {
        it('includes /update command definition', () => {
            expect(commandDefinitions.find((c: { name: string }) => c.name === 'update')).toBeDefined();
        });

        it('/update checks for updates and reports result', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('update');
            await handleCommand(interaction as any, bridge);
            expect(interaction.deferReply).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalled();
        });
    });

    describe('/sessions host grouping', () => {
        it('groups sessions by host and shows bot version', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.listAllSessions).mockResolvedValueOnce([
                { id: 'sess-1', active: true, activeAt: 1000, metadata: { path: '/a/proj1', machineId: 'm1', host: 'macbook' } },
                { id: 'sess-2', active: true, activeAt: 2000, metadata: { path: '/a/proj2', machineId: 'm1', host: 'macbook' } },
                { id: 'sess-3', active: true, activeAt: 3000, metadata: { path: '/b/proj3', machineId: 'm2', host: 'server-1' } },
            ] as any);
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-2' });

            const interaction = mockInteraction('sessions');
            await handleCommand(interaction as any, bridge);

            const call = vi.mocked(interaction.editReply).mock.calls[0][0] as { content: string };
            expect(call.content).toContain('macbook');
            expect(call.content).toContain('server-1');
            expect(call.content).toMatch(/Bot v\d+\.\d+\.\d+/);
        });

        it('shows directory name from metadata path', async () => {
            const bridge = makeMockBridge();
            vi.mocked(bridge.listAllSessions).mockResolvedValueOnce([
                { id: 'sess-1', active: true, activeAt: 1000, metadata: { path: '/Users/user/my-project', host: 'macbook' } },
            ] as any);
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });

            const interaction = mockInteraction('sessions');
            await handleCommand(interaction as any, bridge);

            const call = vi.mocked(interaction.editReply).mock.calls[0][0] as { content: string };
            expect(call.content).toContain('my-project');
        });
    });

    describe('/approve', () => {
        it('includes /approve command definition', () => {
            expect(commandDefinitions.find((c: { name: string }) => c.name === 'approve')).toBeDefined();
        });

        it('sets pendingApprove with correct channelId and 60s timeout', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('approve', {}, 'ch-approve');
            await handleCommand(interaction as any, bridge);

            expect(bridge.setPendingApprove).toHaveBeenCalledWith('ch-approve', 60_000);
            expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('QR code screenshot'));
        });

        it('rejects when already waiting for QR', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'pendingApprove', {
                value: { channelId: 'ch-1', timestamp: Date.now(), timer: setTimeout(() => {}, 0) },
            });
            const interaction = mockInteraction('approve');
            await handleCommand(interaction as any, bridge);

            expect(bridge.setPendingApprove).not.toHaveBeenCalled();
            expect(interaction.reply).toHaveBeenCalledWith(
                expect.objectContaining({ content: expect.stringContaining('Already waiting'), ephemeral: true }),
            );
        });
    });

    describe('/loop', () => {
        it('includes /loop command definition', () => {
            expect(commandDefinitions.find((c: { name: string }) => c.name === 'loop')).toBeDefined();
        });

        it('sends /loop with args to session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            const interaction = mockInteraction('loop', { args: '5m /compact' });
            await handleCommand(interaction as any, bridge);
            expect(bridge.sendMessage).toHaveBeenCalledWith('/loop 5m /compact', 'sess-1');
            expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('/loop 5m /compact'));
        });

        it('resolves session from thread context', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'active-sess', writable: true });
            vi.mocked(bridge.getSessionByThread).mockReturnValue('thread-sess');
            const interaction = mockInteraction('loop', { args: '10m check status' }, 'thread-1');
            await handleCommand(interaction as any, bridge);
            expect(bridge.sendMessage).toHaveBeenCalledWith('/loop 10m check status', 'thread-sess');
        });

        it('shows error when no active session', async () => {
            const bridge = makeMockBridge();
            const interaction = mockInteraction('loop', { args: '5m /compact' });
            await handleCommand(interaction as any, bridge);
            expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('No active session'));
        });

        it('shows usage help when no args provided', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            const interaction = mockInteraction('loop');
            await handleCommand(interaction as any, bridge);
            expect(interaction.reply).toHaveBeenCalledWith(
                expect.objectContaining({ content: expect.stringContaining('/loop'), ephemeral: true }),
            );
            expect(bridge.sendMessage).not.toHaveBeenCalled();
        });

        it('forwards /loop list to session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            const interaction = mockInteraction('loop', { args: 'list' });
            await handleCommand(interaction as any, bridge);
            expect(bridge.sendMessage).toHaveBeenCalledWith('/loop list', 'sess-1');
        });

        it('forwards /loop delete <id> to session', async () => {
            const bridge = makeMockBridge();
            Object.defineProperty(bridge, 'activeSession', { value: 'sess-1' });
            const interaction = mockInteraction('loop', { args: 'delete abc123' });
            await handleCommand(interaction as any, bridge);
            expect(bridge.sendMessage).toHaveBeenCalledWith('/loop delete abc123', 'sess-1');
        });
    });

    describe('handleLoopAutocomplete', () => {
        function mockAutocomplete(focused: string) {
            return {
                commandName: 'loop',
                options: { getFocused: vi.fn().mockReturnValue(focused) },
                respond: vi.fn().mockResolvedValue(undefined),
            };
        }

        it('suggests subcommands and intervals when empty input', async () => {
            const interaction = mockAutocomplete('');
            await handleLoopAutocomplete(interaction as any);
            const choices = interaction.respond.mock.calls[0][0];
            expect(choices).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ value: 'list' }),
                    expect.objectContaining({ value: 'delete ' }),
                ]),
            );
        });

        it('filters suggestions by input', async () => {
            const interaction = mockAutocomplete('lis');
            await handleLoopAutocomplete(interaction as any);
            const choices = interaction.respond.mock.calls[0][0];
            expect(choices).toEqual(
                expect.arrayContaining([expect.objectContaining({ value: 'list' })]),
            );
            expect(choices).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ value: 'delete ' })]),
            );
        });

        it('suggests intervals when input starts with a digit', async () => {
            const interaction = mockAutocomplete('5');
            await handleLoopAutocomplete(interaction as any);
            const choices = interaction.respond.mock.calls[0][0];
            expect(choices.some((c: { value: string }) => c.value.startsWith('5m'))).toBe(true);
        });
    });

    describe('handleSkillsAutocomplete', () => {
        function mockAutocomplete(focused: string) {
            return {
                commandName: 'skills',
                options: { getFocused: vi.fn().mockReturnValue(focused) },
                respond: vi.fn().mockResolvedValue(undefined),
            };
        }

        it('returns matching skills from registry', async () => {
            const registry = {
                search: vi.fn().mockReturnValue([
                    { name: 'commit', description: 'Create commit', type: 'command', source: 'personal' },
                ]),
            };
            const interaction = mockAutocomplete('comm');
            await handleSkillsAutocomplete(interaction as any, registry as any, '/projects/app');
            expect(registry.search).toHaveBeenCalledWith('comm', '/projects/app');
            expect(interaction.respond).toHaveBeenCalledWith(
                expect.arrayContaining([expect.objectContaining({ value: 'commit' })]),
            );
        });

        it('includes reload option when query matches', async () => {
            const registry = { search: vi.fn().mockReturnValue([]) };
            const interaction = mockAutocomplete('rel');
            await handleSkillsAutocomplete(interaction as any, registry as any);
            expect(interaction.respond).toHaveBeenCalledWith(
                expect.arrayContaining([expect.objectContaining({ value: 'reload' })]),
            );
        });

        it('truncates display name to 100 chars', async () => {
            const registry = {
                search: vi.fn().mockReturnValue([
                    { name: 'test', description: 'A'.repeat(200), type: 'skill', source: 'personal' },
                ]),
            };
            const interaction = mockAutocomplete('test');
            await handleSkillsAutocomplete(interaction as any, registry as any);
            const call = interaction.respond.mock.calls[0][0];
            // First is reload, second is the actual skill
            const skillChoice = call.find((c: { value: string }) => c.value === 'test');
            expect(skillChoice.name.length).toBeLessThanOrEqual(100);
        });
    });
});
