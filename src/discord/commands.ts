import {
    SlashCommandBuilder,
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Bridge } from '../bridge.js';
import { buildSessionButtons, buildNewSessionMenu, buildDeleteConfirmButtons, buildCleanupConfirmButtons } from './buttons.js';
import { extractDirectories } from '../happy/session-metadata.js';
import type { PermissionMode } from '../happy/types.js';
import { queryUsage } from '../happy/usage.js';
import { formatUsage } from './formatter.js';
import type { SkillRegistry } from '../happy/skill-registry.js';
import { getVersion } from '../version.js';

// --- Command definitions ---

const sessions = new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('List active Claude Code sessions');

const stop = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Abort the current Claude Code operation');

const compact = new SlashCommandBuilder()
    .setName('compact')
    .setDescription('Compact the current session context');

const mode = new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Set permission approval mode')
    .addStringOption((opt) =>
        opt
            .setName('mode')
            .setDescription('Permission mode')
            .setRequired(true)
            .addChoices(
                { name: 'default', value: 'default' },
                { name: 'accept-edits', value: 'acceptEdits' },
                { name: 'bypass', value: 'bypassPermissions' },
                { name: 'plan', value: 'plan' },
            ),
    );

const newSession = new SlashCommandBuilder()
    .setName('new')
    .setDescription('Create a new Claude Code session');

const archive = new SlashCommandBuilder()
    .setName('archive')
    .setDescription('Archive (kill) a Claude Code session')
    .addStringOption((opt) =>
        opt.setName('session').setDescription('Session ID prefix (default: current)').setRequired(false),
    );

const deleteCmd = new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Permanently delete a Claude Code session')
    .addStringOption((opt) =>
        opt.setName('session').setDescription('Session ID prefix (default: current)').setRequired(false),
    );

const cleanup = new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Delete all archived sessions and their threads');

const usage = new SlashCommandBuilder()
    .setName('usage')
    .setDescription('Show token usage and cost')
    .addStringOption((opt) =>
        opt
            .setName('period')
            .setDescription('Time period (default: session in thread, today in channel)')
            .setRequired(false)
            .addChoices(
                { name: 'today', value: 'today' },
                { name: '7 days', value: '7d' },
                { name: '30 days', value: '30d' },
            ),
    );

const skills = new SlashCommandBuilder()
    .setName('skills')
    .setDescription('List, search, or invoke Claude Code skills/commands')
    .addStringOption((opt) =>
        opt.setName('name').setDescription('Skill/command name or "reload"').setRequired(false).setAutocomplete(true),
    )
    .addStringOption((opt) =>
        opt.setName('args').setDescription('Arguments to pass to the skill').setRequired(false),
    );

const loop = new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Run a prompt or skill on a recurring interval')
    .addStringOption((opt) =>
        opt.setName('args').setDescription('e.g. "list", "delete <id>", "5m /compact"').setRequired(false).setAutocomplete(true),
    );

const approve = new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Approve a Happy account auth request (paste happy:// URL next)');

const update = new SlashCommandBuilder()
    .setName('update')
    .setDescription('Check for updates and upgrade the bot');

const allCommands = [sessions, stop, compact, mode, newSession, archive, deleteCmd, cleanup, usage, skills, loop, approve, update];

export const commandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] =
    allCommands.map((cmd) => cmd.toJSON());

// --- Command handler ---

export async function handleCommand(
    interaction: ChatInputCommandInteraction,
    bridge: Bridge,
): Promise<void> {
    console.log(`[Commands] /${interaction.commandName}`, interaction.options.data?.map((o) => `${o.name}=${o.value}`).join(' ') ?? '');
    switch (interaction.commandName) {
        case 'sessions':
            return handleSessions(interaction, bridge);
        case 'stop':
            return handleStop(interaction, bridge);
        case 'compact':
            return handleCompact(interaction, bridge);
        case 'mode':
            return handleMode(interaction, bridge);
        case 'new':
            return handleNewSession(interaction, bridge);
        case 'archive':
            return handleArchive(interaction, bridge);
        case 'delete':
            return handleDelete(interaction, bridge);
        case 'cleanup':
            return handleCleanup(interaction, bridge);
        case 'usage':
            return handleUsage(interaction, bridge);
        case 'skills':
            return handleSkills(interaction, bridge);
        case 'loop':
            return handleLoop(interaction, bridge);
        case 'approve':
            return handleApprove(interaction, bridge);
        case 'update':
            return handleUpdateCommand(interaction, bridge);
        default:
            await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
    }
}

