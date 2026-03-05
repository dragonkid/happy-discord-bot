import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BotProcess } from './helpers/bot-process.js';
import { DiscordTestClient } from './helpers/discord-test-client.js';
import { StateFile } from './helpers/state-file.js';
import { loadE2EConfig } from './env.js';

const config = loadE2EConfig();
const bot = new BotProcess();
const discord = new DiscordTestClient(config.discordToken, config.discordChannelId);
const stateFile = new StateFile();

let sessionId: string;

describe('Smoke: Permission Auto-Approve', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        // Start bot to discover active session
        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
        });

        // Extract active session from bot logs
        const sessionLog = await bot.waitForLog('[Bridge] Active session:', 10_000);
        const match = sessionLog.match(/Active session:\s*(\S+)/);
        if (!match) throw new Error('Could not extract session ID from logs');
        sessionId = match[1];
        console.log(`[Test] Active session: ${sessionId}`);

        // Stop bot, write acceptEdits state, restart
        await bot.stop();

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

        discord.clearMessages();
        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
        });

        expect(bot.hasLog('[Store] Loaded 1 saved session(s)')).toBe(true);
    }, 120_000);

    afterAll(async () => {
        await bot.stop();
        discord.destroy();
        await stateFile.clean();
    });

    it('should auto-approve Edit/Write tools in acceptEdits mode', async () => {
        const logBaseline = bot.logCount;

        // Ask Claude to create a file (triggers Write or Edit)
        await discord.sendMessage(
            'Create a file at /tmp/e2e-auto-approve-test.txt with content "hello e2e"',
        );

        // Wait for auto-approve log
        await bot.waitForLog('Auto-approving', 60_000);

        // Verify it was an edit-type auto-approve
        const newLogs = bot.getLogsSince(logBaseline);
        const autoApproveLog = newLogs.find((l) => l.includes('Auto-approving'));
        expect(autoApproveLog).toBeDefined();
        expect(
            autoApproveLog!.includes('Auto-approving Write') ||
            autoApproveLog!.includes('Auto-approving Edit'),
        ).toBe(true);

        // Wait for Claude's response in Discord
        await discord.waitForBotMessage(
            (content) => content.includes('e2e-auto-approve-test'),
            60_000,
        );
    });
});
