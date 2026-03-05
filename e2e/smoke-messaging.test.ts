import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BotProcess } from './helpers/bot-process.js';
import { DiscordTestClient } from './helpers/discord-test-client.js';
import { StateFile } from './helpers/state-file.js';
import { loadE2EConfig } from './env.js';

const config = loadE2EConfig();
const bot = new BotProcess();
const discord = new DiscordTestClient(config.discordToken, config.discordChannelId);
const stateFile = new StateFile();

describe('Smoke: Message E2E', () => {
    beforeAll(async () => {
        await stateFile.clean();
        await discord.start();

        // Start bot with test bot's user ID as DISCORD_USER_ID
        await bot.start({
            DISCORD_TOKEN: config.botDiscordToken,
            DISCORD_CHANNEL_ID: config.discordChannelId,
            DISCORD_USER_ID: discord.userId,
        });
    }, 60_000);

    afterAll(async () => {
        await bot.stop();
        discord.destroy();
    });

    it('should forward a message to Claude and receive a response', async () => {
        // Send a simple message that Claude should respond to quickly
        await discord.sendMessage('Reply with exactly: PONG');

        // Wait for bot to relay Claude's response
        const response = await discord.waitForBotMessage(
            (content) => content.toLowerCase().includes('pong'),
            90_000,
        );

        expect(response.content.toLowerCase()).toContain('pong');
    });
});
