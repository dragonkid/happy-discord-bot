import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotProcess } from './helpers/bot-process.js';
import { DiscordTestClient } from './helpers/discord-test-client.js';
import { StateFile } from './helpers/state-file.js';
import { loadE2EConfig } from './env.js';

const config = loadE2EConfig();
const bot = new BotProcess();
const discord = new DiscordTestClient(config.discordToken, config.discordChannelId);
const stateFile = new StateFile(join(tmpdir(), 'happy-discord-bot-e2e'));

let sessionId: string;

describe('Smoke: Bot Restart Recovery', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
            BOT_STATE_DIR: stateFile.stateDir,
        });

        const sessionLog = await bot.waitForLog('[Bridge] Active session:', 10_000);
        const match = sessionLog.match(/Active session:\s*(\S+)/);
        if (!match) throw new Error('Could not extract session ID');
        sessionId = match[1];
    }, 60_000);

    afterAll(async () => {
        await bot.stop();
        discord.destroy();
        await stateFile.clean();
    });

    it('should restore permission state after restart', async () => {
        await stateFile.write({
            sessions: {
                [sessionId]: {
                    mode: 'acceptEdits',
                    allowedTools: [],
                    bashLiterals: [],
                    bashPrefixes: [],
                },
            },
        });

        await bot.restart({
            BOT_STATE_DIR: stateFile.stateDir,
        });

        expect(bot.hasLog('[Store] Loaded 1 saved session(s)')).toBe(true);

        discord.clearMessages();
        const logBaseline = bot.logCount;

        await discord.sendMessage(
            'Create file /tmp/e2e-restart-test.txt with "restart ok"',
        );

        await bot.waitForLog('Auto-approving', 60_000);

        const newLogs = bot.getLogsSince(logBaseline);
        const hasAutoApprove = newLogs.some(
            (l) => l.includes('Auto-approving Write') || l.includes('Auto-approving Edit'),
        );
        expect(hasAutoApprove).toBe(true);
    });
});
