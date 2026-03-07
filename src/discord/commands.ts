import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Bridge } from '../bridge.js';
import { buildSessionButtons, buildNewSessionMenu, buildDeleteConfirmButtons, buildCleanupConfirmButtons } from './buttons.js';
import { extractDirectories, threadName } from '../happy/session-metadata.js';
import type { PermissionMode } from '../happy/types.js';

// --- Command definitions ---

const sessions = new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('List active Claude Code sessions');

const send = new SlashCommandBuilder()
    .setName('send')
    .setDescription('Send a message to the active Claude Code session')
    .addStringOption((opt) =>
        opt.setName('message').setDescription('Message text').setRequired(true),
    );

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

const allCommands = [sessions, send, stop, compact, mode, newSession, archive, deleteCmd, cleanup];

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
        case 'send':
            return handleSend(interaction, bridge);
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

async function handleSend(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    const message = interaction.options.getString('message');
    if (!message) {
        await interaction.reply({ content: 'Please provide a message.', ephemeral: true });
        return;
    }

    await interaction.deferReply();
    try {
        await bridge.sendMessage(message);
        await interaction.editReply(`Sent: "${message}"`);
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to send: ${detail}`);
    }
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
        await bridge.compactSession();
        await interaction.editReply('Compact requested.');
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

async function handleCleanup(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
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
