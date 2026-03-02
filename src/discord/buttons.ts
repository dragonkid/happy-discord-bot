import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { EDIT_TOOLS } from '../happy/types.js';
import type { AskUserQuestionOption } from '../happy/types.js';
import type { DecryptedSession } from '../vendor/api.js';

export const BUTTON_PREFIX = 'perm:';

export type PermissionAction = 'yes' | 'allow-edits' | 'for-tool' | 'no';

export interface ParsedButtonId {
    sessionId: string;
    requestId: string;
    action: PermissionAction;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set<string>(['yes', 'allow-edits', 'for-tool', 'no']);

function buttonId(sessionId: string, requestId: string, action: PermissionAction): string {
    return `${BUTTON_PREFIX}${sessionId}:${requestId}:${action}`;
}

export function buildPermissionButtons(
    sessionId: string,
    requestId: string,
    toolName: string,
    _toolInput: unknown,
): ActionRowBuilder<ButtonBuilder>[] {
    const yes = new ButtonBuilder()
        .setCustomId(buttonId(sessionId, requestId, 'yes'))
        .setLabel('Yes')
        .setStyle(ButtonStyle.Success);

    const no = new ButtonBuilder()
        .setCustomId(buttonId(sessionId, requestId, 'no'))
        .setLabel('No')
        .setStyle(ButtonStyle.Danger);

    const isEditTool = EDIT_TOOLS.has(toolName);

    const middle = isEditTool
        ? new ButtonBuilder()
              .setCustomId(buttonId(sessionId, requestId, 'allow-edits'))
              .setLabel('Allow All Edits')
              .setStyle(ButtonStyle.Primary)
        : new ButtonBuilder()
              .setCustomId(buttonId(sessionId, requestId, 'for-tool'))
              .setLabel('For This Tool')
              .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(yes, middle, no);
    return [row];
}

export function parseButtonId(customId: string): ParsedButtonId | null {
    if (!customId.startsWith(BUTTON_PREFIX)) return null;

    const rest = customId.slice(BUTTON_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 3) return null;

    const [sessionId, requestId, action] = parts;
    if (!VALID_ACTIONS.has(action)) return null;

    return { sessionId, requestId, action: action as PermissionAction };
}

// --- AskUserQuestion buttons ---

const ASK_SELECT_PREFIX = 'ask:';
const ASK_TOGGLE_PREFIX = 'askt:';
const ASK_SUBMIT_PREFIX = 'asks:';
const SESSION_PREFIX = 'sess:';
const MAX_BUTTONS_PER_ROW = 5;

export type AskButtonAction =
    | { type: 'select'; sessionId: string; requestId: string; optionIndex: number }
    | { type: 'toggle'; sessionId: string; requestId: string; questionIndex: number; optionIndex: number }
    | { type: 'submit'; sessionId: string; requestId: string };

export interface ParsedSessionButtonId {
    sessionId: string;
}

function distributeIntoRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
        const chunk = buttons.slice(i, i + MAX_BUTTONS_PER_ROW);
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...chunk));
    }
    return rows;
}

export function buildAskButtons(
    sessionId: string,
    requestId: string,
    options: readonly AskUserQuestionOption[],
    multiSelect: boolean,
    questionIndex: number,
    selectedIndices: ReadonlySet<number> = new Set(),
): ActionRowBuilder<ButtonBuilder>[] {
    if (!multiSelect) {
        const buttons = options.map((opt, i) =>
            new ButtonBuilder()
                .setCustomId(`${ASK_SELECT_PREFIX}${sessionId}:${requestId}:${i}`)
                .setLabel(opt.label)
                .setStyle(ButtonStyle.Primary),
        );
        return distributeIntoRows(buttons);
    }

    // Multi-select: toggle buttons + submit
    const toggles = options.map((opt, i) =>
        new ButtonBuilder()
            .setCustomId(`${ASK_TOGGLE_PREFIX}${sessionId}:${requestId}:${questionIndex}:${i}`)
            .setLabel(opt.label)
            .setStyle(selectedIndices.has(i) ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    const submit = new ButtonBuilder()
        .setCustomId(`${ASK_SUBMIT_PREFIX}${sessionId}:${requestId}`)
        .setLabel('Submit')
        .setStyle(ButtonStyle.Success);

    return distributeIntoRows([...toggles, submit]);
}

export function parseAskButtonId(customId: string): AskButtonAction | null {
    if (customId.startsWith(ASK_SELECT_PREFIX)) {
        const rest = customId.slice(ASK_SELECT_PREFIX.length);
        const parts = rest.split(':');
        if (parts.length !== 3) return null;
        const [sessionId, requestId, indexStr] = parts;
        const optionIndex = Number(indexStr);
        if (Number.isNaN(optionIndex)) return null;
        return { type: 'select', sessionId, requestId, optionIndex };
    }

    if (customId.startsWith(ASK_TOGGLE_PREFIX)) {
        const rest = customId.slice(ASK_TOGGLE_PREFIX.length);
        const parts = rest.split(':');
        if (parts.length !== 4) return null;
        const [sessionId, requestId, qIdxStr, oIdxStr] = parts;
        const questionIndex = Number(qIdxStr);
        const optionIndex = Number(oIdxStr);
        if (Number.isNaN(questionIndex) || Number.isNaN(optionIndex)) return null;
        return { type: 'toggle', sessionId, requestId, questionIndex, optionIndex };
    }

    if (customId.startsWith(ASK_SUBMIT_PREFIX)) {
        const rest = customId.slice(ASK_SUBMIT_PREFIX.length);
        const parts = rest.split(':');
        if (parts.length !== 2) return null;
        const [sessionId, requestId] = parts;
        return { type: 'submit', sessionId, requestId };
    }

    return null;
}

// --- Session buttons ---

function formatSessionLabel(session: Pick<DecryptedSession, 'id' | 'activeAt'>, isCurrent: boolean): string {
    const shortId = session.id.slice(0, 8);
    const ago = formatTimeAgo(session.activeAt);
    return isCurrent ? `${shortId} \u2713` : `${shortId} (${ago})`;
}

function formatTimeAgo(timestamp: number): string {
    const diffMs = Date.now() - timestamp;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

export function buildSessionButtons(
    sessions: readonly Pick<DecryptedSession, 'id' | 'activeAt'>[],
    currentSessionId: string | null,
): ActionRowBuilder<ButtonBuilder>[] {
    const buttons = sessions.map(session => {
        const isCurrent = session.id === currentSessionId;
        const btn = new ButtonBuilder()
            .setCustomId(`${SESSION_PREFIX}${session.id}`)
            .setLabel(formatSessionLabel(session, isCurrent))
            .setStyle(isCurrent ? ButtonStyle.Secondary : ButtonStyle.Primary);
        if (isCurrent) btn.setDisabled(true);
        return btn;
    });
    return distributeIntoRows(buttons);
}

export function parseSessionButtonId(customId: string): ParsedSessionButtonId | null {
    if (!customId.startsWith(SESSION_PREFIX)) return null;
    const sessionId = customId.slice(SESSION_PREFIX.length);
    if (!sessionId) return null;
    return { sessionId };
}
