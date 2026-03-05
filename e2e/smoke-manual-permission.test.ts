import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from 'discord.js';
import { BotProcess } from './helpers/bot-process.js';
import { DiscordTestClient } from './helpers/discord-test-client.js';
import { HappyTestClient } from './helpers/happy-test-client.js';
import { StateFile } from './helpers/state-file.js';
import { DaemonClient } from './helpers/daemon-client.js';
import { loadE2EConfig } from './env.js';

const config = loadE2EConfig();
const bot = new BotProcess();
const discord = new DiscordTestClient(config.discordToken, config.discordChannelId);
const stateFile = new StateFile(join(tmpdir(), 'happy-discord-bot-e2e'));
const daemon = new DaemonClient();
const happy = new HappyTestClient();

let spawnedSessionId: string | null = null;

/** Extract requestId from button custom_id with a given prefix (e.g. 'perm', 'ask', 'plan') */
function extractRequestId(msg: Message, prefix: string): string | null {
    for (const row of msg.components) {
        const actionRow = row as unknown as { components?: Array<{ customId?: string }> };
        if (!actionRow.components) continue;
        for (const component of actionRow.components) {
            if (component.customId) {
                const parts = component.customId.split(':');
                if (parts[0] === prefix && parts.length >= 4) return parts[2];
            }
        }
    }
    return null;
}

describe('Smoke: Manual Permission Approval', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();
        await happy.start();

        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-manual-perm-${Date.now()}`);
        console.log(`[Test] Spawned session: ${spawnedSessionId}`);

        await happy.registerSession(spawnedSessionId);

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
        happy.close();
        if (spawnedSessionId) {
            await daemon.stopSession(spawnedSessionId).catch(() => {});
        }
        await stateFile.clean();
    });

    it('should show permission buttons and approve via RPC', async () => {
        // Use a command that Claude Code won't auto-approve (write to disk via bash)
        await discord.sendMessage('Run this bash command: cat > /tmp/e2e-manual-perm-test.txt <<< "manual-perm-ok"');

        const buttonMsg = await discord.waitForMessageWithButtons(60_000);
        expect(buttonMsg.components.length).toBeGreaterThan(0);

        const requestId = extractRequestId(buttonMsg, 'perm');
        expect(requestId).toBeTruthy();

        await happy.approvePermission(spawnedSessionId!, requestId!);

        const response = await discord.waitForBotMessage(
            (content) =>
                content.includes('manual-perm')
                || content.includes('created')
                || content.includes('written')
                || content.includes('file'),
            90_000,
        );
        expect(response).toBeDefined();
    });
});
