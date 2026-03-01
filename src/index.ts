import { loadBotConfig } from './config.js';

async function main(): Promise<void> {
    const config = loadBotConfig();
    console.log('Config loaded successfully');
    console.log(`Happy server: ${config.happy.serverUrl}`);
    console.log(`Discord channel: ${config.discord.channelId}`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
