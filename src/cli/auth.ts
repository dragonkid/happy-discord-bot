import { createInterface } from 'node:readline/promises';
import { getStateDir } from '../state-dir.js';
import { readBotCredentials, writeBotCredentials, removeBotCredentials } from '../credentials.js';
import { authChallenge, encodeBase64, encodeBase64Url, decodeBase64Url, getRandomBytes } from '../vendor/encryption.js';
import { loadConfig } from '../vendor/config.js';

async function authGetToken(serverUrl: string, secret: Uint8Array): Promise<string> {
    const { publicKey, challenge, signature } = authChallenge(secret);
    const res = await fetch(`${serverUrl}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            publicKey: encodeBase64(publicKey),
            challenge: encodeBase64(challenge),
            signature: encodeBase64(signature),
        }),
    });

    if (!res.ok) {
        throw new Error(`Auth failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as { success: boolean; token?: string };
    if (!data.success || !data.token) {
        throw new Error('Auth failed: server returned unsuccessful response');
    }

    return data.token;
}

async function authLogin(): Promise<void> {
    const stateDir = getStateDir();
    const existing = readBotCredentials(stateDir);
    if (existing) {
        console.log('Already linked. Run `auth logout` first to unlink.');
        return;
    }

    const secret = getRandomBytes(32);
    const { serverUrl } = loadConfig();

    console.log('Creating new Happy account...');
    const token = await authGetToken(serverUrl, secret);

    writeBotCredentials(stateDir, token, secret);

    const secretBackup = encodeBase64Url(secret);
    console.log('Account created and linked.');
    console.log('');
    console.log('IMPORTANT: Save this secret key for backup (you will not see it again):');
    console.log(`  ${secretBackup}`);
    console.log('');
    console.log('To restore on another device: happy-discord-bot auth restore');
}

async function authRestore(): Promise<void> {
    const stateDir = getStateDir();
    const existing = readBotCredentials(stateDir);
    if (existing) {
        console.log('Already linked. Run `auth logout` first to unlink.');
        return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const input = await rl.question('Enter secret key (base64url): ');
        const trimmed = input.trim();
        if (!trimmed) {
            console.error('No secret provided.');
            process.exit(1);
        }

        const secret = decodeBase64Url(trimmed);
        if (secret.length !== 32) {
            console.error(`Invalid secret: expected 32 bytes, got ${secret.length}`);
            process.exit(1);
        }

        const { serverUrl } = loadConfig();
        console.log('Authenticating...');
        const token = await authGetToken(serverUrl, secret);

        writeBotCredentials(stateDir, token, secret);
        console.log('Account linked.');
    } finally {
        rl.close();
    }
}

function authStatus(): void {
    const stateDir = getStateDir();
    const creds = readBotCredentials(stateDir);
    if (!creds) {
        console.log('Not linked. Run `happy-discord-bot auth login` or `auth restore`.');
        return;
    }
    console.log('Linked');
    console.log(`  Token: ${creds.token.slice(0, 8)}...`);
}

function authLogout(): void {
    const stateDir = getStateDir();
    const removed = removeBotCredentials(stateDir);
    if (removed) {
        console.log('Credentials removed.');
    } else {
        console.log('No credentials found.');
    }
}

export async function handleAuth(args: string[]): Promise<void> {
    const sub = args[0];
    switch (sub) {
        case 'login': await authLogin(); break;
        case 'restore': await authRestore(); break;
        case 'status': authStatus(); break;
        case 'logout': authLogout(); break;
        default:
            console.log('Usage: happy-discord-bot auth <login|restore|status|logout>');
            process.exit(1);
    }
}
