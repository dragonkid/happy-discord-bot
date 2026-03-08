import type { ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction } from 'discord.js';
import { parseAskButtonId, parseSessionButtonId, buildAskButtons, buildRejectPlanModal } from './buttons.js';
import type { AskButtonAction, ParsedSessionButtonId, ParsedExitPlanButtonId, ParsedDeleteButtonId } from './buttons.js';
import type { AskUserQuestionInput } from '../happy/types.js';
import type { Bridge } from '../bridge.js';
import type { StateTracker } from '../happy/state-tracker.js';
import { extractDirectories } from '../happy/session-metadata.js';

export async function handleAskButton(
    interaction: ButtonInteraction,
    askParsed: AskButtonAction,
    bridge: Bridge,
    stateTracker: StateTracker,
): Promise<void> {
    if (askParsed.sessionId !== bridge.activeSession) {
        await interaction.editReply({
            content: `⏰ (Session no longer active) ${interaction.message.content}`,
            components: [],
        });
        return;
    }

    const pending = stateTracker.getPendingRequests(askParsed.sessionId);
    const request = pending.find((r) => r.id === askParsed.requestId);
    if (!request) {
        await interaction.editReply({
            content: `⏰ (Request expired) ${interaction.message.content}`,
            components: [],
        });
        return;
    }
    const input = request.arguments as AskUserQuestionInput;

    if (askParsed.type === 'select') {
        const question = input?.questions?.[0];
        const option = question?.options[askParsed.optionIndex];
        const header = question?.header ?? 'Answer';
        const label = option?.label ?? `Option ${askParsed.optionIndex}`;

        const answers: Record<string, string> = { [header]: label };
        await bridge.handleAskUserAnswer(askParsed.sessionId, askParsed.requestId, answers);

        await interaction.editReply({
            content: `✔️ (Selected: ${label}) ${interaction.message.content}`,
            components: [],
        });
    } else if (askParsed.type === 'toggle') {
        const key = `${askParsed.sessionId}:${askParsed.requestId}:${askParsed.questionIndex}`;
        const selected = bridge.toggleMultiSelect(key, askParsed.optionIndex);
        const question = input?.questions?.[askParsed.questionIndex];

        if (question) {
            const rows = buildAskButtons(
                askParsed.sessionId,
                askParsed.requestId,
                question.options,
                true,
                askParsed.questionIndex,
                selected,
            );
            await interaction.editReply({ components: rows });
        }
    } else if (askParsed.type === 'submit') {
        const questions = input?.questions ?? [];
        const answers: Record<string, string> = {};

        for (let qi = 0; qi < questions.length; qi++) {
            const q = questions[qi];
            const key = `${askParsed.sessionId}:${askParsed.requestId}:${qi}`;
            const selected = bridge.getMultiSelectState(key);
            if (selected.size > 0) {
                const labels = Array.from(selected)
                    .map((i) => q.options[i]?.label)
                    .filter(Boolean)
                    .join(', ');
                answers[q.header] = labels;
            }
            bridge.clearMultiSelectState(key);
        }

        if (Object.keys(answers).length === 0) {
            await interaction.editReply({
                content: `⚠️ (No options selected) ${interaction.message.content}`,
            });
            return;
        }

        await bridge.handleAskUserAnswer(askParsed.sessionId, askParsed.requestId, answers);

        const displayText = Object.entries(answers).map(([h, l]) => `${h}: ${l}`).join(', ');
        await interaction.editReply({
            content: `✔️ (Selected: ${displayText}) ${interaction.message.content}`,
            components: [],
        });
    }
}

export async function handleSessionButton(
    interaction: ButtonInteraction,
    sessParsed: ParsedSessionButtonId,
    bridge: Bridge,
): Promise<void> {
    bridge.setActiveSession(sessParsed.sessionId);
    await interaction.editReply({
        content: `Switched to \`${sessParsed.sessionId.slice(0, 8)}\``,
        components: [],
    });
}

