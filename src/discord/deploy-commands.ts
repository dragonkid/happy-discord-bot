// src/discord/deploy-commands.ts
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commandDefinitions } from './commands.js';

async function main(): Promise<void> {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error('DISCORD_TOKEN is required');
    }

    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (!applicationId) {
        throw new Error(
            'DISCORD_APPLICATION_ID is required. '
            + 'Find it at https://discord.com/developers/applications → General Information → Application ID',
        );
    }

    const guildId = process.env.DISCORD_GUILD_ID;

    const rest = new REST().setToken(token);

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

main().catch((err) => {
    console.error('Deploy failed:', err);
    process.exit(1);
});