// --- Helpers ---

function extractHost(metadata: unknown): string {
    if (!metadata || typeof metadata !== 'object') return 'unknown';
    const m = metadata as Record<string, unknown>;
    if (typeof m.host === 'string') return m.host;
    if (typeof m.machineId === 'string') return (m.machineId as string).slice(0, 8);
    return 'unknown';
}

function extractDirName(metadata: unknown, fallbackId: string): string {
    if (!metadata || typeof metadata !== 'object') return `session-${fallbackId.slice(0, 8)}`;
    const m = metadata as Record<string, unknown>;
    if (typeof m.path !== 'string') return `session-${fallbackId.slice(0, 8)}`;
    return m.path.split('/').filter(Boolean).pop() ?? 'unknown';
}

// --- Handlers ---

async function handleSessions(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();

    const sessions = await bridge.listAllSessions();

    if (sessions.length === 0) {
        await interaction.editReply('No sessions found.');
        return;
    }

    // Sort: active first (by activeAt desc), then inactive (by activeAt desc)
    const sorted = [...sessions].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.activeAt - a.activeAt;
    });

    // In a thread, "current" = thread-bound session; in main channel, "current" = activeSession
    const threadSession = bridge.getSessionByThread(interaction.channelId);
    const currentSessionId = threadSession ?? bridge.activeSession;

    // Group sessions by host
    const groups = new Map<string, typeof sorted>();
    for (const s of sorted) {
        const host = extractHost(s.metadata);
        const group = groups.get(host) ?? [];
        group.push(s);
        groups.set(host, group);
    }

    const sections: string[] = [];
    for (const [host, hostSessions] of groups) {
        const header = `**${host}**`;
        const lines = hostSessions.map((s) => {
            const dir = extractDirName(s.metadata, s.id);
            const marker = s.id === currentSessionId ? ' **← current**' : '';
            const status = s.active ? '' : ' (archived)';
            return `  ${s.active ? '🟢' : '⚪'} \`${s.id.slice(0, 8)}\` ${dir}${status}${marker}`;
        });
        sections.push([header, ...lines].join('\n'));
    }
    sections.push(`\nBot v${getVersion()}`);

    const allLines = sections.join('\n\n').split('\n');
    let content = '';
    let truncated = 0;
    for (const line of allLines) {
        const next = content ? `${content}\n${line}` : line;
        if (next.length > 1900) {
            truncated = allLines.length - content.split('\n').length;
            break;
        }
        content = next;
    }
    if (truncated > 0) {
        content += `\n... and ${truncated} more lines`;
    }

    const activeSessions = sorted.filter((s) => s.active);
    const buttons = activeSessions.length > 0
        ? buildSessionButtons(activeSessions, bridge.activeSession)
        : [];

    await interaction.editReply({
        content,
        components: buttons,
    });
}

async function handleStop(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        await bridge.stopSession(sessionId);
        await interaction.editReply('Stop requested.');
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to stop: ${detail}`);
    }
}

async function handleCompact(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        const reply = await interaction.editReply('Compacting session...');
        await bridge.compactSession(sessionId, reply.id);
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to compact: ${detail}`);
    }
}

async function handleMode(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    const modeValue = interaction.options.getString('mode', true) as PermissionMode;
    await interaction.deferReply();

    bridge.permissions.setMode(modeValue);
    bridge.persistModes();
    await interaction.editReply(`Permission mode set to: **${modeValue}**`);
}

async function handleNewSession(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();

    const allSessions = await bridge.listAllSessions();
    const directories = extractDirectories(allSessions);

    if (directories.length === 0) {
        await interaction.editReply('No machines found. Start a session manually first.');
        return;
    }

    const components = buildNewSessionMenu(directories);
    await interaction.editReply({
        content: 'Select a directory for the new session:',
        components,
    });
}

