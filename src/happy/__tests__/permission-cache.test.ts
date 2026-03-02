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
});
