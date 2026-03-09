import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SkillEntry {
    readonly name: string;
    readonly description: string;
    readonly type: 'skill' | 'command';
    readonly source: 'personal' | 'project' | 'plugin';
    readonly pluginName?: string;
}

interface InstalledPlugin {
    readonly installPath: string;
}

interface InstalledPluginsFile {
    readonly version: number;
    readonly plugins: Record<string, InstalledPlugin[]>;
}

interface PluginJson {
    readonly name?: string;
    readonly skills?: string[];
    readonly commands?: string[];
}

export class SkillRegistry {
    private globalEntries: SkillEntry[] = [];
    private readonly projectEntries = new Map<string, SkillEntry[]>();
    private readonly homeDir: string;

    constructor(homeDir?: string) {
        this.homeDir = homeDir ?? process.env.HOME ?? '';
    }

    /** Scan personal + plugin sources (shared across all sessions). */
    async scanGlobal(): Promise<void> {
        const entries: SkillEntry[] = [];
        const seen = new Set<string>();

        const claudeDir = path.join(this.homeDir, '.claude');
        await this.scanSkillsDir(path.join(claudeDir, 'skills'), 'personal', undefined, entries, seen);
        await this.scanCommandsDir(path.join(claudeDir, 'commands'), 'personal', undefined, entries, seen);
        await this.scanPlugins(claudeDir, entries, seen);

        this.globalEntries = entries;
        const skills = entries.filter((e) => e.type === 'skill').length;
        const cmds = entries.filter((e) => e.type === 'command').length;
        console.log(`[SkillRegistry] Global: ${skills} skills, ${cmds} commands`);
    }

    /** Scan a project directory's .claude/skills/ + .claude/commands/. Caches result. */
    async scanProject(projectDir: string): Promise<void> {
        const entries: SkillEntry[] = [];
        const seen = new Set<string>();

        const claudeDir = path.join(projectDir, '.claude');
        await this.scanSkillsDir(path.join(claudeDir, 'skills'), 'project', undefined, entries, seen);
        await this.scanCommandsDir(path.join(claudeDir, 'commands'), 'project', undefined, entries, seen);

        this.projectEntries.set(projectDir, entries);
        if (entries.length > 0) {
            console.log(`[SkillRegistry] Project ${projectDir}: ${entries.length} entries`);
        }
    }

    /** Get all entries visible to a session in the given project directory. */
    getForSession(projectDir?: string): readonly SkillEntry[] {
        const project = projectDir ? (this.projectEntries.get(projectDir) ?? []) : [];
        return [...this.globalEntries, ...project];
    }

    /** Search entries with contains matching and relevance ranking. */
    search(query: string, projectDir?: string): SkillEntry[] {
        const MAX_RESULTS = 25;
        const entries = this.getForSession(projectDir);

        if (!query) {
            return entries.slice(0, MAX_RESULTS) as SkillEntry[];
        }

        const q = query.toLowerCase();

        const scored = (entries as SkillEntry[])
            .map((entry) => {
                const nameLower = entry.name.toLowerCase();
                const descLower = entry.description.toLowerCase();

                let score = 0;
                if (nameLower === q) score = 4;
                else if (nameLower.startsWith(q)) score = 3;
                else if (nameLower.includes(q)) score = 2;
                else if (descLower.includes(q)) score = 1;

                return { entry, score };
            })
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);

