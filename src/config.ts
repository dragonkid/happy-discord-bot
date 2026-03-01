import 'dotenv/config';
import { loadConfig as loadHappyConfig, type Config as HappyConfig } from './vendor/config.js';
import { readCredentials, type Credentials } from './vendor/credentials.js';

export interface BotConfig {
    discord: {
        token: string;
        channelId: string;
        userId: string;
    };
    happy: HappyConfig;
    credentials: Credentials;
}

function requiredEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

export function loadBotConfig(): BotConfig {
    const happy = loadHappyConfig();
    const credentials = readCredentials(happy);
    if (!credentials) {
        throw new Error(
            'No Happy credentials found. Run `happy-agent auth login` first.',
        );
    }

    return {
        discord: {
            token: requiredEnv('DISCORD_TOKEN'),
            channelId: requiredEnv('DISCORD_CHANNEL_ID'),
            userId: requiredEnv('DISCORD_USER_ID'),
        },
        happy,
        credentials,
    };
}
