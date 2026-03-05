import { loadE2EConfig, type E2EConfig } from './env.js';
import { DaemonClient } from './helpers/daemon-client.js';

// Validate environment before any tests run
export async function setup(): Promise<void> {
    let config: E2EConfig;
    try {
        config = loadE2EConfig();
    } catch (err) {
        console.error('\nE2E environment not configured:');
        console.error(err instanceof Error ? err.message : err);
        console.error('\nSee .env.e2e.example for required variables.\n');
        process.exit(1);
    }

    // Verify happy daemon is running
    const daemon = new DaemonClient();
    try {
        await daemon.connect();
        const sessions = await daemon.listSessions();
        console.log(`  Daemon sessions: ${sessions.length}`);
    } catch (err) {
        console.error('\nHappy daemon not available:');
        console.error(err instanceof Error ? err.message : err);
        console.error('\nRun `happy daemon start` before E2E tests.\n');
        process.exit(1);
    }

    console.log('\nE2E Smoke Test Environment:');
    console.log(`  Discord channel: ${config.discordChannelId}`);
    console.log('');
}
