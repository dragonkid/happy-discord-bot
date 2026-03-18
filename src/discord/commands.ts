import {
    SlashCommandBuilder,
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Bridge } from '../bridge.js';
import { buildSessionButtons, buildNewSessionMenu, buildCustomPathOnly, buildDeleteConfirmButtons, buildCleanupConfirmButtons } from './buttons.js';
import { extractDirectories, extractMachines } from '../happy/session-metadata.js';
import type { PermissionMode } from '../happy/types.js';
import { queryUsage } from '../happy/usage.js';
import { formatUsage } from './formatter.js';
import type { SkillRegistry } from '../happy/skill-registry.js';
import { getVersion } from '../version.js';
import { relativeTime } from '../cli/daemon.js';

// --- Command definitions ---

const sessions = new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('List active Claude Code sessions');

const stop = new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Abort the current Claude Code operation');

const compact = new SlashCommandBuilder()
    .setName('compact')
    .setDescription('Compact the current session context');

const mode = new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Set permission approval mode')
    .addStringOption((opt) =>
        opt
            .setName('mode')
            .setDescription('Permission mode')
            .setRequired(true)
            .addChoices(
                { name: 'default — Ask for every tool call', value: 'default' },
                { name: 'accept-edits — Auto-approve Read/Edit/Write', value: 'acceptEdits' },
                { name: 'bypass — Auto-approve everything', value: 'bypassPermissions' },
                { name: 'plan — Require plan approval before edits', value: 'plan' },
            ),
    );

const newSession = new SlashCommandBuilder()
    .setName('new')
    .setDescription('Create a new Claude Code session');

const archive = new SlashCommandBuilder()
    .setName('archive')
    .setDescription('Archive (kill) a Claude Code session')
    .addStringOption((opt) =>
        opt.setName('session').setDescription('Session ID prefix (default: current)').setRequired(false),
    );

const deleteCmd = new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Permanently delete a Claude Code session')
    .addStringOption((opt) =>
        opt.setName('session').setDescription('Session ID prefix (default: current)').setRequired(false),
    );

const cleanup = new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Delete all archived sessions and their threads');

const usage = new SlashCommandBuilder()
    .setName('usage')
    .setDescription('Show token usage and cost')
    .addStringOption((opt) =>
        opt
            .setName('period')
            .setDescription('Time period (default: session in thread, today in channel)')
            .setRequired(false)
            .addChoices(
                { name: 'today', value: 'today' },
                { name: '7 days', value: '7d' },
                { name: '30 days', value: '30d' },
            ),
    );

const skills = new SlashCommandBuilder()
    .setName('skills')
    .setDescription('List, search, or invoke Claude Code skills/commands')
    .addStringOption((opt) =>
        opt.setName('name').setDescription('Skill/command name or "reload"').setRequired(false).setAutocomplete(true),
    )
    .addStringOption((opt) =>
        opt.setName('args').setDescription('Arguments to pass to the skill').setRequired(false),
    );

const loop = new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Run a prompt or skill on a recurring interval')
    .addStringOption((opt) =>
        opt.setName('args').setDescription('e.g. "list", "delete <id>", "5m /compact"').setRequired(false).setAutocomplete(true),
    );

const approve = new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Approve a Happy account auth request (paste happy:// URL next)');

const update = new SlashCommandBuilder()
    .setName('update')
    .setDescription('Check for updates and upgrade the bot');

const allCommands = [sessions, stop, compact, mode, newSession, archive, deleteCmd, cleanup, usage, skills, loop, approve, update];

export const commandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] =
    allCommands.map((cmd) => cmd.toJSON());

// --- Command handler ---

export async function handleCommand(
    interaction: ChatInputCommandInteraction,
    bridge: Bridge,
): Promise<void> {
    console.log(`[Commands] /${interaction.commandName}`, interaction.options.data?.map((o) => `${o.name}=${o.value}`).join(' ') ?? '');
    switch (interaction.commandName) {
        case 'sessions':
            return handleSessions(interaction, bridge);
        case 'stop':
            return handleStop(interaction, bridge);
        case 'compact':
            return handleCompact(interaction, bridge);
        case 'mode':
            return handleMode(interaction, bridge);
        case 'new':
            return handleNewSession(interaction, bridge);
        case 'archive':
            return handleArchive(interaction, bridge);
        case 'delete':
            return handleDelete(interaction, bridge);
        case 'cleanup':
            return handleCleanup(interaction, bridge);
        case 'usage':
            return handleUsage(interaction, bridge);
        case 'skills':
            return handleSkills(interaction, bridge);
        case 'loop':
            return handleLoop(interaction, bridge);
        case 'approve':
            return handleApprove(interaction, bridge);
        case 'update':
            return handleUpdateCommand(interaction, bridge);
        default:
            await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
    }
}

