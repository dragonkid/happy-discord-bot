import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

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

export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
        case 'sessions':
            return handleSessions(interaction);
        case 'send':
            return handleSend(interaction);
        case 'stop':
            return handleStop(interaction);
        case 'compact':
            return handleCompact(interaction);
        case 'mode':
            return handleMode(interaction);
        default:
            await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
    }
}

// --- Handlers (placeholders — wired to Happy RPC in Phase 4) ---

async function handleSessions(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    // TODO: Phase 4 — call listActiveSessions via bridge
    await interaction.editReply('No active sessions. (Connect bridge in Phase 4)');
}

async function handleSend(interaction: ChatInputCommandInteraction): Promise<void> {
    const message = interaction.options.getString('message');
    if (!message) {
        await interaction.reply({ content: 'Please provide a message.', ephemeral: true });
        return;
    }

    await interaction.deferReply();
    // TODO: Phase 4 — send message via bridge
    await interaction.editReply(`Queued: "${message}" (Connect bridge in Phase 4)`);
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    // TODO: Phase 4 — send abort RPC
    await interaction.editReply('Stop requested. (Connect bridge in Phase 4)');
}

async function handleCompact(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    // TODO: Phase 4 — send compact command
    await interaction.editReply('Compact requested. (Connect bridge in Phase 4)');
}

async function handleMode(interaction: ChatInputCommandInteraction): Promise<void> {
    const modeValue = interaction.options.getString('mode', true);
    await interaction.deferReply();
    // TODO: Phase 5 — set permission mode on PermissionCache
    await interaction.editReply(`Permission mode set to: ${modeValue} (Connect in Phase 5)`);
}
