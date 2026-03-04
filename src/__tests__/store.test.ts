import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../store.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Store', () => {
    let dir: string;
    let store: Store;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'bot-store-'));
        store = new Store(dir);
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('load returns empty state when file does not exist', async () => {
        const state = await store.load();
        expect(state).toEqual({ sessions: {} });
    });

    it('save then load round-trips session permissions', async () => {
        await store.save({
            sessions: {
                s1: { mode: 'acceptEdits', allowedTools: ['Edit'], bashLiterals: [], bashPrefixes: [] },
            },
        });
        const state = await store.load();
        expect(state.sessions.s1).toEqual({
            mode: 'acceptEdits',
            allowedTools: ['Edit'],
            bashLiterals: [],
            bashPrefixes: [],
        });
    });

    it('save creates directory if missing', async () => {
        const nested = join(dir, 'sub', 'deep');
        const nestedStore = new Store(nested);
        await nestedStore.save({
            sessions: { s1: { mode: 'plan', allowedTools: [], bashLiterals: [], bashPrefixes: [] } },
        });
        const state = await nestedStore.load();
        expect(state.sessions.s1.mode).toBe('plan');
    });

    it('load ignores corrupted file', async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'state.json'), 'not json');
        const state = await store.load();
        expect(state).toEqual({ sessions: {} });
    });

    it('save overwrites previous state', async () => {
        await store.save({
            sessions: { s1: { mode: 'acceptEdits', allowedTools: [], bashLiterals: [], bashPrefixes: [] } },
        });
        await store.save({
            sessions: { s2: { mode: 'bypassPermissions', allowedTools: ['Glob'], bashLiterals: ['git status'], bashPrefixes: ['npm'] } },
        });
        const state = await store.load();
        expect(state.sessions.s1).toBeUndefined();
        expect(state.sessions.s2).toEqual({
            mode: 'bypassPermissions',
            allowedTools: ['Glob'],
            bashLiterals: ['git status'],
            bashPrefixes: ['npm'],
        });
    });
});
