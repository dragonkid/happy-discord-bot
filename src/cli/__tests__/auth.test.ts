import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../state-dir.js', () => ({
    getStateDir: vi.fn(() => '/tmp/test-state'),
}));

vi.mock('../../credentials.js', () => ({
    readBotCredentials: vi.fn(),
    writeBotCredentials: vi.fn(),
    removeBotCredentials: vi.fn(),
}));

vi.mock('../../vendor/encryption.js', () => ({
    authChallenge: vi.fn(() => ({
        publicKey: new Uint8Array(32),
        challenge: new Uint8Array(16),
        signature: new Uint8Array(64),
    })),
    encodeBase64: vi.fn(() => 'base64data'),
    encodeBase64Url: vi.fn(() => 'base64urlsecret'),
    decodeBase64Url: vi.fn(() => new Uint8Array(32)),
    getRandomBytes: vi.fn(() => new Uint8Array(32)),
}));

vi.mock('../../vendor/config.js', () => ({
    loadConfig: vi.fn(() => ({ serverUrl: 'https://api.test.com' })),
}));

vi.mock('node:readline/promises', () => ({
    createInterface: vi.fn(() => ({
        question: vi.fn(),
        close: vi.fn(),
    })),
}));

import { readBotCredentials, writeBotCredentials, removeBotCredentials } from '../../credentials.js';
import { decodeBase64Url } from '../../vendor/encryption.js';
const { handleAuth } = await import('../auth.js');

describe('handleAuth', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalThis.fetch = vi.fn();
    });

    describe('login', () => {
        it('creates new account when not linked', async () => {
            vi.mocked(readBotCredentials).mockReturnValue(null);
            vi.mocked(globalThis.fetch).mockResolvedValue({
                ok: true,
                json: async () => ({ success: true, token: 'new-token' }),
            } as Response);

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleAuth(['login']);

            expect(writeBotCredentials).toHaveBeenCalledWith('/tmp/test-state', 'new-token', expect.any(Uint8Array));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Account created'));
            logSpy.mockRestore();
        });

        it('does not create account when already linked', async () => {
            vi.mocked(readBotCredentials).mockReturnValue({ token: 'existing', secret: 's' });

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleAuth(['login']);

            expect(writeBotCredentials).not.toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Already linked'));
            logSpy.mockRestore();
        });

        it('throws on auth failure', async () => {
            vi.mocked(readBotCredentials).mockReturnValue(null);
            vi.mocked(globalThis.fetch).mockResolvedValue({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
            } as Response);

            await expect(handleAuth(['login'])).rejects.toThrow('Auth failed');
        });
    });

    describe('restore', () => {
        it('restores account from secret input', async () => {
            vi.mocked(readBotCredentials).mockReturnValue(null);
            vi.mocked(globalThis.fetch).mockResolvedValue({
                ok: true,
                json: async () => ({ success: true, token: 'restored-token' }),
            } as Response);

            const { createInterface } = await import('node:readline/promises');
            vi.mocked(createInterface).mockReturnValue({
                question: vi.fn().mockResolvedValue('somebase64urlsecret'),
                close: vi.fn(),
            } as any);

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleAuth(['restore']);

            expect(writeBotCredentials).toHaveBeenCalledWith('/tmp/test-state', 'restored-token', expect.any(Uint8Array));
            expect(logSpy).toHaveBeenCalledWith('Account linked.');
            logSpy.mockRestore();
        });

        it('does not restore when already linked', async () => {
            vi.mocked(readBotCredentials).mockReturnValue({ token: 'existing', secret: 's' });

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleAuth(['restore']);

            expect(writeBotCredentials).not.toHaveBeenCalled();
            logSpy.mockRestore();
        });

        it('exits on invalid secret length', async () => {
            vi.mocked(readBotCredentials).mockReturnValue(null);
            vi.mocked(decodeBase64Url).mockReturnValue(new Uint8Array(16)); // wrong length

            const { createInterface } = await import('node:readline/promises');
            vi.mocked(createInterface).mockReturnValue({
                question: vi.fn().mockResolvedValue('short'),
                close: vi.fn(),
            } as any);

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(handleAuth(['restore'])).rejects.toThrow('exit');
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid secret'));

            exitSpy.mockRestore();
            errorSpy.mockRestore();
        });
    });

    describe('status', () => {
        it('shows linked status when credentials exist', async () => {
            vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok12345678rest', secret: 's' });

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleAuth(['status']);

            expect(logSpy).toHaveBeenCalledWith('Linked');
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('tok12345'));
            logSpy.mockRestore();
        });

        it('shows not linked when no credentials', async () => {
            vi.mocked(readBotCredentials).mockReturnValue(null);

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleAuth(['status']);

            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Not linked'));
            logSpy.mockRestore();
        });
    });

    describe('logout', () => {
        it('removes credentials when they exist', async () => {
            vi.mocked(removeBotCredentials).mockReturnValue(true);

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleAuth(['logout']);

            expect(removeBotCredentials).toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith('Credentials removed.');
            logSpy.mockRestore();
        });

        it('shows message when no credentials found', async () => {
            vi.mocked(removeBotCredentials).mockReturnValue(false);

            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await handleAuth(['logout']);

            expect(logSpy).toHaveBeenCalledWith('No credentials found.');
            logSpy.mockRestore();
        });
    });

    describe('unknown subcommand', () => {
        it('shows usage and exits', async () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

            await expect(handleAuth(['badcmd'])).rejects.toThrow('exit');
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));

            logSpy.mockRestore();
            exitSpy.mockRestore();
        });
    });
});