// --- Helpers ---

function extractHost(metadata: unknown): string {
    if (!metadata || typeof metadata !== 'object') return 'unknown';
    const m = metadata as Record<string, unknown>;
    if (typeof m.host === 'string') return m.host;
    if (typeof m.machineId === 'string') return (m.machineId as string).slice(0, 8);
    return 'unknown';
}

function extractMachineId(metadata: unknown): string {
    if (!metadata || typeof metadata !== 'object') return 'unknown';
    const m = metadata as Record<string, unknown>;
    return typeof m.machineId === 'string' ? m.machineId : 'unknown';
}

function extractPath(metadata: unknown): string {
    if (!metadata || typeof metadata !== 'object') return 'unknown';
    const m = metadata as Record<string, unknown>;
    return typeof m.path === 'string' ? m.path : 'unknown';
}

// --- Handlers ---

async function handleSessions(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();

    const [sessions, machines] = await Promise.all([
        bridge.listAllSessions(),
        bridge.listMachines(),
    ]);
    const machineEntries = extractMachines(machines);

    if (sessions.length === 0 && machineEntries.length === 0) {
        await interaction.editReply('No machines or sessions found.');
        return;
    }

    // In a thread, "current" = thread-bound session; in main channel, "current" = activeSession
    const threadSession = bridge.getSessionByThread(interaction.channelId);
    const currentSessionId = threadSession ?? bridge.activeSession;

    // Build machine map from machines API
    type MachineGroup = { host: string; active: boolean; sessions: typeof sessions };
    const machineMap = new Map<string, MachineGroup>();
    for (const m of machineEntries) {
        machineMap.set(m.machineId, { host: m.host, active: m.active, sessions: [] });
    }

    // Assign sessions to machines
    const sorted = [...sessions].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.activeAt - a.activeAt;
    });
    for (const s of sorted) {
        const machineId = extractMachineId(s.metadata);
        const host = extractHost(s.metadata);
        if (!machineMap.has(machineId)) {
            machineMap.set(machineId, { host, active: false, sessions: [] });
        }
        machineMap.get(machineId)!.sessions.push(s);
    }

    // Format: Connected Machines
    const sections: string[] = ['**Connected Machines**'];
    for (const [machineId, { host, active, sessions: machineSessions }] of machineMap) {
        const status = active ? 'online' : 'offline';
        sections.push(`  **${host}** (${machineId.slice(0, 8)}) [${status}]`);
        if (machineSessions.length === 0) {
            sections.push('    No sessions');
        } else {
            for (const s of machineSessions) {
                const path = extractPath(s.metadata);
                const marker = s.id === currentSessionId ? '  **← current**' : '';
                const icon = s.active ? '🟢' : '⚪';
                const yolo = (s.metadata as unknown as Record<string, unknown>)?.dangerouslySkipPermissions ? ' [YOLO]' : '';
                sections.push(`    ${icon}${yolo} \`${s.id.slice(0, 7)}\` ${path}  ${relativeTime(s.activeAt)}${marker}`);
            }
        }
    }
    sections.push(`\nBot v${getVersion()}`);

    const allLines = sections.join('\n');
    const content = allLines.length > 1900 ? allLines.slice(0, 1900) + '\n...(truncated)' : allLines;

    const activeSessions = sorted.filter((s) => s.active);
    const buttons = activeSessions.length > 0
        ? buildSessionButtons(activeSessions, bridge.activeSession)
        : [];

    await interaction.editReply({
        content,
        components: buttons,
    });
}

async function handleStop(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        await bridge.stopSession(sessionId);
        await interaction.editReply('Stop requested.');
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to stop: ${detail}`);
    }
}

async function handleCompact(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        const reply = await interaction.editReply('Compacting session...');
        await bridge.compactSession(sessionId, reply.id);
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to compact: ${detail}`);
    }
}

async function handleMode(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    const modeValue = interaction.options.getString('mode', true) as PermissionMode;
    await interaction.deferReply();

    bridge.permissions.setMode(modeValue);
    bridge.persistModes();
    await interaction.editReply(`Permission mode set to: **${modeValue}**`);
}

