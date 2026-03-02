import { randomUUID } from 'node:crypto';
import type { HappyClient } from './happy/client.js';
import type { DiscordBot } from './discord/bot.js';
import type { BotConfig } from './config.js';
import { encrypt, encodeBase64, decrypt, decodeBase64 } from './vendor/encryption.js';
import { listActiveSessions, type DecryptedSession } from './vendor/api.js';
import type { StateTracker } from './happy/state-tracker.js';
import type { PermissionCache } from './happy/permission-cache.js';
import { buildPermissionButtons, buildAskButtons } from './discord/buttons.js';
import { formatPermissionRequest, formatAskUserQuestion } from './discord/formatter.js';
import type { PermissionRequest, PermissionResponse, PermissionMode, AgentState, AskUserQuestionInput } from './happy/types.js';

const RESPONSE_TIMEOUT_MS = 30_000;

export class Bridge {
    private readonly happy: HappyClient;
    private readonly discord: DiscordBot;
    private readonly config: BotConfig;
    private readonly stateTracker: StateTracker;
    private readonly permissionCache: PermissionCache;
    private readonly multiSelectState = new Map<string, Set<number>>();
    private activeSessionId: string | null = null;
    private responseTimer: ReturnType<typeof setTimeout> | null = null;
    private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private initialConnectDone = false;

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
        this.activeSessionId = sessionId;
        this.permissionCache.reset();
    }

    get activeSession(): string | null {
        return this.activeSessionId;
    }

    get permissions(): PermissionCache {
        return this.permissionCache;
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
        this.startResponseTimer();
    }

    async start(): Promise<void> {
        // Register listener before loading sessions to avoid missing events
        this.happy.on('update', (data) => this.processUpdate(data));

        this.stateTracker.on('permission-request', (sessionId, request) => {
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
            }, 5000);
        });

        this.happy.on('connected', () => {
            const wasDisconnected = this.disconnectTimer !== null;
            this.cancelDisconnectTimer();
            if (!this.initialConnectDone) {
                this.initialConnectDone = true;
                return;
            }
            if (!wasDisconnected) {
                this.discord.send('✅ Happy relay reconnected').catch((err) => {
                    console.error('[Bridge] Failed to send reconnect notification:', err);
                });
            }
            // If wasDisconnected is true, reconnect happened within 5s debounce — skip both messages
        });

        const sessions = await this.loadSessions();

        // Auto-select latest active session by activeAt
        if (sessions.length > 0) {
            const latest = sessions.reduce((a, b) => (a.activeAt > b.activeAt ? a : b));
            this.activeSessionId = latest.id;
        }
    }

    async listSessions(): Promise<DecryptedSession[]> {
        return this.loadSessions();
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
        if (!body?.t) return;

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

    async stopSession(): Promise<void> {
        const sessionId = this.requireActiveSession();
        await this.happy.sessionRPC(sessionId, 'abort', {});
    }

    async compactSession(): Promise<void> {
        await this.sendMessage('/compact');
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
    ): Promise<void> {
        const response: PermissionResponse = {
            id: requestId,
            approved: true,
            ...(mode && { mode }),
            ...(allowTools && { allowTools }),
        };
        await this.happy.sessionRPC(sessionId, 'permission', response);
    }

    async denyPermission(sessionId: string, requestId: string): Promise<void> {
        const response: PermissionResponse = {
            id: requestId,
            approved: false,
        };
        await this.happy.sessionRPC(sessionId, 'permission', response);
    }

    async handleAskUserAnswer(sessionId: string, requestId: string, answerText: string): Promise<void> {
        await this.approvePermission(sessionId, requestId);
        await this.sendMessage(answerText);
    }

    toggleMultiSelect(key: string, optionIndex: number): ReadonlySet<number> {
        let selected = this.multiSelectState.get(key);
        if (!selected) {
            selected = new Set();
            this.multiSelectState.set(key, selected);
        }
        if (selected.has(optionIndex)) {
            selected.delete(optionIndex);
        } else {
            selected.add(optionIndex);
        }
        return selected;
    }

    getMultiSelectState(key: string): ReadonlySet<number> {
        return this.multiSelectState.get(key) ?? new Set();
    }

    clearMultiSelectState(key: string): void {
        this.multiSelectState.delete(key);
    }

    private startResponseTimer(): void {
        this.cancelResponseTimer();
        this.responseTimer = setTimeout(() => {
            this.responseTimer = null;
            console.warn('[Bridge] No CLI response within timeout');
            this.discord.send(
                '⚠️ CLI appears unresponsive — no activity detected within 30s.\n'
                + 'Try pressing Enter in the CLI terminal to wake it.',
            ).catch((err) => {
                console.error('[Bridge] Failed to send timeout warning:', err);
            });
        }, RESPONSE_TIMEOUT_MS);
    }

    private cancelResponseTimer(): void {
        if (this.responseTimer) {
            clearTimeout(this.responseTimer);
            this.responseTimer = null;
        }
    }

    private cancelDisconnectTimer(): void {
        if (this.disconnectTimer) {
            clearTimeout(this.disconnectTimer);
            this.disconnectTimer = null;
        }
    }

    private async handleSessionUpdate(
        sessionId: string,
        encryptedState: { version: number; value: string },
    ): Promise<void> {
        if (sessionId !== this.activeSessionId) return;

        this.cancelResponseTimer();

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
            await this.discord.sendWithButtons(description, allRows.slice(0, 5));
            return;
        }

        if (this.permissionCache.isAutoApproved(request.tool, request.arguments)) {
            console.log(`[Bridge] Auto-approving ${request.tool} (${request.id})`);
            await this.approvePermission(sessionId, request.id);
            return;
        }

        const description = formatPermissionRequest(request.tool, request.arguments);
        const buttons = buildPermissionButtons(sessionId, request.id, request.tool, request.arguments);
        await this.discord.sendWithButtons(description, buttons);
    }

    private async loadSessions(): Promise<DecryptedSession[]> {
        const sessions = await listActiveSessions(this.config.happy, this.config.credentials);
        // Register encryption keys from DecryptedSession (which has .encryption field)
        for (const session of sessions) {
            this.happy.registerSessionEncryption(session.id, session.encryption);
        }
        return sessions;
    }

    private async handleNewMessage(sessionId: string, raw: unknown): Promise<void> {
        if (sessionId === this.activeSessionId) {
            this.cancelResponseTimer();
        }

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

        // Skip user messages (own echoes)
        if (record.role === 'user') return;

        // Handle agent output
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
                        await this.discord.send(text);
                    }
                }
            } else {
                console.log(`[Bridge] Unhandled agent message type: ${agentContent?.type ?? 'unknown'}`,
                    JSON.stringify(agentContent).slice(0, 200));
            }
        }
    }

    private requireActiveSession(): string {
        if (!this.activeSessionId) {
            throw new Error('No active session. Use /sessions to check available sessions.');
        }
        return this.activeSessionId;
    }
}
