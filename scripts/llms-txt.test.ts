import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const llmsTxt = readFileSync(join(rootDir, 'public/llms.txt'), 'utf8');

/** The commands `cloudchef help` lists, like `repo clone` and `browse`, without their arguments. */
function cliCommands(): string[] {
  const help = execFileSync('bash', [join(rootDir, 'public/cli/cloudchef'), 'help'], { encoding: 'utf8' });
  return help
    .split('\n')
    .flatMap((line) => /^ {2}([a-z][a-z-]*(?: [a-z][a-z-]*)?)(?= {2,}| [A-Z[])/.exec(line)?.[1] ?? []);
}

describe('public/llms.txt', () => {
  it('follows llms.txt: one H1, then a blockquote summary', () => {
    const lines = llmsTxt.split('\n');
    expect(lines[0]).toBe('# CloudChef');
    expect(lines.filter((line) => line.startsWith('# '))).toHaveLength(1);
    expect(lines[2]).toMatch(/^> \S/);
  });

  it('names every command the cloudchef command line has', () => {
    const commands = cliCommands();
    expect(commands).toEqual(
      expect.arrayContaining(['auth login', 'repo rewrite-main', 'run watch', 'browse', 'api', 'skill install']),
    );
    const missing = commands.filter((command) => command !== 'help' && !llmsTxt.includes(`cloudchef ${command}`));
    expect(missing).toEqual([]);
  });

  it('links only to pages and files CloudChef serves', () => {
    const paths = [...llmsTxt.matchAll(/\]\(https:\/\/cloudchef\.build(\/[^)]*)\)/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(5);
    const missing = paths.filter((path) => {
      if (path === '/') {
        return !existsSync(join(rootDir, 'app/routes/index.tsx'));
      }
      const route = path.slice(1).replaceAll('/', '.');
      return ![
        join(rootDir, 'public', path),
        join(rootDir, 'app/routes', `${route}.tsx`),
        join(rootDir, 'app/routes', `${route}.index.tsx`),
      ].some(existsSync);
    });
    expect(missing).toEqual([]);
  });
});
