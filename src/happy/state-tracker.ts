import { EventEmitter } from 'node:events';
import type { AgentState, PermissionRequest } from './types.js';

interface StateTrackerEvents {
    'permission-request': [sessionId: string, request: PermissionRequest];
}

export class StateTracker extends EventEmitter<StateTrackerEvents> {
    // sessionId → Set of request IDs we've already emitted
    private seenRequests = new Map<string, Set<string>>();
    // sessionId → current pending requests
    private pendingRequests = new Map<string, Map<string, PermissionRequest>>();

    handleSessionUpdate(sessionId: string, agentState: AgentState): void {
        const requests = agentState.requests ?? {};
        const requestIds = Object.keys(requests);

        let seen = this.seenRequests.get(sessionId);
        if (!seen) {
            seen = new Set();
            this.seenRequests.set(sessionId, seen);
        }

        // Update pending requests to reflect current state
        const pending = new Map<string, PermissionRequest>();
        for (const [id, req] of Object.entries(requests)) {
            pending.set(id, { ...req, id });
        }
        this.pendingRequests.set(sessionId, pending);

        // Emit events for new (unseen) requests
        for (const id of requestIds) {
            if (!seen.has(id)) {
                seen.add(id);
                const req = requests[id];
                this.emit('permission-request', sessionId, { ...req, id });
            }
        }
    }

    getPendingRequests(sessionId: string): PermissionRequest[] {
        const pending = this.pendingRequests.get(sessionId);
        if (!pending) return [];
        return [...pending.values()];
    }

    clearSession(sessionId: string): void {
        this.seenRequests.delete(sessionId);
        this.pendingRequests.delete(sessionId);
    }
}
