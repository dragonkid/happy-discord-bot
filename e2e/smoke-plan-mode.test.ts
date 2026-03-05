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

describe('Smoke: ExitPlanMode', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();
        await happy.start();

        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-plan-${Date.now()}`);
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

    it('should show plan with approve/reject buttons and handle reject with feedback', async () => {
        // Use explicit tool name to avoid Claude invoking the plan skill instead
        await discord.sendMessage(
            'Call the EnterPlanMode tool now. Then plan: create file /tmp/e2e-plan-test.txt with "hello". Keep it to 2 steps max.',
        );

        // Wait for plan message with buttons
        const planMsg = await discord.waitForMessageWithButtons(90_000);
        expect(planMsg.components.length).toBeGreaterThan(0);

        const requestId = extractRequestId(planMsg, 'plan');
        expect(requestId).toBeTruthy();

        // Reject with feedback
        await happy.denyPermission(spawnedSessionId!, requestId!, 'Add error handling to the plan');

        // Wait for Claude to send a revised plan
        discord.clearMessages();
        const revisedPlanMsg = await discord.waitForMessageWithButtons(90_000);
        const revisedRequestId = extractRequestId(revisedPlanMsg, 'plan');
        expect(revisedRequestId).toBeTruthy();

        // Approve the revised plan
        await happy.approvePermission(spawnedSessionId!, revisedRequestId!);

        // Wait for Claude to proceed with implementation
        const response = await discord.waitForBotMessage(
            (content) =>
                content.includes('e2e-plan-test')
                || content.toLowerCase().includes('created')
                || content.toLowerCase().includes('done'),
            90_000,
        );
        expect(response).toBeDefined();
    });
});
