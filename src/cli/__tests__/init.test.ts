import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
    createInterface: vi.fn(() => ({
        question: vi.fn(),
        close: vi.fn(),
    })),
}));

const { buildEnvContent, parseEnvFile, handleInit } = await import('../init.js');

describe('buildEnvContent', () => {
    it('builds .env content with all required fields', () => {
        const content = buildEnvContent({
            DISCORD_TOKEN: 'tok123',
            DISCORD_CHANNEL_ID: 'ch456',
            DISCORD_USER_ID: 'u789',
            DISCORD_APPLICATION_ID: 'app000',
            DISCORD_GUILD_ID: 'guild123',
        });
        expect(content).toContain('DISCORD_TOKEN=tok123');
        expect(content).toContain('DISCORD_CHANNEL_ID=ch456');
        expect(content).toContain('DISCORD_USER_ID=u789');
        expect(content).toContain('DISCORD_APPLICATION_ID=app000');
        expect(content).toContain('DISCORD_GUILD_ID=guild123');
    });

    it('ends with newline', () => {
        const content = buildEnvContent({
            DISCORD_TOKEN: 't',
            DISCORD_CHANNEL_ID: 'c',
            DISCORD_USER_ID: 'u',
            DISCORD_APPLICATION_ID: 'a',
            DISCORD_GUILD_ID: 'g',
        });
        expect(content.endsWith('\n')).toBe(true);
    });
});

describe('parseEnvFile', () => {
    it('parses key=value pairs from .env content', () => {
        const content = '# comment\nDISCORD_TOKEN=tok123\nDISCORD_CHANNEL_ID=ch456\n';
        const result = parseEnvFile(content);
        expect(result).toEqual({ DISCORD_TOKEN: 'tok123', DISCORD_CHANNEL_ID: 'ch456' });
    });

    it('ignores blank lines and comments', () => {
        const content = '\n# comment\n\nDISCORD_TOKEN=tok\n';
        const result = parseEnvFile(content);
        expect(result).toEqual({ DISCORD_TOKEN: 'tok' });
    });

    it('handles values with equals signs', () => {
        const content = 'DISCORD_TOKEN=tok=with=equals\n';
        const result = parseEnvFile(content);
        expect(result).toEqual({ DISCORD_TOKEN: 'tok=with=equals' });
    });

    it('strips surrounding double quotes from values', () => {
        const result = parseEnvFile('DISCORD_TOKEN="my-token"\n');
        expect(result).toEqual({ DISCORD_TOKEN: 'my-token' });
    });

    it('strips surrounding single quotes from values', () => {
        const result = parseEnvFile("DISCORD_TOKEN='my-token'\n");
        expect(result).toEqual({ DISCORD_TOKEN: 'my-token' });
    });

    it('does not strip mismatched quotes', () => {
        const result = parseEnvFile('DISCORD_TOKEN="my-token\'\n');
        expect(result).toEqual({ DISCORD_TOKEN: '"my-token\'' });
    });

    it('returns empty object for empty content', () => {
        expect(parseEnvFile('')).toEqual({});
    });
});

describe('handleInit', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('shows current values as defaults when config exists', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(
            '# Discord Bot\nDISCORD_TOKEN=old-tok\nDISCORD_CHANNEL_ID=old-ch\nDISCORD_USER_ID=old-uid\nDISCORD_APPLICATION_ID=old-app\n',
        );

        const { createInterface } = await import('node:readline/promises');
        const mockQuestion = vi.fn()
            .mockResolvedValueOnce('')       // keep token
            .mockResolvedValueOnce('new-ch') // update channel
            .mockResolvedValueOnce('')       // keep user ID
            .mockResolvedValueOnce('')       // keep app ID
            .mockResolvedValueOnce('');      // keep guild (no existing)

        vi.mocked(createInterface).mockReturnValue({
            question: mockQuestion,
            close: vi.fn(),
        } as any);

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleInit();

        // Should prompt with defaults shown in brackets
        expect(mockQuestion).toHaveBeenCalledWith(expect.stringContaining('[old-tok]'));
        // Empty input keeps old value, new input overrides
        const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        expect(written).toContain('DISCORD_TOKEN=old-tok');
        expect(written).toContain('DISCORD_CHANNEL_ID=new-ch');
        expect(written).toContain('DISCORD_USER_ID=old-uid');
        logSpy.mockRestore();
    });

    it('preserves existing guild ID when user presses Enter', async () => {
        vi.mocked(fs.writeFileSync).mockClear();
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(
            'DISCORD_TOKEN=t\nDISCORD_CHANNEL_ID=c\nDISCORD_USER_ID=u\nDISCORD_APPLICATION_ID=a\nDISCORD_GUILD_ID=g123\n',
        );

        const { createInterface } = await import('node:readline/promises');
        const mockQuestion = vi.fn().mockResolvedValue(''); // keep all defaults

        vi.mocked(createInterface).mockReturnValue({
            question: mockQuestion,
            close: vi.fn(),
        } as any);

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handleInit();

        const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        expect(written).toContain('DISCORD_GUILD_ID=g123');
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
            .mockResolvedValueOnce('gid');   // guild ID

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
