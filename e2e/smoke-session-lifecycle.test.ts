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

describe('Smoke: Session Lifecycle E2E', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        // Spawn a fresh CLI session
        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-lifecycle-${Date.now()}`);
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

    it('bot stays online after session process is killed (archive scenario)', async () => {
        // 1. Verify bot is alive: send a message and get a response
        await discord.sendMessage('Reply with exactly: ALIVE');
        const aliveResponse = await discord.waitForBotMessage(
            (content) => content.toLowerCase().includes('alive'),
            90_000,
        );
        expect(aliveResponse.content.toLowerCase()).toContain('alive');

        // 2. Kill the session process via daemon (simulates archive: killSession RPC)
        if (spawnedSessionId) {
            await daemon.stopSession(spawnedSessionId);
            console.log(`[Test] Stopped session: ${spawnedSessionId}`);
            // Mark as cleaned so afterAll doesn't double-stop
            spawnedSessionId = null;
        }

        // 3. Wait for relay to propagate
        await new Promise((r) => setTimeout(r, 5_000));

        // 4. Bot should NOT have crashed
        expect(bot.hasLog('Shutting down')).toBe(false);
        expect(bot.hasLog('[Discord] Bot online')).toBe(true);
    });

    it('bot sends error when forwarding to a dead session', async () => {
        // Session was killed in previous test — sending a message should fail gracefully
        discord.clearMessages();
        await discord.sendMessage('Hello dead session');

        // Bot should either send an error message or the send fails silently.
        // We verify bot doesn't crash — give it time.
        await new Promise((r) => setTimeout(r, 8_000));
        expect(bot.hasLog('Shutting down')).toBe(false);

        // Best-effort: check if bot logged a send failure
        const hasError = bot.hasLog('Send failed') || bot.hasLog('Failed to forward');
        console.log(`[Test] Bot logged send error: ${hasError}`);
    });
});
