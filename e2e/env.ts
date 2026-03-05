import { config } from 'dotenv';
import { resolve } from 'node:path';

// Load .env.e2e from project root
config({ path: resolve(import.meta.dirname, '..', '.env.e2e') });

export interface E2EConfig {
    /** Test bot token (second Discord bot) */
    discordToken: string;
    /** Dedicated test channel ID */
    discordChannelId: string;
    /** Main bot's Discord token (for subprocess) */
    botDiscordToken: string;
    /** Optional machine ID for session spawn (auto-detected if omitted) */
    machineId?: string;
}

export function loadE2EConfig(): E2EConfig {
    const discordToken = process.env.E2E_DISCORD_TOKEN;
    const discordChannelId = process.env.E2E_DISCORD_CHANNEL_ID;
    const botDiscordToken = process.env.E2E_BOT_DISCORD_TOKEN;

    if (!discordToken || !discordChannelId || !botDiscordToken) {
        throw new Error(
            'Missing E2E env vars. Required: E2E_DISCORD_TOKEN, E2E_DISCORD_CHANNEL_ID, E2E_BOT_DISCORD_TOKEN.\n'
            + 'Copy .env.e2e.example to .env.e2e and fill in values.',
        );
    }

    return {
        discordToken,
        discordChannelId,
        botDiscordToken,
        machineId: process.env.E2E_MACHINE_ID || undefined,
    };
}
