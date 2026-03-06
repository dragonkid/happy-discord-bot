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
let sessionDirName: string;

describe('Smoke: Thread per Session E2E', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();
        await daemon.connect();

        sessionDirName = `e2e-thread-${Date.now()}`;
        spawnedSessionId = await daemon.spawnSession(`/tmp/${sessionDirName}`);
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
        // Clean up threads created during test
        for (const thread of discord.getCreatedThreads()) {
            await discord.deleteThread(thread.id).catch(() => {});
        }
        discord.destroy();
        if (spawnedSessionId) {
            await daemon.stopSession(spawnedSessionId).catch(() => {});
        }
        await stateFile.clean();
    });

    it('creates a thread when session starts', async () => {
        // Bot auto-creates threads for all active sessions — find the e2e one
        const thread = await discord.waitForThread(
            (t) => t.name.includes(sessionDirName),
            15_000,
        );
        expect(thread).toBeDefined();
        expect(thread.name).toContain('@');
        console.log(`[Test] Thread created: ${thread.name} (${thread.id})`);
    });

    it('routes message in thread to session and responds in thread', async () => {
        const thread = discord.findThread((t) => t.name.includes('e2e-thread'));
        expect(thread).toBeDefined();

        // Small delay to ensure session is ready for input
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        discord.clearMessages();

        await discord.sendMessageInThread(thread!.id, 'What is 2+2? Reply with just the number.');

        const response = await discord.waitForBotMessageInThread(
            thread!.id,
            (content) => content.includes('4'),
            90_000,
        );
        expect(response.content).toContain('4');
    });

    it('restores thread routing after bot restart', async () => {
        await bot.stop();

        // Restart bot — thread mapping should restore from state.json
        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
            BOT_STATE_DIR: stateFile.stateDir,
        });
        await bot.waitForLog('[Store] Loaded', 15_000);
        await bot.waitForLog('saved thread', 10_000);

        const thread = discord.findThread((t) => t.name.includes('e2e-thread'));
        if (thread) {
            discord.clearMessages();
            await discord.sendMessageInThread(thread.id, 'Reply with exactly: RESTART-PONG');
            const response = await discord.waitForBotMessageInThread(
                thread.id,
                (content) => content.toLowerCase().includes('restart-pong'),
                90_000,
            );
            expect(response.content.toLowerCase()).toContain('restart-pong');
        }
    });
});
