import { describe, it, expect } from 'vitest';
import { chunkMessage, codeBlock, diffBlock, truncate, formatPermissionRequest, formatAskUserQuestion, formatExitPlanMode } from '../formatter.js';

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
            // All chunks must be within limit
            for (const chunk of chunks) {
                expect(chunk.length).toBeLessThanOrEqual(2000);
            }
            // All content preserved
            expect(chunks.join('')).toBe(text);
        });

        it('returns empty array for empty string', () => {
            expect(chunkMessage('')).toEqual([]);
        });

        it('closes and reopens code fence when splitting inside a code block', () => {
            const code = 'line\n'.repeat(600); // ~3000 chars, forces split
            const text = `Before\n\`\`\`typescript\n${code}\`\`\`\nAfter`;
            const chunks = chunkMessage(text, 2000);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            // Every chunk should have balanced code fences
            for (const chunk of chunks) {
                const fenceCount = (chunk.match(/^```/gm) || []).length;
                expect(fenceCount % 2).toBe(0);
            }
            // Second chunk should reopen with same language
            expect(chunks[1]).toMatch(/^```typescript\n/);
        });

        it('closes and reopens diff code fence when splitting', () => {
            const diffLines = Array.from({ length: 200 }, (_, i) =>
                i % 2 === 0 ? `- old line ${i}` : `+ new line ${i}`,
            ).join('\n');
            const text = `Header\n\`\`\`diff\n${diffLines}\n\`\`\``;
            const chunks = chunkMessage(text, 2000);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            for (const chunk of chunks) {
                const fenceCount = (chunk.match(/^```/gm) || []).length;
                expect(fenceCount % 2).toBe(0);
            }
            expect(chunks[1]).toMatch(/^```diff\n/);
        });

        it('handles code fence without language specifier', () => {
            const code = 'x\n'.repeat(1500);
            const text = `\`\`\`\n${code}\`\`\``;
            const chunks = chunkMessage(text, 2000);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            for (const chunk of chunks) {
                const fenceCount = (chunk.match(/^```/gm) || []).length;
                expect(fenceCount % 2).toBe(0);
            }
            expect(chunks[1]).toMatch(/^```\n/);
        });

        it('does not modify chunks that have no open code fence', () => {
            const line = 'x'.repeat(1500);
            const text = `${line}\n${'y'.repeat(1500)}`;
            const chunks = chunkMessage(text, 2000);
            expect(chunks).toHaveLength(2);
            // Content is preserved (though split point may shift due to fence reserve)
            expect(chunks[0] + '\n' + chunks[1]).toBe(text);
        });

        it('never produces chunks exceeding the limit', () => {
            const code = 'line of code here\n'.repeat(200);
            const text = `Header\n\`\`\`typescript\n${code}\`\`\`\nFooter`;
            const chunks = chunkMessage(text, 2000);
            for (const chunk of chunks) {
                expect(chunk.length).toBeLessThanOrEqual(2000);
            }
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

    describe('formatAskUserQuestion', () => {
        it('formats a single question with options', () => {
            const question = {
                question: 'Which database?',
                header: 'Database',
                options: [
                    { label: 'PostgreSQL', description: 'Relational database' },
                    { label: 'MongoDB', description: 'Document database' },
                ],
                multiSelect: false,
            };
            const result = formatAskUserQuestion([question]);
            expect(result).toContain('Which database?');
            expect(result).toContain('PostgreSQL');
            expect(result).toContain('Relational database');
        });

        it('formats multiple questions separated by blank lines', () => {
            const questions = [
                {
                    question: 'Q1?', header: 'H1',
                    options: [{ label: 'A', description: 'desc A' }],
                    multiSelect: false,
                },
                {
                    question: 'Q2?', header: 'H2',
                    options: [{ label: 'B', description: 'desc B' }],
                    multiSelect: true,
                },
            ];
            const result = formatAskUserQuestion(questions);
            expect(result).toContain('Q1?');
            expect(result).toContain('Q2?');
            expect(result).toContain('(select multiple)');
        });

        it('marks multi-select questions', () => {
            const question = {
                question: 'Pick features', header: 'Features',
                options: [{ label: 'A', description: 'desc' }],
                multiSelect: true,
            };
            const result = formatAskUserQuestion([question]);
            expect(result).toContain('(select multiple)');
        });
    });

    describe('formatExitPlanMode', () => {
        it('inlines short plan text in code block', () => {
            const result = formatExitPlanMode('Step 1: Do thing');
            expect(result).toContain('Plan Proposal');
            expect(result).toContain('```md');
            expect(result).toContain('Step 1: Do thing');
            expect(result).not.toContain('attached plan');
        });

        it('shows attachment header for long plan', () => {
            const longPlan = 'x'.repeat(1600);
            const result = formatExitPlanMode(longPlan);
            expect(result).toContain('Plan Proposal');
            expect(result).toContain('attached plan');
            expect(result).not.toContain(longPlan);
        });

        it('shows attachment header for empty plan', () => {
            const result = formatExitPlanMode('');
            expect(result).toContain('Plan Proposal');
            expect(result).toContain('attached plan');
        });
    });
});
