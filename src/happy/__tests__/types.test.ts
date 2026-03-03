import { describe, it, expect } from 'vitest';
import { isExitPlanMode } from '../types.js';

describe('isExitPlanMode', () => {
    it('returns true for ExitPlanMode', () => {
        expect(isExitPlanMode('ExitPlanMode')).toBe(true);
    });
    it('returns true for exit_plan_mode', () => {
        expect(isExitPlanMode('exit_plan_mode')).toBe(true);
    });
    it('returns false for other tools', () => {
        expect(isExitPlanMode('Bash')).toBe(false);
        expect(isExitPlanMode('Edit')).toBe(false);
        expect(isExitPlanMode('AskUserQuestion')).toBe(false);
    });
});
