import { loadE2EConfig, type E2EConfig } from './env.js';

// Validate environment before any tests run
export function setup(): void {
    let config: E2EConfig;
    try {
        config = loadE2EConfig();
    } catch (err) {
        console.error('\nE2E environment not configured:');
        console.error(err instanceof Error ? err.message : err);
        console.error('\nSee .env.e2e.example for required variables.\n');
        process.exit(1);
    }

    console.log('\nE2E Smoke Test Environment:');
    console.log(`  Discord channel: ${config.discordChannelId}`);
    console.log(`  Machine ID: ${config.machineId ?? '(auto-detect)'}`);
    console.log('');
}
