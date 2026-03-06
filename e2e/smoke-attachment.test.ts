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

describe('Smoke: Attachment Upload', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        await daemon.connect();
        spawnedSessionId = await daemon.spawnSession(`/tmp/e2e-session-attach-${Date.now()}`);
        console.log(`[Test] Spawned session: ${spawnedSessionId}`);

        // bypassPermissions so bash (mkdir) and writeFile RPCs are auto-approved
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
        discord.destroy();
        if (spawnedSessionId) {
            await daemon.stopSession(spawnedSessionId).catch(() => {});
        }
        await stateFile.clean();
    });

    it('should upload a text file attachment and Claude should read it', async () => {
        const fileContent = Buffer.from('Hello from E2E attachment test!\nLine 2: success marker ATTACH_E2E_OK', 'utf-8');

        await discord.sendMessageWithFiles(
            'I attached a text file. Read it with the Read tool and tell me what the success marker says. Reply with just the marker text.',
            [{ content: fileContent, name: 'test-note.txt' }],
        );

        // Bot should forward message with [Attached file: ...] hint
        // Then Claude reads the file and responds with the marker
        const response = await discord.waitForBotMessage(
            (content) => content.includes('ATTACH_E2E_OK'),
            90_000,
        );

        expect(response.content).toContain('ATTACH_E2E_OK');
    });
});
