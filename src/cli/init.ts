import { createInterface } from 'node:readline/promises';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getStateDir } from '../state-dir.js';

interface ConfigAnswers {
    DISCORD_TOKEN: string;
    DISCORD_CHANNEL_ID: string;
    DISCORD_USER_ID: string;
    DISCORD_APPLICATION_ID: string;
    DISCORD_GUILD_ID?: string;
}

export function buildEnvContent(answers: ConfigAnswers): string {
    const lines: string[] = [
        '# Discord Bot',
        `DISCORD_TOKEN=${answers.DISCORD_TOKEN}`,
        `DISCORD_CHANNEL_ID=${answers.DISCORD_CHANNEL_ID}`,
        `DISCORD_USER_ID=${answers.DISCORD_USER_ID}`,
        `DISCORD_APPLICATION_ID=${answers.DISCORD_APPLICATION_ID}`,
    ];

    if (answers.DISCORD_GUILD_ID) {
        lines.push(`DISCORD_GUILD_ID=${answers.DISCORD_GUILD_ID}`);
    }

    return lines.join('\n') + '\n';
}

export async function handleInit(): Promise<void> {
    const stateDir = getStateDir();
    const envPath = join(stateDir, '.env');

    if (existsSync(envPath)) {
        console.log(`Config already exists at ${envPath}`);
        console.log('Delete it first if you want to reconfigure.');
        return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        console.log('Setting up happy-discord-bot\n');

        const token = await rl.question('Discord bot token: ');
        const channelId = await rl.question('Discord channel ID: ');
        const userId = await rl.question('Your Discord user ID: ');
        const appId = await rl.question('Discord application ID: ');
        const guildId = await rl.question('Discord guild ID (optional, press Enter to skip): ');

        const answers: ConfigAnswers = {
            DISCORD_TOKEN: token,
            DISCORD_CHANNEL_ID: channelId,
            DISCORD_USER_ID: userId,
            DISCORD_APPLICATION_ID: appId,
            ...(guildId && { DISCORD_GUILD_ID: guildId }),
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
