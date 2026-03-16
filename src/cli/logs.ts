import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getStateDir } from '../state-dir.js';

export async function handleLogs(): Promise<void> {
    const stateDir = getStateDir();
    const logPath = join(stateDir, 'daemon.log');

    if (!existsSync(logPath)) {
        console.error(`No log file found at ${logPath}`);
        console.error('Start the daemon first: happy-discord-bot daemon start');
        return void process.exit(1);
    }

    const child = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
    return new Promise<void>((resolve, reject) => {
        child.on('close', () => resolve());
        child.on('error', (err) => {
            console.error(`Failed to tail log: ${err.message}`);
            reject(err);
        });
    });
}