async function handleNewSession(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();

    const allSessions = await bridge.listAllSessions();
    const directories = extractDirectories(allSessions);

    const machines = await bridge.listMachines();
    const entries = extractMachines(machines).filter(m => m.active);

    if (directories.length === 0) {
        // No sessions — show custom path buttons for active machines
        if (entries.length === 0) {
            await interaction.editReply('No machines found. Make sure the happy daemon is running and paired.');
            return;
        }
        const components = buildCustomPathOnly(entries);
        const content = entries.length === 1
            ? `Connected to **${entries[0].host}**. Enter a directory path to start a new session:`
            : `${entries.length} machines connected. Select a machine to start a new session:`;
        await interaction.editReply({ content, components });
        return;
    }

    // Deduplicate machines from directories (for menu labels + custom path buttons)
    const seenMachines = new Map<string, { machineId: string; host: string }>();
    for (const dir of directories) {
        if (!seenMachines.has(dir.machineId)) {
            seenMachines.set(dir.machineId, { machineId: dir.machineId, host: dir.host });
        }
    }
    // Also include active machines that may not have sessions in the directory list
    for (const m of entries) {
        if (!seenMachines.has(m.machineId)) {
            seenMachines.set(m.machineId, { machineId: m.machineId, host: m.host });
        }
    }
    const machineList = Array.from(seenMachines.values());

    const components = buildNewSessionMenu(directories, machineList);
    await interaction.editReply({
        content: 'Select a directory for the new session:',
        components,
    });
}

function resolveSessionFromContext(interaction: ChatInputCommandInteraction, bridge: Bridge): string {
    const prefix = interaction.options.getString('session');
    if (prefix) return prefix;

    const threadSession = bridge.getSessionByThread(interaction.channelId);
    if (threadSession) return threadSession;

    const active = bridge.activeSession;
    if (!active) throw new Error('No active session. Use /sessions to check available sessions.');
    return active;
}

async function handleArchive(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        await bridge.archiveSession(sessionId);
        await interaction.editReply(`Session \`${sessionId.slice(0, 8)}\` archived.`);
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to archive: ${detail}`);
    }
}

async function handleDelete(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        const buttons = buildDeleteConfirmButtons(sessionId);
        await interaction.editReply({
            content: `⚠️ Permanently delete session \`${sessionId.slice(0, 8)}\`? This removes all messages and data.`,
            components: buttons,
        });
    } catch (err) {
        // If in an orphaned thread (no mapped session), delete it directly
        if (interaction.channel?.isThread()) {
            await interaction.editReply('Deleting orphaned thread...');
            await interaction.channel.delete().catch(() => {});
            return;
        }
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed: ${detail}`);
    }
}

async function handleCleanup(interaction: ChatInputCommandInteraction, _bridge: Bridge): Promise<void> {
    await interaction.deferReply();
    try {
        const buttons = buildCleanupConfirmButtons();
        await interaction.editReply({
            content: '⚠️ Delete all archived sessions and orphan threads? This is irreversible.',
            components: buttons,
        });
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed: ${detail}`);
    }
}

async function handleUsage(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    try {
        const period = interaction.options.getString('period') as 'today' | '7d' | '30d' | null;
        const threadSession = bridge.getSessionByThread(interaction.channelId);

        if (period) {
            const now = Math.floor(Date.now() / 1000);
            const startTime = period === 'today'
                ? todayMidnight()
                : period === '7d'
                    ? now - 7 * 86400
                    : now - 30 * 86400;
            const groupBy = period === 'today' ? 'hour' as const : 'day' as const;

            const result = await queryUsage(bridge.happyClient, { startTime, groupBy });
            await interaction.editReply(formatUsage(result, period));
        } else if (threadSession) {
            const result = await queryUsage(bridge.happyClient, { sessionId: threadSession });
            await interaction.editReply(formatUsage(result, 'session', threadSession));
        } else {
            const result = await queryUsage(bridge.happyClient, { startTime: todayMidnight(), groupBy: 'hour' });
            await interaction.editReply(formatUsage(result, 'today'));
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error';
        await interaction.editReply(`Failed to query usage: ${detail}`);
    }
}

function todayMidnight(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

// --- /skills handler ---

async function handleSkills(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    await interaction.deferReply();

    const name = interaction.options.getString('name');
    const args = interaction.options.getString('args');

    const projectDir = bridge.getProjectDirForThread(interaction.channelId)
        ?? (bridge.activeSession ? bridge.getSessionProjectDir(bridge.activeSession) : undefined);

    if (!name) {
        // List all available skills
        const entries = bridge.skillRegistry.getForSession(projectDir);
        if (entries.length === 0) {
            await interaction.editReply('No skills or commands found.');
            return;
        }
        const lines = entries.map((e) => {
            const prefix = e.source === 'plugin' ? '🔌' : e.source === 'project' ? '📁' : '👤';
            return `${prefix} \`/${e.name}\` — ${e.description || '(no description)'}`;
        });

        // Split into chunks that fit Discord's 2000-char limit
        const chunks: string[] = [];
        let current = '';
        for (const line of lines) {
            const next = current ? `${current}\n${line}` : line;
            if (next.length > 1900) {
                chunks.push(current);
                current = line;
            } else {
                current = next;
            }
        }
        if (current) chunks.push(current);

        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
        }
        return;
    }

    if (name === 'reload') {
        await bridge.skillRegistry.scanGlobal();
        for (const dir of bridge.getAllProjectDirs()) {
            await bridge.skillRegistry.scanProject(dir);
        }
        const count = bridge.skillRegistry.getForSession(projectDir).length;
        await interaction.editReply(`Reloaded — ${count} skills/commands available.`);
        return;
    }

    // Execute: send as slash command to session
    if (!/^[\w:.-]+$/.test(name)) {
        await interaction.editReply('Invalid skill name.');
        return;
    }
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        const message = args ? `/${name} ${args}` : `/${name}`;
        await bridge.sendMessage(message, sessionId);
        await interaction.editReply(`Sent \`${message}\``);
    } catch {
        await interaction.editReply('No active session. Use /sessions to connect.');
    }
}

