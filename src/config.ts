import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig as loadHappyConfig, type Config as HappyConfig } from './vendor/config.js';
import type { Credentials } from './vendor/credentials.js';
import { deriveContentKeyPair, decodeBase64 } from './vendor/encryption.js';
import { getStateDir } from './state-dir.js';
import { readBotCredentials } from './credentials.js';

export function resolveEnvFile(): string | undefined {
    const cwdEnv = join(process.cwd(), '.env');
    if (existsSync(cwdEnv)) return cwdEnv;

    const stateEnv = join(getStateDir(), '.env');
    if (existsSync(stateEnv)) return stateEnv;

    return undefined;
}

const envFile = resolveEnvFile();
if (envFile) dotenvConfig({ path: envFile });

export interface BotConfig {
    discord: {
        token: string;
        channelId: string;
        userId: string;
        requireMention: boolean;
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

/** Read credentials from env vars (HAPPY_TOKEN + HAPPY_SECRET), fallback to bot's credentials.json */
function loadCredentials(_happy: HappyConfig): Credentials {
    const envToken = process.env.HAPPY_TOKEN;
    const envSecret = process.env.HAPPY_SECRET;

    if (envToken && envSecret) {
        const secret = decodeBase64(envSecret);
        const contentKeyPair = deriveContentKeyPair(secret);
        return { token: envToken, secret, contentKeyPair };
    }

    const botCreds = readBotCredentials(getStateDir());
    if (botCreds) {
        const secret = decodeBase64(botCreds.secret);
        const contentKeyPair = deriveContentKeyPair(secret);
        return { token: botCreds.token, secret, contentKeyPair };
    }

    throw new Error(
        'No Happy credentials found. Either set HAPPY_TOKEN + HAPPY_SECRET env vars, '
        + 'or run `happy-discord-bot auth login`.',
    );
}

export function loadBotConfig(): BotConfig {
    const happy = loadHappyConfig();
    const credentials = loadCredentials(happy);

    return {
        discord: {
            token: requiredEnv('DISCORD_TOKEN'),
            channelId: requiredEnv('DISCORD_CHANNEL_ID'),
            userId: requiredEnv('DISCORD_USER_ID'),
            requireMention: process.env.DISCORD_REQUIRE_MENTION === 'true',
        },
        happy,
        credentials,
    };
}
