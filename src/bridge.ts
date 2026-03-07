import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { HappyClient } from './happy/client.js';
import type { DiscordBot } from './discord/bot.js';
import type { BotConfig } from './config.js';
import { encrypt, encodeBase64, decrypt, decodeBase64 } from './vendor/encryption.js';
import { listActiveSessions, listSessions, deleteSession as apiDeleteSession, type DecryptedSession } from './vendor/api.js';
import type { StateTracker } from './happy/state-tracker.js';
import type { PermissionCache } from './happy/permission-cache.js';
import type { Store } from './store.js';
import { buildPermissionButtons, buildAskButtons, buildExitPlanButtons } from './discord/buttons.js';
import { formatPermissionRequest, formatAskUserQuestion, formatExitPlanMode, formatTodoWrite } from './discord/formatter.js';
import type { TodoItem } from './discord/formatter.js';
import { isExitPlanMode } from './happy/types.js';
import type { PermissionRequest, PermissionResponse, PermissionMode, AgentState, AskUserQuestionInput, WriteFileResponse } from './happy/types.js';
import { threadName } from './happy/session-metadata.js';

const DISCONNECT_DEBOUNCE_MS = 5_000;
const TYPING_INTERVAL_MS = 8_000;
const THINKING_EMOJI = '🤔';
const TOOL_USE_EMOJI = '🔧';
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ATTACHMENT_DIR = '.attachments';
const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface DiscordAttachment {
    url: string;
    name: string;
    contentType: string | null;
    size: number;
}

export class Bridge {
    private readonly happy: HappyClient;
    private readonly discord: DiscordBot;
    private readonly config: BotConfig;
    private readonly stateTracker: StateTracker;
    private readonly permissionCache: PermissionCache;
    private readonly multiSelectState = new Map<string, Set<number>>();
    private readonly sessionToThread = new Map<string, string>();
    private readonly threadToSession = new Map<string, string>();
    private activeSessionId: string | null = null;
    private store: Store | null = null;
    private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private initialConnectDone = false;
    private typingInterval: ReturnType<typeof setInterval> | null = null;
    private thinkingEmoji = false;
    private toolUseEmoji = false;
    private lastUserMsgId: string | null = null;
    private lastUserMsgThreadId: string | null = null;
    private isThinking = false;
    private todoMessageId: string | null = null;

    constructor(
        happy: HappyClient,
        discord: DiscordBot,
        config: BotConfig,
        stateTracker: StateTracker,
        permissionCache: PermissionCache,
    ) {
        this.happy = happy;
        this.discord = discord;
        this.config = config;
        this.stateTracker = stateTracker;
        this.permissionCache = permissionCache;
    }

    setActiveSession(sessionId: string): void {
        this.stopTypingLoop();
        this.updateThinkingEmoji(false);
        this.updateToolUseEmoji(false);
        this.isThinking = false;
        this.lastUserMsgId = null;
        this.lastUserMsgThreadId = null;
        this.todoMessageId = null;
        if (this.activeSessionId) {
            this.permissionCache.saveSession(this.activeSessionId);
        }
        this.activeSessionId = sessionId;
        this.permissionCache.restoreSession(sessionId);
        this.multiSelectState.clear();
    }

    get activeSession(): string | null {
        return this.activeSessionId;
    }

    get permissions(): PermissionCache {
        return this.permissionCache;
    }

    setStore(store: Store): void {
        this.store = store;
    }

    persistModes(): void {
        if (!this.store) return;
        if (this.activeSessionId) {
            this.permissionCache.saveSession(this.activeSessionId);
        }
        this.store.save({ sessions: this.permissionCache.getAllSessions(), threads: this.getThreadMap() }).catch((err) => {
            console.error('[Bridge] Failed to persist modes:', err);
        });
    }

    setLastUserMessageId(messageId: string, threadId?: string): void {
        this.lastUserMsgId = messageId;
        this.lastUserMsgThreadId = threadId ?? null;
    }

    /** Handle ephemeral activity update (session-alive keepalive). */
    handleEphemeralActivity(sessionId: string, thinking: boolean): void {
        if (sessionId !== this.activeSessionId) return;
        if (thinking === this.isThinking) return;

        if (thinking) {
            this.startTypingLoop();
            this.updateThinkingEmoji(true);
        } else {
            this.stopTypingLoop();
            this.updateThinkingEmoji(false);
        }
        this.isThinking = thinking;
    }

