import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordBot } from '../bot.js';

// --- Mock discord.js ---
const mockReactionUsers = { remove: vi.fn().mockResolvedValue(undefined) };
const mockReaction = { users: mockReactionUsers };
const mockReactions = { resolve: vi.fn().mockReturnValue(mockReaction) };
const mockFetchedMessage = {
    react: vi.fn().mockResolvedValue(undefined),
    reactions: mockReactions,
};

const mockChannel = {
    send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    messages: { fetch: vi.fn().mockResolvedValue(mockFetchedMessage) },
    isTextBased: vi.fn().mockReturnValue(true),
};

const mockClient = {
    on: vi.fn(),
    login: vi.fn().mockResolvedValue('token'),
    destroy: vi.fn(),
    channels: {
        fetch: vi.fn().mockResolvedValue(mockChannel),
    },
    user: { tag: 'TestBot#1234', id: 'bot-user-id' },
};

vi.mock('discord.js', () => ({
    Client: vi.fn(function () { return mockClient; }),
    GatewayIntentBits: { Guilds: 1, GuildMessages: 512, MessageContent: 32768 },
    Events: {
        ClientReady: 'ready',
        InteractionCreate: 'interactionCreate',
        MessageCreate: 'messageCreate',
    },
    ChannelType: { GuildText: 0 },
    AttachmentBuilder: vi.fn(function (this: any, content: any, opts: any) {
        this.content = content;
        this.name = opts?.name;
    }),
}));

describe('DiscordBot', () => {
    let bot: DiscordBot;

    beforeEach(() => {
        vi.clearAllMocks();
        bot = new DiscordBot({ token: 'test-token', channelId: 'ch-1', userId: 'u-1' });
    });

    describe('start', () => {
        it('calls client.login with token', async () => {
            await bot.start();
            expect(mockClient.login).toHaveBeenCalledWith('test-token');
        });

        it('fetches the target channel', async () => {
            await bot.start();
            expect(mockClient.channels.fetch).toHaveBeenCalledWith('ch-1');
        });

        it('registers interaction handler', async () => {
            await bot.start();
            expect(mockClient.on).toHaveBeenCalledWith('interactionCreate', expect.any(Function));
        });

        it('registers message handler', async () => {
            await bot.start();
            expect(mockClient.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
        });
    });

    describe('send', () => {
        it('sends message to channel', async () => {
            await bot.start();
            await bot.send('hello');
            expect(mockChannel.send).toHaveBeenCalledWith('hello');
        });

        it('throws if not started', async () => {
            await expect(bot.send('hello')).rejects.toThrow('Bot not started');
        });

        it('chunks long messages and sends multiple', async () => {
            await bot.start();
            const long = 'a'.repeat(4000);
            await bot.send(long);
            expect(mockChannel.send).toHaveBeenCalledTimes(2);
        });
    });

    describe('sendWithButtons', () => {
        it('sends message with components', async () => {
            await bot.start();
            const rows = [{ type: 'row' }];
            await bot.sendWithButtons('Pick one', rows as any);
            expect(mockChannel.send).toHaveBeenCalledWith({
                content: 'Pick one',
                components: rows,
            });
        });
    });

    describe('sendWithAttachmentAndButtons', () => {
        it('sends message with file attachment and components', async () => {
            await bot.start();
            const rows = [{ type: 'row' }];
            const fileContent = Buffer.from('file data');
            await bot.sendWithAttachmentAndButtons('See attached', fileContent, 'log.txt', rows as any);
            expect(mockChannel.send).toHaveBeenCalledWith({
                content: 'See attached',
                files: [expect.objectContaining({ content: fileContent, name: 'log.txt' })],
                components: rows,
            });
        });
    });

    describe('destroy', () => {
        it('calls client.destroy', async () => {
            await bot.start();
            bot.destroy();
            expect(mockClient.destroy).toHaveBeenCalledOnce();
        });
    });

    describe('sendTyping', () => {
        it('calls channel.sendTyping()', async () => {
            await bot.start();
            await bot.sendTyping();
            expect(mockChannel.sendTyping).toHaveBeenCalledOnce();
        });

        it('throws if not started', async () => {
            await expect(bot.sendTyping()).rejects.toThrow('Bot not started');
        });
    });

    describe('reactToMessage', () => {
        it('fetches message and adds reaction', async () => {
            await bot.start();
            await bot.reactToMessage('msg-123', '🤔');
            expect(mockChannel.messages.fetch).toHaveBeenCalledWith('msg-123');
            expect(mockFetchedMessage.react).toHaveBeenCalledWith('🤔');
        });
    });

    describe('removeReaction', () => {
        it('fetches message and removes bot reaction', async () => {
            await bot.start();
            await bot.removeReaction('msg-123', '🤔');
            expect(mockChannel.messages.fetch).toHaveBeenCalledWith('msg-123');
            expect(mockReactionUsers.remove).toHaveBeenCalledWith(mockClient.user.id);
        });
    });
});
