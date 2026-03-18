import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleExitPlanButton, handleNewSessionSelect, handleNewSessionModal, handleDeleteButton, handleYoloToggle } from '../interactions.js';
import type { ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction } from 'discord.js';
import type { Bridge } from '../../bridge.js';
import type { StateTracker } from '../../happy/state-tracker.js';
import type { ParsedExitPlanButtonId, ParsedDeleteButtonId } from '../buttons.js';

function makeMockInteraction(overrides: Partial<ButtonInteraction> = {}): ButtonInteraction {
    return {
        message: { content: '**Plan Proposal**' },
        editReply: vi.fn().mockResolvedValue({}),
        showModal: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as ButtonInteraction;
}

function makeMockBridge(activeSession: string | null = 'sess-1'): Bridge {
    return {
        activeSession,
        isSessionAvailable: vi.fn().mockReturnValue(true),
        approvePermission: vi.fn().mockResolvedValue(undefined),
        denyPermission: vi.fn().mockResolvedValue(undefined),
        permissions: {
            applyApproval: vi.fn(),
        },
    } as unknown as Bridge;
}

function makeMockStateTracker(pendingRequests: Array<{ id: string; tool: string; arguments: unknown; createdAt: number }> = []): StateTracker {
    return {
        getPendingRequests: vi.fn().mockReturnValue(pendingRequests),
    } as unknown as StateTracker;
}

describe('handleExitPlanButton', () => {
    let interaction: ButtonInteraction;
    let bridge: Bridge;
    let stateTracker: StateTracker;

    const planRequest = {
        id: 'req-plan',
        tool: 'ExitPlanMode',
        arguments: { plan: 'Step 1: Do thing' },
        createdAt: 1000,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        interaction = makeMockInteraction();
        bridge = makeMockBridge('sess-1');
        stateTracker = makeMockStateTracker([planRequest]);
    });

    it('shows session no longer active when session changed', async () => {
        vi.mocked(bridge.isSessionAvailable).mockReturnValue(false);
        const parsed: ParsedExitPlanButtonId = { sessionId: 'sess-1', requestId: 'req-plan', action: 'approve' };

        await handleExitPlanButton(interaction, parsed, bridge, stateTracker);

        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Session no longer active'),
            components: [],
        }));
    });

    it('shows request expired when request not found', async () => {
        stateTracker = makeMockStateTracker([]);
        const parsed: ParsedExitPlanButtonId = { sessionId: 'sess-1', requestId: 'req-gone', action: 'approve' };

        await handleExitPlanButton(interaction, parsed, bridge, stateTracker);

        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Request expired'),
            components: [],
        }));
    });

    it('approves plan with no mode for approve action', async () => {
        const parsed: ParsedExitPlanButtonId = { sessionId: 'sess-1', requestId: 'req-plan', action: 'approve' };

        await handleExitPlanButton(interaction, parsed, bridge, stateTracker);

        expect(bridge.approvePermission).toHaveBeenCalledWith('sess-1', 'req-plan');
        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('✅ (Approved)'),
            components: [],
        }));
    });

    it('approves plan with acceptEdits mode and updates cache', async () => {
        const parsed: ParsedExitPlanButtonId = { sessionId: 'sess-1', requestId: 'req-plan', action: 'approve-edits' };

        await handleExitPlanButton(interaction, parsed, bridge, stateTracker);

        expect(bridge.approvePermission).toHaveBeenCalledWith('sess-1', 'req-plan', 'acceptEdits');
        expect(bridge.permissions.applyApproval).toHaveBeenCalledWith([], 'acceptEdits');
        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('✅ (Approved - accept all edits)'),
            components: [],
        }));
    });

    it('shows modal for reject action', async () => {
        const parsed: ParsedExitPlanButtonId = { sessionId: 'sess-1', requestId: 'req-plan', action: 'reject' };

        await handleExitPlanButton(interaction, parsed, bridge, stateTracker);

        expect(interaction.showModal).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    custom_id: 'plan-modal:sess-1:req-plan',
                    title: 'Reject Plan',
                }),
            }),
        );
        expect(bridge.denyPermission).not.toHaveBeenCalled();
    });
});

function makeMockSelectInteraction(value: string): StringSelectMenuInteraction {
    return {
        values: [value],
        message: { content: 'Select a directory for the new session:' },
        editReply: vi.fn().mockResolvedValue({}),
    } as unknown as StringSelectMenuInteraction;
}

function makeMockModalInteraction(directory: string): ModalSubmitInteraction {
    return {
        message: { content: '' },
        isFromMessage: vi.fn().mockReturnValue(false),
        fields: {
            getTextInputValue: vi.fn().mockReturnValue(directory),
        },
        editReply: vi.fn().mockResolvedValue({}),
    } as unknown as ModalSubmitInteraction;
}

