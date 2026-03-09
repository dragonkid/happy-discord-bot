import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillRegistry, type SkillEntry } from '../skill-registry.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

vi.mock('node:fs/promises');

const MOCK_HOME = '/mock-home';

function mockSkillMd(name: string, description: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}`;
}

function mockCommandMd(description: string): string {
    return `---\ndescription: ${description}\n---\n\n## Context`;
}

// --- Helpers for mock filesystem ---

type MockFs = Record<string, string | string[]>; // path -> file content or dir listing

function setupMockFs(files: MockFs) {
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const p = String(filePath);
        const content = files[p];
        if (typeof content === 'string') return content;
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    });

    vi.mocked(fs.readdir).mockImplementation(async (dirPath) => {
        const p = String(dirPath);
        const listing = files[p];
        if (Array.isArray(listing)) return listing as unknown as Awaited<ReturnType<typeof fs.readdir>>;
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    });

    vi.mocked(fs.stat).mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (p in files) {
            return { isDirectory: () => Array.isArray(files[p]) } as any;
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    });
}

const PLUGINS_JSON = path.join(MOCK_HOME, '.claude', 'plugins', 'installed_plugins.json');
const SETTINGS_JSON = path.join(MOCK_HOME, '.claude', 'settings.json');
const USER_SKILLS = path.join(MOCK_HOME, '.claude', 'skills');
const USER_COMMANDS = path.join(MOCK_HOME, '.claude', 'commands');

