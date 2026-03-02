import { describe, it, expect } from 'vitest';
import { buildPermissionButtons, parseButtonId, BUTTON_PREFIX } from '../buttons.js';
import { ButtonStyle } from 'discord.js';

describe('buttons', () => {
    describe('buildPermissionButtons', () => {
        it('returns Yes and No for edit tools', () => {
            const rows = buildPermissionButtons('sess-1', 'req-1', 'Edit', {});
            const buttons = rows[0].components;
            expect(buttons).toHaveLength(3);
            // Yes, Allow All Edits, No
            expect(buttons[0].data.label).toBe('Yes');
            expect(buttons[0].data.style).toBe(ButtonStyle.Success);
            expect(buttons[1].data.label).toBe('Allow All Edits');
            expect(buttons[1].data.style).toBe(ButtonStyle.Primary);
            expect(buttons[2].data.label).toBe('No');
            expect(buttons[2].data.style).toBe(ButtonStyle.Danger);
        });

        it('returns Yes, For This Tool, and No for non-edit tools', () => {
            const rows = buildPermissionButtons('sess-1', 'req-1', 'Bash', { command: 'ls' });
            const buttons = rows[0].components;
            expect(buttons).toHaveLength(3);
            expect(buttons[0].data.label).toBe('Yes');
            expect(buttons[1].data.label).toBe('For This Tool');
            expect(buttons[2].data.label).toBe('No');
        });

        it('encodes session, request, and action in button customId', () => {
            const rows = buildPermissionButtons('sess-1', 'req-1', 'Edit', {});
            const yesId = rows[0].components[0].data.custom_id;
            expect(yesId).toBe(`${BUTTON_PREFIX}sess-1:req-1:yes`);
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
