import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Bridge } from '../bridge.js';
import { buildSessionButtons } from './buttons.js';
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

const allCommands = [sessions, send, stop, compact, mode];

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
        default:
            await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
    }
}

// --- Handlers ---

async function handleSessions(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    const sessions = await bridge.listSessions();

    if (sessions.length === 0) {
        await interaction.editReply('No active sessions.');
        return;
    }

    const lines = sessions.map((s) => {
        const marker = s.id === bridge.activeSession ? ' ← current' : '';
        const time = new Date(s.activeAt).toLocaleTimeString();
        return `• \`${s.id.slice(0, 8)}\` (active ${time})${marker}`;
    });

    const buttons = buildSessionButtons(sessions, bridge.activeSession);

    await interaction.editReply({
        content: lines.join('\n'),
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
        await bridge.stopSession();
        await interaction.editReply('Stop requested.');
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to stop: ${detail}`);
    }
}

async function handleCompact(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
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
    bridge.permissions.setMode(modeValue);
    bridge.persistModes();
    await interaction.editReply(`Permission mode set to: **${modeValue}**`);
}