function resolveSessionFromContext(interaction: ChatInputCommandInteraction, bridge: Bridge): string {
    const prefix = interaction.options.getString('session');
    if (prefix) return prefix;

    const threadSession = bridge.getSessionByThread(interaction.channelId);
    if (threadSession) return threadSession;

    const active = bridge.activeSession;
    if (!active) throw new Error('No active session. Use /sessions to check available sessions.');
    return active;
}

async function handleArchive(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        await bridge.archiveSession(sessionId);
        await interaction.editReply(`Session \`${sessionId.slice(0, 8)}\` archived.`);
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to archive: ${detail}`);
    }
}

async function handleDelete(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        const buttons = buildDeleteConfirmButtons(sessionId);
        await interaction.editReply({
            content: `⚠️ Permanently delete session \`${sessionId.slice(0, 8)}\`? This removes all messages and data.`,
            components: buttons,
        });
    } catch (err) {
        // If in an orphaned thread (no mapped session), delete it directly
        if (interaction.channel?.isThread()) {
            await interaction.editReply('Deleting orphaned thread...');
            await interaction.channel.delete().catch(() => {});
            return;
        }
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed: ${detail}`);
    }
}

async function handleCleanup(interaction: ChatInputCommandInteraction, _bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const buttons = buildCleanupConfirmButtons();
        await interaction.editReply({
            content: '⚠️ Delete all archived sessions and orphan threads? This is irreversible.',
            components: buttons,
        });
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed: ${detail}`);
    }
}

async function handleUsage(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    try {
        const period = interaction.options.getString('period') as 'today' | '7d' | '30d' | null;
        const threadSession = bridge.getSessionByThread(interaction.channelId);

        if (period) {
            const now = Math.floor(Date.now() / 1000);
            const startTime = period === 'today'
                ? todayMidnight()
                : period === '7d'
                    ? now - 7 * 86400
                    : now - 30 * 86400;
            const groupBy = period === 'today' ? 'hour' as const : 'day' as const;

            const result = await queryUsage(bridge.happyClient, { startTime, groupBy });
            await interaction.editReply(formatUsage(result, period));
        } else if (threadSession) {
            const result = await queryUsage(bridge.happyClient, { sessionId: threadSession });
            await interaction.editReply(formatUsage(result, 'session', threadSession));
        } else {
            const result = await queryUsage(bridge.happyClient, { startTime: todayMidnight(), groupBy: 'hour' });
            await interaction.editReply(formatUsage(result, 'today'));
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to query usage: ${detail}`);
    }
}

function todayMidnight(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

// --- /skills handler ---

async function handleSkills(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();

    const name = interaction.options.getString('name');
    const args = interaction.options.getString('args');

    const projectDir = bridge.getProjectDirForThread(interaction.channelId)
        ?? (bridge.activeSession ? bridge.getSessionProjectDir(bridge.activeSession) : undefined);

    if (!name) {
        // List all available skills
        const entries = bridge.skillRegistry.getForSession(projectDir);
        if (entries.length === 0) {
            await interaction.editReply('No skills or commands found.');
            return;
        }
        const lines = entries.map((e) => {
            const prefix = e.source === 'plugin' ? '🔌' : e.source === 'project' ? '📁' : '👤';
            return `${prefix} \`/${e.name}\` — ${e.description || '(no description)'}`;
        });

        // Split into chunks that fit Discord's 2000-char limit
        const chunks: string[] = [];
        let current = '';
        for (const line of lines) {
            const next = current ? `${current}\n${line}` : line;
            if (next.length > 1900) {
                chunks.push(current);
                current = line;
            } else {
                current = next;
            }
        }
        if (current) chunks.push(current);

        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
        }
        return;
    }

    if (name === 'reload') {
        await bridge.skillRegistry.scanGlobal();
        for (const dir of bridge.getAllProjectDirs()) {
            await bridge.skillRegistry.scanProject(dir);
        }
        const count = bridge.skillRegistry.getForSession(projectDir).length;
        await interaction.editReply(`Reloaded — ${count} skills/commands available.`);
        return;
    }

    // Execute: send as slash command to session
    if (!/^[\w:.-]+$/.test(name)) {
        await interaction.editReply('Invalid skill name.');
        return;
    }
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        const message = args ? `/${name} ${args}` : `/${name}`;
        await bridge.sendMessage(message, sessionId);
        await interaction.editReply(`Sent \`${message}\``);
    } catch {
        await interaction.editReply('No active session. Use /sessions to connect.');
    }
}

