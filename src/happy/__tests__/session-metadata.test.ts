import { describe, it, expect } from 'vitest';
import { extractDirectories } from '../session-metadata.js';
import type { DecryptedSession } from '../../vendor/api.js';

function makeSession(path: string, machineId: string, activeAt: number): DecryptedSession {
    return {
        id: `sess-${activeAt}`,
        seq: 1,
        createdAt: activeAt - 1000,
        updatedAt: activeAt,
        active: false,
        activeAt,
        metadata: { path, machineId, host: 'test', version: '0.14.0', os: 'darwin' },
        agentState: null,
        dataEncryptionKey: null,
        encryption: { key: new Uint8Array(32), variant: 'dataKey' as const },
    };
}

describe('extractDirectories', () => {
    it('extracts unique directories from sessions', () => {
        const sessions = [
            makeSession('/Users/user/project-a', 'machine-1', 3000),
            makeSession('/Users/user/project-b', 'machine-1', 2000),
            makeSession('/Users/user/project-a', 'machine-1', 1000),
        ];
        const result = extractDirectories(sessions);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ path: '/Users/user/project-a', machineId: 'machine-1', label: 'user/project-a' });
        expect(result[1]).toEqual({ path: '/Users/user/project-b', machineId: 'machine-1', label: 'user/project-b' });
    });

    it('filters out e2e temp directories', () => {
        const sessions = [
            makeSession('/private/tmp/e2e-session-123', 'machine-1', 3000),
            makeSession('/tmp/e2e-test-456', 'machine-1', 2000),
            makeSession('/Users/user/real-project', 'machine-1', 1000),
        ];
        const result = extractDirectories(sessions);
        expect(result).toHaveLength(1);
        expect(result[0].path).toBe('/Users/user/real-project');
    });

    it('sorts by most recently active', () => {
        const sessions = [
            makeSession('/Users/user/old', 'machine-1', 1000),
            makeSession('/Users/user/new', 'machine-1', 3000),
            makeSession('/Users/user/mid', 'machine-1', 2000),
        ];
        const result = extractDirectories(sessions);
        expect(result.map(d => d.path)).toEqual([
            '/Users/user/new',
            '/Users/user/mid',
            '/Users/user/old',
        ]);
    });

    it('limits to 25 entries', () => {
        const sessions = Array.from({ length: 30 }, (_, i) =>
            makeSession(`/Users/user/project-${i}`, 'machine-1', i * 1000),
        );
        const result = extractDirectories(sessions);
        expect(result).toHaveLength(25);
    });

    it('returns empty array when no valid sessions', () => {
        expect(extractDirectories([])).toEqual([]);
    });

    it('skips sessions with missing metadata fields', () => {
        const sessions = [
            { ...makeSession('/valid', 'machine-1', 2000) },
            { ...makeSession('/valid2', 'machine-1', 1000), metadata: null },
            { ...makeSession('/valid3', 'machine-1', 500), metadata: { host: 'test' } },
        ];
        const result = extractDirectories(sessions as DecryptedSession[]);
        expect(result).toHaveLength(1);
        expect(result[0].path).toBe('/valid');
    });

    it('generates short label from last two path segments', () => {
        const sessions = [
            makeSession('/Users/user/Coding/happy-discord-bot', 'machine-1', 1000),
        ];
        const result = extractDirectories(sessions);
        expect(result[0].label).toBe('Coding/happy-discord-bot');
    });

    it('uses full path as label when path has fewer than 2 segments', () => {
        const sessions = [
            makeSession('/root', 'machine-1', 1000),
        ];
        const result = extractDirectories(sessions);
        expect(result[0].label).toBe('/root');
    });
});
