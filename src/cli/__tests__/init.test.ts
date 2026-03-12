import { describe, it, expect } from 'vitest';
import { buildEnvContent } from '../init.js';

describe('buildEnvContent', () => {
    it('builds .env content from answers', () => {
        const content = buildEnvContent({
            DISCORD_TOKEN: 'tok123',
            DISCORD_CHANNEL_ID: 'ch456',
            DISCORD_USER_ID: 'u789',
            DISCORD_APPLICATION_ID: 'app000',
        });
        expect(content).toContain('DISCORD_TOKEN=tok123');
        expect(content).toContain('DISCORD_CHANNEL_ID=ch456');
        expect(content).toContain('DISCORD_USER_ID=u789');
        expect(content).toContain('DISCORD_APPLICATION_ID=app000');
    });

    it('includes optional fields when provided', () => {
        const content = buildEnvContent({
            DISCORD_TOKEN: 'tok',
            DISCORD_CHANNEL_ID: 'ch',
            DISCORD_USER_ID: 'u',
            DISCORD_APPLICATION_ID: 'app',
            DISCORD_GUILD_ID: 'guild123',
            HAPPY_TOKEN: 'ht',
            HAPPY_SECRET: 'hs',
        });
        expect(content).toContain('DISCORD_GUILD_ID=guild123');
        expect(content).toContain('HAPPY_TOKEN=ht');
        expect(content).toContain('HAPPY_SECRET=hs');
    });
});
