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
