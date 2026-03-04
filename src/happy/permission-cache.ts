import { EDIT_TOOLS, type PermissionMode } from './types.js';

export class PermissionCache {
    private allowedTools = new Set<string>();
    private bashLiterals = new Set<string>();
    private bashPrefixes = new Set<string>();
    private _mode: PermissionMode = 'default';
    private sessionModes = new Map<string, PermissionMode>();

    get mode(): PermissionMode {
        return this._mode;
    }

    setMode(mode: PermissionMode): void {
        this._mode = mode;
    }

    isAutoApproved(toolName: string, input: unknown): boolean {
        // 1. Bash literal match
        if (toolName === 'Bash') {
            const command = (input as { command?: string })?.command ?? '';
            if (this.bashLiterals.has(command)) return true;

            // 2. Bash prefix match
            for (const prefix of this.bashPrefixes) {
                if (command.startsWith(prefix)) return true;
            }
        }

        // 3. Tool whitelist (non-Bash)
        if (toolName !== 'Bash' && this.allowedTools.has(toolName)) return true;

        // 4. Permission mode
        if (this._mode === 'bypassPermissions') return true;
        if (this._mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true;

        return false;
    }

    applyApproval(allowTools?: string[], mode?: PermissionMode): void {
        if (mode) this._mode = mode;
        if (!allowTools) return;

        for (const tool of allowTools) {
            this.parseTool(tool);
        }
    }

    reset(): void {
        this.allowedTools.clear();
        this.bashLiterals.clear();
        this.bashPrefixes.clear();
        this._mode = 'default';
    }

    saveSessionMode(sessionId: string, mode: PermissionMode): void {
        this.sessionModes.set(sessionId, mode);
    }

    getSessionMode(sessionId: string): PermissionMode {
        return this.sessionModes.get(sessionId) ?? 'default';
    }

    restoreSession(sessionId: string): void {
        this.reset();
        this._mode = this.sessionModes.get(sessionId) ?? 'default';
    }

    loadSessionModes(modes: Record<string, PermissionMode>): void {
        for (const [id, mode] of Object.entries(modes)) {
            this.sessionModes.set(id, mode);
        }
    }

    getAllSessionModes(): Record<string, PermissionMode> {
        return Object.fromEntries(this.sessionModes);
    }

    private parseTool(permission: string): void {
        if (permission === 'Bash') return; // plain Bash ignored

        const match = permission.match(/^Bash\((.+?)\)$/);
        if (match) {
            const command = match[1];
            if (command.endsWith(':*')) {
                this.bashPrefixes.add(command.slice(0, -2));
            } else {
                this.bashLiterals.add(command);
            }
            return;
        }

        this.allowedTools.add(permission);
    }
}
