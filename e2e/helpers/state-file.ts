import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SessionPermissions {
    mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools: string[];
    bashLiterals: string[];
    bashPrefixes: string[];
}

export interface BotState {
    sessions: Record<string, SessionPermissions>;
}

const STATE_DIR = join(homedir(), '.happy-discord-bot');
const STATE_FILE = join(STATE_DIR, 'state.json');

export class StateFile {
    /**
     * Write state.json with the given state.
     */
    async write(state: BotState): Promise<void> {
        await mkdir(STATE_DIR, { recursive: true });
        await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
    }

    /**
     * Read current state.json.
     */
    async read(): Promise<BotState> {
        try {
            const raw = await readFile(STATE_FILE, 'utf-8');
            return JSON.parse(raw) as BotState;
        } catch {
            return { sessions: {} };
        }
    }

    /**
     * Delete state.json (clean slate for tests).
     */
    async clean(): Promise<void> {
        await rm(STATE_FILE, { force: true });
    }
}
