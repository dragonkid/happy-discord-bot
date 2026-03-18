import {
    Client,
    DiscordAPIError,
    GatewayIntentBits,
    Events,
    AttachmentBuilder,
    type TextChannel,
    type ThreadChannel,
    type Interaction,
    type ActionRowBuilder,
    type ButtonBuilder,
    type Message,
} from 'discord.js';
import { chunkMessage } from './formatter.js';

export interface DiscordConfig {
    token: string;
    channelId: string;
    userId: string;
}

export class DiscordBot {
    private readonly config: DiscordConfig;
    private readonly client: Client;
    private channel: TextChannel | null = null;
    private interactionHandler: ((interaction: Interaction) => void) | null = null;
    private messageHandler: ((message: Message) => void) | null = null;

    constructor(config: DiscordConfig) {
        this.config = config;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });
    }

    /** Set a handler for all interactions (slash commands, buttons). */
    onInteraction(handler: (interaction: Interaction) => void): void {
        this.interactionHandler = handler;
    }

    /** Set a handler for incoming messages. */
    onMessage(handler: (message: Message) => void): void {
        this.messageHandler = handler;
    }

    async start(): Promise<void> {
        this.client.on(Events.InteractionCreate, (interaction) => {
            this.interactionHandler?.(interaction);
        });

        this.client.on(Events.MessageCreate, (message) => {
            this.messageHandler?.(message);
        });

        await this.client.login(this.config.token);
        const ch = await this.client.channels.fetch(this.config.channelId);
        if (!ch || !ch.isTextBased()) {
            throw new Error(`Channel ${this.config.channelId} is not a text channel`);
        }
        this.channel = ch as TextChannel;
    }

    /** Send text to the target channel, auto-chunking if needed. */
    async send(text: string): Promise<Message[]> {
        const channel = this.requireChannel();
        const chunks = chunkMessage(text);
        const messages: Message[] = [];
        for (const chunk of chunks) {
            messages.push(await channel.send(chunk));
        }
        return messages;
    }

    /** Send a message with button action rows. */
    async sendWithButtons(
        text: string,
        components: ActionRowBuilder<ButtonBuilder>[],
    ): Promise<Message> {
        const channel = this.requireChannel();
        return channel.send({ content: text, components });
    }

    /** Send a message with a file attachment and button action rows. */
    async sendWithAttachmentAndButtons(
        text: string,
        fileContent: Buffer,
        fileName: string,
        components: ActionRowBuilder<ButtonBuilder>[],
    ): Promise<Message> {
        const channel = this.requireChannel();
        const attachment = new AttachmentBuilder(fileContent, { name: fileName });
        return channel.send({ content: text, files: [attachment], components });
    }

    /** Send typing indicator to the target channel. */
    async sendTyping(): Promise<void> {
        const channel = this.requireChannel();
        await channel.sendTyping();
    }

    /** Add an emoji reaction to a specific message. */
    async reactToMessage(messageId: string, emoji: string): Promise<void> {
        const channel = this.requireChannel();
        const message = await channel.messages.fetch(messageId);
        await message.react(emoji);
    }

    /** Remove the bot's emoji reaction from a specific message. */
    async removeReaction(messageId: string, emoji: string): Promise<void> {
        const channel = this.requireChannel();
        const encoded = encodeURIComponent(emoji);
        await this.client.rest.delete(
            `/channels/${channel.id}/messages/${messageId}/reactions/${encoded}/@me`,
        ).catch((err: unknown) => {
            if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) return;
            throw err;
        });
    }

    /** Edit an existing message's content. */
    async editMessage(messageId: string, content: string): Promise<void> {
        const channel = this.requireChannel();
        const message = await channel.messages.fetch(messageId);
        await message.edit({ content });
    }

    /** Pin a message in the channel. */
    async pinMessage(messageId: string): Promise<void> {
        const channel = this.requireChannel();
        const message = await channel.messages.fetch(messageId);
        await message.pin();
    }

    /** Unpin a message from the channel. */
    async unpinMessage(messageId: string): Promise<void> {
        const channel = this.requireChannel();
        const message = await channel.messages.fetch(messageId);
        await message.unpin();
    }

    /** Create a thread from an anchor message in the main channel. Returns thread ID. */
    async createThread(name: string): Promise<string> {
        const channel = this.requireChannel();
        const anchor = await channel.send(`--- ${name} ---`);
        const thread = await anchor.startThread({ name });
        return thread.id;
    }

    /** Send text to a thread, auto-chunking if needed. */
    async sendToThread(threadId: string, text: string): Promise<Message[]> {
        const thread = await this.fetchThread(threadId);
        const chunks = chunkMessage(text);
        const messages: Message[] = [];
        for (const chunk of chunks) {
            messages.push(await thread.send(chunk));
        }
        return messages;
    }

    /** Send a message with button action rows to a thread. */
    async sendToThreadWithButtons(
        threadId: string,
        text: string,
        components: ActionRowBuilder<ButtonBuilder>[],
    ): Promise<Message> {
        const thread = await this.fetchThread(threadId);
        return thread.send({ content: text, components });
    }

    /** Send a message with a file attachment and button action rows to a thread. */
    async sendToThreadWithAttachment(
        threadId: string,
        text: string,
        fileContent: Buffer,
        fileName: string,
        components: ActionRowBuilder<ButtonBuilder>[],
    ): Promise<Message> {
        const thread = await this.fetchThread(threadId);
        const attachment = new AttachmentBuilder(fileContent, { name: fileName });
        return thread.send({ content: text, files: [attachment], components });
    }

    /** Archive a thread. Silently ignores if thread was already deleted. */
    async archiveThread(threadId: string): Promise<void> {
        try {
            const thread = await this.fetchThread(threadId);
            await thread.setArchived(true);
        } catch (err) {
            if (err instanceof DiscordAPIError && err.code === 10003) return;
            throw err;
        }
    }

    /** Delete a thread. Silently ignores if thread was already deleted. */
    async deleteThread(threadId: string): Promise<void> {
        try {
            const thread = await this.fetchThread(threadId);
            await thread.delete();
        } catch (err) {
            if (err instanceof DiscordAPIError && err.code === 10003) return;
            throw err;
        }
    }

    /** Send typing indicator to a thread. */
    async sendTypingInThread(threadId: string): Promise<void> {
        const thread = await this.fetchThread(threadId);
        await thread.sendTyping();
    }

    /** Add an emoji reaction to a message in a thread. */
    async reactInThread(threadId: string, messageId: string, emoji: string): Promise<void> {
        const thread = await this.fetchThread(threadId);
        const message = await thread.messages.fetch(messageId);
        await message.react(emoji);
    }

    /** Remove the bot's emoji reaction from a message in a thread. */
    async removeReactionInThread(threadId: string, messageId: string, emoji: string): Promise<void> {
        const encoded = encodeURIComponent(emoji);
        await this.client.rest.delete(
            `/channels/${threadId}/messages/${messageId}/reactions/${encoded}/@me`,
        ).catch((err: unknown) => {
            if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) return;
            throw err;
        });
    }

    /** Edit a message's content in a thread. */
    async editMessageInThread(threadId: string, messageId: string, content: string): Promise<void> {
        const thread = await this.fetchThread(threadId);
        const message = await thread.messages.fetch(messageId);
        await message.edit({ content });
    }

    /** Pin a message in a thread. */
    async pinMessageInThread(threadId: string, messageId: string): Promise<void> {
        const thread = await this.fetchThread(threadId);
        const message = await thread.messages.fetch(messageId);
        await message.pin();
    }

    /** Unpin a message from a thread. */
    async unpinMessageInThread(threadId: string, messageId: string): Promise<void> {
        const thread = await this.fetchThread(threadId);
        const message = await thread.messages.fetch(messageId);
        await message.unpin();
    }

    /** List all threads (active + archived) in the main channel. */
    async listThreads(): Promise<Array<{ id: string; name: string }>> {
        const channel = this.requireChannel();
        const active = await channel.threads.fetchActive();
        const archived = await channel.threads.fetchArchived();
        const threads: Array<{ id: string; name: string }> = [];
        for (const t of active.threads.values()) {
            threads.push({ id: t.id, name: t.name });
        }
        for (const t of archived.threads.values()) {
            threads.push({ id: t.id, name: t.name });
        }
        return threads;
    }

    destroy(): void {
        this.client.destroy();
        this.channel = null;
    }

    /** The authorized user ID. */
    get userId(): string {
        return this.config.userId;
    }

    private async fetchThread(threadId: string): Promise<ThreadChannel> {
        const ch = await this.client.channels.fetch(threadId);
        if (!ch?.isThread()) {
            throw new Error(`Channel ${threadId} is not a thread`);
        }
        return ch as ThreadChannel;
    }

    private requireChannel(): TextChannel {
        if (!this.channel) {
            throw new Error('Bot not started — call start() first');
        }
        return this.channel;
    }
}