// --- /loop handler ---

const LOOP_USAGE = [
    '**Usage:** `/loop [args]`',
    '',
    '`/loop 5m /compact` — run /compact every 5 minutes',
    '`/loop 10m check deploy` — check deploy every 10 minutes',
    '`/loop list` — list scheduled jobs',
    '`/loop delete <id>` — delete a scheduled job',
].join('\n');

async function handleLoop(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    const args = interaction.options.getString('args');

    if (!args) {
        await interaction.reply({ content: LOOP_USAGE, ephemeral: true });
        return;
    }

    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        const message = `/loop ${args}`;
        await bridge.sendMessage(message, sessionId);
        await interaction.editReply(`Sent \`${message}\``);
    } catch {
        await interaction.editReply('No active session. Use /sessions to connect.');
    }
}

// --- /approve handler ---

const PENDING_APPROVE_TIMEOUT_MS = 60_000;

async function handleApprove(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    if (bridge.pendingApprove) {
        await interaction.reply({ content: 'Already waiting for a happy:// URL. Paste the URL or wait for timeout.', ephemeral: true });
        return;
    }

    bridge.setPendingApprove(interaction.channelId, PENDING_APPROVE_TIMEOUT_MS);
    await interaction.reply('Paste the `happy://` URL from your `auth login` output within 60 seconds.');
}

// --- /update handler ---

async function handleUpdateCommand(interaction: ChatInputCommandInteraction, _bridge: Bridge): Promise<void> {
    await interaction.deferReply();

    const { checkForUpdate, performDiscordUpdate } = await import('../cli/update.js');
    const currentVersion = getVersion();
    const latest = await checkForUpdate(currentVersion);

    if (!latest) {
        await interaction.editReply(`Already on latest version (v${currentVersion}).`);
        return;
    }

    await interaction.editReply(`Updating to v${latest}...`);

    const success = await performDiscordUpdate(latest);

    if (!success) {
        await interaction.editReply(`Update to v${latest} failed. Still running v${currentVersion}.`);
        return;
    }

    await interaction.editReply(`Updated to v${latest}. Restarting...`);
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1000);
}

// --- /loop autocomplete ---

const LOOP_SUGGESTIONS = [
    { name: 'list — Show scheduled jobs', value: 'list' },
    { name: 'delete <id> — Cancel a scheduled job', value: 'delete ' },
    { name: '5m — Every 5 minutes', value: '5m ' },
    { name: '10m — Every 10 minutes', value: '10m ' },
    { name: '30m — Every 30 minutes', value: '30m ' },
    { name: '1h — Every hour', value: '1h ' },
];

export async function handleLoopAutocomplete(
    interaction: AutocompleteInteraction,
): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();

    const filtered = focused
        ? LOOP_SUGGESTIONS.filter((s) => s.value.startsWith(focused) || s.name.toLowerCase().includes(focused))
        : LOOP_SUGGESTIONS;

    await interaction.respond(filtered.slice(0, 25));
}
// --- /skills autocomplete ---

const MAX_AUTOCOMPLETE = 25;

export async function handleSkillsAutocomplete(
    interaction: AutocompleteInteraction,
    registry: SkillRegistry,
    projectDir?: string,
): Promise<void> {
    const focused = interaction.options.getFocused();
    const results = registry.search(focused, projectDir);

    const reloadOption = { name: '🔄 reload — Re-scan skills from disk', value: 'reload' };
    const showReload = !focused || 'reload'.includes(focused.toLowerCase());

    const choices = results.map((e) => ({ name: e.name, value: e.name }));

    if (showReload) {
        choices.unshift(reloadOption);
    }

    await interaction.respond(choices.slice(0, MAX_AUTOCOMPLETE));
}
