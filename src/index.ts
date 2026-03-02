import { loadBotConfig } from './config.js';
import { HappyClient } from './happy/client.js';
import { DiscordBot } from './discord/bot.js';
import { handleCommand } from './discord/commands.js';
import { Bridge } from './bridge.js';
import { StateTracker } from './happy/state-tracker.js';
import { PermissionCache } from './happy/permission-cache.js';

async function main(): Promise<void> {
    const config = loadBotConfig();
    console.log(`Happy server: ${config.happy.serverUrl}`);
    console.log(`Discord channel: ${config.discord.channelId}`);

    // --- Happy relay ---
    const happy = new HappyClient(config.happy, config.credentials);

    happy.on('connected', () => {
        console.log('[Happy] Connected to relay');
    });

    happy.on('disconnected', (reason) => {
        console.log(`[Happy] Disconnected: ${reason}`);
    });

    happy.connect();

    // --- Discord bot ---
    const discord = new DiscordBot(config.discord);

    // --- Bridge ---
    const stateTracker = new StateTracker();
    const permissionCache = new PermissionCache();
    const bridge = new Bridge(happy, discord, config, stateTracker, permissionCache);
    await bridge.start();

    if (bridge.activeSession) {
        console.log(`[Bridge] Active session: ${bridge.activeSession}`);
    } else {
        console.log('[Bridge] No active sessions found');
    }

    discord.onInteraction(async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        if (interaction.user.id !== config.discord.userId) {
            await interaction.reply({ content: 'Unauthorized.', ephemeral: true });
            return;
        }

        try {
            await handleCommand(interaction, bridge);
        } catch (err) {
            console.error('[Discord] Command error:', err);
            const reply = interaction.deferred
                ? interaction.editReply('An error occurred.')
                : interaction.reply({ content: 'An error occurred.', ephemeral: true });
            await reply.catch(() => {});
        }
    });

    await discord.start();
    console.log('[Discord] Bot online');

    // --- Graceful shutdown ---
    process.on('SIGINT', () => {
        console.log('Shutting down...');
        happy.close();
        discord.destroy();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
