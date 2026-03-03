import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleExitPlanButton } from '../interactions.js';
import type { ButtonInteraction } from 'discord.js';
import type { Bridge } from '../../bridge.js';
import type { StateTracker } from '../../happy/state-tracker.js';
import type { ParsedExitPlanButtonId } from '../buttons.js';

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
        bridge = makeMockBridge('other-sess');
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
            content: expect.stringContaining('*Approved*'),
            components: [],
        }));
    });

    it('approves plan with acceptEdits mode and updates cache', async () => {
        const parsed: ParsedExitPlanButtonId = { sessionId: 'sess-1', requestId: 'req-plan', action: 'approve-edits' };

        await handleExitPlanButton(interaction, parsed, bridge, stateTracker);

        expect(bridge.approvePermission).toHaveBeenCalledWith('sess-1', 'req-plan', 'acceptEdits');
        expect(bridge.permissions.applyApproval).toHaveBeenCalledWith([], 'acceptEdits');
        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Approved (allow all edits)'),
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
