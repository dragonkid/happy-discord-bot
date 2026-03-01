import { loadBotConfig } from './config.js';
import { HappyClient } from './happy/client.js';
import { DiscordBot } from './discord/bot.js';
import { handleCommand } from './discord/commands.js';
import { listActiveSessions } from './vendor/api.js';

async function main(): Promise<void> {
    const config = loadBotConfig();
    console.log(`Happy server: ${config.happy.serverUrl}`);
    console.log(`Discord channel: ${config.discord.channelId}`);

    // --- Happy relay ---
    const sessions = await listActiveSessions(config.happy, config.credentials);
    console.log(`Found ${sessions.length} active session(s)`);
    for (const s of sessions) {
        console.log(`  - ${s.id} (active: ${s.active})`);
    }

    const happy = new HappyClient(config.happy, config.credentials);

    happy.on('connected', () => {
        console.log('[Happy] Connected to relay');
    });

    happy.on('update', (data) => {
        console.log('[Happy] Update:', JSON.stringify(data).slice(0, 200));
    });

    happy.on('disconnected', (reason) => {
        console.log(`[Happy] Disconnected: ${reason}`);
    });

    happy.connect();

    // --- Discord bot ---
    const discord = new DiscordBot(config.discord);

    discord.onInteraction(async (interaction) => {
        if (interaction.isChatInputCommand()) {
            await handleCommand(interaction);
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
