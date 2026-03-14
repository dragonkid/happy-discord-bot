import { describe, it, expect } from 'vitest';
import { parseArgs } from '../cli.js';

describe('parseArgs', () => {
    it('parses "start" command', () => {
        expect(parseArgs(['start'])).toEqual({ command: 'start', args: [] });
    });

    it('defaults to "start" when no args', () => {
        expect(parseArgs([])).toEqual({ command: 'start', args: [] });
    });

    it('parses "daemon start"', () => {
        expect(parseArgs(['daemon', 'start'])).toEqual({ command: 'daemon', args: ['start'] });
    });

    it('parses "update"', () => {
        expect(parseArgs(['update'])).toEqual({ command: 'update', args: [] });
    });

    it('parses "version" and --version flag', () => {
        expect(parseArgs(['version'])).toEqual({ command: 'version', args: [] });
        expect(parseArgs(['--version'])).toEqual({ command: 'version', args: [] });
    });

    it('parses "init"', () => {
        expect(parseArgs(['init'])).toEqual({ command: 'init', args: [] });
    });

    it('parses "deploy-commands"', () => {
        expect(parseArgs(['deploy-commands'])).toEqual({ command: 'deploy-commands', args: [] });
    });

    it('parses "help" and --help flag', () => {
        expect(parseArgs(['help'])).toEqual({ command: 'help', args: [] });
        expect(parseArgs(['--help'])).toEqual({ command: 'help', args: [] });
        expect(parseArgs(['-h'])).toEqual({ command: 'help', args: [] });
    });

    it('passes remaining args through', () => {
        expect(parseArgs(['daemon', 'start', '--verbose'])).toEqual({
            command: 'daemon',
            args: ['start', '--verbose'],
        });
    });
});
