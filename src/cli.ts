#!/usr/bin/env node

export interface ParsedArgs {
    command: string;
    args: string[];
}

const COMMANDS = new Set(['start', 'daemon', 'update', 'version', 'init', 'deploy-commands']);

export function parseArgs(argv: string[]): ParsedArgs {
    const first = argv[0];

    if (!first || (!COMMANDS.has(first) && first !== '--version')) {
        return { command: 'start', args: argv };
    }

    if (first === '--version') {
        return { command: 'version', args: [] };
    }

    return { command: first, args: argv.slice(1) };
}

async function main(): Promise<void> {
    const { command, args } = parseArgs(process.argv.slice(2));

    switch (command) {
        case 'version': {
            const { getVersion } = await import('./version.js');
            console.log(`happy-discord-bot v${getVersion()}`);
            break;
        }
        case 'start': {
            await import('./index.js');
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

const isDirectRun = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts');
if (isDirectRun) {
    main().catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
