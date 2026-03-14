#!/usr/bin/env node

export interface ParsedArgs {
    command: string;
    args: string[];
}

const COMMANDS = new Set(['start', 'daemon', 'update', 'version', 'init', 'deploy-commands', 'help', 'auth']);

export function parseArgs(argv: string[]): ParsedArgs {
    const first = argv[0];

    if (!first || (!COMMANDS.has(first) && !first.startsWith('-'))) {
        return { command: 'start', args: argv };
    }

    if (first === '--version') {
        return { command: 'version', args: [] };
    }

    if (first === '--help' || first === '-h') {
        return { command: 'help', args: [] };
    }

    return { command: first, args: argv.slice(1) };
}

async function main(): Promise<void> {
    const { command, args } = parseArgs(process.argv.slice(2));

    switch (command) {
        case 'help': {
            const { getVersion } = await import('./version.js');
            console.log(`happy-discord-bot v${getVersion()}

Usage: happy-discord-bot [command]

Commands:
  start               Run the bot (default)
  auth <action>       Manage Happy account (login|restore|status|logout)
  daemon <action>     Manage background daemon (start|stop|status)
  update              Check for updates and upgrade
  init                Interactive config setup
  deploy-commands     Register Discord slash commands
  version             Show version
  help                Show this help message

Options:
  --version, -v       Show version
  --help, -h          Show this help message`);
            break;
        }
        case 'version': {
            const { getVersion } = await import('./version.js');
            console.log(`happy-discord-bot v${getVersion()}`);
            break;
        }
        case 'start': {
            await import('./index.js');
            break;
        }
        case 'auth': {
            const { handleAuth } = await import('./cli/auth.js');
            await handleAuth(args);
            break;
        }
        case 'daemon': {
            const { handleDaemon } = await import('./cli/daemon.js');
            await handleDaemon(args);
            break;
        }
        case 'update': {
            const { handleUpdate } = await import('./cli/update.js');
            await handleUpdate(args);
            break;
        }
        case 'init': {
            const { handleInit } = await import('./cli/init.js');
            await handleInit();
            break;
        }
        case 'deploy-commands': {
            // Import config.js to trigger env var loading (resolveEnvFile + dotenv)
            await import('./config.js');
            const { autoDeployCommands } = await import('./discord/deploy-commands.js');
            await autoDeployCommands();
            break;
        }
        default:
            console.error(`Unknown command: ${command}`);
            process.exit(1);
    }
}

import { realpathSync } from 'node:fs';

const resolvedArgv = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return process.argv[1] ?? ''; } })();
const isDirectRun = resolvedArgv.endsWith('cli.js') || resolvedArgv.endsWith('cli.ts');
if (isDirectRun) {
    main().catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
