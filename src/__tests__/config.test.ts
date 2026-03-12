import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, existsSync: vi.fn() };
});

const { resolveEnvFile } = await import('../config.js');

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

    it('falls back to ~/.happy-discord-bot/.env', () => {
        vi.mocked(existsSync).mockImplementation((p) =>
            typeof p === 'string' && p.includes('.happy-discord-bot'),
        );
        const result = resolveEnvFile();
        expect(result).toContain('.happy-discord-bot');
    });

    it('returns undefined when no .env exists', () => {
        vi.mocked(existsSync).mockReturnValue(false);
        const result = resolveEnvFile();
        expect(result).toBeUndefined();
    });
});
