import { describe, it, expect } from 'vitest';
import {
    buildPermissionButtons,
    parseButtonId,
    BUTTON_PREFIX,
    buildAskButtons,
    parseAskButtonId,
    buildSessionButtons,
    parseSessionButtonId,
} from '../buttons.js';
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

describe('AskUserQuestion buttons', () => {
    describe('buildAskButtons (single select)', () => {
        it('creates one button per option', () => {
            const options = [
                { label: 'PostgreSQL', description: 'Relational' },
                { label: 'MongoDB', description: 'Document' },
            ];
            const rows = buildAskButtons('sess-1', 'req-1', options, false, 0);
            const buttons = rows.flatMap(r => r.components);
            expect(buttons).toHaveLength(2);
            expect((buttons[0].data as any).label).toBe('PostgreSQL');
            expect((buttons[1].data as any).label).toBe('MongoDB');
        });

        it('encodes ask: prefix in button IDs', () => {
            const options = [{ label: 'A', description: 'a' }];
            const rows = buildAskButtons('sess-1', 'req-1', options, false, 0);
            expect((rows[0].components[0].data as any).custom_id).toBe('ask:sess-1:req-1:0');
        });
    });

    describe('buildAskButtons (multi select)', () => {
        it('creates toggle buttons + Submit button', () => {
            const options = [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' },
            ];
            const rows = buildAskButtons('sess-1', 'req-1', options, true, 0);
            const allButtons = rows.flatMap(r => r.components);
            expect(allButtons).toHaveLength(3);
            expect((allButtons[2].data as any).label).toBe('Submit');
            expect((allButtons[2].data as any).custom_id).toBe('asks:sess-1:req-1');
        });

        it('uses askt: prefix for toggle buttons', () => {
            const options = [{ label: 'A', description: 'a' }];
            const rows = buildAskButtons('sess-1', 'req-1', options, true, 0);
            expect((rows[0].components[0].data as any).custom_id).toBe('askt:sess-1:req-1:0:0');
        });
    });

    describe('parseAskButtonId', () => {
        it('parses single select button', () => {
            const result = parseAskButtonId('ask:sess-1:req-1:2');
            expect(result).toEqual({
                type: 'select',
                sessionId: 'sess-1',
                requestId: 'req-1',
                optionIndex: 2,
            });
        });

        it('parses multi-select toggle button', () => {
            const result = parseAskButtonId('askt:sess-1:req-1:0:1');
            expect(result).toEqual({
                type: 'toggle',
                sessionId: 'sess-1',
                requestId: 'req-1',
                questionIndex: 0,
                optionIndex: 1,
            });
        });

        it('parses multi-select submit button', () => {
            const result = parseAskButtonId('asks:sess-1:req-1');
            expect(result).toEqual({
                type: 'submit',
                sessionId: 'sess-1',
                requestId: 'req-1',
            });
        });

        it('returns null for unknown prefix', () => {
            expect(parseAskButtonId('perm:sess-1:req-1:yes')).toBeNull();
            expect(parseAskButtonId('unknown:foo')).toBeNull();
        });
    });
});

describe('session buttons', () => {
    describe('buildSessionButtons', () => {
        it('creates one button per session', () => {
            const sessions = [
                { id: 'sess-1', activeAt: 1000 },
                { id: 'sess-2', activeAt: 2000 },
            ];
            const rows = buildSessionButtons(sessions as any, 'sess-1');
            const buttons = rows.flatMap(r => r.components);
            expect(buttons).toHaveLength(2);
        });

        it('disables current session button', () => {
            const sessions = [
                { id: 'sess-1', activeAt: 1000 },
                { id: 'sess-2', activeAt: 2000 },
            ];
            const rows = buildSessionButtons(sessions as any, 'sess-1');
            const btn1 = rows[0].components[0].data as any;
            const btn2 = rows[0].components[1].data as any;
            expect(btn1.disabled).toBe(true);
            expect(btn2.disabled).toBeFalsy();
        });

        it('encodes sess: prefix in button IDs', () => {
            const sessions = [{ id: 'sess-1', activeAt: 1000 }];
            const rows = buildSessionButtons(sessions as any, null);
            expect((rows[0].components[0].data as any).custom_id).toBe('sess:sess-1');
        });
    });

    describe('parseSessionButtonId', () => {
        it('parses valid session button', () => {
            expect(parseSessionButtonId('sess:sess-1')).toEqual({ sessionId: 'sess-1' });
        });

        it('returns null for non-session button', () => {
            expect(parseSessionButtonId('perm:sess-1:req-1:yes')).toBeNull();
        });
    });
});
