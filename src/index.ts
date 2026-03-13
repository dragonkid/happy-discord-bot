import { loadBotConfig } from './config.js';
import { HappyClient } from './happy/client.js';
import { DiscordBot } from './discord/bot.js';
import { handleCommand, handleSkillsAutocomplete, handleLoopAutocomplete } from './discord/commands.js';
import { parseButtonId, parseExitPlanButtonId, parsePlanModalId, parseNewSessionSelect, parseCustomPathButton, parseCustomPathModal, buildCustomPathModal, parseDeleteButtonId, parseCleanupButtonId } from './discord/buttons.js';
import { parseAskButtonId, parseSessionButtonId, handleAskButton, handleSessionButton, handleExitPlanButton, handleNewSessionSelect, handleNewSessionModal, handleDeleteButton } from './discord/interactions.js';
import { Bridge } from './bridge.js';
import { StateTracker } from './happy/state-tracker.js';
import { PermissionCache } from './happy/permission-cache.js';
import { Store } from './store.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    const store = new Store(process.env.BOT_STATE_DIR ?? join(homedir(), '.happy-discord-bot'));
    const savedState = await store.load();
    permissionCache.loadSessions(savedState.sessions);
    console.log(`[Store] Loaded ${Object.keys(savedState.sessions).length} saved session(s)`);
    const bridge = new Bridge(happy, discord, config, stateTracker, permissionCache);
    bridge.setStore(store);
    bridge.loadThreadMap(savedState.threads);
    console.log(`[Store] Loaded ${Object.keys(savedState.threads).length} saved thread(s)`);
    await bridge.start();

    // Scan skills: global (personal + plugins) + all session project dirs
    await bridge.skillRegistry.scanGlobal();
    for (const dir of bridge.getAllProjectDirs()) {
        await bridge.skillRegistry.scanProject(dir);
    }

    if (bridge.activeSession) {
        console.log(`[Bridge] Active session: ${bridge.activeSession}`);
    } else {
        console.log('[Bridge] No active sessions found');
    }

    discord.onMessage((message) => {
        if (message.author.id !== config.discord.userId) return;

        // Check if message is in a known thread -> route to that session
        const threadSessionId = bridge.getSessionByThread(message.channelId);
        if (threadSessionId) {
            // Thread message — route directly to bound session, no activeSession switch
        } else if (message.channelId !== config.discord.channelId) {
            return;
        }

        let text = message.content;

        // If requireMention is enabled, only forward messages that @ the bot
        if (config.discord.requireMention) {
            const botId = message.client.user?.id;
            const mentionPrefix = botId ? `<@${botId}>` : null;
            if (!mentionPrefix || !text.includes(mentionPrefix)) return;
            text = text.replaceAll(mentionPrefix, '').trim();
        }

        // Upload attachments if present
        const handleMessage = async () => {
            // Handle message reference (reply)
            if (message.reference?.messageId) {
                try {
                    const channel = await message.client.channels.fetch(message.channelId);
                    if (channel?.isTextBased()) {
                        const refMsg = await channel.messages.fetch(message.reference.messageId);
                        const refContent = refMsg.content || '[attachment/embed]';
                        const quotedText = refContent.split('\n').map(line => `> ${line}`).join('\n');
                        text = `${quotedText}\n\n${text}`;
                    }
                } catch (err) {
                    console.error('[Bridge] Failed to fetch referenced message:', err);
                }
            }

            if (message.attachments.size > 0) {
                const attachments = [...message.attachments.values()].map((a) => ({
                    url: a.url,
                    name: a.name,
                    contentType: a.contentType,
                    size: a.size,
                }));
                const hints = await bridge.uploadAttachments(attachments);
                if (hints.length > 0) {
                    const hintBlock = hints.join('\n');
                    text = text ? `${text}\n\n${hintBlock}` : hintBlock;
                }
            }

            if (!text) return;

            // Determine target session: thread-bound session or active session
            const targetSessionId = threadSessionId || bridge.activeSession;
            if (!targetSessionId) {
                console.error('[Index] No target session for message');
                return;
            }

            const threadId = threadSessionId ? message.channelId : undefined;
            bridge.setLastUserMessageId(message.id, threadId, targetSessionId);
            await bridge.sendMessage(text, targetSessionId);
        };

        handleMessage().catch((err) => {
            console.error('[Bridge] Failed to forward message:', err);
            if (threadSessionId) {
                discord.sendToThread(message.channelId, '\u26a0\ufe0f Failed to send message to CLI.').catch(() => {});
            } else {
                discord.send('\u26a0\ufe0f Failed to send message to CLI.').catch(() => {});
            }
        });
    });

    discord.onInteraction(async (interaction) => {
        // Autocomplete
        if (interaction.isAutocomplete()) {
            if (interaction.user.id !== config.discord.userId) {
                await interaction.respond([]);
                return;
            }
            if (interaction.commandName === 'skills') {
                try {
                    const threadId = interaction.channelId;
                    const projectDir = bridge.getProjectDirForThread(threadId)
                        ?? (bridge.activeSession ? bridge.getSessionProjectDir(bridge.activeSession) : undefined);
                    await handleSkillsAutocomplete(interaction, bridge.skillRegistry, projectDir);
                } catch (err) {
                    console.error('[Discord] Autocomplete error:', err);
                }
            } else if (interaction.commandName === 'loop') {
                try {
                    await handleLoopAutocomplete(interaction);
                } catch (err) {
                    console.error('[Discord] Loop autocomplete error:', err);
                }
            }
            return;
        }

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

            // --- New Session custom path button ---
            if (parseCustomPathButton(interaction.customId)) {
                const menuRow = interaction.message.components[0] as unknown as
                    { components?: Array<{ type: number; options?: Array<{ value: string }> }> };
                let machineId = '';
                if (menuRow?.components?.[0]?.type === 3 /* StringSelect */) {
                    const firstOption = menuRow.components[0].options?.[0];
                    if (firstOption?.value) {
                        // Index-based: re-fetch directories to get machineId
                        try {
                            const allSessions = await bridge.listAllSessions();
                            const { extractDirectories } = await import('./happy/session-metadata.js');
                            const dirs = extractDirectories(allSessions);
                            if (dirs.length > 0) machineId = dirs[0].machineId;
                        } catch {
                            // fallback: empty
                        }
                    }
                }
                if (!machineId) {
                    await interaction.reply({ content: 'No machine available.', ephemeral: true });
                    return;
                }
                try {
                    await interaction.showModal(buildCustomPathModal(machineId));
                } catch (err) {
                    console.error('[Discord] Custom path modal error:', err);
                    await interaction.reply({ content: 'Error showing path input.', ephemeral: true }).catch(() => {});
                }
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
                    const label = isTimeout ? '⏰ (Request expired)' : '⚠️ (Error processing answer)';
                    await interaction.editReply({
                        content: `${label} ${interaction.message.content}`,
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
                        content: `⚠️ (Error switching session) ${interaction.message.content}`,
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
                    const isAvailable = bridge.isSessionAvailable(planParsed.sessionId);
                    const pending = stateTracker.getPendingRequests(planParsed.sessionId);
                    const hasRequest = pending.some((r) => r.id === planParsed.requestId);

                    if (!isAvailable || !hasRequest) {
                        await interaction.update({
                            content: `⏰ (${!isAvailable ? 'Session no longer active' : 'Request expired'}) ${interaction.message.content}`,
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
                            content: `⚠️ (Error processing plan approval) ${interaction.message.content}`,
                            components: [],
                        }).catch(() => {});
                    }
                }
                return;
            }

            // --- Delete confirmation buttons ---
            const deleteParsed = parseDeleteButtonId(interaction.customId);
            if (deleteParsed) {
                await interaction.deferUpdate();
                try {
                    await handleDeleteButton(interaction, deleteParsed, bridge);
                } catch (err) {
                    console.error('[Discord] Delete button error:', err);
                    await interaction.editReply({
                        content: `⚠️ (Error processing delete) ${interaction.message.content}`,
                        components: [],
                    }).catch(() => {});
                }
                return;
            }

            // --- Cleanup confirmation buttons ---
            const cleanupParsed = parseCleanupButtonId(interaction.customId);
            if (cleanupParsed) {
                await interaction.deferUpdate();
                try {
                    if (cleanupParsed.action === 'cancel') {
                        await interaction.editReply({
                            content: `🚫 (Cancelled) ${interaction.message.content}`,
                            components: [],
                        });
                    } else {
                        await interaction.editReply({ content: 'Cleaning up...', components: [] });
                        const result = await bridge.cleanupArchivedSessions();
                        const parts = [];
                        if (result.sessions > 0) parts.push(`${result.sessions} session(s)`);
                        if (result.threads > 0) parts.push(`${result.threads} orphan thread(s)`);
                        const summary = parts.length > 0 ? parts.join(', ') : 'nothing to clean';
                        await interaction.editReply({ content: `Cleaned up ${summary}.`, components: [] });
                    }
                } catch (err) {
                    console.error('[Discord] Cleanup button error:', err);
                    await interaction.editReply({
                        content: `⚠️ (Error during cleanup) ${interaction.message.content}`,
                        components: [],
                    }).catch(() => {});
                }
                return;
            }

            // --- Permission buttons ---
            const parsed = parseButtonId(interaction.customId);
            if (!parsed) return;

            console.log(`[Discord] Permission button: action=${parsed.action} tool=${parsed.requestId.slice(0, 8)}`);
            await interaction.deferUpdate();

            try {
                const { sessionId, requestId, action } = parsed;

                // Validate session is still available
                if (!bridge.isSessionAvailable(sessionId)) {
                    await interaction.editReply({
                        content: `⏰ (Session no longer active) ${interaction.message.content}`,
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
                        bridge.persistModes();
                        break;
                    case 'for-tool': {
                        let toolIdentifier = toolName;
                        if (toolName === 'Bash' && toolInput && typeof toolInput === 'object' && 'command' in toolInput) {
                            const command = (toolInput as { command: string }).command;
                            const program = command.trimStart().split(/\s/)[0];
                            toolIdentifier = program ? `Bash(${program}:*)` : 'Bash';
                        }
                        await bridge.approvePermission(sessionId, requestId, undefined, [toolIdentifier]);
                        permissionCache.applyApproval([toolIdentifier]);
                        bridge.persistModes();
                        break;
                    }
                    case 'no':
                        await bridge.denyPermission(sessionId, requestId);
                        break;
                }

                const status = action === 'no' ? '❌ Denied' : '✅ Approved';
                const label = action === 'allow-edits' ? ' - accept all edits'
                            : action === 'for-tool' ? ` - for ${toolName}`
                            : '';
                await interaction.editReply({
                    content: `(${status}${label}) ${interaction.message.content}`,
                    components: [],
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const isExpired = msg.includes('not available');
                if (!isExpired) {
                    console.error('[Discord] Button error:', err);
                }
                const label = isExpired ? '⏰ (Request expired)' : '⚠️ (Error processing approval)';
                await interaction.editReply({
                    content: `${label} ${interaction.message.content}`,
                    components: [],
                }).catch(() => {});
            }
        }
        // StringSelectMenu interactions
        if (interaction.isStringSelectMenu()) {
            if (interaction.user.id !== config.discord.userId) {
                await interaction.reply({ content: 'Unauthorized.', ephemeral: true });
                return;
            }

            if (parseNewSessionSelect(interaction.customId)) {
                await interaction.deferUpdate();
                try {
                    await handleNewSessionSelect(interaction, bridge);
                } catch (err) {
                    console.error('[Discord] New session select error:', err);
                    await interaction.editReply({
                        content: 'Error creating session.',
                        components: [],
                    }).catch(() => {});
                }
                return;
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
                    const reason = feedback.trim() || undefined;
                    await bridge.denyPermission(modalParsed.sessionId, modalParsed.requestId, reason);
                    await interaction.editReply({
                        content: `❌ (Rejected${reason ? `: ${reason}` : ''}) ${interaction.message?.content ?? ''}`,
                        components: [],
                    });
                } catch (err) {
                    console.error('[Discord] Plan reject modal error:', err);
                    await interaction.editReply({
                        content: `⚠️ (Error processing rejection) ${interaction.message?.content ?? ''}`,
                        components: [],
                    }).catch(() => {});
                }
                return;
            }

            const newSessModal = parseCustomPathModal(interaction.customId);
            if (newSessModal) {
                await interaction.deferUpdate();
                try {
                    await handleNewSessionModal(interaction, newSessModal.machineId, bridge);
                } catch (err) {
                    console.error('[Discord] New session modal error:', err);
                    await interaction.editReply({
                        content: 'Error creating session.',
                        components: [],
                    }).catch(() => {});
                }
                return;
            }
        }
    });

    await discord.start();
    console.log('[Discord] Bot online');

    // Create threads for sessions that don't have one (requires Discord bot to be online)
    await bridge.ensureThreadsForSessions();

    // Replay pending permission requests from all sessions (requires threads to exist)
    await bridge.replayPendingPermissions();

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
