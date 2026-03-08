import {
    SlashCommandBuilder,
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Bridge } from '../bridge.js';
import { buildSessionButtons, buildNewSessionMenu, buildDeleteConfirmButtons, buildCleanupConfirmButtons } from './buttons.js';
import { extractDirectories, threadName } from '../happy/session-metadata.js';
import type { PermissionMode } from '../happy/types.js';
import { queryUsage } from '../happy/usage.js';
import { formatUsage } from './formatter.js';
import type { SkillRegistry } from '../happy/skill-registry.js';

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

const allCommands = [sessions, stop, compact, mode, newSession, archive, deleteCmd, cleanup, usage, skills];

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
        default:
            await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
    }
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

    const lines = sorted.map((s) => {
        const name = threadName(s.metadata, s.id);
        const marker = s.id === bridge.activeSession ? ' **← current**' : '';
        const status = s.active ? '' : ' (archived)';
        return `${s.active ? '🟢' : '⚪'} \`${s.id.slice(0, 8)}\` ${name}${status}${marker}`;
    });

    // Truncate to fit Discord 2000-char limit
    let content = '';
    for (const line of lines) {
        const next = content ? `${content}\n${line}` : line;
        if (next.length > 1900) {
            content += `\n... and ${lines.length - content.split('\n').length} more`;
            break;
        }
        content = next;
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
        if (bridge.activeSession !== sessionId) {
            bridge.setActiveSession(sessionId);
            bridge.persistModes();
        }
        const reply = await interaction.editReply('Compacting session...');
        await bridge.compactSession(reply.id, interaction.channelId);
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to compact: ${detail}`);
    }
}

async function handleMode(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    const modeValue = interaction.options.getString('mode', true) as PermissionMode;
    await interaction.deferReply();

    const threadSession = bridge.getSessionByThread(interaction.channelId);
    if (threadSession && bridge.activeSession !== threadSession) {
        bridge.setActiveSession(threadSession);
    }

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
        let content = '';
        for (const line of lines) {
            const next = content ? `${content}\n${line}` : line;
            if (next.length > 1900) {
                content += `\n... and ${lines.length - content.split('\n').length} more`;
                break;
            }
            content = next;
        }
        await interaction.editReply(content);
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
    if (!bridge.activeSession) {
        await interaction.editReply('No active session. Use /sessions to connect.');
        return;
    }
    const message = args ? `/${name} ${args}` : `/${name}`;
    await bridge.sendMessage(message);
    await interaction.editReply(`Sent \`${message}\``);
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

    const choices = results.map((e) => {
        const display = `${e.name} — ${e.description || '(no description)'}`;
        return { name: display.length > 100 ? display.slice(0, 97) + '...' : display, value: e.name };
    });

    if (showReload) {
        choices.unshift(reloadOption);
    }

    await interaction.respond(choices.slice(0, MAX_AUTOCOMPLETE));
}