describe('handleNewSessionSelect', () => {
    it('calls bridge.createNewSession with selected directory', async () => {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).listAllSessions = vi.fn().mockResolvedValue([
            {
                id: 'sess-1',
                activeAt: 3000,
                metadata: { path: '/Users/user/project', machineId: 'machine-1', host: 'test' },
            },
        ]);
        (bridge as any).createNewSession = vi.fn().mockResolvedValue('new-sess');
        const interaction = makeMockSelectInteraction('0');

        await handleNewSessionSelect(interaction, bridge);

        expect(bridge.createNewSession).toHaveBeenCalledWith('machine-1', '/Users/user/project', false);
        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringContaining('Session created'),
                components: [],
            }),
        );
    });

    it('shows error when index is invalid', async () => {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).listAllSessions = vi.fn().mockResolvedValue([]);
        const interaction = makeMockSelectInteraction('99');

        await handleNewSessionSelect(interaction, bridge);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: 'Invalid selection.',
                components: [],
            }),
        );
    });

    it('shows error when createNewSession fails', async () => {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).listAllSessions = vi.fn().mockResolvedValue([
            {
                id: 'sess-1',
                activeAt: 3000,
                metadata: { path: '/test', machineId: 'machine-1', host: 'test' },
            },
        ]);
        (bridge as any).createNewSession = vi.fn().mockRejectedValue(new Error('machine offline'));
        const interaction = makeMockSelectInteraction('0');

        await handleNewSessionSelect(interaction, bridge);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringContaining('Failed'),
                components: [],
            }),
        );
    });
});

describe('handleNewSessionModal', () => {
    function mockBridgeForModal(remoteHome = '/Users/remoteuser'): Bridge {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).createNewSession = vi.fn().mockResolvedValue('new-sess');
        (bridge as any).getMachineHomeDir = vi.fn().mockResolvedValue(remoteHome);
        return bridge;
    }

    it('calls bridge.createNewSession with custom directory', async () => {
        const bridge = mockBridgeForModal();
        const interaction = makeMockModalInteraction('/Users/user/custom-dir');

        await handleNewSessionModal(interaction, 'machine-1', bridge);

        expect(bridge.createNewSession).toHaveBeenCalledWith('machine-1', '/Users/user/custom-dir', false);
    });

    it('expands ~ using remote machine homeDir', async () => {
        const bridge = mockBridgeForModal('/Users/dk');
        const interaction = makeMockModalInteraction('~/Coding/happy-discord-bot');

        await handleNewSessionModal(interaction, 'machine-1', bridge);

        expect(bridge.createNewSession).toHaveBeenCalledWith('machine-1', '/Users/dk/Coding/happy-discord-bot', false);
    });

    it('expands bare ~ to remote homeDir', async () => {
        const bridge = mockBridgeForModal('/Users/dk');
        const interaction = makeMockModalInteraction('~');

        await handleNewSessionModal(interaction, 'machine-1', bridge);

        expect(bridge.createNewSession).toHaveBeenCalledWith('machine-1', '/Users/dk', false);
    });

    it('passes ~ through when homeDir unavailable', async () => {
        const bridge = mockBridgeForModal(undefined as unknown as string);
        (bridge as any).getMachineHomeDir = vi.fn().mockResolvedValue(undefined);
        const interaction = makeMockModalInteraction('~/project');

        await handleNewSessionModal(interaction, 'machine-1', bridge);

        expect(bridge.createNewSession).toHaveBeenCalledWith('machine-1', '~/project', false);
    });

    it('shows error for empty directory', async () => {
        const bridge = mockBridgeForModal();
        const interaction = makeMockModalInteraction('   ');

        await handleNewSessionModal(interaction, 'machine-1', bridge);

        expect(interaction.editReply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringContaining('provide a directory'),
            }),
        );
    });
});

describe('handleDeleteButton', () => {
    it('cancels delete and shows cancelled message', async () => {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).deleteSession = vi.fn().mockResolvedValue('sess-1');
        const interaction = makeMockInteraction();
        const parsed: ParsedDeleteButtonId = { sessionId: 'sess-1', action: 'cancel' };

        await handleDeleteButton(interaction, parsed, bridge);

        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Cancelled'),
            components: [],
        }));
        expect(bridge.deleteSession).not.toHaveBeenCalled();
    });

    it('confirms delete and calls bridge.deleteSession', async () => {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).deleteSession = vi.fn().mockResolvedValue('sess-1');
        const interaction = makeMockInteraction();
        const parsed: ParsedDeleteButtonId = { sessionId: 'sess-1', action: 'confirm' };

        await handleDeleteButton(interaction, parsed, bridge);

        expect(bridge.deleteSession).toHaveBeenCalledWith('sess-1');
        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('deleted'),
            components: [],
        }));
    });

    it('shows error when deleteSession fails', async () => {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).deleteSession = vi.fn().mockRejectedValue(new Error('Not found'));
        const interaction = makeMockInteraction();
        const parsed: ParsedDeleteButtonId = { sessionId: 'sess-1', action: 'confirm' };

        await handleDeleteButton(interaction, parsed, bridge);

        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Failed to delete'),
        }));
    });
});

