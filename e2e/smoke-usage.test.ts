import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotProcess } from './helpers/bot-process.js';
import { DiscordTestClient } from './helpers/discord-test-client.js';
import { StateFile } from './helpers/state-file.js';
import { DaemonClient } from './helpers/daemon-client.js';
import { loadE2EConfig } from './env.js';
import { loadConfig } from '../src/vendor/config.js';
import { readCredentials } from '../src/vendor/credentials.js';
import { queryUsage } from '../src/happy/usage.js';
import { HappyClient } from '../src/happy/client.js';

const config = loadE2EConfig();
const bot = new BotProcess();
const discord = new DiscordTestClient(config.discordToken, config.discordChannelId);
const stateFile = new StateFile(join(tmpdir(), 'happy-discord-bot-e2e'));
const daemon = new DaemonClient();

let spawnedSessionId: string | null = null;
let happyClient: HappyClient;

describe('Smoke: Usage Data Pipeline E2E', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        // Set up a HappyClient for direct API calls
        const happyConfig = loadConfig();
        const credentials = readCredentials(happyConfig);
        if (!credentials) throw new Error('No Happy credentials found');
        happyClient = new HappyClient(happyConfig, credentials);

        // Spawn a fresh CLI session
        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-usage-${Date.now()}`);
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
        discord.destroy();
        if (spawnedSessionId) {
            await daemon.stopSession(spawnedSessionId).catch(() => {});
        }
        await stateFile.clean();
    });

    it('relay has usage data after Claude processes a message', async () => {
        // Send a message to trigger Claude processing (generates usage data)
        await discord.sendMessage('Reply with exactly: USAGE-TEST-OK');

        await discord.waitForBotMessage(
            (content) => content.toLowerCase().includes('usage-test-ok'),
            90_000,
        );

        // Query usage data for this session from relay REST API
        // Usage reports are sent asynchronously — allow a brief window
        let result = await queryUsage(happyClient, { sessionId: spawnedSessionId! });

        // Retry once if usage data hasn't arrived yet
        if (result.usage.length === 0) {
            await new Promise((r) => setTimeout(r, 5_000));
            result = await queryUsage(happyClient, { sessionId: spawnedSessionId! });
        }

        expect(result.usage.length).toBeGreaterThan(0);
        expect(result.usage[0].tokens.total).toBeGreaterThan(0);
        expect(result.usage[0].cost.total).toBeGreaterThan(0);
        console.log(`[Test] Usage: ${result.usage[0].tokens.total} tokens, $${result.usage[0].cost.total.toFixed(4)}`);
    });
});
