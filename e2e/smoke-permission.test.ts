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

        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-perm-${Date.now()}`);
        console.log(`[Test] Spawned session: ${spawnedSessionId}`);

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
        for (const thread of discord.getCreatedThreads()) {
            await discord.deleteThread(thread.id).catch(() => {});
        }
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

        // The key assertion: bot should auto-approve Write and Read tools without
        // showing permission buttons. Wait for ANY text response without components.
        const response = await discord.waitForBotMessage(
            (content, msg) => msg.components.length === 0 && content.length > 0,
            90_000,
        );

        // Verify no permission buttons were shown at any point
        expect(response.components.length).toBe(0);
    });
});
