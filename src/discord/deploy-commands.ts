import { REST, Routes } from 'discord.js';
import { commandDefinitions } from './commands.js';

export async function autoDeployCommands(): Promise<void> {
    const token = process.env.DISCORD_TOKEN;
    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (!token || !applicationId) return;

    const rest = new REST().setToken(token);
    const guildId = process.env.DISCORD_GUILD_ID;

    if (guildId) {
        console.log(`Deploying ${commandDefinitions.length} commands to guild ${guildId}...`);
        await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
            body: commandDefinitions,
        });
        console.log('Guild commands deployed (available immediately).');
    } else {
        console.log(`Deploying ${commandDefinitions.length} commands globally...`);
        await rest.put(Routes.applicationCommands(applicationId), {
            body: commandDefinitions,
        });
        console.log('Global commands deployed (may take up to 1 hour to propagate).');
    }
}

// Run as standalone script when executed directly
const isDirectRun = process.argv[1]?.endsWith('deploy-commands.js') || process.argv[1]?.endsWith('deploy-commands.ts');
if (isDirectRun) {
    const { config } = await import('dotenv');
    config();

    autoDeployCommands()
        .then(() => console.log('Done.'))
        .catch((err) => { console.error('Deploy failed:', err); process.exit(1); });
}