export async function handleExitPlanButton(
    interaction: ButtonInteraction,
    parsed: ParsedExitPlanButtonId,
    bridge: Bridge,
    stateTracker: StateTracker,
): Promise<void> {
    if (parsed.sessionId !== bridge.activeSession) {
        await interaction.editReply({
            content: `⏰ (Session no longer active) ${interaction.message.content}`,
            components: [],
        });
        return;
    }

    const pending = stateTracker.getPendingRequests(parsed.sessionId);
    const request = pending.find((r) => r.id === parsed.requestId);
    if (!request) {
        await interaction.editReply({
            content: `⏰ (Request expired) ${interaction.message.content}`,
            components: [],
        });
        return;
    }

    switch (parsed.action) {
        case 'approve':
            await bridge.approvePermission(parsed.sessionId, parsed.requestId);
            await interaction.editReply({
                content: `✅ (Approved) ${interaction.message.content}`,
                components: [],
            });
            break;

        case 'approve-edits':
            await bridge.approvePermission(parsed.sessionId, parsed.requestId, 'acceptEdits');
            bridge.permissions.applyApproval([], 'acceptEdits');
            await interaction.editReply({
                content: `✅ (Approved - accept all edits) ${interaction.message.content}`,
                components: [],
            });
            break;

        case 'reject': {
            const modal = buildRejectPlanModal(parsed.sessionId, parsed.requestId);
            await interaction.showModal(modal);
            break;
        }
    }
}

export { parseAskButtonId, parseSessionButtonId };

export async function handleNewSessionSelect(
    interaction: StringSelectMenuInteraction,
    bridge: Bridge,
): Promise<void> {
    const index = Number(interaction.values[0]);

    // Re-fetch directories to resolve the index
    const allSessions = await bridge.listAllSessions();
    const directories = extractDirectories(allSessions);
    const selection = directories[index];

    if (!selection) {
        await interaction.editReply({ content: 'Invalid selection.', components: [] });
        return;
    }

    try {
        const sessionId = await bridge.createNewSession(selection.machineId, selection.path);
        await interaction.editReply({
            content: `Session created in \`${selection.path}\` (\`${sessionId.slice(0, 8)}\`)`,
            components: [],
        });
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply({
            content: `Failed to create session: ${detail}`,
            components: [],
        });
    }
}

function expandHome(p: string): string {
    if (p === '~') return process.env.HOME ?? p;
    if (p.startsWith('~/')) return (process.env.HOME ?? '') + p.slice(1);
    return p;
}

export async function handleNewSessionModal(
    interaction: ModalSubmitInteraction,
    machineId: string,
    bridge: Bridge,
): Promise<void> {
    const directory = expandHome(interaction.fields.getTextInputValue('directory').trim());
    if (!directory) {
        await interaction.editReply({
            content: 'Please provide a directory path.',
            components: [],
        });
        return;
    }

    try {
        const sessionId = await bridge.createNewSession(machineId, directory);
        await interaction.editReply({
            content: `Session created in \`${directory}\` (\`${sessionId.slice(0, 8)}\`)`,
            components: [],
        });
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply({
            content: `Failed to create session: ${detail}`,
            components: [],
        });
    }
}

export async function handleDeleteButton(
    interaction: ButtonInteraction,
    parsed: ParsedDeleteButtonId,
    bridge: Bridge,
): Promise<void> {
    if (parsed.action === 'cancel') {
        await interaction.editReply({
            content: `🚫 (Cancelled) ${interaction.message.content}`,
            components: [],
        });
        return;
    }

    try {
        const deletedId = await bridge.deleteSession(parsed.sessionId);
        await interaction.editReply({
            content: `Session \`${deletedId.slice(0, 8)}\` deleted.`,
            components: [],
        }).catch(() => {});

        // Fallback: if deleteSession didn't find the thread via session ID prefix,
        // delete the thread directly when the button was clicked inside one.
        if (interaction.channel?.isThread()) {
            await interaction.channel.delete().catch(() => {});
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply({
            content: `Failed to delete: ${detail}`,
            components: [],
        });
    }
}
