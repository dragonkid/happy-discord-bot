import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | undefined;

export function getVersion(): string {
    if (cachedVersion) return cachedVersion;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
        try {
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
            if (pkg.name === 'happy-discord-bot') {
                cachedVersion = pkg.version as string;
                return cachedVersion;
            }
        } catch { /* continue */ }
        dir = dirname(dir);
    }
    cachedVersion = '0.0.0';
    return cachedVersion;
}
