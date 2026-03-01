import { loadBotConfig } from './config.js';
import { HappyClient } from './happy/client.js';
import { listActiveSessions } from './vendor/api.js';

async function main(): Promise<void> {
    const config = loadBotConfig();
    console.log(`Happy server: ${config.happy.serverUrl}`);
    console.log(`Discord channel: ${config.discord.channelId}`);

    // List active sessions to verify API access
    const sessions = await listActiveSessions(config.happy, config.credentials);
    console.log(`Found ${sessions.length} active session(s)`);
    for (const s of sessions) {
        console.log(`  - ${s.id} (active: ${s.active})`);
    }

    // Create and connect HappyClient
    const happy = new HappyClient(config.happy, config.credentials);

    happy.on('connected', () => {
        console.log('[Bot] Connected to relay, ready to receive events');
    });

    happy.on('update', (data) => {
        console.log('[Bot] Update:', JSON.stringify(data).slice(0, 200));
    });

    happy.on('disconnected', (reason) => {
        console.log(`[Bot] Disconnected: ${reason}`);
    });

    happy.connect();

    // Keep process alive
    process.on('SIGINT', () => {
        console.log('Shutting down...');
        happy.close();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
