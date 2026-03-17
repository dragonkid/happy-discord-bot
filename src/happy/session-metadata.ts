import type { DecryptedSession, DecryptedMachine } from '../vendor/api.js';
import type { SessionMetadata } from './types.js';

export interface DirectoryEntry {
    path: string;
    machineId: string;
    label: string;
}

const E2E_PATH_PATTERN = /^\/(?:private\/)?tmp\/e2e-/;
const MAX_DIRECTORIES = 25;

function isValidMetadata(metadata: unknown): metadata is SessionMetadata {
    if (!metadata || typeof metadata !== 'object') return false;
    const m = metadata as Record<string, unknown>;
    return typeof m.path === 'string' && typeof m.machineId === 'string';
}

export function threadName(metadata: unknown, fallbackSessionId: string): string {
    if (!isValidMetadata(metadata)) {
        return `session-${fallbackSessionId.slice(0, 8)}`;
    }
    const dir = metadata.path.split('/').filter(Boolean).pop() ?? 'unknown';
    const host = metadata.host || metadata.machineId.slice(0, 8);
    return `${dir} @ ${host}`;
}

function shortLabel(fullPath: string): string {
    const segments = fullPath.split('/').filter(Boolean);
    if (segments.length < 2) return fullPath;
    return segments.slice(-2).join('/');
}

export function extractMachineIds(sessions: readonly DecryptedSession[]): string[] {
    const seen = new Set<string>();
    for (const session of sessions) {
        if (!isValidMetadata(session.metadata)) continue;
        seen.add(session.metadata.machineId);
    }
    return Array.from(seen);
}

export interface MachineEntry {
    machineId: string;
    host: string;
    active: boolean;
    activeAt: number;
}

function isMachineMetadata(m: unknown): m is { host: string } {
    return !!m && typeof m === 'object' && 'host' in m
        && typeof (m as Record<string, unknown>).host === 'string';
}

export function extractMachines(machines: readonly DecryptedMachine[]): MachineEntry[] {
    return machines.map(m => {
        const meta = isMachineMetadata(m.metadata) ? m.metadata : null;
        return {
            machineId: m.id,
            host: meta?.host ?? m.id.slice(0, 8),
            active: m.active,
            activeAt: m.activeAt,
        };
    });
}

export function extractDirectories(sessions: readonly DecryptedSession[]): DirectoryEntry[] {
    const byPath = new Map<string, { machineId: string; activeAt: number }>();

    for (const session of sessions) {
        if (!isValidMetadata(session.metadata)) continue;
        const { path, machineId } = session.metadata;
        if (E2E_PATH_PATTERN.test(path)) continue;

        const existing = byPath.get(path);
        if (!existing || session.activeAt > existing.activeAt) {
            byPath.set(path, { machineId, activeAt: session.activeAt });
        }
    }

    return Array.from(byPath.entries())
        .sort((a, b) => b[1].activeAt - a[1].activeAt)
        .slice(0, MAX_DIRECTORIES)
        .map(([path, { machineId }]) => ({
            path,
            machineId,
            label: shortLabel(path),
        }));
}
