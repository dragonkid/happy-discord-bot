import type { ButtonInteraction } from 'discord.js';
import { parseAskButtonId, parseSessionButtonId, buildAskButtons } from './buttons.js';
import type { AskButtonAction, ParsedSessionButtonId } from './buttons.js';
import type { AskUserQuestionInput } from '../happy/types.js';
import type { Bridge } from '../bridge.js';
import type { StateTracker } from '../happy/state-tracker.js';

export async function handleAskButton(
    interaction: ButtonInteraction,
    askParsed: AskButtonAction,
    bridge: Bridge,
    stateTracker: StateTracker,
): Promise<void> {
    if (askParsed.sessionId !== bridge.activeSession) {
        await interaction.editReply({
            content: `${interaction.message.content}\n\n*Session no longer active*`,
            components: [],
        });
        return;
    }

    const pending = stateTracker.getPendingRequests(askParsed.sessionId);
    const request = pending.find((r) => r.id === askParsed.requestId);
    if (!request) {
        await interaction.editReply({
            content: `${interaction.message.content}\n\n*Request expired*`,
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
        const answerText = `${header}: ${label}`;

        await bridge.handleAskUserAnswer(askParsed.sessionId, askParsed.requestId, answerText);

        await interaction.editReply({
            content: `${interaction.message.content}\n\n*Selected: ${label}*`,
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
        const responseLines: string[] = [];

        for (let qi = 0; qi < questions.length; qi++) {
            const q = questions[qi];
            const key = `${askParsed.sessionId}:${askParsed.requestId}:${qi}`;
            const selected = bridge.getMultiSelectState(key);
            if (selected.size > 0) {
                const labels = Array.from(selected)
                    .map((i) => q.options[i]?.label)
                    .filter(Boolean)
                    .join(', ');
                responseLines.push(`${q.header}: ${labels}`);
            }
            bridge.clearMultiSelectState(key);
        }

        if (responseLines.length === 0) {
            await interaction.editReply({
                content: `${interaction.message.content}\n\n*No options selected — please select at least one.*`,
            });
            return;
        }

        const answerText = responseLines.join('\n');
        await bridge.handleAskUserAnswer(askParsed.sessionId, askParsed.requestId, answerText);

        await interaction.editReply({
            content: `${interaction.message.content}\n\n*Selected: ${answerText}*`,
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

export { parseAskButtonId, parseSessionButtonId };
