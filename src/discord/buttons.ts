import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { EDIT_TOOLS } from '../happy/types.js';
import type { AskUserQuestionOption } from '../happy/types.js';
import type { DecryptedSession } from '../vendor/api.js';
import type { DirectoryEntry } from '../happy/session-metadata.js';

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
    toolInput: unknown,
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

    let forToolLabel = `For ${toolName}`;
    if (toolName === 'Bash' && toolInput && typeof toolInput === 'object' && 'command' in toolInput) {
        const program = ((toolInput as { command: string }).command).trimStart().split(/\s/)[0];
        if (program) forToolLabel = `For ${program}:*`;
    }

    const middle = isEditTool
        ? new ButtonBuilder()
              .setCustomId(buttonId(sessionId, requestId, 'allow-edits'))
              .setLabel('Allow All Edits')
              .setStyle(ButtonStyle.Primary)
        : new ButtonBuilder()
              .setCustomId(buttonId(sessionId, requestId, 'for-tool'))
              .setLabel(forToolLabel)
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
    const diffMs = Math.max(0, Date.now() - timestamp);
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

// --- ExitPlanMode buttons ---

const PLAN_PREFIX = 'plan:';
export const PLAN_MODAL_PREFIX = 'plan-modal:';

export type ExitPlanAction = 'approve' | 'approve-edits' | 'reject';

export interface ParsedExitPlanButtonId {
    sessionId: string;
    requestId: string;
    action: ExitPlanAction;
}

const VALID_PLAN_ACTIONS: ReadonlySet<string> = new Set(['approve', 'approve-edits', 'reject']);

export function buildExitPlanButtons(
    sessionId: string,
    requestId: string,
): ActionRowBuilder<ButtonBuilder>[] {
    const approve = new ButtonBuilder()
        .setCustomId(`${PLAN_PREFIX}${sessionId}:${requestId}:approve`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success);

    const approveEdits = new ButtonBuilder()
        .setCustomId(`${PLAN_PREFIX}${sessionId}:${requestId}:approve-edits`)
        .setLabel('Approve + Allow Edits')
        .setStyle(ButtonStyle.Primary);

    const reject = new ButtonBuilder()
        .setCustomId(`${PLAN_PREFIX}${sessionId}:${requestId}:reject`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger);

    return [new ActionRowBuilder<ButtonBuilder>().addComponents(approve, approveEdits, reject)];
}

export function parseExitPlanButtonId(customId: string): ParsedExitPlanButtonId | null {
    if (!customId.startsWith(PLAN_PREFIX)) return null;

    const rest = customId.slice(PLAN_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 3) return null;

    const [sessionId, requestId, action] = parts;
    if (!VALID_PLAN_ACTIONS.has(action)) return null;

    return { sessionId, requestId, action: action as ExitPlanAction };
}

export function buildRejectPlanModal(
    sessionId: string,
    requestId: string,
): ModalBuilder {
    const input = new TextInputBuilder()
        .setCustomId('feedback')
        .setLabel('What should Claude change?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder('Describe your modifications (leave empty for generic rejection)');

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);

    return new ModalBuilder()
        .setCustomId(`${PLAN_MODAL_PREFIX}${sessionId}:${requestId}`)
        .setTitle('Reject Plan')
        .addComponents(row);
}

export function parsePlanModalId(customId: string): { sessionId: string; requestId: string } | null {
    if (!customId.startsWith(PLAN_MODAL_PREFIX)) return null;
    const rest = customId.slice(PLAN_MODAL_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 2) return null;
    return { sessionId: parts[0], requestId: parts[1] };
}

// --- New Session menu ---

export const NEW_SESSION_SELECT_PREFIX = 'newsess-sel:';
export const NEW_SESSION_CUSTOM_PREFIX = 'newsess-custom:';
export const NEW_SESSION_MODAL_PREFIX = 'newsess-modal:';

export function buildNewSessionMenu(
    directories: readonly DirectoryEntry[],
    machines: readonly { machineId: string; host: string }[],
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
    const multiMachine = machines.length > 1;

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`${NEW_SESSION_SELECT_PREFIX}dir`)
        .setPlaceholder('Select a directory...')
        .addOptions(
            directories.map((dir, i) => {
                const desc = multiMachine
                    ? `${dir.path} @ ${dir.host}`.slice(0, 100)
                    : dir.path.slice(0, 100);
                return {
                    label: dir.label.slice(0, 100),
                    description: desc,
                    value: String(i),
                };
            }),
        );

    const menuRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    const buttons = multiMachine
        ? machines.map(m =>
            new ButtonBuilder()
                .setCustomId(`${NEW_SESSION_CUSTOM_PREFIX}${m.machineId}`)
                .setLabel(`Custom path @${m.host}...`.slice(0, 80))
                .setStyle(ButtonStyle.Secondary),
        )
        : [
            new ButtonBuilder()
                .setCustomId(`${NEW_SESSION_CUSTOM_PREFIX}btn`)
                .setLabel('Custom path...')
                .setStyle(ButtonStyle.Secondary),
        ];

    const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

    return [menuRow, btnRow];
}