        return scored.slice(0, MAX_RESULTS).map(({ entry }) => entry);
    }

    private async scanPlugins(
        claudeDir: string,
        entries: SkillEntry[],
        seen: Set<string>,
    ): Promise<void> {
        const pluginsJsonPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
        let manifest: InstalledPluginsFile;
        try {
            manifest = JSON.parse(await fs.readFile(pluginsJsonPath, 'utf-8'));
        } catch {
            return;
        }

        const settingsPath = path.join(claudeDir, 'settings.json');
        let enabledPlugins: Record<string, boolean> = {};
        try {
            const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
            enabledPlugins = settings.enabledPlugins ?? {};
        } catch {
            // No settings — treat all as enabled
        }

        for (const [key, installs] of Object.entries(manifest.plugins)) {
            if (installs.length === 0) continue;
            if (enabledPlugins[key] === false) continue;

            const installPath = installs[0].installPath;
            const pluginName = key.split('@')[0];

            let pluginJson: PluginJson = {};
            try {
                const raw = await fs.readFile(
                    path.join(installPath, '.claude-plugin', 'plugin.json'),
                    'utf-8',
                );
                pluginJson = JSON.parse(raw);
            } catch {
                // No plugin.json — use defaults only
            }

            const skillDirs = new Set<string>();
            skillDirs.add(path.join(installPath, 'skills'));
            if (pluginJson.skills) {
                for (const p of pluginJson.skills) {
                    const resolved = path.resolve(installPath, p);
                    if (resolved.startsWith(installPath)) skillDirs.add(resolved);
                }
            }
            for (const dir of skillDirs) {
                await this.scanSkillsDir(dir, 'plugin', pluginName, entries, seen);
            }

            const cmdDirs = new Set<string>();
            cmdDirs.add(path.join(installPath, 'commands'));
            if (pluginJson.commands) {
                for (const p of pluginJson.commands) {
                    const resolved = path.resolve(installPath, p);
                    if (resolved.startsWith(installPath)) cmdDirs.add(resolved);
                }
            }
            for (const dir of cmdDirs) {
                await this.scanCommandsDir(dir, 'plugin', pluginName, entries, seen);
            }
        }
    }

    private async scanSkillsDir(
        dirPath: string,
        source: 'personal' | 'project' | 'plugin',
        pluginName: string | undefined,
        entries: SkillEntry[],
        seen: Set<string>,
    ): Promise<void> {
        let subdirs: string[];
        try {
            subdirs = await fs.readdir(dirPath);
        } catch {
            return;
        }

        for (const subdir of subdirs) {
            const skillFile = path.join(dirPath, subdir, 'SKILL.md');
            const parsed = await this.parseFrontmatter(skillFile);
            if (!parsed) continue;

            if (parsed.userInvocable === false) continue;

            const name =
                source === 'plugin' && pluginName
                    ? `${pluginName}:${parsed.name ?? subdir}`
                    : (parsed.name ?? subdir);

            if (seen.has(name)) continue;
            seen.add(name);

            entries.push({
                name,
                description: parsed.description ?? '',
                type: 'skill',
                source,
                pluginName,
            });
        }
    }

    private async scanCommandsDir(
        dirPath: string,
        source: 'personal' | 'project' | 'plugin',
        pluginName: string | undefined,
        entries: SkillEntry[],
        seen: Set<string>,
    ): Promise<void> {
        let files: string[];
        try {
            files = await fs.readdir(dirPath);
        } catch {
            return;
        }

        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const filePath = path.join(dirPath, file);
            const parsed = await this.parseFrontmatter(filePath);
            const baseName = file.replace(/\.md$/, '');

            const name =
                source === 'plugin' && pluginName
                    ? `${pluginName}:${parsed?.name ?? baseName}`
                    : (parsed?.name ?? baseName);

            if (seen.has(name)) continue;
            seen.add(name);

            entries.push({
                name,
                description: parsed?.description ?? '',
                type: 'command',
                source,
                pluginName,
            });
        }
    }

    private async parseFrontmatter(
        filePath: string,
    ): Promise<{ name?: string; description?: string; userInvocable?: boolean } | null> {
        let content: string;
        try {
            const raw = await fs.readFile(filePath, 'utf-8');
            content = raw.slice(0, 4096);
        } catch {
            return null;
        }

        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return null;

        const fm = match[1];
        const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
        const userInvocableMatch = fm.match(/^user-invocable:\s*(.+)$/m)?.[1]?.trim();
        const userInvocable = userInvocableMatch === 'false' ? false : undefined;

        return { name, description, userInvocable };
    }
}
