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

function extractFirstOptionLabel(msg: Message): string | null {
    for (const row of msg.components) {
        const actionRow = row as unknown as { components?: Array<{ label?: string }> };
        if (!actionRow.components) continue;
        for (const component of actionRow.components) {
            if (component.label) return component.label;
        }
    }
    return null;
}

describe('Smoke: AskUserQuestion', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();
        await happy.start();

        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-ask-${Date.now()}`);
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

    it('should show AskUserQuestion options and accept the answer', async () => {
        await discord.sendMessage(
            'Use the AskUserQuestion tool to ask me: "Which format?" with options "JSON" and "YAML". Then tell me what I chose.',
        );

        const buttonMsg = await discord.waitForMessageWithButtons(60_000);
        expect(buttonMsg.components.length).toBeGreaterThan(0);

        const requestId = extractRequestId(buttonMsg, 'ask');
        expect(requestId).toBeTruthy();

        const firstLabel = extractFirstOptionLabel(buttonMsg);
        expect(firstLabel).toBeTruthy();

        await happy.approvePermission(spawnedSessionId!, requestId!, {
            answers: { Format: firstLabel! },
        });

        const response = await discord.waitForBotMessage(
            (content) => content.toLowerCase().includes(firstLabel!.toLowerCase()),
            90_000,
        );
        expect(response.content.toLowerCase()).toContain(firstLabel!.toLowerCase());
    });
});
