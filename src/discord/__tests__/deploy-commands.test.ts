import { describe, it, expect, vi, beforeEach } from 'vitest';

// Auto-chainable proxy: any property access returns a function that returns the proxy itself
function chainProxy(): any {
    const proxy: any = new Proxy(() => {}, {
        get(_target, prop) {
            if (prop === 'toJSON') return () => ({ name: 'mock' });
            if (prop === 'then') return undefined; // prevent Promise-like behavior
            return proxy;
        },
        apply(_target, _thisArg, args) {
            for (const arg of args) {
                if (typeof arg === 'function') arg(chainProxy());
            }
            return proxy;
        },
    });
    return proxy;
}

vi.mock('discord.js', () => ({
    REST: class {
        put = vi.fn().mockResolvedValue(undefined);
        setToken() { return this; }
    },
    Routes: {
        applicationGuildCommands: vi.fn(() => '/guild-commands'),
        applicationCommands: vi.fn(() => '/commands'),
    },
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    SlashCommandBuilder: class { constructor() { return chainProxy(); } },
}));

const { autoDeployCommands } = await import('../deploy-commands.js');

describe('autoDeployCommands', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        delete process.env.DISCORD_TOKEN;
        delete process.env.DISCORD_APPLICATION_ID;
        delete process.env.DISCORD_GUILD_ID;
    });

    it('throws when DISCORD_TOKEN is missing', async () => {
        await expect(autoDeployCommands()).rejects.toThrow('DISCORD_TOKEN is required');
    });

    it('throws when DISCORD_APPLICATION_ID is missing', async () => {
        process.env.DISCORD_TOKEN = 'tok';
        await expect(autoDeployCommands()).rejects.toThrow('DISCORD_APPLICATION_ID is required');
    });

    it('returns silently when env vars missing and silent: true', async () => {
        await expect(autoDeployCommands({ silent: true })).resolves.toBeUndefined();
    });

    it('deploys to guild when DISCORD_GUILD_ID is set', async () => {
        process.env.DISCORD_TOKEN = 'tok';
        process.env.DISCORD_APPLICATION_ID = 'appid';
        process.env.DISCORD_GUILD_ID = 'guildid';

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await autoDeployCommands();

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('guild'));
        logSpy.mockRestore();
    });

    it('deploys globally when no guild ID', async () => {
        process.env.DISCORD_TOKEN = 'tok';
        process.env.DISCORD_APPLICATION_ID = 'appid';

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await autoDeployCommands();

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('globally'));
        logSpy.mockRestore();
    });
});
