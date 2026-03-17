import { createInterface } from 'node:readline/promises';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getStateDir } from '../state-dir.js';

interface ConfigAnswers {
    DISCORD_TOKEN: string;
    DISCORD_CHANNEL_ID: string;
    DISCORD_USER_ID: string;
    DISCORD_APPLICATION_ID: string;
    DISCORD_GUILD_ID: string;
}

export function parseEnvFile(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const raw = trimmed.slice(eqIndex + 1);
        result[trimmed.slice(0, eqIndex)] = raw.replace(/^(['"])(.*)\1$/, '$2');
    }
    return result;
}

export function buildEnvContent(answers: ConfigAnswers): string {
    const lines: string[] = [
        '# Discord Bot',
        `DISCORD_TOKEN=${answers.DISCORD_TOKEN}`,
        `DISCORD_CHANNEL_ID=${answers.DISCORD_CHANNEL_ID}`,
        `DISCORD_USER_ID=${answers.DISCORD_USER_ID}`,
        `DISCORD_APPLICATION_ID=${answers.DISCORD_APPLICATION_ID}`,
    ];

    lines.push(`DISCORD_GUILD_ID=${answers.DISCORD_GUILD_ID}`);

    return lines.join('\n') + '\n';
}

export async function handleInit(): Promise<void> {
    const stateDir = getStateDir();
    const envPath = join(stateDir, '.env');

    let defaults: Record<string, string> = {};
    if (existsSync(envPath)) {
        defaults = parseEnvFile(readFileSync(envPath, 'utf-8'));
        console.log(`Existing config found at ${envPath}\n`);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        console.log('Setting up happy-discord-bot\n');

        const ask = (label: string, key: string, optional = false): Promise<string> => {
            const current = defaults[key];
            const suffix = current ? ` [${current}]` : '';
            const optHint = optional ? ' (optional, press Enter to skip)' : '';
            return rl.question(`${label}${suffix}${optHint}: `);
        };

        const token = await ask('Discord bot token', 'DISCORD_TOKEN');
        const channelId = await ask('Discord channel ID', 'DISCORD_CHANNEL_ID');
        const userId = await ask('Your Discord user ID', 'DISCORD_USER_ID');
        const appId = await ask('Discord application ID', 'DISCORD_APPLICATION_ID');
        const guildId = await ask('Discord guild (server) ID', 'DISCORD_GUILD_ID');

        const answers: ConfigAnswers = {
            DISCORD_TOKEN: token || defaults.DISCORD_TOKEN || '',
            DISCORD_CHANNEL_ID: channelId || defaults.DISCORD_CHANNEL_ID || '',
            DISCORD_USER_ID: userId || defaults.DISCORD_USER_ID || '',
            DISCORD_APPLICATION_ID: appId || defaults.DISCORD_APPLICATION_ID || '',
            DISCORD_GUILD_ID: guildId || defaults.DISCORD_GUILD_ID || '',
        };

        const content = buildEnvContent(answers);
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        writeFileSync(envPath, content, { mode: 0o600 });

        console.log(`\nConfig saved to ${envPath}`);
        console.log('\nNext steps:');
        console.log('  1. happy-discord-bot auth login    (create new Happy account)');
        console.log('     — or: happy-discord-bot auth restore  (restore existing account)');
        console.log('  2. happy-discord-bot deploy-commands');
        console.log('  3. happy-discord-bot start');
    } finally {
        rl.close();
    }
}
