import { describe, it, expect } from 'vitest';
import { chunkMessage, codeBlock, diffBlock, truncate, formatPermissionRequest } from '../formatter.js';

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

    describe('formatPermissionRequest', () => {
        it('formats Edit tool with file path', () => {
            const text = formatPermissionRequest('Edit', { file_path: '/src/index.ts', old_string: 'foo', new_string: 'bar' });
            expect(text).toContain('Edit');
            expect(text).toContain('/src/index.ts');
        });

        it('formats Edit tool with diff block showing old and new strings', () => {
            const text = formatPermissionRequest('Edit', { file_path: '/src/index.ts', old_string: 'foo', new_string: 'bar' });
            expect(text).toContain('- foo');
            expect(text).toContain('+ bar');
            expect(text).toContain('```diff');
        });

        it('formats Bash tool with command', () => {
            const text = formatPermissionRequest('Bash', { command: 'npm test' });
            expect(text).toContain('Bash');
            expect(text).toContain('npm test');
            expect(text).toContain('```bash');
        });

        it('formats Write tool with file path', () => {
            const text = formatPermissionRequest('Write', { file_path: '/src/new.ts', content: 'const x = 1;' });
            expect(text).toContain('Write');
            expect(text).toContain('/src/new.ts');
        });

        it('truncates long command output', () => {
            const longCommand = 'a'.repeat(500);
            const text = formatPermissionRequest('Bash', { command: longCommand });
            expect(text.length).toBeLessThan(600);
        });

        it('truncates long Edit old/new strings', () => {
            const longStr = 'x'.repeat(300);
            const text = formatPermissionRequest('Edit', { file_path: '/f.ts', old_string: longStr, new_string: longStr });
            // Each side truncated to 150 chars, so combined diff should be well under 600
            expect(text.length).toBeLessThan(600);
        });

        it('handles unknown tool gracefully', () => {
            const text = formatPermissionRequest('CustomTool', { arg1: 'value' });
            expect(text).toContain('CustomTool');
        });

        it('handles unknown tool with JSON args', () => {
            const text = formatPermissionRequest('CustomTool', { arg1: 'value', nested: { key: 42 } });
            expect(text).toContain('CustomTool');
            expect(text).toContain('```');
        });

        it('handles Bash with no command', () => {
            const text = formatPermissionRequest('Bash', {});
            expect(text).toContain('Bash');
        });

        it('handles Edit with no old_string or new_string', () => {
            const text = formatPermissionRequest('Edit', { file_path: '/src/index.ts' });
            expect(text).toContain('Edit');
            expect(text).toContain('/src/index.ts');
        });
    });
});