describe('SkillRegistry', () => {
    let registry: SkillRegistry;

    beforeEach(() => {
        vi.restoreAllMocks();
        registry = new SkillRegistry(MOCK_HOME);
    });

    describe('scan — personal sources', () => {
        it('loads skills from ~/.claude/skills/<name>/SKILL.md', async () => {
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [USER_SKILLS]: ['my-skill'],
                [path.join(USER_SKILLS, 'my-skill', 'SKILL.md')]: mockSkillMd('my-skill', 'My personal skill'),
            });
            await registry.scanGlobal();
            const all = registry.getForSession();
            expect(all).toHaveLength(1);
            expect(all[0]).toMatchObject({
                name: 'my-skill',
                description: 'My personal skill',
                type: 'skill',
                source: 'personal',
            });
        });

        it('loads commands from ~/.claude/commands/<name>.md', async () => {
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [USER_COMMANDS]: ['commit.md'],
                [path.join(USER_COMMANDS, 'commit.md')]: mockCommandMd('Create a git commit'),
            });
            await registry.scanGlobal();
            const all = registry.getForSession();
            expect(all).toHaveLength(1);
            expect(all[0]).toMatchObject({
                name: 'commit',
                type: 'command',
                source: 'personal',
            });
        });

        it('uses filename (sans .md) as name when frontmatter has no name field', async () => {
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [USER_COMMANDS]: ['my-cmd.md'],
                [path.join(USER_COMMANDS, 'my-cmd.md')]: mockCommandMd('My command'),
            });
            await registry.scanGlobal();
            expect(registry.getForSession()[0].name).toBe('my-cmd');
        });
    });

    describe('scan — project sources (per-session isolation)', () => {
        it('loads skills from project .claude/skills/', async () => {
            const projDir = '/projects/my-app';
            const projSkills = path.join(projDir, '.claude', 'skills');
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [projSkills]: ['proj-skill'],
                [path.join(projSkills, 'proj-skill', 'SKILL.md')]: mockSkillMd('proj-skill', 'Project skill'),
            });
            await registry.scanProject(projDir);
            const all = registry.getForSession(projDir);
            expect(all).toHaveLength(1);
            expect(all[0]).toMatchObject({
                name: 'proj-skill',
                source: 'project',
            });
        });

        it('project skills are isolated — different dirs have different skills', async () => {
            const dirA = '/projects/app-a';
            const dirB = '/projects/app-b';
            const skillsA = path.join(dirA, '.claude', 'skills');
            const skillsB = path.join(dirB, '.claude', 'skills');
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [skillsA]: ['skill-a'],
                [path.join(skillsA, 'skill-a', 'SKILL.md')]: mockSkillMd('skill-a', 'From A'),
                [skillsB]: ['skill-b'],
                [path.join(skillsB, 'skill-b', 'SKILL.md')]: mockSkillMd('skill-b', 'From B'),
            });
            await registry.scanProject(dirA);
            await registry.scanProject(dirB);

            const forA = registry.getForSession(dirA);
            expect(forA.map((e) => e.name)).toContain('skill-a');
            expect(forA.map((e) => e.name)).not.toContain('skill-b');

            const forB = registry.getForSession(dirB);
            expect(forB.map((e) => e.name)).toContain('skill-b');
            expect(forB.map((e) => e.name)).not.toContain('skill-a');
        });

        it('getForSession merges global + project entries', async () => {
            const projDir = '/projects/my-app';
            const projSkills = path.join(projDir, '.claude', 'skills');
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [USER_SKILLS]: ['personal-skill'],
                [path.join(USER_SKILLS, 'personal-skill', 'SKILL.md')]: mockSkillMd('personal-skill', 'Personal'),
                [projSkills]: ['proj-skill'],
                [path.join(projSkills, 'proj-skill', 'SKILL.md')]: mockSkillMd('proj-skill', 'Project'),
            });
            await registry.scanGlobal();
            await registry.scanProject(projDir);
            const all = registry.getForSession(projDir);
            expect(all.map((e) => e.name)).toContain('personal-skill');
            expect(all.map((e) => e.name)).toContain('proj-skill');
        });

        it('getForSession without projectDir returns only global', async () => {
            const projDir = '/projects/my-app';
            const projSkills = path.join(projDir, '.claude', 'skills');
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [USER_SKILLS]: ['personal-skill'],
                [path.join(USER_SKILLS, 'personal-skill', 'SKILL.md')]: mockSkillMd('personal-skill', 'Personal'),
                [projSkills]: ['proj-skill'],
                [path.join(projSkills, 'proj-skill', 'SKILL.md')]: mockSkillMd('proj-skill', 'Project'),
            });
            await registry.scanGlobal();
            await registry.scanProject(projDir);
            const all = registry.getForSession();
            expect(all.map((e) => e.name)).toContain('personal-skill');
            expect(all.map((e) => e.name)).not.toContain('proj-skill');
        });

        it('does not shadow: personal and project with same name both appear', async () => {
            const projDir = '/projects/my-app';
            const projSkills = path.join(projDir, '.claude', 'skills');
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [USER_SKILLS]: ['dup'],
                [path.join(USER_SKILLS, 'dup', 'SKILL.md')]: mockSkillMd('dup', 'Personal'),
                [projSkills]: ['dup'],
                [path.join(projSkills, 'dup', 'SKILL.md')]: mockSkillMd('dup', 'Project'),
            });
            await registry.scanGlobal();
            await registry.scanProject(projDir);
            const all = registry.getForSession(projDir);
            const dups = all.filter((e) => e.name === 'dup');
            expect(dups).toHaveLength(2);
            expect(dups.map((e) => e.source)).toContain('personal');
            expect(dups.map((e) => e.source)).toContain('project');
        });
    });

    describe('scan — plugins', () => {
        it('only loads enabled plugins', async () => {
            const installA = '/p/a/1.0';
            const installB = '/p/b/1.0';
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({
                    version: 2,
                    plugins: {
                        'pluginA@m': [{ installPath: installA }],
                        'pluginB@m': [{ installPath: installB }],
                    },
                }),
                [SETTINGS_JSON]: JSON.stringify({
                    enabledPlugins: { 'pluginA@m': true, 'pluginB@m': false },
                }),
                [path.join(installA, 'skills')]: ['skillA'],
                [path.join(installA, 'skills', 'skillA', 'SKILL.md')]: mockSkillMd('skillA', 'From A'),
                [path.join(installB, 'skills')]: ['skillB'],
                [path.join(installB, 'skills', 'skillB', 'SKILL.md')]: mockSkillMd('skillB', 'From B'),
            });
            await registry.scanGlobal();
            const names = registry.getForSession().map((e) => e.name);
            expect(names).toContain('pluginA:skillA');
            expect(names).not.toContain('pluginB:skillB');
        });

        it('uses plugin.json custom skills paths', async () => {
            const install = '/p/ecc/1.0';
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({
                    version: 2,
                    plugins: { 'ecc@m': [{ installPath: install }] },
                }),
                [SETTINGS_JSON]: JSON.stringify({ enabledPlugins: { 'ecc@m': true } }),
                [path.join(install, '.claude-plugin', 'plugin.json')]: JSON.stringify({
                    name: 'ecc',
                    skills: ['./skills/', './commands/'],
                }),
                [path.join(install, 'skills')]: ['s1'],
                [path.join(install, 'skills', 's1', 'SKILL.md')]: mockSkillMd('s1', 'Skill 1'),
                [path.join(install, 'commands')]: ['s2'],
                [path.join(install, 'commands', 's2', 'SKILL.md')]: mockSkillMd('s2', 'Skill 2'),
            });
            await registry.scanGlobal();
            const names = registry.getForSession().map((e) => e.name);
            expect(names).toContain('ecc:s1');
            expect(names).toContain('ecc:s2');
        });

        it('uses plugin name as prefix for plugin skills: pluginName:skillName', async () => {
            const install = '/p/test/1.0';
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({
                    version: 2,
                    plugins: { 'test-plugin@m': [{ installPath: install }] },
                }),
                [SETTINGS_JSON]: JSON.stringify({ enabledPlugins: { 'test-plugin@m': true } }),
                [path.join(install, 'skills')]: ['my-skill'],
                [path.join(install, 'skills', 'my-skill', 'SKILL.md')]: mockSkillMd('my-skill', 'A skill'),
                [path.join(install, 'commands')]: ['my-cmd.md'],
                [path.join(install, 'commands', 'my-cmd.md')]: mockCommandMd('A command'),
            });
            await registry.scanGlobal();
            const all = registry.getForSession();
            const skill = all.find((e) => e.type === 'skill');
            const cmd = all.find((e) => e.type === 'command');
            expect(skill?.name).toBe('test-plugin:my-skill');
            expect(cmd?.name).toBe('test-plugin:my-cmd');
        });

        it('skips plugins not in enabledPlugins (defaults to enabled)', async () => {
            const install = '/p/new/1.0';
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({
                    version: 2,
                    plugins: { 'new-plugin@m': [{ installPath: install }] },
                }),
                [SETTINGS_JSON]: JSON.stringify({ enabledPlugins: {} }),
                [path.join(install, 'skills')]: ['s1'],
                [path.join(install, 'skills', 's1', 'SKILL.md')]: mockSkillMd('s1', 'New'),
            });
            await registry.scanGlobal();
            expect(registry.getForSession().map((e) => e.name)).toContain('new-plugin:s1');
        });
    });

    describe('scan — edge cases', () => {
        it('skips files with no frontmatter', async () => {
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [USER_SKILLS]: ['bad'],
                [path.join(USER_SKILLS, 'bad', 'SKILL.md')]: '# No frontmatter',
            });
            await registry.scanGlobal();
            expect(registry.getForSession()).toHaveLength(0);
        });

        it('handles missing installed_plugins.json gracefully', async () => {
            setupMockFs({
                [SETTINGS_JSON]: JSON.stringify({}),
            });
            await registry.scanGlobal();
            expect(registry.getForSession()).toHaveLength(0);
        });

        it('deduplicates within same source (global): personal shadows plugin of same name', async () => {
            const install = '/p/a/1.0';
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({
                    version: 2,
                    plugins: { 'a@m': [{ installPath: install }] },
                }),
                [SETTINGS_JSON]: JSON.stringify({ enabledPlugins: { 'a@m': true } }),
                [USER_SKILLS]: ['dup'],
                [path.join(USER_SKILLS, 'dup', 'SKILL.md')]: mockSkillMd('dup', 'Personal'),
                [path.join(install, 'skills')]: ['dup'],
                [path.join(install, 'skills', 'dup', 'SKILL.md')]: mockSkillMd('dup', 'Plugin'),
            });
            await registry.scanGlobal();
            const all = registry.getForSession();
            const dup = all.filter((e) => e.name === 'dup');
            expect(dup).toHaveLength(1);
            expect(dup[0].source).toBe('personal');
        });

        it('filters out skills with user-invocable: false', async () => {
            setupMockFs({
                [PLUGINS_JSON]: JSON.stringify({ version: 2, plugins: {} }),
                [SETTINGS_JSON]: JSON.stringify({}),
                [USER_SKILLS]: ['hidden'],
                [path.join(USER_SKILLS, 'hidden', 'SKILL.md')]:
                    '---\nname: hidden\ndescription: Hidden skill\nuser-invocable: false\n---\n',
            });
            await registry.scanGlobal();
            expect(registry.getForSession()).toHaveLength(0);
        });
    });

    describe('search', () => {
        function makeEntry(name: string, description = '', source: SkillEntry['source'] = 'personal'): SkillEntry {
            return { name, description, type: 'skill', source };
        }

        function registryWith(global: SkillEntry[], project?: { dir: string; entries: SkillEntry[] }): SkillRegistry {
            const r = new SkillRegistry(MOCK_HOME);
            (r as unknown as { globalEntries: SkillEntry[] }).globalEntries = global;
            if (project) {
                (r as unknown as { projectEntries: Map<string, SkillEntry[]> }).projectEntries.set(
                    project.dir,
                    project.entries,
                );
            }
            return r;
        }

        it('returns exact name match first', () => {
            const r = registryWith([
                makeEntry('commit-push-pr', 'Commit push PR'),
                makeEntry('commit', 'Create a git commit'),
                makeEntry('recommit', 'Re-commit'),
            ]);
            const results = r.search('commit');
            expect(results[0].name).toBe('commit');
        });

        it('matches by contains in name', () => {
            const r = registryWith([
                makeEntry('code-review', 'Review code'),
                makeEntry('go-review', 'Review Go code'),
                makeEntry('security-review', 'Security analysis'),
                makeEntry('tdd', 'Test driven development'),
            ]);
            const results = r.search('review');
            expect(results).toHaveLength(3);
            expect(results.map((e) => e.name)).toEqual(
                expect.arrayContaining(['code-review', 'go-review', 'security-review']),
            );
        });

        it('matches by contains in description', () => {
            const r = registryWith([
                makeEntry('tdd', 'Test driven development'),
                makeEntry('commit', 'Create a git commit'),
            ]);
            const results = r.search('test');
            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('tdd');
        });

        it('ranks: exact > prefix > contains-name > contains-description', () => {
            const r = registryWith([
                makeEntry('security-review', 'Security analysis'),
                makeEntry('security', 'Security checklist'),
                makeEntry('springboot-security', 'Spring security'),
                makeEntry('tdd', 'Includes security checks'),
            ]);
            const results = r.search('security');
            expect(results[0].name).toBe('security');
            expect(results[1].name).toBe('security-review');
            expect(results[2].name).toBe('springboot-security');
            expect(results[3].name).toBe('tdd');
        });

        it('returns max 25 results', () => {
            const entries = Array.from({ length: 30 }, (_, i) => makeEntry(`skill-${i}`, 'match'));
            const r = registryWith(entries);
            expect(r.search('match')).toHaveLength(25);
        });

        it('returns first 25 for empty query', () => {
            const entries = Array.from({ length: 30 }, (_, i) => makeEntry(`skill-${i}`, 'desc'));
            const r = registryWith(entries);
            expect(r.search('')).toHaveLength(25);
        });

        it('is case insensitive', () => {
            const r = registryWith([makeEntry('TDD', 'Test Driven')]);
            expect(r.search('tdd')).toHaveLength(1);
            expect(r.search('TDD')).toHaveLength(1);
        });

        it('includes project entries when projectDir is provided', () => {
            const projDir = '/projects/my-app';
            const r = registryWith(
                [makeEntry('global-skill', 'Global')],
                { dir: projDir, entries: [makeEntry('proj-skill', 'Project', 'project')] },
            );
            const results = r.search('skill', projDir);
            expect(results.map((e) => e.name)).toContain('global-skill');
            expect(results.map((e) => e.name)).toContain('proj-skill');
        });

        it('excludes project entries when projectDir is not provided', () => {
            const projDir = '/projects/my-app';
            const r = registryWith(
                [makeEntry('global-skill', 'Global')],
                { dir: projDir, entries: [makeEntry('proj-skill', 'Project', 'project')] },
            );
            const results = r.search('skill');
            expect(results.map((e) => e.name)).toContain('global-skill');
            expect(results.map((e) => e.name)).not.toContain('proj-skill');
        });
    });
});
