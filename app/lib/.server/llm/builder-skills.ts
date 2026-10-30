import { parse } from 'yaml';
/*
 * Lives outside .server/ because the exported project's Cursor rules embed the same stack-selection
 * text, and that module is bundled for the browser.
 */
import projectStackSkill from '~/lib/guidance/project-stack/SKILL.md?raw';
import postClipSkill from '~/lib/guidance/post-clip/SKILL.md?raw';
import { CLOUDFLARE_SKILLS } from './skills/cloudflare-skills.vendored';

const BUILDER_SKILL_ROOT = '/__skills__';
const MAX_BUILDER_SKILL_PROMPT_CHARS = 16_000;

/**
 * References bundled into this Worker and served read-only under /__skills__/: CloudChef's own (what is
 * specific to its starter app, and making a clip for a project's post), and Cloudflare's official skills, vendored at a pinned commit by
 * scripts/sync-cloudflare-skills.mjs so they stay Cloudflare's current guidance. The rest of Cloudflare's
 * documentation is retrieved live with `cf docs search` in the workspace. The catalog must never point at
 * workspace files: the model reads them through the Computer VFS, which a fresh seed does not populate
 * beyond the template sources.
 */
const BUNDLED_SKILLS: readonly BundledSkillSource[] = [
  { name: 'project-stack', files: new Map([['SKILL.md', projectStackSkill]]) },
  // Any project's post can carry a clip, so this one is in every catalog.
  { name: 'post-clip', files: new Map([['SKILL.md', postClipSkill]]) },
  ...CLOUDFLARE_SKILLS.map(({ name, files }) => ({ name, files: new Map(files) })),
];

type BuilderSkillReadResult = { kind: 'file' | 'directory'; content: string };

export type BuilderSkillReader = {
  read(path: string): Promise<BuilderSkillReadResult | null>;
};

type BuilderSkillContext = {
  prompt: string;
  reader: BuilderSkillReader;
};

type BundledSkillSource = { name: string; files: ReadonlyMap<string, string> };

type BundledSkill = { name: string; description: string; files: ReadonlyMap<string, string> };

/** CloudChef's own skill, which describes its starter app and so means nothing in a project not made from it. */
const STARTER_APP_SKILL = 'project-stack';

/**
 * Load the references bundled into this Worker. No network, no storage, no generation. A project not
 * made from CloudChef's starter leaves the starter app's skill out of its catalog.
 */
export function createBuilderSkillContext(options: { starterApp?: boolean } = {}): BuilderSkillContext {
  const starterApp = options.starterApp !== false;
  const skills = BUNDLED_SKILLS.filter(({ name }) => starterApp || name !== STARTER_APP_SKILL).map(({ name, files }) =>
    parseSkill(name, files),
  );
  return { prompt: renderPrompt(skills, starterApp), reader: createReader(skills) };
}

export function isBuilderSkillPath(path: string): boolean {
  const normalized = normalizeAbsolutePath(path);
  return normalized === BUILDER_SKILL_ROOT || normalized.startsWith(`${BUILDER_SKILL_ROOT}/`);
}

type DeclaredSkillFrontmatter = { name?: unknown; description?: unknown };

function declaredSkillFrontmatter(value: unknown): DeclaredSkillFrontmatter {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const declared: DeclaredSkillFrontmatter = {};
  if ('name' in value) {
    declared.name = value.name;
  }
  if ('description' in value) {
    declared.description = value.description;
  }
  return declared;
}

/** The catalog quotes the skill's own description, so editing the file updates the prompt. */
function parseSkill(name: string, files: ReadonlyMap<string, string>): BundledSkill {
  const source = files.get('SKILL.md') ?? '';
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) {
    throw new Error(`Bundled builder skill ${name} has no frontmatter.`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]!);
  } catch {
    throw new Error(`Bundled builder skill ${name} has invalid frontmatter.`);
  }
  const declared = declaredSkillFrontmatter(frontmatter);
  if (declared.name !== name || typeof declared.description !== 'string' || !declared.description) {
    throw new Error(`Bundled builder skill ${name} does not declare a matching name and description.`);
  }
  return { name, description: declared.description.trim(), files };
}

function renderPrompt(skills: readonly BundledSkill[], starterApp: boolean): string {
  const prompt = [
    '<builder_skills>',
    'Reference skills, read-only and outside the project. Read a SKILL.md when its topic matters to the work; it points to the files worth reading next.',
    '',
    ...skills.map(({ name, description }) => `- ${BUILDER_SKILL_ROOT}/${name}/SKILL.md — ${description}`),
    '',
    'llms.txt and llms-full.txt files are too large to read whole; use `cf docs search "<question>"` instead.',
    "Where a skill's advice conflicts with this workspace, the workspace wins: `cf` is installed and signed in to this account by CloudChef outside the container, a change it makes waits for the person's approval, `cf auth` is refused, and nothing outside the container can reach a dev server" +
      (starterApp ? '; and project-stack describes this project.' : '.'),
    '</builder_skills>',
  ].join('\n');
  if (prompt.length > MAX_BUILDER_SKILL_PROMPT_CHARS) {
    throw new Error('Bundled builder skill catalog exceeds the system-prompt limit.');
  }
  return prompt;
}

function createReader(skills: readonly BundledSkill[]): BuilderSkillReader {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    async read(path) {
      const target = parseSkillPath(path);
      const skill = target ? byName.get(target.name) : undefined;
      if (!target || !skill) {
        return null;
      }
      const file = target.path ? skill.files.get(target.path) : undefined;
      if (file !== undefined) {
        return { kind: 'file', content: file };
      }
      const listing = directoryListing(skill.files, target.path);
      return listing ? { kind: 'directory', content: listing } : null;
    },
  };
}

/** Immediate children of a directory inside one bundled skill; subdirectories carry a trailing slash. */
function directoryListing(files: ReadonlyMap<string, string>, directory: string): string | null {
  const prefix = directory ? `${directory}/` : '';
  const entries = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    entries.add(slash === -1 ? rest : rest.slice(0, slash + 1));
  }
  return entries.size > 0 ? [...entries].sort().join('\n') : null;
}

function parseSkillPath(path: string): { name: string; path: string } | null {
  const withoutTrailingSlash = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (
    normalizeAbsolutePath(withoutTrailingSlash) !== withoutTrailingSlash ||
    !withoutTrailingSlash.startsWith(`${BUILDER_SKILL_ROOT}/`)
  ) {
    return null;
  }
  const [name, ...parts] = withoutTrailingSlash.slice(BUILDER_SKILL_ROOT.length + 1).split('/');
  if (!name) {
    return null;
  }
  return { name, path: parts.join('/') };
}

function normalizeAbsolutePath(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join('/')}`;
}
