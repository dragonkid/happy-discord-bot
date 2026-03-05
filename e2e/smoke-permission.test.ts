import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotProcess } from './helpers/bot-process.js';
import { DiscordTestClient } from './helpers/discord-test-client.js';
import { StateFile } from './helpers/state-file.js';
import { DaemonClient } from './helpers/daemon-client.js';
import { loadE2EConfig } from './env.js';

const config = loadE2EConfig();
const bot = new BotProcess();
const discord = new DiscordTestClient(config.discordToken, config.discordChannelId);
const stateFile = new StateFile(join(tmpdir(), 'happy-discord-bot-e2e'));
const daemon = new DaemonClient();

let spawnedSessionId: string | null = null;

describe('Smoke: Permission Auto-Approve', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        // Spawn a fresh CLI session
        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-perm-${Date.now()}`);
        console.log(`[Test] Spawned session: ${spawnedSessionId}`);

        // Write acceptEdits state for the session before starting bot
        await stateFile.write({
            sessions: {
                [spawnedSessionId]: {
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
            BOT_STATE_DIR: stateFile.stateDir,
        });

        expect(bot.hasLog('[Store] Loaded 1 saved session(s)')).toBe(true);
        await bot.waitForLog('[Bridge] Active session:', 15_000);
    }, 120_000);

    afterAll(async () => {
        await bot.stop();
        discord.destroy();
        if (spawnedSessionId) {
            await daemon.stopSession(spawnedSessionId).catch(() => {});
        }
        await stateFile.clean();
    });

    it('should complete edit operations without permission buttons in acceptEdits mode', async () => {
        await discord.sendMessage(
            'Create a file at /tmp/e2e-auto-approve-test.txt with content "hello e2e"',
        );

        // Wait for Claude to complete the task — either bot auto-approved
        // or CLI-side cache auto-approved. Either way, no permission buttons
        // should appear, and Claude should reply about the file.
        const response = await discord.waitForBotMessage(
            (content) => content.toLowerCase().includes('e2e-auto-approve-test')
                || content.toLowerCase().includes('created')
                || content.toLowerCase().includes('file'),
            90_000,
        );

        // Verify no permission buttons were shown (no message with components)
        // The response should be a text message, not a button prompt
        expect(response.components.length).toBe(0);
    });
});
