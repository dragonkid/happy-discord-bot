import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
}));

vi.mock('../vendor/config.js', () => ({
    loadConfig: vi.fn(() => ({ serverUrl: 'https://test.example.com' })),
}));

vi.mock('../vendor/encryption.js', () => ({
    decodeBase64: vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64'))),
    deriveContentKeyPair: vi.fn((_secret: Uint8Array) => ({
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(32),
    })),
}));

vi.mock('../credentials.js', () => ({
    readBotCredentials: vi.fn(),
}));

vi.mock('../state-dir.js', () => ({
    getStateDir: vi.fn(() => '/mock-state-dir'),
}));

vi.mock('dotenv', () => ({
    config: vi.fn(),
}));

const { resolveEnvFile, loadBotConfig } = await import('../config.js');
const { readBotCredentials } = await import('../credentials.js');

// Save original env
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
    'DISCORD_TOKEN', 'DISCORD_CHANNEL_ID', 'DISCORD_USER_ID',
    'DISCORD_REQUIRE_MENTION', 'HAPPY_TOKEN', 'HAPPY_SECRET',
];

describe('resolveEnvFile', () => {
    beforeEach(() => {
        vi.mocked(existsSync).mockReturnValue(false);
    });

    it('returns cwd .env if it exists', () => {
        vi.mocked(existsSync).mockImplementation((p) =>
            typeof p === 'string' && p.endsWith('.env') && !p.includes('.happy-discord-bot'),
        );
        const result = resolveEnvFile();
        expect(result).toMatch(/\.env$/);
        expect(result).not.toContain('.happy-discord-bot');
    });

    it('falls back to state dir .env', () => {
        vi.mocked(existsSync).mockImplementation((p) =>
            typeof p === 'string' && p.includes('mock-state-dir'),
        );
        const result = resolveEnvFile();
        expect(result).toContain('mock-state-dir');
    });

    it('returns undefined when no .env exists', () => {
        vi.mocked(existsSync).mockReturnValue(false);
        const result = resolveEnvFile();
        expect(result).toBeUndefined();
    });
});

