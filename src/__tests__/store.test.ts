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
        expect(state).toEqual({ sessionModes: {} });
    });

    it('save then load round-trips sessionModes', async () => {
        await store.save({ sessionModes: { s1: 'acceptEdits' } });
        const state = await store.load();
        expect(state.sessionModes).toEqual({ s1: 'acceptEdits' });
    });

    it('save creates directory if missing', async () => {
        const nested = join(dir, 'sub', 'deep');
        const nestedStore = new Store(nested);
        await nestedStore.save({ sessionModes: { s1: 'plan' } });
        const state = await nestedStore.load();
        expect(state.sessionModes.s1).toBe('plan');
    });

    it('load ignores corrupted file', async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'state.json'), 'not json');
        const state = await store.load();
        expect(state).toEqual({ sessionModes: {} });
    });

    it('save overwrites previous state', async () => {
        await store.save({ sessionModes: { s1: 'acceptEdits' } });
        await store.save({ sessionModes: { s2: 'bypassPermissions' } });
        const state = await store.load();
        expect(state.sessionModes).toEqual({ s2: 'bypassPermissions' });
    });
});
