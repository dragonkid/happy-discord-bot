import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EDIT_TOOLS, type PermissionMode } from './types.js';
import type { SessionPermissions } from '../store.js';

interface ClaudeSettings {
    permissions?: { allow?: string[] };
}

/**
 * Load allow rules from Claude Code settings files (3 layers):
 * 1. ~/.claude/settings.json (global)
 * 2. ~/.claude/settings.local.json (global local)
 * 3. {projectDir}/.claude/settings.local.json (project local)
 */
export async function loadClaudeAllowRules(projectDir?: string): Promise<string[]> {
    const home = homedir();
    const paths = [
        join(home, '.claude', 'settings.json'),
        join(home, '.claude', 'settings.local.json'),
    ];
    if (projectDir) {
        paths.push(join(projectDir, '.claude', 'settings.local.json'));
    }

    const rules: string[] = [];
    for (const p of paths) {
        try {
            const raw = await readFile(p, 'utf-8');
            const parsed = JSON.parse(raw) as ClaudeSettings;
            if (Array.isArray(parsed.permissions?.allow)) {
                rules.push(...parsed.permissions.allow);
            }
        } catch {
            // File not found or parse error — skip silently
        }
    }
    return rules;
}

export class PermissionCache {
    private allowedTools = new Set<string>();
    private bashLiterals = new Set<string>();
    private bashPrefixes = new Set<string>();
    private _mode: PermissionMode = 'default';
    private sessionStates = new Map<string, SessionPermissions>();

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

    /** Save current permission state for a session. */
    saveSession(sessionId: string): void {
        this.sessionStates.set(sessionId, {
            mode: this._mode,
            allowedTools: [...this.allowedTools],
            bashLiterals: [...this.bashLiterals],
            bashPrefixes: [...this.bashPrefixes],
        });
    }

    /**
     * Seed a session's permission state with allow rules from Claude settings.
     * Merges with any existing saved state (user approvals take precedence).
     */
    seedSessionRules(sessionId: string, allowRules: string[]): void {
        const existing = this.sessionStates.get(sessionId) ?? {
            mode: 'default' as PermissionMode,
            allowedTools: [],
            bashLiterals: [],
            bashPrefixes: [],
        };

        // Parse allow rules into temporary sets
        const tools = new Set(existing.allowedTools);
        const literals = new Set(existing.bashLiterals);
        const prefixes = new Set(existing.bashPrefixes);

        for (const rule of allowRules) {
            if (rule === 'Bash') continue;
            const match = rule.match(/^Bash\((.+?)\)$/);
            if (match) {
                const command = match[1];
                if (command.endsWith(':*')) {
                    prefixes.add(command.slice(0, -2));
                } else {
                    literals.add(command);
                }
            } else {
                tools.add(rule);
            }
        }

        this.sessionStates.set(sessionId, {
            mode: existing.mode,
            allowedTools: [...tools],
            bashLiterals: [...literals],
            bashPrefixes: [...prefixes],
        });
    }

    /** Restore permission state for a session (resets first). */
    restoreSession(sessionId: string): void {
        this.reset();
        const saved = this.sessionStates.get(sessionId);
        if (!saved) return;
        this._mode = saved.mode;
        for (const tool of saved.allowedTools) this.allowedTools.add(tool);
        for (const literal of saved.bashLiterals) this.bashLiterals.add(literal);
        for (const prefix of saved.bashPrefixes) this.bashPrefixes.add(prefix);
    }

    /** Bulk-load session states from persisted data. */
    loadSessions(sessions: Record<string, SessionPermissions>): void {
        for (const [id, state] of Object.entries(sessions)) {
            this.sessionStates.set(id, state);
        }
    }

    /** Export all session states for persistence. */
    getAllSessions(): Record<string, SessionPermissions> {
        return Object.fromEntries(this.sessionStates);
    }

    /** Remove a session's saved permission state. */
    removeSession(sessionId: string): void {
        this.sessionStates.delete(sessionId);
    }

    /** Remove all sessions not in the given set of active IDs. */
    retainSessions(activeIds: ReadonlySet<string>): number {
        let removed = 0;
        for (const id of [...this.sessionStates.keys()]) {
            if (!activeIds.has(id)) {
                this.sessionStates.delete(id);
                removed++;
            }
        }
        return removed;
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
