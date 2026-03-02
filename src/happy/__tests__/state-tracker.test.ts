import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateTracker } from '../state-tracker.js';

describe('StateTracker', () => {
    let tracker: StateTracker;

    beforeEach(() => {
        tracker = new StateTracker();
    });

    describe('handleSessionUpdate', () => {
        it('emits permission-request for new requests in agentState', () => {
            const handler = vi.fn();
            tracker.on('permission-request', handler);

            const agentState = {
                requests: {
                    'req-1': { id: 'req-1', tool: 'Edit', arguments: { file_path: '/tmp/x' }, createdAt: 1000 },
                },
            };

            tracker.handleSessionUpdate('sess-1', agentState);

            expect(handler).toHaveBeenCalledWith('sess-1', {
                id: 'req-1',
                tool: 'Edit',
                arguments: { file_path: '/tmp/x' },
                createdAt: 1000,
            });
        });

        it('does not re-emit already seen requests', () => {
            const handler = vi.fn();
            tracker.on('permission-request', handler);

            const agentState = {
                requests: {
                    'req-1': { id: 'req-1', tool: 'Edit', arguments: {}, createdAt: 1000 },
                },
            };

            tracker.handleSessionUpdate('sess-1', agentState);
            tracker.handleSessionUpdate('sess-1', agentState);

            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('emits for new requests when previous ones still exist', () => {
            const handler = vi.fn();
            tracker.on('permission-request', handler);

            tracker.handleSessionUpdate('sess-1', {
                requests: {
                    'req-1': { id: 'req-1', tool: 'Edit', arguments: {}, createdAt: 1000 },
                },
            });

            tracker.handleSessionUpdate('sess-1', {
                requests: {
                    'req-1': { id: 'req-1', tool: 'Edit', arguments: {}, createdAt: 1000 },
                    'req-2': { id: 'req-2', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 2000 },
                },
            });

            expect(handler).toHaveBeenCalledTimes(2);
            expect(handler).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({ id: 'req-2' }));
        });

        it('handles agentState with no requests', () => {
            const handler = vi.fn();
            tracker.on('permission-request', handler);

            tracker.handleSessionUpdate('sess-1', { state: 'thinking' });

            expect(handler).not.toHaveBeenCalled();
        });

        it('handles agentState with empty requests object', () => {
            const handler = vi.fn();
            tracker.on('permission-request', handler);

            tracker.handleSessionUpdate('sess-1', { requests: {} });

            expect(handler).not.toHaveBeenCalled();
        });

        it('cleans up seen requests when they disappear from agentState', () => {
            const handler = vi.fn();
            tracker.on('permission-request', handler);

            tracker.handleSessionUpdate('sess-1', {
                requests: {
                    'req-1': { id: 'req-1', tool: 'Edit', arguments: {}, createdAt: 1000 },
                },
            });

            // req-1 disappears (approved/denied externally)
            tracker.handleSessionUpdate('sess-1', { requests: {} });

            // getPendingRequests should reflect current state
            expect(tracker.getPendingRequests('sess-1')).toEqual([]);
        });

        it('tracks requests per session independently', () => {
            const handler = vi.fn();
            tracker.on('permission-request', handler);

            tracker.handleSessionUpdate('sess-1', {
                requests: { 'req-1': { id: 'req-1', tool: 'Edit', arguments: {}, createdAt: 1000 } },
            });

            tracker.handleSessionUpdate('sess-2', {
                requests: { 'req-1': { id: 'req-1', tool: 'Bash', arguments: {}, createdAt: 2000 } },
            });

            expect(handler).toHaveBeenCalledTimes(2);
        });
    });

    describe('getPendingRequests', () => {
        it('returns current pending requests for a session', () => {
            tracker.handleSessionUpdate('sess-1', {
                requests: {
                    'req-1': { id: 'req-1', tool: 'Edit', arguments: { file: 'a.ts' }, createdAt: 1000 },
                    'req-2': { id: 'req-2', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 2000 },
                },
            });

            const pending = tracker.getPendingRequests('sess-1');
            expect(pending).toHaveLength(2);
            expect(pending).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'req-1' }),
                expect.objectContaining({ id: 'req-2' }),
            ]));
        });

        it('returns empty array for unknown session', () => {
            expect(tracker.getPendingRequests('unknown')).toEqual([]);
        });
    });

    describe('clearSession', () => {
        it('removes all tracking for a session', () => {
            tracker.handleSessionUpdate('sess-1', {
                requests: { 'req-1': { id: 'req-1', tool: 'Edit', arguments: {}, createdAt: 1000 } },
            });

            tracker.clearSession('sess-1');
            expect(tracker.getPendingRequests('sess-1')).toEqual([]);
        });
    });
});