    async sendMessage(text: string): Promise<void> {
        const sessionId = this.requireActiveSession();
        console.log(`[Bridge] Sending message to ${sessionId.slice(0, 8)}, connected: ${this.happy.connected}`);
        const enc = this.happy.getSessionEncryption(sessionId);
        if (!enc) {
            throw new Error(`No encryption key for session ${sessionId}`);
        }

        const content = {
            role: 'user' as const,
            content: { type: 'text' as const, text },
            meta: { sentFrom: 'happy-discord-bot' as const },
        };

        const encrypted = encodeBase64(encrypt(enc.key, enc.variant, content));
        const localId = randomUUID();

        const resp = await this.happy.request(
            `/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ localId, content: encrypted }],
                }),
            },
        );

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error(`[Bridge] Send failed: ${resp.status} ${resp.statusText}`, body);
            throw new Error(`Failed to send message: ${resp.status} ${resp.statusText}`);
        }

        console.log(`[Bridge] Message sent to session ${sessionId.slice(0, 8)} (localId: ${localId.slice(0, 8)})`);
    }

    async uploadAttachments(attachments: readonly DiscordAttachment[]): Promise<string[]> {
        if (!this.activeSessionId) return [];
        const sessionId = this.activeSessionId;

        // Ensure .attachments directory exists
        await this.happy.sessionRPC(sessionId, 'bash', { command: `mkdir -p ${ATTACHMENT_DIR}` });

        const hints = await Promise.all(
            attachments.map(async (att) => {
                // Sanitize filename to prevent path traversal
                const safeName = path.basename(att.name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'unnamed';
                const timestamp = Date.now();

                // Size check
                if (att.size > ATTACHMENT_MAX_BYTES) {
                    const sizeMB = (att.size / (1024 * 1024)).toFixed(1);
                    return `[Skipped: ${safeName} (${sizeMB}MB, exceeds 10MB limit)]`;
                }

                // Download
                let buffer: Buffer;
                try {
                    const resp = await fetch(att.url);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    buffer = Buffer.from(await resp.arrayBuffer());
                    if (buffer.byteLength > ATTACHMENT_MAX_BYTES) {
                        const actualMB = (buffer.byteLength / (1024 * 1024)).toFixed(1);
                        return `[Skipped: ${safeName} (${actualMB}MB actual, exceeds 10MB limit)]`;
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[Bridge] Failed to download attachment ${safeName}:`, msg);
                    return `[Failed to download: ${safeName}]`;
                }

