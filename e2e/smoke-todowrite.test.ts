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

describe('Smoke: TodoWrite Progress Display', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-todo-${Date.now()}`);
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

    it('should display todo progress and update when all tasks completed', async () => {
        // Step 1: Ask Claude to create a mixed-status todo list
        await discord.sendMessage(
            'Use the TodoWrite tool to create a todo list with these 3 items: "Read file" (completed), "Edit file" (in_progress), "Run tests" (pending). Do not do anything else.',
        );

        const todoMsg = await discord.waitForBotMessage(
            (content) => content.includes('📋 Tasks'),
            90_000,
        );

        expect(todoMsg.content).toContain('📋 Tasks');
        expect(todoMsg.content).toContain('```');

        // Step 2: Ask Claude to mark all tasks as completed
        await discord.sendMessage(
            'Use the TodoWrite tool again to update the same todo list, but now mark ALL 3 items as completed. Do not do anything else.',
        );

        // Wait for the same message to be edited with all tasks completed
        const edited = await discord.waitForMessageEdit(
            todoMsg.id,
            (content) => content.includes('3/3'),
            90_000,
        );

        expect(edited.content).toContain('📋 Tasks (3/3)');
    });
});
