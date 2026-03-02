import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { EDIT_TOOLS } from '../happy/types.js';

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
