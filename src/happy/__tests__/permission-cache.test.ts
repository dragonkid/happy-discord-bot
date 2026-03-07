import { describe, it, expect, beforeEach } from 'vitest';
import { PermissionCache } from '../permission-cache.js';

describe('PermissionCache', () => {
    let cache: PermissionCache;

    beforeEach(() => {
        cache = new PermissionCache();
    });

    describe('isAutoApproved', () => {
        it('returns false by default for any tool', () => {
            expect(cache.isAutoApproved('Edit', {})).toBe(false);
        });

        it('returns true for tool in allowedTools', () => {
            cache.applyApproval(['Edit']);
            expect(cache.isAutoApproved('Edit', {})).toBe(true);
        });

        it('returns true for Bash with matching literal', () => {
            cache.applyApproval(['Bash(git status)']);
            expect(cache.isAutoApproved('Bash', { command: 'git status' })).toBe(true);
        });

        it('returns false for Bash with non-matching literal', () => {
            cache.applyApproval(['Bash(git status)']);
            expect(cache.isAutoApproved('Bash', { command: 'rm -rf /' })).toBe(false);
        });

        it('returns true for Bash with matching prefix', () => {
            cache.applyApproval(['Bash(npm:*)']);
            expect(cache.isAutoApproved('Bash', { command: 'npm test' })).toBe(true);
            expect(cache.isAutoApproved('Bash', { command: 'npm run build' })).toBe(true);
        });

        it('returns false for Bash with non-matching prefix', () => {
            cache.applyApproval(['Bash(npm:*)']);
            expect(cache.isAutoApproved('Bash', { command: 'yarn test' })).toBe(false);
        });

        it('ignores plain Bash in allowTools', () => {
            cache.applyApproval(['Bash']);
            expect(cache.isAutoApproved('Bash', { command: 'anything' })).toBe(false);
        });
    });

    describe('permissionMode', () => {
        it('bypassPermissions approves everything', () => {
            cache.setMode('bypassPermissions');
            expect(cache.isAutoApproved('Bash', { command: 'rm -rf /' })).toBe(true);
            expect(cache.isAutoApproved('Edit', {})).toBe(true);
        });

        it('acceptEdits approves edit tools', () => {
            cache.setMode('acceptEdits');
            expect(cache.isAutoApproved('Edit', {})).toBe(true);
            expect(cache.isAutoApproved('MultiEdit', {})).toBe(true);
            expect(cache.isAutoApproved('Write', {})).toBe(true);
            expect(cache.isAutoApproved('NotebookEdit', {})).toBe(true);
            expect(cache.isAutoApproved('Read', {})).toBe(true);
        });

        it('acceptEdits does not approve non-edit tools', () => {
            cache.setMode('acceptEdits');
            expect(cache.isAutoApproved('Bash', { command: 'ls' })).toBe(false);
        });

        it('default mode does not auto-approve', () => {
            cache.setMode('default');
            expect(cache.isAutoApproved('Edit', {})).toBe(false);
        });
    });

    describe('check order (Bash literal → prefix → tool → mode)', () => {
        it('bash literal takes priority over mode', () => {
            cache.setMode('default');
            cache.applyApproval(['Bash(git status)']);
            expect(cache.isAutoApproved('Bash', { command: 'git status' })).toBe(true);
        });
    });

    describe('applyApproval with mode', () => {
        it('sets mode when provided', () => {
            cache.applyApproval([], 'acceptEdits');
            expect(cache.isAutoApproved('Edit', {})).toBe(true);
        });

        it('accumulates allowTools across calls', () => {
            cache.applyApproval(['Read']);
            cache.applyApproval(['Glob']);
            expect(cache.isAutoApproved('Read', {})).toBe(true);
            expect(cache.isAutoApproved('Glob', {})).toBe(true);
        });
    });

    describe('reset', () => {
        it('clears all cached permissions and resets mode', () => {
            cache.applyApproval(['Edit']);
            cache.setMode('bypassPermissions');
            cache.reset();
            expect(cache.isAutoApproved('Edit', {})).toBe(false);
            expect(cache.isAutoApproved('Bash', { command: 'ls' })).toBe(false);
        });
    });

    describe('mode getter', () => {
        it('returns current permission mode', () => {
            expect(cache.mode).toBe('default');
            cache.setMode('plan');
            expect(cache.mode).toBe('plan');
        });
    });

    describe('per-session persistence', () => {
        it('saveSession + restoreSession round-trips mode', () => {
            cache.setMode('acceptEdits');
            cache.saveSession('sess-1');
            cache.reset();
            cache.restoreSession('sess-1');
            expect(cache.mode).toBe('acceptEdits');
        });

        it('saveSession + restoreSession round-trips allowedTools', () => {
            cache.applyApproval(['Edit', 'Glob']);
            cache.saveSession('sess-1');
            cache.reset();
            cache.restoreSession('sess-1');
            expect(cache.isAutoApproved('Edit', {})).toBe(true);
            expect(cache.isAutoApproved('Glob', {})).toBe(true);
        });

        it('saveSession + restoreSession round-trips bash permissions', () => {
            cache.applyApproval(['Bash(git status)', 'Bash(npm:*)']);
            cache.saveSession('sess-1');
            cache.reset();
            cache.restoreSession('sess-1');
            expect(cache.isAutoApproved('Bash', { command: 'git status' })).toBe(true);
            expect(cache.isAutoApproved('Bash', { command: 'npm test' })).toBe(true);
            expect(cache.isAutoApproved('Bash', { command: 'rm -rf' })).toBe(false);
        });

        it('restoreSession with no saved state resets to default', () => {
            cache.setMode('acceptEdits');
            cache.restoreSession('unknown-session');
            expect(cache.mode).toBe('default');
        });

        it('loadSessions bulk-loads from persisted data', () => {
            cache.loadSessions({
                s1: { mode: 'acceptEdits', allowedTools: ['Edit'], bashLiterals: [], bashPrefixes: [] },
                s2: { mode: 'plan', allowedTools: [], bashLiterals: [], bashPrefixes: [] },
            });
            cache.restoreSession('s1');
            expect(cache.mode).toBe('acceptEdits');
            expect(cache.isAutoApproved('Edit', {})).toBe(true);
        });

        it('getAllSessions returns all saved session states', () => {
            cache.setMode('acceptEdits');
            cache.applyApproval(['Edit']);
            cache.saveSession('s1');
            cache.reset();
            cache.setMode('plan');
            cache.saveSession('s2');
            const all = cache.getAllSessions();
            expect(all.s1.mode).toBe('acceptEdits');
            expect(all.s1.allowedTools).toContain('Edit');
            expect(all.s2.mode).toBe('plan');
        });
    });

    describe('retainSessions', () => {
        it('removes sessions not in the active set', () => {
            cache.setMode('acceptEdits');
            cache.saveSession('s1');
            cache.reset();
            cache.setMode('plan');
            cache.saveSession('s2');
            cache.reset();
            cache.saveSession('s3');

            const removed = cache.retainSessions(new Set(['s2']));
            expect(removed).toBe(2);
            const all = cache.getAllSessions();
            expect(Object.keys(all)).toEqual(['s2']);
        });

        it('returns 0 when all sessions are active', () => {
            cache.saveSession('s1');
            cache.saveSession('s2');
            const removed = cache.retainSessions(new Set(['s1', 's2']));
            expect(removed).toBe(0);
        });
    });
});
