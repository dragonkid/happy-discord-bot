import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
    createInterface: vi.fn(() => ({
        question: vi.fn(),
        close: vi.fn(),
    })),
}));

const { buildEnvContent, handleInit } = await import('../init.js');

describe('buildEnvContent', () => {
    it('builds .env content with required fields', () => {
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

    it('includes guild ID when provided', () => {
        const content = buildEnvContent({
            DISCORD_TOKEN: 'tok',
            DISCORD_CHANNEL_ID: 'ch',
            DISCORD_USER_ID: 'u',
            DISCORD_APPLICATION_ID: 'app',
            DISCORD_GUILD_ID: 'guild123',
        });
        expect(content).toContain('DISCORD_GUILD_ID=guild123');
    });

    it('ends with newline', () => {
        const content = buildEnvContent({
            DISCORD_TOKEN: 't',
            DISCORD_CHANNEL_ID: 'c',
            DISCORD_USER_ID: 'u',
            DISCORD_APPLICATION_ID: 'a',
        });
        expect(content.endsWith('\n')).toBe(true);
    });
});

describe('handleInit', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('exits early when config already exists', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await handleInit();

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Config already exists'));
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        logSpy.mockRestore();
    });

    it('writes .env with correct permissions when config does not exist', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const { createInterface } = await import('node:readline/promises');
        const mockQuestion = vi.fn()
            .mockResolvedValueOnce('tok')    // Discord bot token
            .mockResolvedValueOnce('ch')     // channel ID
            .mockResolvedValueOnce('uid')    // user ID
            .mockResolvedValueOnce('appid')  // app ID
            .mockResolvedValueOnce('');      // guild ID (skip)

        vi.mocked(createInterface).mockReturnValue({
            question: mockQuestion,
            close: vi.fn(),
        } as any);

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleInit();

        expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 });
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining('.env'),
            expect.stringContaining('DISCORD_TOKEN=tok'),
            { mode: 0o600 },
        );
        logSpy.mockRestore();
    });
});