describe('handleYoloToggle', () => {
    it('flips YOLO OFF to ON', async () => {
        const interaction = {
            customId: 'newsess-yolo:off',
            message: {
                components: [{
                    components: [
                        { customId: 'newsess-custom:btn', toJSON: () => ({ type: 2, custom_id: 'newsess-custom:btn', label: 'Custom path...', style: 2 }) },
                        { customId: 'newsess-yolo:off', toJSON: () => ({ type: 2, custom_id: 'newsess-yolo:off', label: 'YOLO: OFF', style: 2 }) },
                    ],
                }],
            },
            update: vi.fn(),
        } as any;
        await handleYoloToggle(interaction);
        expect(interaction.update).toHaveBeenCalled();
        const call = interaction.update.mock.calls[0][0];
        const allBtns = call.components.flatMap((r: any) => r.components ?? []);
        const yoloBtn = allBtns.find((b: any) => b.toJSON().custom_id?.startsWith('newsess-yolo:'));
        expect(yoloBtn).toBeDefined();
        expect(yoloBtn.toJSON().custom_id).toBe('newsess-yolo:on');
        expect(yoloBtn.toJSON().label).toBe('YOLO: ON');
    });

    it('flips YOLO ON to OFF', async () => {
        const interaction = {
            customId: 'newsess-yolo:on',
            message: {
                components: [{
                    components: [
                        { customId: 'newsess-custom:btn', toJSON: () => ({ type: 2, custom_id: 'newsess-custom:btn', label: 'Custom path...', style: 2 }) },
                        { customId: 'newsess-yolo:on', toJSON: () => ({ type: 2, custom_id: 'newsess-yolo:on', label: 'YOLO: ON', style: 4 }) },
                    ],
                }],
            },
            update: vi.fn(),
        } as any;
        await handleYoloToggle(interaction);
        const call = interaction.update.mock.calls[0][0];
        const allBtns = call.components.flatMap((r: any) => r.components ?? []);
        const yoloBtn = allBtns.find((b: any) => b.toJSON().custom_id?.startsWith('newsess-yolo:'));
        expect(yoloBtn.toJSON().custom_id).toBe('newsess-yolo:off');
    });
});

describe('handleNewSessionSelect YOLO passthrough', () => {
    it('passes YOLO ON state to createNewSession', async () => {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).listAllSessions = vi.fn().mockResolvedValue([
            {
                id: 'sess-1',
                activeAt: 3000,
                metadata: { path: '/Users/user/project', machineId: 'machine-1', host: 'test' },
            },
        ]);
        (bridge as any).createNewSession = vi.fn().mockResolvedValue('new-sess');
        const interaction = makeMockSelectInteraction('0');
        interaction.message = {
            ...interaction.message,
            components: [
                { components: [{ customId: 'newsess-sel:dir' }] },
                { components: [{ customId: 'newsess-custom:btn' }, { customId: 'newsess-yolo:on' }] },
            ],
        } as any;

        await handleNewSessionSelect(interaction, bridge);

        expect(bridge.createNewSession).toHaveBeenCalledWith('machine-1', '/Users/user/project', true);
    });

    it('passes YOLO OFF state to createNewSession', async () => {
        const bridge = makeMockBridge('sess-1');
        (bridge as any).listAllSessions = vi.fn().mockResolvedValue([
            {
                id: 'sess-1',
                activeAt: 3000,
                metadata: { path: '/Users/user/project', machineId: 'machine-1', host: 'test' },
            },
        ]);
        (bridge as any).createNewSession = vi.fn().mockResolvedValue('new-sess');
        const interaction = makeMockSelectInteraction('0');
        interaction.message = {
            ...interaction.message,
            components: [
                { components: [{ customId: 'newsess-sel:dir' }] },
                { components: [{ customId: 'newsess-custom:btn' }, { customId: 'newsess-yolo:off' }] },
            ],
        } as any;

        await handleNewSessionSelect(interaction, bridge);

        expect(bridge.createNewSession).toHaveBeenCalledWith('machine-1', '/Users/user/project', false);
    });
});
