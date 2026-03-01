import { describe, it, expect } from 'vitest';
import { chunkMessage, codeBlock, diffBlock, truncate } from '../formatter.js';

describe('formatter', () => {
    describe('chunkMessage', () => {
        it('returns single chunk for short messages', () => {
            const chunks = chunkMessage('Hello world');
            expect(chunks).toEqual(['Hello world']);
        });

        it('splits at newline boundary within limit', () => {
            const line = 'x'.repeat(1500);
            const text = `${line}\n${'y'.repeat(1500)}`;
            const chunks = chunkMessage(text, 2000);
            expect(chunks).toHaveLength(2);
            expect(chunks[0]).toBe(line);
            expect(chunks[1]).toBe('y'.repeat(1500));
        });

        it('hard-splits lines exceeding limit', () => {
            const text = 'a'.repeat(5000);
            const chunks = chunkMessage(text, 2000);
            expect(chunks).toHaveLength(3);
            expect(chunks[0]).toHaveLength(2000);
            expect(chunks[1]).toHaveLength(2000);
            expect(chunks[2]).toHaveLength(1000);
        });

        it('returns empty array for empty string', () => {
            expect(chunkMessage('')).toEqual([]);
        });
    });

    describe('codeBlock', () => {
        it('wraps content in fenced code block', () => {
            expect(codeBlock('echo hi', 'bash')).toBe('```bash\necho hi\n```');
        });

        it('defaults to no language', () => {
            expect(codeBlock('text')).toBe('```\ntext\n```');
        });
    });

    describe('diffBlock', () => {
        it('wraps content in diff code block', () => {
            expect(diffBlock('- old\n+ new')).toBe('```diff\n- old\n+ new\n```');
        });
    });

    describe('truncate', () => {
        it('returns text as-is if within limit', () => {
            expect(truncate('short', 100)).toBe('short');
        });

        it('truncates with ellipsis suffix', () => {
            const result = truncate('a'.repeat(200), 100);
            expect(result).toHaveLength(100);
            expect(result.endsWith('…')).toBe(true);
        });
    });
});
