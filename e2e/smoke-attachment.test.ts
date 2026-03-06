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

        const response = await discord.waitForBotMessage(
            (content) => content.includes('ATTACH_E2E_OK'),
            90_000,
        );

        expect(response.content).toContain('ATTACH_E2E_OK');
    });

    it('should upload a PNG image and Claude should describe it', async () => {
        // Minimal valid 1x1 red PNG (67 bytes)
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
            'base64',
        );

        await discord.sendMessageWithFiles(
            'I attached a PNG image. Use the Read tool to view it and describe what you see. Mention the word "image" in your reply.',
            [{ content: png, name: 'red-pixel.png' }],
        );

        const response = await discord.waitForBotMessage(
            (content) => content.toLowerCase().includes('image') || content.toLowerCase().includes('pixel') || content.toLowerCase().includes('red'),
            90_000,
        );

        expect(response.content.toLowerCase()).toMatch(/image|pixel|red|png/);
    });

    it('should upload a PDF and Claude should read its content', async () => {
        // Minimal valid PDF with text "PDF_MARKER_E2E"
        const pdfContent = [
            '%PDF-1.0',
            '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
            '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
            '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
            '4 0 obj<</Length 44>>stream',
            'BT /F1 12 Tf 100 700 Td (PDF_MARKER_E2E) Tj ET',
            'endstream endobj',
            '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
            'xref',
            '0 6',
            '0000000000 65535 f ',
            '0000000009 00000 n ',
            '0000000058 00000 n ',
            '0000000115 00000 n ',
            '0000000266 00000 n ',
            '0000000360 00000 n ',
            'trailer<</Size 6/Root 1 0 R>>',
            'startxref',
            '430',
            '%%EOF',
        ].join('\n');

        await discord.sendMessageWithFiles(
            'I attached a PDF file. Read it and tell me the marker text inside. Reply with just the marker.',
            [{ content: Buffer.from(pdfContent, 'utf-8'), name: 'test-doc.pdf' }],
        );

        const response = await discord.waitForBotMessage(
            (content) => content.includes('PDF_MARKER_E2E'),
            90_000,
        );

        expect(response.content).toContain('PDF_MARKER_E2E');
    });
});
