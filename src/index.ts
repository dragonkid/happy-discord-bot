import { loadBotConfig } from './config.js';
import { HappyClient } from './happy/client.js';
import { DiscordBot } from './discord/bot.js';
import { handleCommand } from './discord/commands.js';
import { parseButtonId, parseExitPlanButtonId, parsePlanModalId } from './discord/buttons.js';
import { parseAskButtonId, parseSessionButtonId, handleAskButton, handleSessionButton, handleExitPlanButton } from './discord/interactions.js';
import { Bridge } from './bridge.js';
import { StateTracker } from './happy/state-tracker.js';
import { PermissionCache } from './happy/permission-cache.js';

// Patch console to prepend timestamps
const origLog = console.log;
const origError = console.error;
const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
console.log = (...args: unknown[]) => origLog(ts(), ...args);
console.error = (...args: unknown[]) => origError(ts(), ...args);

async function main(): Promise<void> {
    const config = loadBotConfig();
    console.log(`Happy server: ${config.happy.serverUrl}`);
    console.log(`Discord channel: ${config.discord.channelId}`);

    // --- Happy relay ---
    const happy = new HappyClient(config.happy, config.credentials);

    happy.on('connected', () => {
        console.log('[Happy] Connected to relay');
    });

    happy.on('disconnected', (reason) => {
        console.log(`[Happy] Disconnected: ${reason}`);
    });

    happy.connect();

    // --- Discord bot ---
    const discord = new DiscordBot(config.discord);

    // --- Bridge ---
    const stateTracker = new StateTracker();
    const permissionCache = new PermissionCache();
    const bridge = new Bridge(happy, discord, config, stateTracker, permissionCache);
    await bridge.start();

    if (bridge.activeSession) {
        console.log(`[Bridge] Active session: ${bridge.activeSession}`);
    } else {
        console.log('[Bridge] No active sessions found');
    }

    discord.onInteraction(async (interaction) => {
        // Slash commands
        if (interaction.isChatInputCommand()) {
            if (interaction.user.id !== config.discord.userId) {
                await interaction.reply({ content: 'Unauthorized.', ephemeral: true });
                return;
            }
            try {
                await handleCommand(interaction, bridge);
            } catch (err) {
                console.error('[Discord] Command error:', err);
                const reply = interaction.deferred
                    ? interaction.editReply('An error occurred.')
                    : interaction.reply({ content: 'An error occurred.', ephemeral: true });
                await reply.catch(() => {});
            }
            return;
        }

        // Button interactions
        if (interaction.isButton()) {
            if (interaction.user.id !== config.discord.userId) {
                await interaction.reply({ content: 'Unauthorized.', ephemeral: true });
                return;
            }

            // --- AskUserQuestion buttons ---
            const askParsed = parseAskButtonId(interaction.customId);
            if (askParsed) {
                await interaction.deferUpdate();
                try {
                    await handleAskButton(interaction, askParsed, bridge, stateTracker);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    const isTimeout = msg.includes('timed out') || msg.includes('not available');
                    if (!isTimeout) {
                        console.error('[Discord] AskUserQuestion button error:', err);
                    }
                    const label = isTimeout ? '*Request expired*' : '*Error processing answer*';
                    await interaction.editReply({
                        content: `${interaction.message.content}\n\n${label}`,
                        components: [],
                    }).catch(() => {});
                }
                return;
            }

            // --- Session buttons ---
            const sessParsed = parseSessionButtonId(interaction.customId);
            if (sessParsed) {
                await interaction.deferUpdate();
                try {
                    await handleSessionButton(interaction, sessParsed, bridge);
                } catch (err) {
                    console.error('[Discord] Session switch error:', err);
                    await interaction.editReply({
                        content: `${interaction.message.content}\n\n*Error switching session*`,
                        components: [],
                    }).catch(() => {});
                }
                return;
            }

            // --- ExitPlanMode buttons ---
            const planParsed = parseExitPlanButtonId(interaction.customId);
            if (planParsed) {
                if (planParsed.action === 'reject') {
                    // showModal requires un-deferred interaction — validate guards first
                    const isActive = planParsed.sessionId === bridge.activeSession;
                    const pending = stateTracker.getPendingRequests(planParsed.sessionId);
                    const hasRequest = pending.some((r) => r.id === planParsed.requestId);

                    if (!isActive || !hasRequest) {
                        await interaction.update({
                            content: `${interaction.message.content}\n\n*${!isActive ? 'Session no longer active' : 'Request expired'}*`,
                            components: [],
                        });
                        return;
                    }
                    try {
                        await handleExitPlanButton(interaction, planParsed, bridge, stateTracker);
                    } catch (err) {
                        console.error('[Discord] ExitPlanMode button error:', err);
                        await interaction.reply({
                            content: 'Error showing rejection form.',
                            ephemeral: true,
                        }).catch(() => {});
                    }
                } else {
                    await interaction.deferUpdate();
                    try {
                        await handleExitPlanButton(interaction, planParsed, bridge, stateTracker);
                    } catch (err) {
                        console.error('[Discord] ExitPlanMode button error:', err);
                        await interaction.editReply({
                            content: `${interaction.message.content}\n\n*Error processing plan approval*`,
                            components: [],
                        }).catch(() => {});
                    }
                }
                return;
            }

            // --- Permission buttons ---
            const parsed = parseButtonId(interaction.customId);
            if (!parsed) return;

            await interaction.deferUpdate();

            try {
                const { sessionId, requestId, action } = parsed;

                // Validate session is still active
                if (sessionId !== bridge.activeSession) {
                    await interaction.editReply({
                        content: `${interaction.message.content}\n\n*Session no longer active*`,
                        components: [],
                    });
                    return;
                }

                const pending = stateTracker.getPendingRequests(sessionId);
                const request = pending.find((r) => r.id === requestId);
                const toolName = request?.tool ?? 'Unknown';
                const toolInput = request?.arguments;

                switch (action) {
                    case 'yes':
                        await bridge.approvePermission(sessionId, requestId);
                        break;
                    case 'allow-edits':
                        await bridge.approvePermission(sessionId, requestId, 'acceptEdits');
                        permissionCache.applyApproval([], 'acceptEdits');
                        break;
                    case 'for-tool': {
                        let toolIdentifier = toolName;
                        if (toolName === 'Bash' && toolInput && typeof toolInput === 'object' && 'command' in toolInput) {
                            toolIdentifier = `Bash(${(toolInput as { command: string }).command})`;
                        }
                        await bridge.approvePermission(sessionId, requestId, undefined, [toolIdentifier]);
                        permissionCache.applyApproval([toolIdentifier]);
                        break;
                    }
                    case 'no':
                        await bridge.denyPermission(sessionId, requestId);
                        break;
                }

                const status = action === 'no' ? 'Denied' : 'Approved';
                const label = action === 'allow-edits' ? ' (accept all edits)'
                            : action === 'for-tool' ? ` (for ${toolName})`
                            : '';
                await interaction.editReply({
                    content: `${interaction.message.content}\n\n*${status}${label}*`,
                    components: [],
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const isExpired = msg.includes('not available');
                if (!isExpired) {
                    console.error('[Discord] Button error:', err);
                }
                const label = isExpired ? '*Request expired*' : '*Error processing approval*';
                await interaction.editReply({
                    content: `${interaction.message.content}\n\n${label}`,
                    components: [],
                }).catch(() => {});
            }
        }
        // Modal submissions (ExitPlanMode reject feedback)
        if (interaction.isModalSubmit()) {
            if (interaction.user.id !== config.discord.userId) {
                await interaction.reply({ content: 'Unauthorized.', ephemeral: true });
                return;
            }

            const modalParsed = parsePlanModalId(interaction.customId);
            if (modalParsed) {
                await interaction.deferUpdate();
                try {
                    const feedback = interaction.fields.getTextInputValue('feedback');
                    const reason = feedback.trim() || 'Plan rejected';
                    await bridge.denyPermission(modalParsed.sessionId, modalParsed.requestId, reason);
                    await interaction.editReply({
                        content: `${interaction.message?.content ?? ''}\n\n*Rejected: ${reason}*`,
                        components: [],
                    });
                } catch (err) {
                    console.error('[Discord] Plan reject modal error:', err);
                    await interaction.editReply({
                        content: `${interaction.message?.content ?? ''}\n\n*Error processing rejection*`,
                        components: [],
                    }).catch(() => {});
                }
            }
        }
    });

    await discord.start();
    console.log('[Discord] Bot online');

    // --- Graceful shutdown ---
    process.on('SIGINT', () => {
        console.log('Shutting down...');
        happy.close();
        discord.destroy();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
