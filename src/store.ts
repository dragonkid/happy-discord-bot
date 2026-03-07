import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PermissionMode } from './happy/types.js';

export interface SessionPermissions {
    mode: PermissionMode;
    allowedTools: string[];
    bashLiterals: string[];
    bashPrefixes: string[];
}

export interface BotState {
    sessions: Record<string, SessionPermissions>;
    threads: Record<string, string>;
}

const STATE_FILE = 'state.json';

export class Store {
    private readonly filePath: string;
    private readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
        this.filePath = join(dir, STATE_FILE);
    }

    async load(): Promise<BotState> {
        try {
            const raw = await readFile(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<BotState>;
            return { sessions: parsed.sessions ?? {}, threads: parsed.threads ?? {} };
        } catch {
            return { sessions: {}, threads: {} };
        }
    }

    async save(state: BotState): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        await writeFile(this.filePath, JSON.stringify(state, null, 2) + '\n');
    }
}