// --- /loop handler ---

const LOOP_USAGE = [
    '**Usage:** `/loop [args]`',
    '',
    '`/loop 5m /compact` — run /compact every 5 minutes',
    '`/loop 10m check deploy` — check deploy every 10 minutes',
    '`/loop list` — list scheduled jobs',
    '`/loop delete <id>` — delete a scheduled job',
].join('\n');

async function handleLoop(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    const args = interaction.options.getString('args');

    if (!args) {
        await interaction.reply({ content: LOOP_USAGE, ephemeral: true });
        return;
    }

    await interaction.deferReply();
    try {
        const sessionId = resolveSessionFromContext(interaction, bridge);
        const message = `/loop ${args}`;
        await bridge.sendMessage(message, sessionId);
        await interaction.editReply(`Sent \`${message}\``);
    } catch {
        await interaction.editReply('No active session. Use /sessions to connect.');
    }
}

// --- /approve handler ---

const PENDING_APPROVE_TIMEOUT_MS = 60_000;

async function handleApprove(interaction: ChatInputCommandInteraction, bridge: Bridge): Promise<void> {
    if (bridge.pendingApprove) {
        await interaction.reply({ content: 'Already waiting for a happy:// URL. Paste the URL or wait for timeout.', ephemeral: true });
        return;
    }

    bridge.setPendingApprove(interaction.channelId, PENDING_APPROVE_TIMEOUT_MS);
    await interaction.reply('Paste the `happy://` URL from your `auth login` output within 60 seconds.');
}

// --- /update handler ---

async function handleUpdateCommand(interaction: ChatInputCommandInteraction, _bridge: Bridge): Promise<void> {
    await interaction.deferReply();

    const { checkForUpdate, performDiscordUpdate } = await import('../cli/update.js');
    const currentVersion = getVersion();
    const latest = await checkForUpdate(currentVersion);

    if (!latest) {
        await interaction.editReply(`Already on latest version (v${currentVersion}).`);
        return;
    }

    await interaction.editReply(`Updating to v${latest}...`);

    const success = await performDiscordUpdate(latest);

    if (!success) {
        await interaction.editReply(`Update to v${latest} failed. Still running v${currentVersion}.`);
        return;
    }

    await interaction.editReply(`Updated to v${latest}. Restarting...`);
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1000);
}

// --- /loop autocomplete ---

const LOOP_SUGGESTIONS = [
    { name: 'list — Show scheduled jobs', value: 'list' },
    { name: 'delete <id> — Cancel a scheduled job', value: 'delete ' },
    { name: '5m — Every 5 minutes', value: '5m ' },
    { name: '10m — Every 10 minutes', value: '10m ' },
    { name: '30m — Every 30 minutes', value: '30m ' },
    { name: '1h — Every hour', value: '1h ' },
];

export async function handleLoopAutocomplete(
    interaction: AutocompleteInteraction,
): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();

    const filtered = focused
        ? LOOP_SUGGESTIONS.filter((s) => s.value.startsWith(focused) || s.name.toLowerCase().includes(focused))
        : LOOP_SUGGESTIONS;

    await interaction.respond(filtered.slice(0, 25));
}
// --- /skills autocomplete ---

const MAX_AUTOCOMPLETE = 25;

export async function handleSkillsAutocomplete(
    interaction: AutocompleteInteraction,
    registry: SkillRegistry,
    projectDir?: string,
): Promise<void> {
    const focused = interaction.options.getFocused();
    const results = registry.search(focused, projectDir);

    const reloadOption = { name: '🔄 reload — Re-scan skills from disk', value: 'reload' };
    const showReload = !focused || 'reload'.includes(focused.toLowerCase());

    const choices = results.map((e) => ({ name: e.name, value: e.name }));

    if (showReload) {
        choices.unshift(reloadOption);
    }

    await interaction.respond(choices.slice(0, MAX_AUTOCOMPLETE));
}
