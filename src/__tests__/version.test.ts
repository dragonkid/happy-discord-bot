import { describe, it, expect } from 'vitest';
import { getVersion } from '../version.js';

describe('getVersion', () => {
    it('returns a valid semver string', () => {
        const version = getVersion();
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
});