                // Write to CLI working directory
                const remotePath = `${ATTACHMENT_DIR}/${timestamp}-${safeName}`;
                try {
                    const result = await this.happy.sessionRPC<WriteFileResponse>(
                        sessionId, 'writeFile', {
                            path: remotePath,
                            content: buffer.toString('base64'),
                            expectedHash: null,
                        },
                    );
                    if (!result.success) throw new Error(result.error ?? 'unknown');
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[Bridge] Failed to upload attachment ${safeName}:`, msg);
                    return `[Failed to upload: ${safeName}]`;
                }

                // Build hint
                const isImage = att.contentType !== null && IMAGE_CONTENT_TYPES.has(att.contentType);
                const label = isImage ? 'image' : 'file';
                const action = isImage ? 'view' : 'open';
                return `[Attached ${label}: ${remotePath} — use Read tool to ${action}]`;
            }),
        );

        return hints;
    }

    async start(): Promise<void> {
        // Register listener before loading sessions to avoid missing events
        this.happy.on('update', (data) => this.processUpdate(data));

        this.happy.on('ephemeral', (data) => {
            const update = data as { type?: string; id?: string; thinking?: boolean };
            if (update?.type === 'activity' && update.id && typeof update.thinking === 'boolean') {
                this.handleEphemeralActivity(update.id, update.thinking);
            }
        });

        this.stateTracker.on('permission-request', (sessionId, request) => {
            this.stopTypingLoop();
            this.updateThinkingEmoji(false);
            this.updateToolUseEmoji(false);
            this.isThinking = false;
            this.handlePermissionRequest(sessionId, request).catch((err) => {
                console.error('[Bridge] Error handling permission request:', err);
            });
        });

        this.happy.on('disconnected', (reason) => {
            this.cancelDisconnectTimer();
            this.disconnectTimer = setTimeout(() => {
                this.disconnectTimer = null;
                this.discord.send(`⚠️ Happy relay disconnected: ${reason}`).catch((err) => {
                    console.error('[Bridge] Failed to send disconnect notification:', err);
                });
            }, DISCONNECT_DEBOUNCE_MS);
        });

        this.happy.on('connected', () => {
            const debounceStillPending = this.disconnectTimer !== null;
            this.cancelDisconnectTimer();
            if (!this.initialConnectDone) {
                this.initialConnectDone = true;
                return;
            }
            if (debounceStillPending) {
                // Reconnected within debounce window — skip both messages
                return;
            }
            // Debounce already fired (user saw disconnect warning), notify reconnection
            this.discord.send('✅ Happy relay reconnected').catch((err) => {
                console.error('[Bridge] Failed to send reconnect notification:', err);
            });
        });

        const sessions = await this.loadSessions();

        // Auto-select latest active session by activeAt
        if (sessions.length > 0) {
            const latest = sessions.reduce((a, b) => (a.activeAt > b.activeAt ? a : b));
            this.setActiveSession(latest.id);
        }
    }

    /** Create threads for sessions that don't have one. Call after Discord bot is online. */
    async ensureThreadsForSessions(): Promise<void> {
        const sessions = await this.loadSessions();
        for (const session of sessions) {
            if (!this.getThreadId(session.id)) {
                this.ensureThread(session.id, session.metadata).catch((err) => {
                    console.error(`[Bridge] Failed to create thread for session ${session.id.slice(0, 8)}:`, err);
                });
            }
        }
    }

    async listSessions(): Promise<DecryptedSession[]> {
        return this.loadSessions();
    }

    async listAllSessions(): Promise<DecryptedSession[]> {
        return listSessions(this.config.happy, this.config.credentials);
    }

    async createNewSession(machineId: string, directory: string): Promise<string> {
        const result = await this.happy.machineRPC<{ sessionId: string }>(
            machineId,
            'spawn-happy-session',
            { directory, approvedNewDirectoryCreation: true },
        );

        const sessionId = (result as { sessionId?: string } | undefined)?.sessionId;
        if (!sessionId) {
            throw new Error('Daemon did not return a sessionId');
        }

        const newSession = await this.waitForSession(sessionId);
        if (newSession) {
            this.happy.registerSessionEncryption(newSession.id, newSession.encryption);
            this.setActiveSession(newSession.id);
            this.persistModes();
            await this.ensureThread(newSession.id, newSession.metadata);
        }

        return sessionId;
    }

    async archiveSession(sessionId?: string): Promise<string> {
        const target = sessionId ?? this.requireActiveSession();
        await this.happy.sessionRPC(target, 'killSession', {});
        const fullId = this.resolveFullSessionId(target);
        const threadId = this.getThreadId(fullId);
        if (threadId) {
            await this.discord.archiveThread(threadId).catch((err) => {
                console.error(`[Bridge] Failed to archive thread:`, err);
            });
        }
        return target;
    }

    async deleteSession(sessionId?: string): Promise<string> {
        const target = sessionId ?? this.requireActiveSession();
        await apiDeleteSession(this.config.happy, this.config.credentials, target);
        const fullId = this.resolveFullSessionId(target);
        const threadId = this.getThreadId(fullId);
        if (threadId) {
            await this.discord.deleteThread(threadId).catch((err) => {
                console.error(`[Bridge] Failed to delete thread:`, err);
            });
            this.removeThread(fullId);
        }
        if (target === this.activeSessionId) {
            this.activeSessionId = null;
        }
        this.persistModes();
        return target;
    }

    async cleanupArchivedSessions(): Promise<{ sessions: number; threads: number }> {
        const all = await listSessions(this.config.happy, this.config.credentials);
        const archived = all.filter((s) => !s.active);
        const activeIds = new Set(all.filter((s) => s.active).map((s) => s.id));
        let sessionCount = 0;

        for (const session of archived) {
            try {
                await apiDeleteSession(this.config.happy, this.config.credentials, session.id);
                const fullId = this.resolveFullSessionId(session.id);
                const threadId = this.getThreadId(fullId);
                if (threadId) {
                    await this.discord.deleteThread(threadId).catch(() => {});
                    this.removeThread(fullId);
                }
                sessionCount++;
            } catch (err) {
                // 404 = already deleted, skip silently
                const status = (err as { status?: number }).status;
                if (status !== 404) {
                    console.error(`[Bridge] Failed to delete archived session ${session.id.slice(0, 8)}:`, err);
                }
            }
        }

        // Clean up orphan threads (mapped to sessions that no longer exist)
        let threadCount = 0;
        for (const [sessionId, threadId] of this.sessionToThread.entries()) {
            if (!activeIds.has(sessionId)) {
                await this.discord.deleteThread(threadId).catch(() => {});
                this.removeThread(sessionId);
                threadCount++;
            }
        }

        if (sessionCount > 0 || threadCount > 0) this.persistModes();
        return { sessions: sessionCount, threads: threadCount };
    }

    /** Process a raw update from the Happy relay. Public for testing. */
    processUpdate(data: unknown): void {
        const update = data as {
            body?: {
                t?: string;
                sid?: string;
                id?: string;
                message?: unknown;
                agentState?: { version: number; value: string };
            };
        };
        const body = update?.body;
        if (!body?.t) {
            console.log('[Bridge] processUpdate: no body.t, skipping', JSON.stringify(data).slice(0, 200));
            return;
        }

        console.log(`[Bridge] processUpdate: type=${body.t} sid=${body.sid ?? body.id ?? '?'}`);

        if (body.t === 'new-message' && body.sid && body.message) {
            this.handleNewMessage(body.sid, body.message).catch((err) => {
                console.error('[Bridge] Error handling new message:', err);
            });
        }

        if (body.t === 'update-session' && body.id && body.agentState) {
            this.handleSessionUpdate(body.id, body.agentState).catch((err: unknown) => {
                console.error('[Bridge] Error handling session update:', err);
            });
        }
    }

    async stopSession(sessionId?: string): Promise<void> {
        const target = sessionId ?? this.requireActiveSession();
        await this.happy.sessionRPC(target, 'abort', {});
    }

    async compactSession(): Promise<void> {
        await this.sendMessage('/compact');
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        answers?: Record<string, string>,
    ): Promise<void> {
        const response: PermissionResponse = {
            id: requestId,
            approved: true,
            ...(mode && { mode }),
            ...(allowTools && { allowTools }),
            ...(answers && { answers }),
        };
        await this.happy.sessionRPC(sessionId, 'permission', response);
    }

    async denyPermission(sessionId: string, requestId: string, reason?: string): Promise<void> {
        const response: PermissionResponse = {
            id: requestId,
            approved: false,
            ...(reason && { reason }),
        };
        await this.happy.sessionRPC(sessionId, 'permission', response);
    }

    async handleAskUserAnswer(sessionId: string, requestId: string, answers: Record<string, string>): Promise<void> {
        console.log(`[Bridge] AskUserAnswer: approving with answers for session ${sessionId.slice(0, 8)}`);
        await this.approvePermission(sessionId, requestId, undefined, undefined, answers);
        console.log(`[Bridge] AskUserAnswer: permission approved with answers`);
    }

    toggleMultiSelect(key: string, optionIndex: number): ReadonlySet<number> {
        const current = this.multiSelectState.get(key) ?? new Set<number>();
        const next = new Set(current);
        if (next.has(optionIndex)) {
            next.delete(optionIndex);
        } else {
            next.add(optionIndex);
        }
        this.multiSelectState.set(key, next);
        return next;
    }

    getMultiSelectState(key: string): ReadonlySet<number> {
        return this.multiSelectState.get(key) ?? new Set();
    }

    clearMultiSelectState(key: string): void {
        this.multiSelectState.delete(key);
    }

    setThread(sessionId: string, threadId: string): void {
        this.sessionToThread.set(sessionId, threadId);
        this.threadToSession.set(threadId, sessionId);
    }

    removeThread(sessionId: string): void {
        const threadId = this.sessionToThread.get(sessionId);
        if (threadId) this.threadToSession.delete(threadId);
        this.sessionToThread.delete(sessionId);
    }

    getThreadId(sessionId: string): string | null {
        return this.sessionToThread.get(sessionId) ?? null;
    }

    getSessionByThread(threadId: string): string | null {
        return this.threadToSession.get(threadId) ?? null;
    }

    getThreadMap(): Record<string, string> {
        return Object.fromEntries(this.sessionToThread);
    }

    loadThreadMap(map: Record<string, string>): void {
        for (const [sessionId, threadId] of Object.entries(map)) {
            this.setThread(sessionId, threadId);
        }
    }

    async ensureThread(sessionId: string, metadata: unknown): Promise<string> {
        const existing = this.getThreadId(sessionId);
        if (existing) return existing;

        const name = threadName(metadata, sessionId);
        const threadId = await this.discord.createThread(name);
        this.setThread(sessionId, threadId);
        this.persistModes();
        return threadId;
    }

    private cancelDisconnectTimer(): void {
        if (this.disconnectTimer) {
            clearTimeout(this.disconnectTimer);
            this.disconnectTimer = null;
        }
    }

    private startTypingLoop(): void {
        this.stopTypingLoop();
        const threadId = this.activeSessionId ? this.getThreadId(this.activeSessionId) : null;
        const doTyping = () => {
            if (threadId) {
                this.discord.sendTypingInThread(threadId).catch((err) =>
                    console.error('[Bridge] sendTyping failed:', err));
            } else {
                this.discord.sendTyping().catch((err) =>
                    console.error('[Bridge] sendTyping failed:', err));
            }
        };
        doTyping();
        this.typingInterval = setInterval(doTyping, TYPING_INTERVAL_MS);
    }

    private stopTypingLoop(): void {
        if (this.typingInterval) {
            clearInterval(this.typingInterval);
            this.typingInterval = null;
        }
    }

    private updateThinkingEmoji(thinking: boolean): void {
        if (thinking === this.thinkingEmoji) return;

        if (this.lastUserMsgId && this.thinkingEmoji) {
            if (this.lastUserMsgThreadId) {
                this.discord.removeReactionInThread(this.lastUserMsgThreadId, this.lastUserMsgId, THINKING_EMOJI).catch((err) =>
                    console.error('[Bridge] removeReaction failed:', err));
            } else {
                this.discord.removeReaction(this.lastUserMsgId, THINKING_EMOJI).catch((err) =>
                    console.error('[Bridge] removeReaction failed:', err));
            }
        }
        if (this.lastUserMsgId && thinking) {
            if (this.lastUserMsgThreadId) {
                this.discord.reactInThread(this.lastUserMsgThreadId, this.lastUserMsgId, THINKING_EMOJI).catch((err) =>
                    console.error('[Bridge] reactToMessage failed:', err));
            } else {
                this.discord.reactToMessage(this.lastUserMsgId, THINKING_EMOJI).catch((err) =>
                    console.error('[Bridge] reactToMessage failed:', err));
            }
        }
        this.thinkingEmoji = thinking;
    }

    private updateToolUseEmoji(active: boolean): void {
        if (active === this.toolUseEmoji) return;

        if (this.lastUserMsgId && this.toolUseEmoji) {
            if (this.lastUserMsgThreadId) {
                this.discord.removeReactionInThread(this.lastUserMsgThreadId, this.lastUserMsgId, TOOL_USE_EMOJI).catch((err) =>
                    console.error('[Bridge] removeReaction failed:', err));
            } else {
                this.discord.removeReaction(this.lastUserMsgId, TOOL_USE_EMOJI).catch((err) =>
                    console.error('[Bridge] removeReaction failed:', err));
            }
        }
        if (this.lastUserMsgId && active) {
            if (this.lastUserMsgThreadId) {
                this.discord.reactInThread(this.lastUserMsgThreadId, this.lastUserMsgId, TOOL_USE_EMOJI).catch((err) =>
                    console.error('[Bridge] reactToMessage failed:', err));
            } else {
                this.discord.reactToMessage(this.lastUserMsgId, TOOL_USE_EMOJI).catch((err) =>
                    console.error('[Bridge] reactToMessage failed:', err));
            }
        }
        this.toolUseEmoji = active;
    }

    private async sendToSession(sessionId: string, text: string): Promise<{ id: string }[]> {
        const threadId = this.getThreadId(sessionId);
        if (threadId) {
            return this.discord.sendToThread(threadId, text);
        }
        return this.discord.send(text);
    }

    private async sendWithButtonsToSession(
        sessionId: string, text: string, buttons: Parameters<DiscordBot['sendWithButtons']>[1],
    ): Promise<{ id: string }> {
        const threadId = this.getThreadId(sessionId);
        if (threadId) {
            return this.discord.sendToThreadWithButtons(threadId, text, buttons);
        }
        return this.discord.sendWithButtons(text, buttons);
    }

    private async sendWithAttachmentToSession(
        sessionId: string, text: string, file: Buffer, fileName: string,
        buttons: Parameters<DiscordBot['sendWithAttachmentAndButtons']>[3],
    ): Promise<{ id: string }> {
        const threadId = this.getThreadId(sessionId);
        if (threadId) {
            return this.discord.sendToThreadWithAttachment(threadId, text, file, fileName, buttons);
        }
        return this.discord.sendWithAttachmentAndButtons(text, file, fileName, buttons);
    }

    private async handleSessionUpdate(
        sessionId: string,
        encryptedState: { version: number; value: string },
    ): Promise<void> {
        if (sessionId !== this.activeSessionId) return;

        const enc = this.happy.getSessionEncryption(sessionId);
        if (!enc) {
            console.warn(`[Bridge] No key for session ${sessionId}, skipping state update`);
            return;
        }

        const decrypted = decrypt(enc.key, enc.variant, decodeBase64(encryptedState.value));
        if (!decrypted) {
            console.error(`[Bridge] Failed to decrypt agentState for session ${sessionId}`);
            return;
        }

        this.stateTracker.handleSessionUpdate(sessionId, decrypted as AgentState);
    }

    private async handlePermissionRequest(
        sessionId: string,
        request: PermissionRequest,
    ): Promise<void> {
        // AskUserQuestion gets special UI
        if (request.tool === 'AskUserQuestion') {
            const input = request.arguments as AskUserQuestionInput;
            const questions = input?.questions;
            if (!questions?.length) {
                await this.approvePermission(sessionId, request.id);
                return;
            }

            const description = formatAskUserQuestion(questions);
            const allRows = questions.flatMap((q, i) =>
                buildAskButtons(sessionId, request.id, q.options, q.multiSelect, i),
            );
            if (allRows.length > 5) {
                console.warn(`[Bridge] AskUserQuestion has ${allRows.length} button rows, truncating to 5 (Discord limit)`);
            }
            await this.sendWithButtonsToSession(sessionId, description, allRows.slice(0, 5));
            return;
        }

        // ExitPlanMode gets plan attachment + special buttons
        if (isExitPlanMode(request.tool)) {
            const args = (request.arguments ?? {}) as Record<string, unknown>;
            const planText = typeof args.plan === 'string' ? args.plan : '';
            const description = formatExitPlanMode(planText);
            const buttons = buildExitPlanButtons(sessionId, request.id);
            const fileContent = Buffer.from(planText || '(empty plan)', 'utf-8');
            await this.sendWithAttachmentToSession(sessionId, description, fileContent, 'plan.md', buttons);
            return;
        }

        if (this.permissionCache.isAutoApproved(request.tool, request.arguments)) {
            console.log(`[Bridge] Auto-approving ${request.tool} (${request.id})`);
            await this.approvePermission(sessionId, request.id);
            return;
        }

        const description = formatPermissionRequest(request.tool, request.arguments);
        const buttons = buildPermissionButtons(sessionId, request.id, request.tool, request.arguments);
        await this.sendWithButtonsToSession(sessionId, description, buttons);
    }

    private async loadSessions(): Promise<DecryptedSession[]> {
        let sessions: DecryptedSession[];
        try {
            sessions = await listActiveSessions(this.config.happy, this.config.credentials);
        } catch (err) {
            // 404 when no active sessions exist — treat as empty list
            if ((err as { status?: number }).status === 404) {
                return [];
            }
            throw err;
        }
        for (const session of sessions) {
            this.happy.registerSessionEncryption(session.id, session.encryption);
        }
        return sessions;
    }

    private async waitForSession(sessionId: string, retries = 2): Promise<DecryptedSession | null> {
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            const sessions = await this.loadSessions();
            const found = sessions.find((s) => s.id === sessionId);
            if (found) return found;
        }
        console.warn(`[Bridge] Session ${sessionId} not found after ${retries + 1} attempts`);
        return null;
    }

    private async handleNewMessage(sessionId: string, raw: unknown): Promise<void> {
        const msg = raw as Record<string, unknown> | null;
        const content = (msg?.content as Record<string, unknown> | undefined);
        if (!content?.c || typeof content.c !== 'string') {
            console.warn(`[Bridge] Malformed message for session ${sessionId}, skipping`);
            return;
        }

        const enc = this.happy.getSessionEncryption(sessionId);
        if (!enc) {
            console.warn(`[Bridge] No key for session ${sessionId}, skipping message`);
            return;
        }

        const decrypted = decrypt(enc.key, enc.variant, decodeBase64(content.c));
        if (!decrypted) {
            console.error(`[Bridge] Failed to decrypt message for session ${sessionId}`);
            return;
        }

        const record = decrypted as { role?: string; content?: unknown };
        console.log(`[Bridge] handleNewMessage: role=${record.role}`,
            JSON.stringify(record).slice(0, 300));

        // Skip user messages (own echoes)
        if (record.role === 'user') return;

        // Handle agent output (legacy format)
        if (record.role === 'agent') {
            const agentContent = record.content as { type?: string; data?: unknown };
            if (agentContent?.type === 'output') {
                const outputData = agentContent.data as {
                    type?: string;
                    message?: { content?: Array<{ type: string; text?: string }> };
                };
                if (outputData?.type === 'assistant' && Array.isArray(outputData.message?.content)) {
                    const textBlocks = outputData.message.content
                        .filter((block) => block.type === 'text' && block.text)
                        .map((block) => block.text!);
                    const text = textBlocks.join('');
                    if (text) {
                        await this.sendToSession(sessionId, text);
                    }
                }
            } else {
                console.log(`[Bridge] Unhandled agent message type: ${agentContent?.type ?? 'unknown'}`,
                    JSON.stringify(agentContent).slice(0, 200));
            }
        }

        // Handle session protocol messages (new format)
        if (record.role === 'session') {
            const envelope = record.content as {
                role?: string;
                ev?: { t?: string; text?: string; thinking?: boolean; name?: string; args?: Record<string, unknown> };
            };
            if (envelope?.role !== 'agent') return;

            // Forward agent text messages to Discord (skip thinking/reasoning)
            if (envelope.ev?.t === 'text' && envelope.ev.text && !envelope.ev.thinking) {
                await this.sendToSession(sessionId, envelope.ev.text);
            }

            // Tool use emoji tracking + TodoWrite interception
            if (envelope.ev?.t === 'tool-call-start') {
                this.updateToolUseEmoji(true);

                if (envelope.ev.name === 'TodoWrite' && sessionId === this.activeSessionId) {
                    const todos = Array.isArray(envelope.ev.args?.todos) ? envelope.ev.args.todos as TodoItem[] : [];
                    if (todos.length > 0) {
                        await this.handleTodoWrite(sessionId, todos);
                    }
                }
            } else if (envelope.ev?.t === 'tool-call-end') {
                this.updateToolUseEmoji(false);
            }
        }
    }

    private async handleTodoWrite(sessionId: string, todos: readonly TodoItem[]): Promise<void> {
        const text = formatTodoWrite(todos);
        if (!text) return;

        const allCompleted = todos.every((t) => t.status === 'completed');
        const threadId = this.getThreadId(sessionId);

        if (this.todoMessageId) {
            if (threadId) {
                await this.discord.editMessageInThread(threadId, this.todoMessageId, text);
            } else {
                await this.discord.editMessage(this.todoMessageId, text);
            }
            if (allCompleted) {
                if (threadId) {
                    await this.discord.unpinMessageInThread(threadId, this.todoMessageId);
                } else {
                    await this.discord.unpinMessage(this.todoMessageId);
                }
                this.todoMessageId = null;
            }
        } else {
            const messages = await this.sendToSession(sessionId, text);
            const msg = messages[0];
            if (msg) {
                if (allCompleted) {
                    // Already all done — show once, don't pin
                } else {
                    this.todoMessageId = msg.id;
                    if (threadId) {
                        await this.discord.pinMessageInThread(threadId, msg.id);
                    } else {
                        await this.discord.pinMessage(msg.id);
                    }
                }
            }
        }
    }

    /** Resolve a session ID prefix to a full session ID via the thread map. */
    private resolveFullSessionId(idOrPrefix: string): string {
        if (this.sessionToThread.has(idOrPrefix)) return idOrPrefix;
        for (const key of this.sessionToThread.keys()) {
            if (key.startsWith(idOrPrefix)) return key;
        }
        return idOrPrefix;
    }

    private requireActiveSession(): string {
        if (!this.activeSessionId) {
            throw new Error('No active session. Use /sessions to check available sessions.');
        }
        return this.activeSessionId;
    }
}
