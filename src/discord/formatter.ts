import type { AskUserQuestionItem } from '../happy/types.js';
import type { UsageResult } from '../happy/usage.js';

const DISCORD_MAX = 2000;

/** Detect if a chunk has an unclosed code fence. Returns the fence header (e.g. "```diff") or null. */
function findOpenFence(text: string): string | null {
    const fenceRegex = /^(`{3,})(.*)/gm;
    let open: string | null = null;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(text)) !== null) {
        if (open) {
            open = null;
        } else {
            const backticks = match[1];
            const lang = match[2].trim();
            open = lang ? `${backticks}${lang}` : backticks;
        }
    }
    return open;
}

/** Split text into chunks that fit within Discord's message limit, preserving code fences. */
export function chunkMessage(text: string, limit = DISCORD_MAX): string[] {
    if (!text) return [];
    if (text.length <= limit) return [text];

    // Reserve space for fence overhead: closing "\n```" (4) + reopening "```language\n" (up to ~20)
    const FENCE_RESERVE = 24;
    const splitLimit = limit - FENCE_RESERVE;

    // First pass: split by size (with reserve for fence fixup)
    const rawChunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            rawChunks.push(remaining);
            break;
        }

        const slice = remaining.slice(0, splitLimit);
        const newlineIdx = slice.lastIndexOf('\n');

        if (newlineIdx > 0) {
            rawChunks.push(remaining.slice(0, newlineIdx));
            remaining = remaining.slice(newlineIdx + 1);
        } else {
            rawChunks.push(slice);
            remaining = remaining.slice(splitLimit);
        }
    }

    // Second pass: fix unclosed code fences
    const chunks: string[] = [];
    let pendingFence: string | null = null;

    for (const raw of rawChunks) {
        const chunk = pendingFence ? `${pendingFence}\n${raw}` : raw;
        const openFence = findOpenFence(chunk);
        if (openFence) {
            chunks.push(`${chunk}\n\`\`\``);
            pendingFence = openFence;
        } else {
            chunks.push(chunk);
            pendingFence = null;
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

            const diff = `- ${truncate(oldStr, 200)}\n+ ${truncate(newStr, 200)}`;
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

/** Format AskUserQuestion items for Discord display. */
export function formatAskUserQuestion(questions: readonly AskUserQuestionItem[]): string {
    return questions.map((q) => {
        const multiTag = q.multiSelect ? ' *(select multiple)*' : '';
        const header = `**${q.question}**${multiTag}`;
        const options = q.options
            .map((opt, i) => `${i + 1}. **${opt.label}** — ${opt.description}`)
            .join('\n');
        return `${header}\n${options}`;
    }).join('\n\n');
}

const PLAN_INLINE_LIMIT = 1500;

/** Format ExitPlanMode message. Inlines short plans, shows header-only for long ones. */
export function formatExitPlanMode(planText: string): string {
    if (planText && planText.length <= PLAN_INLINE_LIMIT) {
        return `**Plan Proposal**\n${codeBlock(planText, 'md')}`;
    }
    return '**Plan Proposal**\nSee attached plan. Choose how to proceed:';
}

export interface TodoItem {
    id?: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority?: 'high' | 'medium' | 'low';
}

const TODO_STATUS_EMOJI: Record<TodoItem['status'], string> = {
    completed: '✅',
    in_progress: '🔄',
    pending: '⬜',
};

/** Format a TodoWrite tool call for Discord display. */
export function formatTodoWrite(todos: readonly TodoItem[]): string {
    if (todos.length === 0) return '';

    const completed = todos.filter((t) => t.status === 'completed').length;
    const header = `📋 Tasks (${completed}/${todos.length})`;

    const lines = todos.map((todo) => {
        const emoji = TODO_STATUS_EMOJI[todo.status] ?? '⬜';
        const priority = todo.priority ? ` [${todo.priority}]` : '';
        return `${emoji} ${todo.content}${priority}`;
    });

    return `${header}\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

type UsagePeriod = 'session' | 'today' | '7d' | '30d';

const PERIOD_LABELS: Record<UsagePeriod, string> = {
    session: 'Session',
    today: 'Today',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
};

function fmtTokens(n: number): string {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtCost(n: number): string {
    return `$${n.toFixed(2)}`;
}

export function formatUsage(result: UsageResult, period: UsagePeriod, sessionId?: string): string {
    if (result.usage.length === 0) {
        const label = period === 'session' && sessionId
            ? `Session ${sessionId.slice(0, 8)}`
            : PERIOD_LABELS[period];
        return `📊 ${label} — No usage data found.`;
    }

    if (period === 'session') {
        const totals = result.usage.reduce(
            (acc, dp) => ({
                tokens: acc.tokens + dp.tokens.total,
                input: acc.input + dp.tokens.input,
                output: acc.output + dp.tokens.output,
                cacheCreation: acc.cacheCreation + dp.tokens.cache_creation,
                cacheRead: acc.cacheRead + dp.tokens.cache_read,
                cost: acc.cost + dp.cost.total,
                costIn: acc.costIn + dp.cost.input,
                costOut: acc.costOut + dp.cost.output,
            }),
            { tokens: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0, costIn: 0, costOut: 0 },
        );

        const sid = sessionId ? ` ${sessionId.slice(0, 8)}` : '';
        const lines = [
            `📊 Session${sid}`,
            '',
            `Tokens:  ${fmtTokens(totals.tokens)} (${fmtTokens(totals.input)} in / ${fmtTokens(totals.output)} out)`,
            `Cache:   ${fmtTokens(totals.cacheCreation)} created / ${fmtTokens(totals.cacheRead)} read`,
            `Cost:    ${fmtCost(totals.cost)} (${fmtCost(totals.costIn)} in / ${fmtCost(totals.costOut)} out)`,
        ];
        return lines.join('\n');
    }

    const label = PERIOD_LABELS[period];
    const isHourly = result.groupBy === 'hour';

    const timeCol = isHourly ? 'Hour ' : 'Date  ';
    const rows = result.usage.map((dp) => {
        const d = new Date(dp.timestamp * 1000);
        const time = isHourly
            ? `${String(d.getHours()).padStart(2, '0')}:00`
            : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
        return { time, tokens: dp.tokens.total, cost: dp.cost.total };
    });

    const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);

    const tokW = Math.max(6, ...rows.map((r) => fmtTokens(r.tokens).length), fmtTokens(totalTokens).length);
    const costW = Math.max(4, ...rows.map((r) => fmtCost(r.cost).length), fmtCost(totalCost).length);

    const headerLine = `${timeCol}  ${'Tokens'.padStart(tokW)}  ${'Cost'.padStart(costW)}`;
    const dataLines = rows.map((r) =>
        `${r.time.padEnd(timeCol.length)}  ${fmtTokens(r.tokens).padStart(tokW)}  ${fmtCost(r.cost).padStart(costW)}`,
    );
    const separator = '─'.repeat(headerLine.length);
    const totalLine = `${'Total'.padEnd(timeCol.length)}  ${fmtTokens(totalTokens).padStart(tokW)}  ${fmtCost(totalCost).padStart(costW)}`;

    const table = [headerLine, ...dataLines, separator, totalLine].join('\n');

    return `📊 Usage — ${label}\n\n\`\`\`\n${table}\n\`\`\``;
}
