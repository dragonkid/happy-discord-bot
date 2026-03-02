const DISCORD_MAX = 2000;

/** Split text into chunks that fit within Discord's message limit. */
export function chunkMessage(text: string, limit = DISCORD_MAX): string[] {
    if (!text) return [];
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }

        // Try to split at last newline within limit
        const slice = remaining.slice(0, limit);
        const newlineIdx = slice.lastIndexOf('\n');

        if (newlineIdx > 0) {
            chunks.push(remaining.slice(0, newlineIdx));
            remaining = remaining.slice(newlineIdx + 1);
        } else {
            // Hard split
            chunks.push(slice);
            remaining = remaining.slice(limit);
        }
    }

    return chunks;
}

/** Wrap text in a fenced code block. */
export function codeBlock(content: string, language = ''): string {
    return `\`\`\`${language}\n${content}\n\`\`\``;
}

/** Wrap text in a diff code block. */
export function diffBlock(content: string): string {
    return codeBlock(content, 'diff');
}

/** Truncate text to a maximum length with ellipsis. */
export function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1) + '…';
}

/** Format a tool permission request for Discord display. */
export function formatPermissionRequest(toolName: string, input: unknown): string {
    const args = (input ?? {}) as Record<string, unknown>;

    switch (toolName) {
        case 'Bash': {
            const command = typeof args.command === 'string' ? args.command : '';
            if (!command) return '**Bash**';
            return `**Bash**\n${codeBlock(truncate(command, 400), 'bash')}`;
        }

        case 'Edit': {
            const filePath = typeof args.file_path === 'string' ? args.file_path : '';
            const header = `**Edit** \`${filePath}\``;
            const oldStr = typeof args.old_string === 'string' ? args.old_string : '';
            const newStr = typeof args.new_string === 'string' ? args.new_string : '';

            if (!oldStr && !newStr) return header;

            const diff = `- ${truncate(oldStr, 150)}\n+ ${truncate(newStr, 150)}`;
            return `${header}\n${diffBlock(diff)}`;
        }

        case 'Write': {
            const filePath = typeof args.file_path === 'string' ? args.file_path : '';
            return `**Write** \`${filePath}\``;
        }

        default: {
            const header = `**${toolName}**`;
            const jsonStr = JSON.stringify(args);

            if (!jsonStr || jsonStr === '{}') return header;

            return `${header}\n${codeBlock(truncate(jsonStr, 200))}`;
        }
    }
}
