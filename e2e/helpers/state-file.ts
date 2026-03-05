import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionPermissions, BotState } from '../../src/store.js';

export type { SessionPermissions, BotState };

const STATE_FILE = 'state.json';

export class StateFile {
    private readonly dir: string;
    private readonly filePath: string;

    constructor(dir: string) {
        this.dir = dir;
        this.filePath = join(dir, STATE_FILE);
    }

    /**
     * Write state.json with the given state.
     */
    async write(state: BotState): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        await writeFile(this.filePath, JSON.stringify(state, null, 2) + '\n');
    }

    /**
     * Read current state.json.
     */
    async read(): Promise<BotState> {
        try {
            const raw = await readFile(this.filePath, 'utf-8');
            return JSON.parse(raw) as BotState;
        } catch {
            return { sessions: {} };
        }
    }

    /**
     * Delete state.json (clean slate for tests).
     */
    async clean(): Promise<void> {
        await rm(this.filePath, { force: true });
    }

    /**
     * Get the directory path (for passing as BOT_STATE_DIR to bot subprocess).
     */
    get stateDir(): string {
        return this.dir;
    }
}
