import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_STATE_DIR = join(homedir(), '.happy-discord-bot');

export function getStateDir(): string {
    return process.env.BOT_STATE_DIR || DEFAULT_STATE_DIR;
}
