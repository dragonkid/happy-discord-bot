import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotProcess } from './helpers/bot-process.js';
import { DiscordTestClient } from './helpers/discord-test-client.js';
import { StateFile } from './helpers/state-file.js';
import { DaemonClient } from './helpers/daemon-client.js';
import { loadE2EConfig } from './env.js';

/**
 * Regression test for message routing bug:
 * When multiple sessions exist, messages sent in a thread must be routed
 * to that thread's bound session — not to whichever session happens to be
 * "active" at the time.
 */

const config = loadE2EConfig();
const bot = new BotProcess();
const discord = new DiscordTestClient(config.discordToken, config.discordChannelId);
const stateFile = new StateFile(join(tmpdir(), 'happy-discord-bot-e2e-routing'));
const daemon = new DaemonClient();

let sessionIdA: string | null = null;
let sessionIdB: string | null = null;
let sessionDirA: string;
let sessionDirB: string;

describe('Smoke: Thread Message Routing (multi-session)', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();
        await daemon.connect();

        // Spawn two independent sessions
        sessionDirA = `e2e-routing-a-${Date.now()}`;
        sessionDirB = `e2e-routing-b-${Date.now()}`;

        sessionIdA = await daemon.spawnSession(`/tmp/${sessionDirA}`);
        // Small delay so sessions get distinct timestamps
        await new Promise((r) => setTimeout(r, 2_000));
        sessionIdB = await daemon.spawnSession(`/tmp/${sessionDirB}`);

        console.log(`[Test] Session A: ${sessionIdA}`);
        console.log(`[Test] Session B: ${sessionIdB}`);

        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
            BOT_STATE_DIR: stateFile.stateDir,
        });

        // Wait for both threads to be created
        await discord.waitForThread((t) => t.name.includes(sessionDirA), 20_000);
        await discord.waitForThread((t) => t.name.includes(sessionDirB), 20_000);

        // Let sessions settle
        await new Promise((r) => setTimeout(r, 3_000));
    }, 120_000);

    afterAll(async () => {
        await bot.stop();
        for (const thread of discord.getCreatedThreads()) {
            await discord.deleteThread(thread.id).catch(() => {});
        }
        discord.destroy();
        if (sessionIdA) await daemon.stopSession(sessionIdA).catch(() => {});
        if (sessionIdB) await daemon.stopSession(sessionIdB).catch(() => {});
        await stateFile.clean();
    });

    it('routes reply to thread A when message sent in thread A', async () => {
        const threadA = discord.findThread((t) => t.name.includes(sessionDirA));
        expect(threadA).toBeDefined();

        discord.clearMessages();
        await discord.sendMessageInThread(threadA!.id, 'Reply with exactly: THREAD-A-REPLY');

        const response = await discord.waitForBotMessageInThread(
            threadA!.id,
            (content) => content.toLowerCase().includes('thread-a-reply'),
            90_000,
        );

        expect(response.channelId).toBe(threadA!.id);
        expect(response.content.toLowerCase()).toContain('thread-a-reply');
    });

    it('routes reply to thread B when message sent in thread B', async () => {
        const threadB = discord.findThread((t) => t.name.includes(sessionDirB));
        expect(threadB).toBeDefined();

        discord.clearMessages();
        await discord.sendMessageInThread(threadB!.id, 'Reply with exactly: THREAD-B-REPLY');

        const response = await discord.waitForBotMessageInThread(
            threadB!.id,
            (content) => content.toLowerCase().includes('thread-b-reply'),
            90_000,
        );

        expect(response.channelId).toBe(threadB!.id);
        expect(response.content.toLowerCase()).toContain('thread-b-reply');
    });

    it('does not cross-contaminate: reply to A stays in A while B is active', async () => {
        const threadA = discord.findThread((t) => t.name.includes(sessionDirA));
        const threadB = discord.findThread((t) => t.name.includes(sessionDirB));
        expect(threadA).toBeDefined();
        expect(threadB).toBeDefined();

        // Send to B first to make B the "active" session
        discord.clearMessages();
        await discord.sendMessageInThread(threadB!.id, 'Reply with exactly: ACTIVATE-B');
        await discord.waitForBotMessageInThread(
            threadB!.id,
            (content) => content.toLowerCase().includes('activate-b'),
            90_000,
        );

        // Now send to A — reply must go to A, not B
        discord.clearMessages();
        await discord.sendMessageInThread(threadA!.id, 'Reply with exactly: CROSS-CHECK-A');

        const response = await discord.waitForBotMessageInThread(
            threadA!.id,
            (content) => content.toLowerCase().includes('cross-check-a'),
            90_000,
        );

        expect(response.channelId).toBe(threadA!.id);
        expect(response.content.toLowerCase()).toContain('cross-check-a');
    });
});
