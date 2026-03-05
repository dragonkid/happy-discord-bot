import {
    Client,
    GatewayIntentBits,
    Events,
    type Message,
    type TextChannel,
    ChannelType,
} from 'discord.js';
import { waitFor } from './wait.js';

export class DiscordTestClient {
    private client: Client;
    private channel: TextChannel | null = null;
    private collectedMessages: Message[] = [];

    constructor(
        private readonly token: string,
        private readonly channelId: string,
    ) {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });
    }

    /**
     * Connect to Discord and start listening for messages.
     */
    async start(): Promise<void> {
        this.client.on(Events.MessageCreate, (msg) => {
            if (msg.channelId !== this.channelId) return;
            if (msg.author.id === this.client.user?.id) return; // ignore own messages
            this.collectedMessages.push(msg);
        });

        await this.client.login(this.token);

        const ch = await this.client.channels.fetch(this.channelId);
        if (!ch || ch.type !== ChannelType.GuildText) {
            throw new Error(`Channel ${this.channelId} is not a text channel`);
        }
        this.channel = ch as TextChannel;
        console.log('[TestClient] Connected to Discord');
    }

    /**
     * Send a message to the test channel.
     */
    async sendMessage(text: string): Promise<Message> {
        if (!this.channel) throw new Error('Not connected');
        const msg = await this.channel.send(text);
        console.log(`[TestClient] Sent: "${text}"`);
        return msg;
    }

    /**
     * Wait for the bot to send a message matching the predicate.
     * Only checks messages received AFTER this method is called.
     */
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

    /**
     * Wait for a message with button components.
     */
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

    /**
     * Clear collected messages (call between tests).
     */
    clearMessages(): void {
        this.collectedMessages = [];
    }

    /**
     * Get the test bot's user ID.
     */
    get userId(): string {
        return this.client.user?.id ?? '';
    }

    /**
     * Disconnect from Discord.
     */
    destroy(): void {
        this.client.destroy();
        this.channel = null;
    }
}
