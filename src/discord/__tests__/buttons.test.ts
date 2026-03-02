import { describe, it, expect } from 'vitest';
import { buildPermissionButtons, parseButtonId, BUTTON_PREFIX } from '../buttons.js';
import { ButtonStyle, type APIButtonComponentWithCustomId } from 'discord.js';

/** Helper to access button data with the correct type. */
function btnData(rows: ReturnType<typeof buildPermissionButtons>, index: number): APIButtonComponentWithCustomId {
    return rows[0].components[index].data as APIButtonComponentWithCustomId;
}

describe('buttons', () => {
    describe('buildPermissionButtons', () => {
        it('returns Yes and No for edit tools', () => {
            const rows = buildPermissionButtons('sess-1', 'req-1', 'Edit', {});
            expect(rows[0].components).toHaveLength(3);
            // Yes, Allow All Edits, No
            expect(btnData(rows, 0).label).toBe('Yes');
            expect(btnData(rows, 0).style).toBe(ButtonStyle.Success);
            expect(btnData(rows, 1).label).toBe('Allow All Edits');
            expect(btnData(rows, 1).style).toBe(ButtonStyle.Primary);
            expect(btnData(rows, 2).label).toBe('No');
            expect(btnData(rows, 2).style).toBe(ButtonStyle.Danger);
        });

        it('returns Yes, For This Tool, and No for non-edit tools', () => {
            const rows = buildPermissionButtons('sess-1', 'req-1', 'Bash', { command: 'ls' });
            expect(rows[0].components).toHaveLength(3);
            expect(btnData(rows, 0).label).toBe('Yes');
            expect(btnData(rows, 1).label).toBe('For This Tool');
            expect(btnData(rows, 2).label).toBe('No');
        });

        it('encodes session, request, and action in button customId', () => {
            const rows = buildPermissionButtons('sess-1', 'req-1', 'Edit', {});
            expect(btnData(rows, 0).custom_id).toBe(`${BUTTON_PREFIX}sess-1:req-1:yes`);
        });
    });

    describe('parseButtonId', () => {
        it('parses valid button customId', () => {
            const result = parseButtonId(`${BUTTON_PREFIX}sess-1:req-1:yes`);
            expect(result).toEqual({ sessionId: 'sess-1', requestId: 'req-1', action: 'yes' });
        });

        it('returns null for non-permission button', () => {
            expect(parseButtonId('other:button')).toBeNull();
        });

        it('returns null for malformed button', () => {
            expect(parseButtonId(`${BUTTON_PREFIX}incomplete`)).toBeNull();
        });

        it('parses all action types', () => {
            for (const action of ['yes', 'allow-edits', 'for-tool', 'no']) {
                const result = parseButtonId(`${BUTTON_PREFIX}s:r:${action}`);
                expect(result?.action).toBe(action);
            }
        });
    });
});
