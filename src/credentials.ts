import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { encodeBase64 } from './vendor/encryption.js';

const CREDENTIALS_FILE = 'credentials.json';

export interface BotCredentials {
    token: string;
    secret: string; // base64-encoded
}

export function readBotCredentials(stateDir: string): BotCredentials | null {
    try {
        const raw = readFileSync(join(stateDir, CREDENTIALS_FILE), 'utf-8');
        const parsed = JSON.parse(raw) as BotCredentials;
        if (!parsed.token || !parsed.secret) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function writeBotCredentials(stateDir: string, token: string, secret: Uint8Array): void {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const data = JSON.stringify({ token, secret: encodeBase64(secret) });
    writeFileSync(join(stateDir, CREDENTIALS_FILE), data + '\n', { mode: 0o600 });
}

export function removeBotCredentials(stateDir: string): boolean {
    try {
        unlinkSync(join(stateDir, CREDENTIALS_FILE));
        return true;
    } catch {
        return false;
    }
}
