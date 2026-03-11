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

describe('Smoke: Bot Restart Recovery', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        // Spawn a fresh CLI session
        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-restart-${Date.now()}`);
        console.log(`[Test] Spawned session: ${spawnedSessionId}`);

        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
            BOT_STATE_DIR: stateFile.stateDir,
        });

        await bot.waitForLog('[Bridge] Active session:', 15_000);
    }, 120_000);

    afterAll(async () => {
        await bot.stop();
        for (const thread of discord.getCreatedThreads()) {
            await discord.deleteThread(thread.id).catch(() => {});
        }
        discord.destroy();
        if (spawnedSessionId) {
            await daemon.stopSession(spawnedSessionId).catch(() => {});
        }
        await stateFile.clean();
    });

    it('should restore permission state and keep working after restart', async () => {
        // Write acceptEdits state
        await stateFile.write({
            sessions: {
                [spawnedSessionId!]: {
                    mode: 'acceptEdits',
                    allowedTools: [],
                    bashLiterals: [],
                    bashPrefixes: [],
                },
            },
        });

        // Restart bot
        await bot.restart({
            BOT_STATE_DIR: stateFile.stateDir,
        });

        // Verify state loaded
        expect(bot.hasLog('[Store] Loaded 1 saved session(s)')).toBe(true);
        expect(bot.hasLog(`[Bridge] Active session: ${spawnedSessionId}`)).toBe(true);

        // Send a simple message to verify the bot is functional after restart
        discord.clearMessages();
        await discord.sendMessage('Reply with exactly: RESTART_OK');

        const response = await discord.waitForBotMessage(
            (content) => content.includes('RESTART_OK') || content.toLowerCase().includes('restart_ok'),
            90_000,
        );

        expect(response.content.toLowerCase()).toContain('restart_ok');
    });
});
