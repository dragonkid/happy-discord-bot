import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordBot } from '../bot.js';

// --- Mock discord.js ---
const mockReactionUsers = { remove: vi.fn().mockResolvedValue(undefined) };
const mockReaction = { users: mockReactionUsers };
const mockReactions = { resolve: vi.fn().mockReturnValue(mockReaction) };
const mockFetchedMessage = {
    react: vi.fn().mockResolvedValue(undefined),
    reactions: mockReactions,
    edit: vi.fn().mockResolvedValue(undefined),
    pin: vi.fn().mockResolvedValue(undefined),
    unpin: vi.fn().mockResolvedValue(undefined),
};

const mockChannel = {
    id: 'channel-1',
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
    rest: {
        delete: vi.fn().mockResolvedValue(undefined),
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
            expect(mockChannel.send.mock.calls.length).toBeGreaterThanOrEqual(2);
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
        it('calls REST delete to remove bot reaction', async () => {
            await bot.start();
            await bot.removeReaction('msg-123', '🤔');
            expect(mockClient.rest.delete).toHaveBeenCalledWith(
                `/channels/${mockChannel.id}/messages/msg-123/reactions/${encodeURIComponent('🤔')}/@me`,
            );
        });
    });

    describe('editMessage', () => {
        it('fetches message and calls edit with new content', async () => {
            await bot.start();
            await bot.editMessage('msg-1', 'updated text');
            expect(mockChannel.messages.fetch).toHaveBeenCalledWith('msg-1');
            expect(mockFetchedMessage.edit).toHaveBeenCalledWith({ content: 'updated text' });
        });
    });

    describe('pinMessage', () => {
        it('fetches message and calls pin()', async () => {
            await bot.start();
            await bot.pinMessage('msg-1');
            expect(mockChannel.messages.fetch).toHaveBeenCalledWith('msg-1');
            expect(mockFetchedMessage.pin).toHaveBeenCalled();
        });
    });

    describe('unpinMessage', () => {
        it('fetches message and calls unpin()', async () => {
            await bot.start();
            await bot.unpinMessage('msg-1');
            expect(mockChannel.messages.fetch).toHaveBeenCalledWith('msg-1');
            expect(mockFetchedMessage.unpin).toHaveBeenCalled();
        });
    });

    describe('createThread', () => {
        it('sends anchor message and creates thread', async () => {
            const mockThread = { id: 'thread-1', send: vi.fn() };
            const mockAnchorMsg = {
                id: 'anchor-1',
                startThread: vi.fn().mockResolvedValue(mockThread),
            };
            mockChannel.send.mockResolvedValueOnce(mockAnchorMsg);

            await bot.start();
            const threadId = await bot.createThread('my-session @ macbook');
            expect(mockChannel.send).toHaveBeenCalledWith('--- my-session @ macbook ---');
            expect(mockAnchorMsg.startThread).toHaveBeenCalledWith({
                name: 'my-session @ macbook',
            });
            expect(threadId).toBe('thread-1');
        });
    });

    describe('sendToThread', () => {
        it('fetches thread channel and sends chunked text', async () => {
            const mockThreadChannel = {
                send: vi.fn().mockResolvedValue({ id: 'tmsg-1' }),
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            const msgs = await bot.sendToThread('thread-1', 'hello');
            expect(mockClient.channels.fetch).toHaveBeenCalledWith('thread-1');
            expect(mockThreadChannel.send).toHaveBeenCalledWith('hello');
            expect(msgs).toHaveLength(1);
        });
    });

    describe('sendToThreadWithButtons', () => {
        it('sends message with buttons to thread', async () => {
            const mockThreadChannel = {
                send: vi.fn().mockResolvedValue({ id: 'tmsg-1' }),
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            const rows = [{ type: 'row' }];
            await bot.sendToThreadWithButtons('thread-1', 'Pick', rows as any);
            expect(mockThreadChannel.send).toHaveBeenCalledWith({
                content: 'Pick',
                components: rows,
            });
        });
    });

    describe('sendToThreadWithAttachment', () => {
        it('sends attachment with buttons to thread', async () => {
            const mockThreadChannel = {
                send: vi.fn().mockResolvedValue({ id: 'tmsg-1' }),
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            const rows = [{ type: 'row' }];
            const buf = Buffer.from('data');
            await bot.sendToThreadWithAttachment('thread-1', 'See', buf, 'f.md', rows as any);
            expect(mockThreadChannel.send).toHaveBeenCalledWith(expect.objectContaining({
                content: 'See',
                components: rows,
            }));
        });
    });

    describe('archiveThread', () => {
        it('sets thread archived', async () => {
            const mockThreadChannel = {
                setArchived: vi.fn().mockResolvedValue(undefined),
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            await bot.archiveThread('thread-1');
            expect(mockThreadChannel.setArchived).toHaveBeenCalledWith(true);
        });
    });

    describe('deleteThread', () => {
        it('deletes thread channel', async () => {
            const mockThreadChannel = {
                delete: vi.fn().mockResolvedValue(undefined),
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            await bot.deleteThread('thread-1');
            expect(mockThreadChannel.delete).toHaveBeenCalled();
        });
    });

    describe('sendTypingInThread', () => {
        it('sends typing in thread channel', async () => {
            const mockThreadChannel = {
                sendTyping: vi.fn().mockResolvedValue(undefined),
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            await bot.sendTypingInThread('thread-1');
            expect(mockThreadChannel.sendTyping).toHaveBeenCalled();
        });
    });

    describe('thread operations — reactInThread / removeReactionInThread', () => {
        it('reacts on message within thread', async () => {
            const mockReactionsCache = {
                resolve: vi.fn().mockReturnValue({
                    users: { remove: vi.fn().mockResolvedValue(undefined) },
                }),
            };
            const mockMsg = { react: vi.fn().mockResolvedValue(undefined), reactions: mockReactionsCache };
            const mockThreadChannel = {
                messages: { fetch: vi.fn().mockResolvedValue(mockMsg) },
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            await bot.reactInThread('thread-1', 'msg-1', '🤔');
            expect(mockThreadChannel.messages.fetch).toHaveBeenCalledWith('msg-1');
            expect(mockMsg.react).toHaveBeenCalledWith('🤔');
        });
    });

    describe('editMessageInThread', () => {
        it('edits message in thread', async () => {
            const mockMsg = { edit: vi.fn().mockResolvedValue(undefined) };
            const mockThreadChannel = {
                messages: { fetch: vi.fn().mockResolvedValue(mockMsg) },
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            await bot.editMessageInThread('thread-1', 'msg-1', 'updated');
            expect(mockMsg.edit).toHaveBeenCalledWith({ content: 'updated' });
        });
    });

    describe('pinMessageInThread / unpinMessageInThread', () => {
        it('pins message in thread', async () => {
            const mockMsg = { pin: vi.fn().mockResolvedValue(undefined) };
            const mockThreadChannel = {
                messages: { fetch: vi.fn().mockResolvedValue(mockMsg) },
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            await bot.pinMessageInThread('thread-1', 'msg-1');
            expect(mockMsg.pin).toHaveBeenCalled();
        });

        it('unpins message in thread', async () => {
            const mockMsg = { unpin: vi.fn().mockResolvedValue(undefined) };
            const mockThreadChannel = {
                messages: { fetch: vi.fn().mockResolvedValue(mockMsg) },
                isThread: vi.fn().mockReturnValue(true),
            };

            await bot.start();
            mockClient.channels.fetch.mockResolvedValueOnce(mockThreadChannel);
            await bot.unpinMessageInThread('thread-1', 'msg-1');
            expect(mockMsg.unpin).toHaveBeenCalled();
        });
    });
});
