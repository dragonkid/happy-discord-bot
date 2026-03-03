// --- Permission types ---

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) as ReadonlySet<string>;

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export type PermissionDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

export interface PermissionRequest {
    id: string;
    tool: string;
    arguments: unknown;
    createdAt: number;
}

export interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: PermissionMode;
    allowTools?: string[];
    decision?: PermissionDecision;
    answers?: Record<string, string>;
}

// --- AskUserQuestion types ---

export interface AskUserQuestionOption {
    label: string;
    description: string;
}

export interface AskUserQuestionItem {
    question: string;
    header: string;
    options: AskUserQuestionOption[];
    multiSelect: boolean;
}

export interface AskUserQuestionInput {
    questions: AskUserQuestionItem[];
}

// --- Agent state ---

export interface AgentState {
    state?: 'idle' | 'thinking' | 'tool_use';
    requests?: Record<string, PermissionRequest>;
    completedRequests?: Record<string, unknown>;
}

// --- Socket.IO update events ---

export interface UpdateContainer {
    seq: number;
    createdAt: number;
    body: UpdateBody;
}

export type UpdateBody =
    | NewMessageUpdate
    | UpdateSessionUpdate;

export interface NewMessageUpdate {
    t: 'new-message';
    sid: string;
    message: {
        id: string;
        seq: number;
        localId?: string | null;
        content: { c: string; t: 'encrypted' };
        createdAt: number;
        updatedAt: number;
    };
}

export interface UpdateSessionUpdate {
    t: 'update-session';
    id: string;
    agentState?: { version: number; value: string };
    metadata?: { version: number; value: string };
}

// --- Session types (bot-internal, derived from vendor DecryptedSession) ---

export interface Session {
    id: string;
    seq: number;
    active: boolean;
    activeAt: number;
    agentState?: AgentState;
    metadata?: unknown;
    dataEncryptionKey: string | null;
    createdAt: number;
    updatedAt: number;
}

// --- RPC types ---

export interface RpcCallPayload {
    method: string;
    params: string; // encrypted base64
}

export interface RpcResult {
    ok: boolean;
    result?: string; // encrypted base64
    error?: string;
}

// --- Message types ---

export interface SessionMessage {
    id: string;
    seq: number;
    localId?: string | null;
    content: unknown; // decrypted JSON
    createdAt: number;
    updatedAt: number;
}
