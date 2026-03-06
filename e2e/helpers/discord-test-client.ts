import {
    Client,
    GatewayIntentBits,
    Events,
    type Message,
    type TextChannel,
    type ThreadChannel,
    ChannelType,
} from 'discord.js';
import { waitFor } from './wait.js';

export class DiscordTestClient {
    private client: Client;
    private channel: TextChannel | null = null;
    private collectedMessages: Message[] = [];
    private typingEvents: Array<{ userId: string; timestamp: Date }> = [];
    private reactionEvents: Array<{ userId: string; emoji: string; messageId: string; added: boolean }> = [];
    private messageUpdateEvents: Array<{ messageId: string; content: string; timestamp: Date }> = [];
    private createdThreads: Array<{ id: string; name: string }> = [];

    constructor(
        private readonly token: string,
        private readonly channelId: string,
    ) {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageTyping,
                GatewayIntentBits.GuildMessageReactions,
            ],
        });
    }

    async start(): Promise<void> {
        this.client.on(Events.MessageCreate, (msg) => {
            // Accept messages from main channel OR its child threads
            const inMainChannel = msg.channelId === this.channelId;
            const inChildThread = msg.channel.isThread() && msg.channel.parentId === this.channelId;
            if (!inMainChannel && !inChildThread) return;
            if (msg.author.id === this.client.user?.id) return;
            this.collectedMessages.push(msg);
        });

        this.client.on(Events.ThreadCreate, (thread) => {
            if (thread.parentId !== this.channelId) return;
            console.log(`[TestClient] Thread created: ${thread.name} (${thread.id})`);
            this.createdThreads.push({ id: thread.id, name: thread.name });
        });

        this.client.on(Events.TypingStart, (typing) => {
            const ch = typing.channel;
            if (ch.id !== this.channelId && !(ch.isThread() && ch.parentId === this.channelId)) return;
            this.typingEvents.push({ userId: typing.user?.id ?? '', timestamp: new Date() });
        });

        this.client.on(Events.MessageReactionAdd, (reaction, user) => {
            const ch = reaction.message.channel;
            if (ch.id !== this.channelId && !(ch.isThread() && ch.parentId === this.channelId)) return;
            this.reactionEvents.push({
                userId: user.id,
                emoji: reaction.emoji.name ?? '',
                messageId: reaction.message.id,
                added: true,
            });
        });

        this.client.on(Events.MessageReactionRemove, (reaction, user) => {
            const ch = reaction.message.channel;
            if (ch.id !== this.channelId && !(ch.isThread() && ch.parentId === this.channelId)) return;
            this.reactionEvents.push({
                userId: user.id,
                emoji: reaction.emoji.name ?? '',
                messageId: reaction.message.id,
                added: false,
            });
        });

        this.client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
            const ch = newMsg.channel;
            if (ch.id !== this.channelId && !(ch.isThread() && ch.parentId === this.channelId)) return;
            if (newMsg.author?.id === this.client.user?.id) return;
            this.messageUpdateEvents.push({
                messageId: newMsg.id,
                content: newMsg.content ?? '',
                timestamp: new Date(),
            });
        });

        await this.client.login(this.token);

        const ch = await this.client.channels.fetch(this.channelId);
        if (!ch || ch.type !== ChannelType.GuildText) {
            throw new Error(`Channel ${this.channelId} is not a text channel`);
        }
        this.channel = ch as TextChannel;
        console.log('[TestClient] Connected to Discord');
    }

    async sendMessage(text: string): Promise<Message> {
        if (!this.channel) throw new Error('Not connected');
        const msg = await this.channel.send(text);
        console.log(`[TestClient] Sent: "${text}"`);
        return msg;
    }

    async sendMessageWithFiles(
        text: string,
        files: Array<{ content: Buffer; name: string }>,
    ): Promise<Message> {
        if (!this.channel) throw new Error('Not connected');
        const msg = await this.channel.send({
            content: text,
            files: files.map((f) => ({ attachment: f.content, name: f.name })),
        });
        const names = files.map((f) => f.name).join(', ');
        console.log(`[TestClient] Sent: "${text}" with files: [${names}]`);
        return msg;
    }

    async waitForBotMessage(
        predicate: (content: string, msg: Message) => boolean,
        timeout = 60_000,
    ): Promise<Message> {
        const baseline = this.collectedMessages.length;

        return waitFor(
            () => {
                const newMsgs = this.collectedMessages.slice(baseline);
                return newMsgs.find((m) => predicate(m.content, m));
            },
            {
                timeout,
                interval: 1000,
                label: 'bot message',
                context: () => {
                    const recent = this.collectedMessages.slice(-5);
                    return `Recent messages:\n${recent.map((m) => `  [${m.author.username}] ${m.content.slice(0, 100)}`).join('\n')}`;
                },
            },
        );
    }

    async waitForMessageWithButtons(timeout = 30_000): Promise<Message> {
        const baseline = this.collectedMessages.length;

        return waitFor(
            () => {
                const newMsgs = this.collectedMessages.slice(baseline);
                return newMsgs.find((m) => m.components.length > 0);
            },
            {
                timeout,
                interval: 1000,
                label: 'message with buttons',
            },
        );
    }

    async waitForTypingStart(timeout = 30_000): Promise<{ userId: string; timestamp: Date }> {
        const baseline = this.typingEvents.length;
        return waitFor(
            () => this.typingEvents.slice(baseline).find(e => e.userId !== this.client.user?.id),
            { timeout, interval: 500, label: 'typing start' },
        );
    }

    async waitForReaction(emoji: string, added: boolean, timeout = 30_000): Promise<void> {
        const baseline = this.reactionEvents.length;
        await waitFor(
            () => this.reactionEvents.slice(baseline).find(
                e => e.emoji === emoji && e.added === added && e.userId !== this.client.user?.id,
            ),
            { timeout, interval: 500, label: `reaction ${added ? 'add' : 'remove'} ${emoji}` },
        );
    }

    async waitForMessageEdit(
        messageId: string,
        predicate: (content: string) => boolean,
        timeout = 60_000,
    ): Promise<{ content: string }> {
        const baseline = this.messageUpdateEvents.length;
        return waitFor(
            () => this.messageUpdateEvents.slice(baseline).find(
                (e) => e.messageId === messageId && predicate(e.content),
            ),
            { timeout, interval: 1000, label: `message edit on ${messageId}` },
        );
    }

    async waitForThread(
        predicate: (thread: { name: string; id: string }) => boolean,
        timeout = 30_000,
    ): Promise<{ name: string; id: string }> {
        return waitFor(
            () => this.createdThreads.find(predicate),
            { timeout, interval: 1000, label: 'thread creation' },
        );
    }

    getLatestThread(): { name: string; id: string } | undefined {
        return this.createdThreads[this.createdThreads.length - 1];
    }

    async sendMessageInThread(threadId: string, text: string): Promise<Message> {
        const thread = await this.client.channels.fetch(threadId);
        if (!thread?.isThread()) throw new Error(`Channel ${threadId} is not a thread`);
        const msg = await (thread as ThreadChannel).send(text);
        console.log(`[TestClient] Sent to thread ${threadId}: "${text}"`);
        return msg;
    }

    async waitForBotMessageInThread(
        threadId: string,
        predicate: (content: string, msg: Message) => boolean,
        timeout = 60_000,
    ): Promise<Message> {
        const baseline = this.collectedMessages.length;
        return waitFor(
            () => {
                const newMsgs = this.collectedMessages.slice(baseline);
                return newMsgs.find((m) => m.channelId === threadId && predicate(m.content, m));
            },
            {
                timeout,
                interval: 1000,
                label: 'bot message in thread',
                context: () => {
                    const recent = this.collectedMessages.slice(-5);
                    return `Recent messages:\n${recent.map((m) => `  [${m.author.username}@${m.channelId.slice(0, 8)}] ${m.content.slice(0, 100)}`).join('\n')}`;
                },
            },
        );
    }

    clearMessages(): void {
        this.collectedMessages = [];
        this.typingEvents = [];
        this.reactionEvents = [];
        this.messageUpdateEvents = [];
        this.createdThreads = [];
    }

    get userId(): string {
        if (!this.client.user) throw new Error('Not connected — call start() first');
        return this.client.user.id;
    }

    destroy(): void {
        this.client.destroy();
        this.channel = null;
    }
}
