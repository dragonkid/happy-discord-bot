import {
    Client,
    GatewayIntentBits,
    Events,
    type TextChannel,
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

    async start(): Promise<void> {
        this.client.on(Events.InteractionCreate, (interaction) => {
            this.interactionHandler?.(interaction);
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

    /** Edit an existing message's content and/or components. */
    async editMessage(
        message: Message,
        content: string,
        components: ActionRowBuilder<ButtonBuilder>[] = [],
    ): Promise<Message> {
        return message.edit({ content, components });
    }

    destroy(): void {
        this.client.destroy();
        this.channel = null;
    }

    /** The authorized user ID. */
    get userId(): string {
        return this.config.userId;
    }

    private requireChannel(): TextChannel {
        if (!this.channel) {
            throw new Error('Bot not started — call start() first');
        }
        return this.channel;
    }
}
