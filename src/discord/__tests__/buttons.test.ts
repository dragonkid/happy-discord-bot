import { describe, it, expect } from 'vitest';
import {
    buildPermissionButtons,
    parseButtonId,
    BUTTON_PREFIX,
    buildAskButtons,
    parseAskButtonId,
    buildSessionButtons,
    parseSessionButtonId,
    buildExitPlanButtons,
    parseExitPlanButtonId,
    buildRejectPlanModal,
    parsePlanModalId,
    PLAN_MODAL_PREFIX,
    buildNewSessionMenu,
    parseNewSessionSelect,
    parseCustomPathButton,
    buildCustomPathModal,
    parseCustomPathModal,
    buildCustomPathOnly,
    NEW_SESSION_SELECT_PREFIX,
    NEW_SESSION_CUSTOM_PREFIX,
    NEW_SESSION_MODAL_PREFIX,
    buildDeleteConfirmButtons,
    parseDeleteButtonId,
    parseCleanupButtonId,
    buildYoloToggleButton,
    extractYoloState,
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

        it('returns Yes, For <program>:*, and No for Bash tools', () => {
            const rows = buildPermissionButtons('sess-1', 'req-1', 'Bash', { command: 'ls' });
            expect(rows[0].components).toHaveLength(3);
            expect(btnData(rows, 0).label).toBe('Yes');
            expect(btnData(rows, 1).label).toBe('For ls:*');
            expect(btnData(rows, 2).label).toBe('No');
        });

        it('shows For <toolName> for non-Bash non-edit tools', () => {
            const rows = buildPermissionButtons('sess-1', 'req-1', 'WebSearch', {});
            expect(btnData(rows, 1).label).toBe('For WebSearch');
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

describe('ExitPlanMode buttons', () => {
    describe('buildExitPlanButtons', () => {
        it('returns one row with three buttons', () => {
            const rows = buildExitPlanButtons('sess-1', 'req-1');
            expect(rows).toHaveLength(1);
            expect(rows[0].components).toHaveLength(3);
        });

        it('buttons have correct custom IDs', () => {
            const rows = buildExitPlanButtons('sess-1', 'req-1');
            const ids = rows[0].components.map((b: any) => b.data.custom_id);
            expect(ids).toEqual([
                'plan:sess-1:req-1:approve',
                'plan:sess-1:req-1:approve-edits',
                'plan:sess-1:req-1:reject',
            ]);
        });

        it('buttons have correct labels and styles', () => {
            const rows = buildExitPlanButtons('sess-1', 'req-1');
            const btns = rows[0].components.map((b: any) => b.data);
            expect(btns[0].label).toBe('Approve');
            expect(btns[0].style).toBe(ButtonStyle.Success);
            expect(btns[1].label).toBe('Approve + Allow Edits');
            expect(btns[1].style).toBe(ButtonStyle.Primary);
            expect(btns[2].label).toBe('Reject');
            expect(btns[2].style).toBe(ButtonStyle.Danger);
        });
    });

    describe('parseExitPlanButtonId', () => {
        it('parses approve button', () => {
            expect(parseExitPlanButtonId('plan:sess-1:req-1:approve')).toEqual({
                sessionId: 'sess-1', requestId: 'req-1', action: 'approve',
            });
        });

        it('parses approve-edits button', () => {
            expect(parseExitPlanButtonId('plan:sess-1:req-1:approve-edits')).toEqual({
                sessionId: 'sess-1', requestId: 'req-1', action: 'approve-edits',
            });
        });

        it('parses reject button', () => {
            expect(parseExitPlanButtonId('plan:sess-1:req-1:reject')).toEqual({
                sessionId: 'sess-1', requestId: 'req-1', action: 'reject',
            });
        });

        it('returns null for non-plan buttons', () => {
            expect(parseExitPlanButtonId('perm:sess-1:req-1:yes')).toBeNull();
        });

        it('returns null for invalid action', () => {
            expect(parseExitPlanButtonId('plan:sess-1:req-1:invalid')).toBeNull();
        });

        it('returns null for malformed button', () => {
            expect(parseExitPlanButtonId('plan:incomplete')).toBeNull();
        });
    });

    describe('buildRejectPlanModal', () => {
        it('creates modal with correct custom ID', () => {
            const modal = buildRejectPlanModal('sess-1', 'req-1');
            expect(modal.data.custom_id).toBe(`${PLAN_MODAL_PREFIX}sess-1:req-1`);
        });

        it('has title "Reject Plan"', () => {
            const modal = buildRejectPlanModal('sess-1', 'req-1');
            expect(modal.data.title).toBe('Reject Plan');
        });

        it('has one component row', () => {
            const modal = buildRejectPlanModal('sess-1', 'req-1');
            expect(modal.components).toHaveLength(1);
        });
    });

    describe('parsePlanModalId', () => {
        it('parses valid modal ID', () => {
            expect(parsePlanModalId('plan-modal:sess-1:req-1')).toEqual({
                sessionId: 'sess-1', requestId: 'req-1',
            });
        });

        it('returns null for non-modal ID', () => {
            expect(parsePlanModalId('plan:sess-1:req-1:approve')).toBeNull();
        });

        it('returns null for malformed modal ID', () => {
            expect(parsePlanModalId('plan-modal:incomplete')).toBeNull();
        });
    });
});

describe('New session menu', () => {
    const singleMachineDirs = [
        { path: '/Users/user/project-a', machineId: 'machine-1', host: 'arbitrage', label: 'user/project-a' },
        { path: '/Users/user/project-b', machineId: 'machine-1', host: 'arbitrage', label: 'user/project-b' },
    ];
    const multiMachineDirs = [
        { path: '/Users/dk/project-a', machineId: 'machine-1', host: 'arbitrage', label: 'dk/project-a' },
        { path: '/Users/bob/project-b', machineId: 'machine-2', host: 'workstation', label: 'bob/project-b' },
    ];
    const singleMachineList = [{ machineId: 'machine-1', host: 'arbitrage' }];
    const multiMachineList = [
        { machineId: 'machine-1', host: 'arbitrage' },
        { machineId: 'machine-2', host: 'workstation' },
    ];

    describe('buildNewSessionMenu', () => {
        it('creates a StringSelectMenu with directory options', () => {
            const rows = buildNewSessionMenu(singleMachineDirs, singleMachineList);
            expect(rows).toHaveLength(2);
            const menuRow = rows[0];
            expect(menuRow.components).toHaveLength(1);
            const menu = menuRow.components[0] as any;
            expect(menu.options?.length ?? menu.data?.options?.length).toBe(2);
        });

        it('uses index-based values to avoid 100-char limit', () => {
            const rows = buildNewSessionMenu(singleMachineDirs, singleMachineList);
            const menu = rows[0].components[0] as any;
            const options = menu.options ?? menu.data?.options ?? [];
            const values = options.map((o: any) => o.data?.value ?? o.value);
            expect(values[0]).toBe('0');
            expect(values[1]).toBe('1');
        });

        it('single machine — no hostname in description, single Custom path button', () => {
            const rows = buildNewSessionMenu(singleMachineDirs, singleMachineList);
            // Description should NOT contain @ hostname
            const menu = rows[0].components[0] as any;
            const options = menu.options ?? menu.data?.options ?? [];
            const desc = options[0].data?.description ?? options[0].description;
            expect(desc).not.toContain('@');
            // Custom path button + YOLO toggle
            const btnRow = rows[1];
            expect(btnRow.components).toHaveLength(2);
            const btnData = btnRow.components[0].data as { custom_id: string; label: string };
            expect(btnData.label).toBe('Custom path...');
            expect(btnData.custom_id).toBe('newsess-custom:btn');
        });

        it('multi machine — hostname in description, per-machine Custom path buttons', () => {
            const rows = buildNewSessionMenu(multiMachineDirs, multiMachineList);
            // Description should contain @ hostname
            const menu = rows[0].components[0] as any;
            const options = menu.options ?? menu.data?.options ?? [];
            const desc0 = options[0].data?.description ?? options[0].description;
            expect(desc0).toContain('@ arbitrage');
            const desc1 = options[1].data?.description ?? options[1].description;
            expect(desc1).toContain('@ workstation');
            // Per-machine buttons + YOLO toggle
            const btnRow = rows[1];
            expect(btnRow.components).toHaveLength(3);
            const btn0 = btnRow.components[0].data as { custom_id: string; label: string };
            expect(btn0.custom_id).toBe('newsess-custom:machine-1');
            expect(btn0.label).toContain('arbitrage');
            const btn1 = btnRow.components[1].data as { custom_id: string; label: string };
            expect(btn1.custom_id).toBe('newsess-custom:machine-2');
            expect(btn1.label).toContain('workstation');
        });

        it('includes YOLO toggle button in button row', () => {
            const rows = buildNewSessionMenu(singleMachineDirs, singleMachineList);
            const btnRow = rows[1];
            const buttons = btnRow.components;
            const yoloBtn = buttons.find((b: any) => {
                const data = b.toJSON();
                return data.custom_id?.startsWith('newsess-yolo:');
            });
            expect(yoloBtn).toBeDefined();
            const data = (yoloBtn as any).toJSON();
            expect(data.custom_id).toBe('newsess-yolo:off');
            expect(data.label).toBe('YOLO: OFF');
        });
    });

    describe('parseNewSessionSelect', () => {
        it('parses valid select customId', () => {
            expect(parseNewSessionSelect(`${NEW_SESSION_SELECT_PREFIX}test`)).toBe(true);
        });

        it('returns false for non-matching prefix', () => {
            expect(parseNewSessionSelect('other:id')).toBe(false);
        });
    });

    describe('parseCustomPathButton', () => {
        it('parses valid custom path button', () => {
            expect(parseCustomPathButton(`${NEW_SESSION_CUSTOM_PREFIX}btn`)).toBe(true);
        });

        it('returns false for non-matching prefix', () => {
            expect(parseCustomPathButton('perm:something')).toBe(false);
        });
    });

    describe('buildCustomPathModal', () => {
        it('creates a modal with text input for directory path', () => {
            const modal = buildCustomPathModal('machine-1');
            expect(modal.data.title).toBe('New Session');
            expect(modal.data.custom_id).toContain(NEW_SESSION_MODAL_PREFIX);
        });
    });

    describe('parseCustomPathModal', () => {
        it('parses valid modal customId', () => {
            const result = parseCustomPathModal(`${NEW_SESSION_MODAL_PREFIX}machine-1`);
            expect(result).toEqual({ machineId: 'machine-1' });
        });

        it('returns null for non-matching prefix', () => {
            expect(parseCustomPathModal('other:id')).toBeNull();
        });
    });
});

describe('YOLO toggle button', () => {
    describe('buildYoloToggleButton', () => {
        it('builds OFF button with Secondary style', () => {
            const btn = buildYoloToggleButton(false);
            const data = btn.toJSON() as any;
            expect(data.custom_id).toBe('newsess-yolo:off');
            expect(data.label).toBe('YOLO: OFF');
            expect(data.style).toBe(ButtonStyle.Secondary);
        });

        it('builds ON button with Danger style', () => {
            const btn = buildYoloToggleButton(true);
            const data = btn.toJSON() as any;
            expect(data.custom_id).toBe('newsess-yolo:on');
            expect(data.label).toBe('YOLO: ON');
            expect(data.style).toBe(ButtonStyle.Danger);
        });
    });

    describe('extractYoloState', () => {
        it('returns false when message is null', () => {
            expect(extractYoloState(null)).toBe(false);
        });

        it('returns false when no YOLO button found', () => {
            const msg = { components: [] } as any;
            expect(extractYoloState(msg)).toBe(false);
        });

        it('returns false when YOLO button is off', () => {
            const msg = {
                components: [{
                    components: [{ customId: 'newsess-yolo:off' }],
                }],
            } as any;
            expect(extractYoloState(msg)).toBe(false);
        });

        it('returns true when YOLO button is on', () => {
            const msg = {
                components: [{
                    components: [{ customId: 'newsess-yolo:on' }],
                }],
            } as any;
            expect(extractYoloState(msg)).toBe(true);
        });

        it('finds YOLO button in second action row', () => {
            const msg = {
                components: [
                    { components: [{ customId: 'newsess-sel:dir' }] },
                    { components: [{ customId: 'newsess-custom:btn' }, { customId: 'newsess-yolo:on' }] },
                ],
            } as any;
            expect(extractYoloState(msg)).toBe(true);
        });
    });
});

describe('buildCustomPathOnly', () => {
    it('includes YOLO toggle button', () => {
        const rows = buildCustomPathOnly([{ machineId: 'machine-1', host: 'macbook' }]);
        const allButtons = rows.flatMap(r => r.components);
        const yoloBtn = allButtons.find((b: any) => {
            const data = b.toJSON();
            return data.custom_id?.startsWith('newsess-yolo:');
        });
        expect(yoloBtn).toBeDefined();
    });
});

describe('Delete confirmation buttons', () => {
    describe('buildDeleteConfirmButtons', () => {
        it('returns one row with confirm and cancel buttons', () => {
            const rows = buildDeleteConfirmButtons('sess-1');
            expect(rows).toHaveLength(1);
            expect(rows[0].components).toHaveLength(2);
        });

        it('confirm button has Danger style', () => {
            const rows = buildDeleteConfirmButtons('sess-1');
            const btn = rows[0].components[0].data as any;
            expect(btn.label).toBe('Confirm Delete');
            expect(btn.style).toBe(ButtonStyle.Danger);
            expect(btn.custom_id).toBe('delete:sess-1:confirm');
        });

        it('cancel button has Secondary style', () => {
            const rows = buildDeleteConfirmButtons('sess-1');
            const btn = rows[0].components[1].data as any;
            expect(btn.label).toBe('Cancel');
            expect(btn.style).toBe(ButtonStyle.Secondary);
            expect(btn.custom_id).toBe('delete:sess-1:cancel');
        });
    });

    describe('parseDeleteButtonId', () => {
        it('parses confirm button', () => {
            expect(parseDeleteButtonId('delete:sess-1:confirm')).toEqual({
                sessionId: 'sess-1', action: 'confirm',
            });
        });

        it('parses cancel button', () => {
            expect(parseDeleteButtonId('delete:sess-1:cancel')).toEqual({
                sessionId: 'sess-1', action: 'cancel',
            });
        });

        it('returns null for non-delete buttons', () => {
            expect(parseDeleteButtonId('perm:sess-1:req-1:yes')).toBeNull();
        });

        it('returns null for invalid action', () => {
            expect(parseDeleteButtonId('delete:sess-1:invalid')).toBeNull();
        });

        it('returns null for malformed button', () => {
            expect(parseDeleteButtonId('delete:incomplete')).toBeNull();
        });
    });

    describe('parseCleanupButtonId', () => {
        it('parses confirm action', () => {
            expect(parseCleanupButtonId('cleanup:confirm')).toEqual({ action: 'confirm' });
        });

        it('parses cancel action', () => {
            expect(parseCleanupButtonId('cleanup:cancel')).toEqual({ action: 'cancel' });
        });

        it('returns null for non-cleanup prefix', () => {
            expect(parseCleanupButtonId('delete:sess-1:confirm')).toBeNull();
        });

        it('returns null for invalid action', () => {
            expect(parseCleanupButtonId('cleanup:invalid')).toBeNull();
        });
    });
});
