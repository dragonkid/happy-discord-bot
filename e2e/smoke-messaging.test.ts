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

describe('Smoke: Message E2E', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        // Spawn a fresh CLI session
        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-msg-${Date.now()}`);
        console.log(`[Test] Spawned session: ${spawnedSessionId}`);

        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
            BOT_STATE_DIR: stateFile.stateDir,
        });

        // Wait for bot to discover the session
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

    it('should forward a message to Claude and receive a response', async () => {
        await discord.sendMessage('Reply with exactly: PONG');

        const response = await discord.waitForBotMessage(
            (content) => content.toLowerCase().includes('pong'),
            90_000,
        );

        expect(response.content.toLowerCase()).toContain('pong');
    });
});
