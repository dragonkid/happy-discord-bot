import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deriveContentKeyPair, decodeBase64, encodeBase64 } from './encryption.js';
import type { Config } from './config.js';

export type Credentials = {
    token: string;
    secret: Uint8Array;
    contentKeyPair: {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    };
    /** Machine key from access.key (dataKey mode). Used for machineRPC. */
    machineKey?: Uint8Array;
};

export function readCredentials(config: Config): Credentials | null {
    try {
        const raw = readFileSync(config.credentialPath, 'utf-8');
        const parsed = JSON.parse(raw) as { token: string; secret: string };
        if (!parsed.token || !parsed.secret) return null;
        const secret = decodeBase64(parsed.secret);
        const contentKeyPair = deriveContentKeyPair(secret);

        // Try to read machineKey from access.key (daemon credential, dataKey mode)
        let machineKey: Uint8Array | undefined;
        try {
            const accessKeyPath = join(dirname(config.credentialPath), 'access.key');
            const accessRaw = readFileSync(accessKeyPath, 'utf-8');
            const accessParsed = JSON.parse(accessRaw) as {
                encryption?: { machineKey?: string };
            };
            if (accessParsed.encryption?.machineKey) {
                machineKey = decodeBase64(accessParsed.encryption.machineKey);
            }
        } catch {
            // access.key not found or not readable — machineKey stays undefined
        }

        return {
            token: parsed.token,
            secret,
            contentKeyPair,
            machineKey,
        };
    } catch {
        return null;
    }
}

export function writeCredentials(config: Config, token: string, secret: Uint8Array): void {
    mkdirSync(dirname(config.credentialPath), { recursive: true, mode: 0o700 });
    const data = JSON.stringify({ token, secret: encodeBase64(secret) });
    writeFileSync(config.credentialPath, data, { mode: 0o600 });
}

export function clearCredentials(config: Config): void {
    try {
        unlinkSync(config.credentialPath);
    } catch {
        // File doesn't exist, nothing to clear
    }
}

export function requireCredentials(config: Config): Credentials {
    const creds = readCredentials(config);
    if (!creds) {
        throw new Error('Not authenticated. Run `happy-agent auth login` first.');
    }
    return creds;
}
