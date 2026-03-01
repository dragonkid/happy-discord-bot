import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandDefinitions, handleCommand } from '../commands.js';

// Minimal interaction mock
function mockInteraction(name: string, options: Record<string, string> = {}) {
    return {
        commandName: name,
        user: { id: 'u-1' },
        options: {
            getString: vi.fn((key: string) => options[key] ?? null),
        },
        reply: vi.fn().mockResolvedValue(undefined),
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
    };
}

describe('commands', () => {
    describe('commandDefinitions', () => {
        it('exports an array of slash command JSON objects', () => {
            expect(Array.isArray(commandDefinitions)).toBe(true);
            expect(commandDefinitions.length).toBeGreaterThan(0);

            for (const cmd of commandDefinitions) {
                expect(cmd).toHaveProperty('name');
                expect(cmd).toHaveProperty('description');
            }
        });

        it('includes /sessions command', () => {
            const sessions = commandDefinitions.find((c) => c.name === 'sessions');
            expect(sessions).toBeDefined();
        });

        it('includes /send command with message option', () => {
            const send = commandDefinitions.find((c) => c.name === 'send');
            expect(send).toBeDefined();
            expect(send!.options).toBeDefined();
        });
    });

    describe('handleCommand', () => {
        it('replies to /sessions', async () => {
            const interaction = mockInteraction('sessions');
            await handleCommand(interaction as any);
            expect(interaction.deferReply).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalled();
        });

        it('replies to /send with message', async () => {
            const interaction = mockInteraction('send', { message: 'hello' });
            await handleCommand(interaction as any);
            expect(interaction.deferReply).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalled();
        });

        it('replies with error for /send without message', async () => {
            const interaction = mockInteraction('send');
            await handleCommand(interaction as any);
            expect(interaction.reply).toHaveBeenCalledWith(
                expect.objectContaining({ content: expect.stringContaining('message') }),
            );
        });

        it('replies with unknown command message for unregistered commands', async () => {
            const interaction = mockInteraction('nonexistent');
            await handleCommand(interaction as any);
            expect(interaction.reply).toHaveBeenCalledWith(
                expect.objectContaining({ content: expect.stringContaining('Unknown') }),
            );
        });
    });
});
