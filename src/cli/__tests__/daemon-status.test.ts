import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all daemon.ts dependencies
vi.mock('node:fs', () => ({
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    openSync: vi.fn(() => 3),
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('../../version.js', () => ({
    getVersion: vi.fn(() => '0.1.0'),
}));

vi.mock('../../credentials.js', () => ({
    readBotCredentials: vi.fn(),
}));

vi.mock('../../vendor/encryption.js', () => ({
    decodeBase64: vi.fn(() => new Uint8Array(32)),
    deriveContentKeyPair: vi.fn(() => ({
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64),
    })),
    encodeBase64: vi.fn((buf: Uint8Array) => Buffer.from(buf).toString('base64')),
}));

vi.mock('../../vendor/config.js', () => ({
    loadConfig: vi.fn(() => ({ serverUrl: 'https://api.test.com' })),
}));

vi.mock('../../vendor/api.js', () => ({
    listSessions: vi.fn(),
    listMachines: vi.fn(),
}));

const { relativeTime, showPairingStatus } = await import('../daemon.js');
const { readBotCredentials } = await import('../../credentials.js');
const { listSessions, listMachines } = await import('../../vendor/api.js');

const mockSession = (overrides: Record<string, unknown> = {}) => ({
    id: 'sess-aaa111', seq: 1, createdAt: 0, updatedAt: 0,
    active: true, activeAt: Date.now() - 60_000,
    metadata: { path: '/home/user/project-a', machineId: 'machine-1', host: 'host-a' },
    agentState: null, dataEncryptionKey: null,
    encryption: { variant: 'legacy' as const, key: new Uint8Array(32) },
    ...overrides,
});

describe('relativeTime', () => {
    it('returns "just now" for < 60 seconds ago', () => {
        expect(relativeTime(Date.now() - 30_000)).toBe('just now');
    });

    it('returns minutes for < 60 minutes', () => {
        expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
    });

    it('returns hours for < 24 hours', () => {
        expect(relativeTime(Date.now() - 3 * 3600_000)).toBe('3h ago');
    });

    it('returns days for >= 24 hours', () => {
        expect(relativeTime(Date.now() - 2 * 86400_000)).toBe('2d ago');
    });

    it('returns "1m ago" at exactly 60 seconds', () => {
        expect(relativeTime(Date.now() - 60_000)).toBe('1m ago');
    });

    it('returns "just now" for future timestamps (clock skew)', () => {
        expect(relativeTime(Date.now() + 60_000)).toBe('just now');
    });
});

const mockMachine = (overrides: Record<string, unknown> = {}) => ({
    id: 'machine-1',
    metadata: { machineId: 'machine-1', host: 'host-a' },
    active: true,
    activeAt: Date.now() - 60_000,
    createdAt: Date.now() - 86400_000,
    ...overrides,
});

describe('showPairingStatus', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(listMachines).mockResolvedValue([]);
    });

    it('prints "Not linked" when no credentials', async () => {
        vi.mocked(readBotCredentials).mockReturnValue(null);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Not linked'));
        logSpy.mockRestore();
    });

    it('prints account status and session count', async () => {
        vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok-abc12345', secret: 'dGVzdA==' });
        vi.mocked(listSessions).mockResolvedValue([
            mockSession({
                id: 'abc123def456',
                activeAt: Date.now() - 120_000,
                metadata: { path: '/home/user/project-a', machineId: '4e1b294f-d870-4ca6-8729-5599b8765bdb', host: 'arbitrage.local' },
            }),
        ]);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Linked'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('tok-abc1'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 active'));
        logSpy.mockRestore();
    });

    it('groups sessions by machine', async () => {
        vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok-abc12345', secret: 'dGVzdA==' });
        vi.mocked(listSessions).mockResolvedValue([
            mockSession({ id: 'sess-aaa111', activeAt: Date.now() - 60_000, metadata: { path: '/home/user/project-a', machineId: 'machine-1', host: 'host-a' } }),
            mockSession({ id: 'sess-bbb222', seq: 2, activeAt: Date.now() - 300_000, metadata: { path: '/home/user/project-b', machineId: 'machine-1', host: 'host-a' } }),
            mockSession({ id: 'sess-ccc333', seq: 3, activeAt: Date.now() - 7200_000, metadata: { path: '/work/api', machineId: 'machine-2', host: 'host-b' } }),
        ]);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        const calls = logSpy.mock.calls.map(c => c[0]);
        expect(calls).toContainEqual(expect.stringContaining('host-a (machine-1)'));
        expect(calls).toContainEqual(expect.stringContaining('host-b (machine-2)'));
        expect(calls).toContainEqual(expect.stringContaining('[sess-aa]'));
        expect(calls).toContainEqual(expect.stringContaining('project-a'));
        expect(calls).toContainEqual(expect.stringContaining('[sess-bb]'));
        expect(calls).toContainEqual(expect.stringContaining('[sess-cc]'));
        // Machines from sessions (not in machines API) show as offline
        expect(calls).toContainEqual(expect.stringContaining('[offline]'));
        logSpy.mockRestore();
    });

    it('prints "No machines paired" when both lists are empty', async () => {
        vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok-abc12345', secret: 'dGVzdA==' });
        vi.mocked(listSessions).mockResolvedValue([]);
        vi.mocked(listMachines).mockResolvedValue([]);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No machines paired'));
        logSpy.mockRestore();
    });

    it('shows machine with no sessions', async () => {
        vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok-abc12345', secret: 'dGVzdA==' });
        vi.mocked(listSessions).mockResolvedValue([]);
        vi.mocked(listMachines).mockResolvedValue([mockMachine()]);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        const calls = logSpy.mock.calls.map(c => c[0]);
        expect(calls).toContainEqual(expect.stringContaining('host-a (machine-1)'));
        expect(calls).toContainEqual(expect.stringContaining('online'));
        expect(calls).toContainEqual(expect.stringContaining('No sessions'));
        logSpy.mockRestore();
    });

    it('shows active/archived status per session', async () => {
        vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok-abc12345', secret: 'dGVzdA==' });
        vi.mocked(listSessions).mockResolvedValue([
            mockSession({ id: 'sess-act111', active: true }),
            mockSession({ id: 'sess-arc222', active: false, metadata: { path: '/home/user/old-project', machineId: 'machine-1', host: 'host-a' } }),
        ]);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        const calls = logSpy.mock.calls.map(c => c[0]);
        expect(calls).toContainEqual(expect.stringContaining('active'));
        expect(calls).toContainEqual(expect.stringContaining('archived'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 active'));
        logSpy.mockRestore();
    });

    it('handles network error gracefully', async () => {
        vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok-abc12345', secret: 'dGVzdA==' });
        vi.mocked(listSessions).mockRejectedValue(new Error('fetch failed'));
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'));
        logSpy.mockRestore();
    });

    it('handles partial metadata (missing host)', async () => {
        vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok-abc12345', secret: 'dGVzdA==' });
        vi.mocked(listSessions).mockResolvedValue([
            mockSession({ id: 'sess-ppp000', metadata: { path: '/partial/path', machineId: 'partial-machine' } }),
        ]);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        const calls = logSpy.mock.calls.map(c => c[0]);
        // Missing host means isValidMetadata returns false → falls back to unknown
        expect(calls).toContainEqual(expect.stringContaining('unknown'));
        expect(calls).toContainEqual(expect.stringContaining('[sess-pp]'));
        logSpy.mockRestore();
    });

    it('handles session with missing metadata', async () => {
        vi.mocked(readBotCredentials).mockReturnValue({ token: 'tok-abc12345', secret: 'dGVzdA==' });
        vi.mocked(listSessions).mockResolvedValue([
            mockSession({ id: 'sess-xxx999', metadata: null }),
        ]);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await showPairingStatus('/tmp/test');

        const calls = logSpy.mock.calls.map(c => c[0]);
        expect(calls).toContainEqual(expect.stringContaining('unknown'));
        expect(calls).toContainEqual(expect.stringContaining('[sess-xx]'));
        logSpy.mockRestore();
    });
});
