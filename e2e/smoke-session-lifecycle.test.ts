import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotProcess } from './helpers/bot-process.js';
import { DiscordTestClient } from './helpers/discord-test-client.js';
import { StateFile } from './helpers/state-file.js';
import { DaemonClient } from './helpers/daemon-client.js';
import { HappyTestClient } from './helpers/happy-test-client.js';
import { loadE2EConfig } from './env.js';

const config = loadE2EConfig();
const bot = new BotProcess();
const discord = new DiscordTestClient(config.discordToken, config.discordChannelId);
const stateFile = new StateFile(join(tmpdir(), 'happy-discord-bot-e2e'));
const daemon = new DaemonClient();
const happy = new HappyTestClient();

let sessionId: string | null = null;

describe('Smoke: Session Lifecycle E2E', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();
        await daemon.connect();
        await happy.start();
    }, 120_000);

    afterAll(async () => {
        await bot.stop();
        discord.destroy();
        happy.close();
        if (sessionId) {
            await daemon.stopSession(sessionId).catch(() => {});
        }
        await stateFile.clean();
    });

    // --- Archive scenario (冒烟 #1, #2, #5, #14) ---

    it('archive: killSession stops CLI but bot stays online', async () => {
        // Spawn session + start bot
        sessionId = await daemon.spawnSession(`/tmp/e2e-lifecycle-archive-${Date.now()}`);
        console.log(`[Test] Spawned session: ${sessionId}`);
        await happy.registerSession(sessionId);

        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
            BOT_STATE_DIR: stateFile.stateDir,
        });
        await bot.waitForLog('[Bridge] Active session:', 15_000);

        // Verify bot is alive
        await discord.sendMessage('Reply with exactly: ALIVE');
        const alive = await discord.waitForBotMessage(
            (c) => c.toLowerCase().includes('alive'),
            90_000,
        );
        expect(alive.content.toLowerCase()).toContain('alive');

        // Kill session via sessionRPC (same as /archive handler)
        await happy.killSession(sessionId);
        sessionId = null; // already killed

        // Bot should NOT crash
        await new Promise((r) => setTimeout(r, 5_000));
        expect(bot.hasLog('Shutting down')).toBe(false);
    });

    it('archive: sending message to killed session does not crash bot', async () => {
        // Session was killed in previous test — bot still running
        discord.clearMessages();
        await discord.sendMessage('Hello dead session');

        // Wait — bot should not crash
        await new Promise((r) => setTimeout(r, 8_000));
        expect(bot.hasLog('Shutting down')).toBe(false);

        // Stop bot for next scenario
        await bot.stop();
    });

    // --- Delete scenario (冒烟 #6-confirm, #9, #13, #14) ---

    it('delete: REST API removes session and bot survives restart', async () => {
        // Spawn a new session
        sessionId = await daemon.spawnSession(`/tmp/e2e-lifecycle-delete-${Date.now()}`);
        console.log(`[Test] Spawned session for delete: ${sessionId}`);

        // Start bot, wait for it to pick up the session
        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
            BOT_STATE_DIR: stateFile.stateDir,
        });
        await bot.waitForLog('[Bridge] Active session:', 15_000);

        // Verify session exists via API
        const beforeIds = await happy.listSessionIds();
        expect(beforeIds).toContain(sessionId);

        // Delete session via REST API (same as /delete confirm handler)
        await happy.deleteSession(sessionId);

        // Verify session is gone
        const afterIds = await happy.listSessionIds();
        expect(afterIds).not.toContain(sessionId);
        sessionId = null; // already deleted

        // Bot should not crash after its active session is deleted
        await new Promise((r) => setTimeout(r, 3_000));
        expect(bot.hasLog('Shutting down')).toBe(false);
    });

    it('delete: sending message after session deletion does not crash bot', async () => {
        // Active session was deleted — bot still running
        discord.clearMessages();
        await discord.sendMessage('Hello deleted session');

        await new Promise((r) => setTimeout(r, 8_000));
        expect(bot.hasLog('Shutting down')).toBe(false);

        await bot.stop();
    });

    // --- Cross scenario (冒烟 #13: archive then delete) ---

    it('archive then delete: killed session can still be deleted via API', async () => {
        // Spawn session + start bot (CLI must be online for killSession RPC)
        sessionId = await daemon.spawnSession(`/tmp/e2e-lifecycle-cross-${Date.now()}`);
        console.log(`[Test] Spawned session for cross test: ${sessionId}`);
        await happy.registerSession(sessionId);

        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
            BOT_STATE_DIR: stateFile.stateDir,
        });
        await bot.waitForLog('[Bridge] Active session:', 15_000);

        // Archive: kill via RPC (requires CLI process online)
        await happy.killSession(sessionId);

        // Delete via REST API — should succeed even after kill
        await happy.deleteSession(sessionId);

        // Session should be gone
        const idsAfterDelete = await happy.listSessionIds();
        expect(idsAfterDelete).not.toContain(sessionId);
        sessionId = null;

        await bot.stop();
    });
});