describe('loadBotConfig', () => {
    beforeEach(() => {
        // Save and clear relevant env vars
        for (const key of envKeys) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        vi.mocked(readBotCredentials).mockReturnValue(null);
    });

    afterEach(() => {
        // Restore env vars
        for (const key of envKeys) {
            if (savedEnv[key] !== undefined) {
                process.env[key] = savedEnv[key];
            } else {
                delete process.env[key];
            }
        }
    });

    it('throws when DISCORD_TOKEN is missing', () => {
        process.env.HAPPY_TOKEN = 'tok';
        process.env.HAPPY_SECRET = Buffer.alloc(32).toString('base64');
        process.env.DISCORD_CHANNEL_ID = 'ch-1';
        process.env.DISCORD_USER_ID = 'u-1';
        // No DISCORD_TOKEN
        expect(() => loadBotConfig()).toThrow('Missing required environment variable: DISCORD_TOKEN');
    });

    it('throws when DISCORD_CHANNEL_ID is missing', () => {
        process.env.HAPPY_TOKEN = 'tok';
        process.env.HAPPY_SECRET = Buffer.alloc(32).toString('base64');
        process.env.DISCORD_TOKEN = 'discord-tok';
        process.env.DISCORD_USER_ID = 'u-1';
        // No DISCORD_CHANNEL_ID
        expect(() => loadBotConfig()).toThrow('Missing required environment variable: DISCORD_CHANNEL_ID');
    });

    it('throws when DISCORD_USER_ID is missing', () => {
        process.env.HAPPY_TOKEN = 'tok';
        process.env.HAPPY_SECRET = Buffer.alloc(32).toString('base64');
        process.env.DISCORD_TOKEN = 'discord-tok';
        process.env.DISCORD_CHANNEL_ID = 'ch-1';
        // No DISCORD_USER_ID
        expect(() => loadBotConfig()).toThrow('Missing required environment variable: DISCORD_USER_ID');
    });

    it('loads credentials from env vars (HAPPY_TOKEN + HAPPY_SECRET)', () => {
        process.env.DISCORD_TOKEN = 'discord-tok';
        process.env.DISCORD_CHANNEL_ID = 'ch-1';
        process.env.DISCORD_USER_ID = 'u-1';
        process.env.HAPPY_TOKEN = 'happy-tok';
        process.env.HAPPY_SECRET = Buffer.alloc(32).toString('base64');

        const config = loadBotConfig();

        expect(config.credentials.token).toBe('happy-tok');
        expect(config.credentials.secret).toBeInstanceOf(Uint8Array);
        expect(config.credentials.contentKeyPair).toBeDefined();
        // Should NOT fall through to readBotCredentials
        expect(readBotCredentials).not.toHaveBeenCalled();
    });

    it('falls back to bot credentials.json when env vars absent', () => {
        process.env.DISCORD_TOKEN = 'discord-tok';
        process.env.DISCORD_CHANNEL_ID = 'ch-1';
        process.env.DISCORD_USER_ID = 'u-1';
        // No HAPPY_TOKEN / HAPPY_SECRET
        vi.mocked(readBotCredentials).mockReturnValue({
            token: 'bot-tok',
            secret: Buffer.alloc(32).toString('base64'),
        });

        const config = loadBotConfig();

        expect(config.credentials.token).toBe('bot-tok');
        expect(readBotCredentials).toHaveBeenCalledWith('/mock-state-dir');
    });

    it('throws when no credentials available', () => {
        process.env.DISCORD_TOKEN = 'discord-tok';
        process.env.DISCORD_CHANNEL_ID = 'ch-1';
        process.env.DISCORD_USER_ID = 'u-1';
        // No HAPPY_TOKEN / HAPPY_SECRET, readBotCredentials returns null
        vi.mocked(readBotCredentials).mockReturnValue(null);

        expect(() => loadBotConfig()).toThrow('No Happy credentials found');
    });

    it('parses requireMention as true only for exact "true" string', () => {
        process.env.DISCORD_TOKEN = 'discord-tok';
        process.env.DISCORD_CHANNEL_ID = 'ch-1';
        process.env.DISCORD_USER_ID = 'u-1';
        process.env.HAPPY_TOKEN = 'tok';
        process.env.HAPPY_SECRET = Buffer.alloc(32).toString('base64');

        process.env.DISCORD_REQUIRE_MENTION = 'true';
        expect(loadBotConfig().discord.requireMention).toBe(true);

        process.env.DISCORD_REQUIRE_MENTION = 'false';
        expect(loadBotConfig().discord.requireMention).toBe(false);

        process.env.DISCORD_REQUIRE_MENTION = '1';
        expect(loadBotConfig().discord.requireMention).toBe(false);

        delete process.env.DISCORD_REQUIRE_MENTION;
        expect(loadBotConfig().discord.requireMention).toBe(false);
    });

    it('only uses env HAPPY_TOKEN when both TOKEN and SECRET are present', () => {
        process.env.DISCORD_TOKEN = 'discord-tok';
        process.env.DISCORD_CHANNEL_ID = 'ch-1';
        process.env.DISCORD_USER_ID = 'u-1';
        process.env.HAPPY_TOKEN = 'happy-tok';
        // HAPPY_SECRET is missing
        vi.mocked(readBotCredentials).mockReturnValue(null);

        // Should NOT use partial env vars, should fall through and throw
        expect(() => loadBotConfig()).toThrow('No Happy credentials found');
    });

    it('returns correct happy config from vendor', () => {
        process.env.DISCORD_TOKEN = 'discord-tok';
        process.env.DISCORD_CHANNEL_ID = 'ch-1';
        process.env.DISCORD_USER_ID = 'u-1';
        process.env.HAPPY_TOKEN = 'tok';
        process.env.HAPPY_SECRET = Buffer.alloc(32).toString('base64');

        const config = loadBotConfig();
        expect(config.happy.serverUrl).toBe('https://test.example.com');
    });
});
