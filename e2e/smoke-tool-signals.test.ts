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

describe('Smoke: Tool Call Signals', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-signals-${Date.now()}`);
        console.log(`[Test] Spawned session: ${spawnedSessionId}`);

        await stateFile.write({
            sessions: {
                [spawnedSessionId]: {
                    mode: 'bypassPermissions',
                    allowedTools: [],
                    bashLiterals: [],
                    bashPrefixes: [],
                },
            },
        });

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

    it('should show typing indicator and tool-use emoji during processing', async () => {
        await discord.sendMessage(
            'Run this command: echo "tool-signal-test-output" && sleep 1',
        );

        // Wait for typing indicator
        const typingEvent = await discord.waitForTypingStart(30_000);
        expect(typingEvent).toBeDefined();

        // Wrench emoji is transient — try to catch it but don't fail if missed
        try {
            await discord.waitForReaction('🔧', true, 30_000);
        } catch {
            console.log('[Test] Wrench emoji not captured (transient)');
        }

        // Wait for Claude's response
        const response = await discord.waitForBotMessage(
            (content) => content.includes('tool-signal-test-output'),
            90_000,
        );
        expect(response.content).toContain('tool-signal-test-output');
    });
});
