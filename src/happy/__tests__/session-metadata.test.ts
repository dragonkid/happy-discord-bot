import { describe, it, expect } from 'vitest';
import { extractDirectories, threadName } from '../session-metadata.js';
import type { DecryptedSession } from '../../vendor/api.js';

function makeSession(path: string, machineId: string, activeAt: number, host = 'test'): DecryptedSession {
    return {
        id: `sess-${activeAt}`,
        seq: 1,
        createdAt: activeAt - 1000,
        updatedAt: activeAt,
        active: false,
        activeAt,
        metadata: { path, machineId, host, version: '0.14.0', os: 'darwin' },
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
        expect(result[0]).toEqual({ path: '/Users/user/project-a', machineId: 'machine-1', host: 'test', label: 'user/project-a' });
        expect(result[1]).toEqual({ path: '/Users/user/project-b', machineId: 'machine-1', host: 'test', label: 'user/project-b' });
    });

    it('includes host from session metadata', () => {
        const sessions = [
            makeSession('/project', 'machine-1', 1000, 'arbitrage.local'),
        ];
        const result = extractDirectories(sessions);
        expect(result[0].host).toBe('arbitrage.local');
    });

    it('falls back to machineId prefix when host missing', () => {
        const sessions = [{
            ...makeSession('/project', 'abcdef1234567890', 1000),
            metadata: { path: '/project', machineId: 'abcdef1234567890' },
        }] as DecryptedSession[];
        const result = extractDirectories(sessions);
        expect(result[0].host).toBe('abcdef12');
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

describe('threadName', () => {
    it('returns "dir @ host" for valid metadata', () => {
        expect(threadName(
            { path: '/Users/user/my-project', machineId: 'abc', host: 'macbook' },
            'sess-1',
        )).toBe('my-project @ macbook');
    });

    it('falls back to machineId prefix when host is empty', () => {
        expect(threadName(
            { path: '/a/b', machineId: 'abcdef1234', host: '' },
            's1',
        )).toBe('b @ abcdef12');
    });

    it('returns fallback for invalid metadata', () => {
        expect(threadName(null, 'sess-1234-abcd')).toBe('session-sess-123');
    });

    it('returns fallback for undefined metadata', () => {
        expect(threadName(undefined, 'abcd1234')).toBe('session-abcd1234');
    });

    it('appends [YOLO] when dangerouslySkipPermissions is true', () => {
        expect(threadName(
            { path: '/Users/dk/project', machineId: 'abc', host: 'macbook', dangerouslySkipPermissions: true },
            'sess-1',
        )).toBe('project @ macbook [YOLO]');
    });

    it('omits [YOLO] when dangerouslySkipPermissions is false', () => {
        expect(threadName(
            { path: '/Users/dk/project', machineId: 'abc', host: 'macbook', dangerouslySkipPermissions: false },
            'sess-1',
        )).toBe('project @ macbook');
    });

    it('omits [YOLO] when dangerouslySkipPermissions is null', () => {
        expect(threadName(
            { path: '/Users/dk/project', machineId: 'abc', host: 'macbook', dangerouslySkipPermissions: null },
            'sess-1',
        )).toBe('project @ macbook');
    });
});