export function buildCustomPathOnly(
    machines: readonly { machineId: string; host: string }[],
): ActionRowBuilder<ButtonBuilder>[] {
    const buttons = machines.length > 1
        ? machines.map(m =>
            new ButtonBuilder()
                .setCustomId(`${NEW_SESSION_CUSTOM_PREFIX}${m.machineId}`)
                .setLabel(`New session @${m.host}...`.slice(0, 80))
                .setStyle(ButtonStyle.Primary),
        )
        : [
            new ButtonBuilder()
                .setCustomId(`${NEW_SESSION_CUSTOM_PREFIX}${machines[0].machineId}`)
                .setLabel('Enter directory path...')
                .setStyle(ButtonStyle.Primary),
        ];

    return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

export function parseNewSessionSelect(customId: string): boolean {
    return customId.startsWith(NEW_SESSION_SELECT_PREFIX);
}

export function parseCustomPathButton(customId: string): boolean {
    return customId.startsWith(NEW_SESSION_CUSTOM_PREFIX);
}

export function buildCustomPathModal(machineId: string): ModalBuilder {
    const input = new TextInputBuilder()
        .setCustomId('directory')
        .setLabel('Directory path')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('/Users/user/my-project');

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);

    return new ModalBuilder()
        .setCustomId(`${NEW_SESSION_MODAL_PREFIX}${machineId}`)
        .setTitle('New Session')
        .addComponents(row);
}

export function parseCustomPathModal(customId: string): { machineId: string } | null {
    if (!customId.startsWith(NEW_SESSION_MODAL_PREFIX)) return null;
    const machineId = customId.slice(NEW_SESSION_MODAL_PREFIX.length);
    if (!machineId) return null;
    return { machineId };
}

// --- Delete confirmation buttons ---

const DELETE_PREFIX = 'delete:';

export type DeleteAction = 'confirm' | 'cancel';

export interface ParsedDeleteButtonId {
    sessionId: string;
    action: DeleteAction;
}

const VALID_DELETE_ACTIONS: ReadonlySet<string> = new Set(['confirm', 'cancel']);

export function buildDeleteConfirmButtons(
    sessionId: string,
): ActionRowBuilder<ButtonBuilder>[] {
    const confirm = new ButtonBuilder()
        .setCustomId(`${DELETE_PREFIX}${sessionId}:confirm`)
        .setLabel('Confirm Delete')
        .setStyle(ButtonStyle.Danger);

    const cancel = new ButtonBuilder()
        .setCustomId(`${DELETE_PREFIX}${sessionId}:cancel`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

    return [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)];
}

export function parseDeleteButtonId(customId: string): ParsedDeleteButtonId | null {
    if (!customId.startsWith(DELETE_PREFIX)) return null;

    const rest = customId.slice(DELETE_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 2) return null;

    const [sessionId, action] = parts;
    if (!VALID_DELETE_ACTIONS.has(action)) return null;

    return { sessionId, action: action as DeleteAction };
}

// --- Cleanup buttons ---

const CLEANUP_PREFIX = 'cleanup:';

export type CleanupAction = 'confirm' | 'cancel';

export interface ParsedCleanupButtonId {
    action: CleanupAction;
}

export function buildCleanupConfirmButtons(): ActionRowBuilder<ButtonBuilder>[] {
    const confirm = new ButtonBuilder()
        .setCustomId(`${CLEANUP_PREFIX}confirm`)
        .setLabel('Confirm Cleanup')
        .setStyle(ButtonStyle.Danger);

    const cancel = new ButtonBuilder()
        .setCustomId(`${CLEANUP_PREFIX}cancel`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

    return [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)];
}

export function parseCleanupButtonId(customId: string): ParsedCleanupButtonId | null {
    if (!customId.startsWith(CLEANUP_PREFIX)) return null;
    const action = customId.slice(CLEANUP_PREFIX.length);
    if (action !== 'confirm' && action !== 'cancel') return null;
    return { action };
}
