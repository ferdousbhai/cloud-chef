import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { env as hostEnvironment } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(rootDir, 'public/cli/cloudchef');
const INSTALLER = join(rootDir, 'public/install.sh');
const TOKEN = 'cct_test_token_123';

const PROJECTS = [
  ['alpha', "Sara's sites", 'edit', 'succeeded', 'https://alpha.example.com', 'proj-alpha-sara'],
  ['alpha', 'Personal', 'view', '-', '-', 'proj-alpha-personal'],
  ['beta', 'Personal', 'edit', 'failed', '-', 'proj-beta'],
  ['watched', 'Personal', 'edit', 'building', '-', 'proj-watched'],
  ['broken', 'Personal', 'edit', 'failed', '-', 'proj-broken'],
];

/** A JSON value, as the fake answers. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The CLI's JSON request bodies hold only strings. */
const RequestBody = z.record(z.string(), z.string());

/** One field of a JSON request body, or '' when it has none. */
function bodyField(body: Buffer, key: string): string {
  return RequestBody.parse(JSON.parse(body.toString()))[key] ?? '';
}

type Upload = { query: URLSearchParams; contentType: string | undefined; body: Buffer };

/** A CloudChef that answers the command-line API, plus a dumb-HTTP git repository at /git/<id>.git. */
class FakeCloudChef {
  server: Server;
  host = '';
  polls = 0;
  watchPolls = 0;
  uploads: Upload[] = [];
  reruns: string[] = [];
  gitRoot: string;

  constructor(gitRoot: string) {
    this.gitRoot = gitRoot;
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => this.handle(request, response, Buffer.concat(chunks)));
    });
  }

  async start() {
    await new Promise<void>((resolveListen) => this.server.listen(0, '127.0.0.1', resolveListen));
    const { port } = z.object({ port: z.number() }).parse(this.server.address());
    this.host = `http://127.0.0.1:${port}`;
  }

  stop() {
    return new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  handle(request: IncomingMessage, response: ServerResponse, body: Buffer) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status: number, value: Json) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const text = (status: number, value: string) => {
      response.writeHead(status, { 'Content-Type': 'text/plain' });
      response.end(value);
    };
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /cli/cloudchef') {
      return text(200, readFileSync(SCRIPT, 'utf8'));
    }
    if (url.pathname.startsWith('/git/')) {
      const basic = `Basic ${Buffer.from(`cloudchef:${TOKEN}`).toString('base64')}`;
      if (request.headers.authorization !== basic) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CloudChef"' });
        return response.end('Use a command-line token.\n');
      }
      const file = join(this.gitRoot, url.pathname.slice('/git/'.length));
      if (!file.startsWith(this.gitRoot) || !existsSync(file) || statSync(file).isDirectory()) {
        return text(404, 'Not found.\n');
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return response.end(readFileSync(file));
    }
    if (route === 'POST /api/command-line/login') {
      const label = bodyField(body, 'label');
      if (!label.endsWith('(cloudchef CLI)')) {
        return json(400, { error: 'Bad label.' });
      }
      return json(200, {
        deviceCode: 'device-1',
        userCode: 'WXYZ-1234',
        verificationUri: `${this.host}/device`,
        verificationUriComplete: `${this.host}/device?code=WXYZ-1234`,
        interval: 0,
        expiresIn: 600,
      });
    }
    if (route === 'POST /api/command-line/login/poll') {
      const deviceCode = bodyField(body, 'deviceCode');
      if (deviceCode !== 'device-1') {
        return json(400, { error: 'Unknown sign-in.' });
      }
      this.polls += 1;
      if (this.polls < 2) {
        return json(428, { error: 'pending' });
      }
      return json(200, { token: TOKEN, user: { email: 'sara@example.com' } });
    }

    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(401, { error: 'Use a command-line token from CloudChef Settings.' });
    }
    if (route === 'GET /api/command-line/user') {
      return json(200, { id: 'u1', name: 'Sara', email: 'sara@example.com' });
    }
    if (route === 'GET /api/command-line/projects') {
      if (url.searchParams.get('format') === 'tsv') {
        return text(200, PROJECTS.map((row) => row.join('\t')).join('\n') + '\n');
      }
      return json(200, { projects: PROJECTS.map(([name, account, , , , id]) => ({ id, name, account })) });
    }
    if (route === 'GET /api/command-line/runs') {
      const project = url.searchParams.get('project');
      let rows: string[][] = [];
      if (project === 'proj-beta') {
        rows = [
          ['failed', 'production', 'main', 'abcdef1234567890', '2026-10-27T10:00:00Z', 'run-2'],
          ['succeeded', 'preview', 'feature', '1234567aaaaaaaa', '2026-10-26T10:00:00Z', 'run-1'],
        ];
      } else if (project === 'proj-watched') {
        this.watchPolls += 1;
        const state = ['queued', 'building', 'building', 'succeeded'][Math.min(this.watchPolls - 1, 3)];
        rows = [[state, 'production', 'main', 'feedface00000000', '2026-10-27T11:00:00Z', 'run-w']];
      } else if (project === 'proj-broken') {
        rows = [['failed', 'production', 'main', 'deadbeef0000000', '2026-10-27T12:00:00Z', 'run-b']];
      } else {
        return json(404, { error: 'Not found.' });
      }
      return text(200, rows.map((row) => row.join('\t')).join('\n') + '\n');
    }
    if (route === 'GET /api/command-line/log') {
      if (url.searchParams.get('project') !== 'proj-beta' || url.searchParams.get('deployment') !== 'run-2') {
        return json(404, { error: 'Not found.' });
      }
      return text(200, 'npm run build\nError: Cannot find module "./missing"\n');
    }
    if (route === 'POST /api/command-line/runs/rerun') {
      this.reruns.push(`${bodyField(body, 'project')}:${bodyField(body, 'deployment')}`);
      return json(200, { deployment: { id: 'run-3' } });
    }
    if (route === 'POST /api/command-line/projects/create') {
      this.uploads.push({ query: url.searchParams, contentType: request.headers['content-type'], body });
      return json(201, {
        project: { id: 'proj-new', name: url.searchParams.get('name'), gitUrl: `${this.host}/git/proj-new.git` },
      });
    }
    return json(404, { error: `No route ${route}.` });
  }
}

type Result = { code: number | null; stdout: string; stderr: string };

let fake: FakeCloudChef;
let workDir: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: hostEnvironment.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

/** A fresh HOME, optionally already logged in. */
function makeHome(loggedIn = true) {
  const home = mkdtempSync(join(workDir, 'home-'));
  if (loggedIn) {
    mkdirSync(join(home, '.config/cloudchef'), { recursive: true });
    writeFileSync(join(home, '.config/cloudchef/token'), `${TOKEN}\n`, { mode: 0o600 });
  }
  return home;
}

/** Only what the script needs from this machine (its PATH), so no CLOUDCHEF_, GIT_ or XDG_ setting leaks in. */
function environment(home: string, extra: Record<string, string> = {}) {
  return {
    PATH: hostEnvironment.PATH ?? '/usr/bin:/bin',
    TMPDIR: tmpdir(),
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    CLOUDCHEF_HOST: fake.host,
    CLOUDCHEF_BROWSER: 'true',
    ...extra,
  };
}

function cli(
  home: string,
  args: string[],
  options: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  return runBash([SCRIPT, ...args], home, options);
}

function runBash(
  args: string[],
  home: string,
  options: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  return new Promise((resolveRun) => {
    const child = spawn('bash', args, { cwd: options.cwd ?? home, env: environment(home, options.env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'cloudchef-cli-'));
  // The project every clone test fetches, served the way dumb-HTTP git reads it.
  const source = join(workDir, 'source');
  mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  writeFileSync(join(source, 'index.html'), '<h1>alpha</h1>\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'First');
  const gitRoot = join(workDir, 'served');
  mkdirSync(gitRoot);
  for (const id of ['proj-alpha-sara', 'proj-beta']) {
    git(workDir, 'clone', '-q', '--bare', source, join(gitRoot, `${id}.git`));
    git(join(gitRoot, `${id}.git`), 'update-server-info');
  }
  fake = new FakeCloudChef(gitRoot);
  await fake.start();
});

afterAll(async () => {
  await fake?.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe('cloudchef auth', () => {
  it('logs in with the device flow, saves the token privately and sets up git', async () => {
    const home = makeHome(false);
    const result = await cli(home, ['auth', 'login']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('WXYZ-1234');
    expect(result.stdout).toContain(`Open ${fake.host}/device?code=WXYZ-1234`);
    expect(result.stdout).toContain('Logged in as sara@example.com');
    expect(fake.polls).toBe(2);

    const tokenFile = join(home, '.config/cloudchef/token');
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(TOKEN);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

    const helpers = execFileSync('git', ['config', '--global', '--get-all', `credential.${fake.host}.helper`], {
      env: environment(home),
      encoding: 'utf8',
    }).split('\n');
    expect(helpers[0]).toBe('');
    expect(helpers[1]).toMatch(/^!'.*\/public\/cli\/cloudchef' auth git-credential$/);
    expect(
      execFileSync('git', ['config', '--global', `credential.${fake.host}.username`], {
        env: environment(home),
        encoding: 'utf8',
      }).trim(),
    ).toBe('cloudchef');

    // git itself now gets the token from the helper.
    const port = new URL(fake.host).port;
    const filled = spawnSync('git', ['credential', 'fill'], {
      env: environment(home),
      input: `protocol=http\nhost=127.0.0.1:${port}\n\n`,
      encoding: 'utf8',
    });
    expect(filled.stdout).toContain(`password=${TOKEN}`);

    const status = await cli(home, ['auth', 'status']);
    expect(status.stdout).toContain(`Logged in to 127.0.0.1:${port} as sara@example.com`);
  });

  it('answers git only for the CloudChef host', async () => {
    const home = makeHome();
    const port = new URL(fake.host).port;
    const ours = await cli(home, ['auth', 'git-credential', 'get'], {
      input: `protocol=http\nhost=127.0.0.1:${port}\npath=git/proj-beta.git\n\n`,
    });
    expect(ours.stdout).toContain('username=cloudchef\n');
    expect(ours.stdout).toContain(`password=${TOKEN}\n`);

    for (const input of ['protocol=https\nhost=github.com\n\n', `protocol=https\nhost=127.0.0.1:${port}\n\n`]) {
      const other = await cli(home, ['auth', 'git-credential', 'get'], { input });
      expect(other).toMatchObject({ code: 0, stdout: '' });
    }
    const stored = await cli(home, ['auth', 'git-credential', 'store'], { input: 'protocol=http\n\n' });
    expect(stored).toMatchObject({ code: 0, stdout: '' });
  });

  it('tells a person without a valid token to log in', async () => {
    const home = makeHome(false);
    const list = await cli(home, ['repo', 'list']);
    expect(list.code).toBe(1);
    expect(list.stderr).toContain('cloudchef auth login');

    const revoked = await cli(home, ['repo', 'list'], { env: { CLOUDCHEF_TOKEN: 'cct_revoked' } });
    expect(revoked.code).toBe(1);
    expect(revoked.stderr).toContain('Use a command-line token from CloudChef Settings. Run: cloudchef auth login');

    const status = await cli(home, ['auth', 'status'], { env: { CLOUDCHEF_TOKEN: 'cct_revoked' } });
    expect(status.code).toBe(1);
    expect(status.stdout).toContain('Not logged in');
  });

  it('logs out by deleting the token file', async () => {
    const home = makeHome();
    const result = await cli(home, ['auth', 'logout']);
    expect(result.stdout).toContain('Settings → Command line');
    expect(existsSync(join(home, '.config/cloudchef/token'))).toBe(false);
  });
});

describe('cloudchef repo', () => {
  it('lists projects as a table', async () => {
    const result = await cli(makeHome(), ['repo', 'list']);
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^NAME\s+ACCOUNT\s+ROLE\s+LAST PUBLISH\s+SITE\s+ID$/);
    expect(lines).toHaveLength(PROJECTS.length + 1);
    expect(lines[1]).toMatch(
      /^alpha\s+Sara's sites\s+edit\s+succeeded\s+https:\/\/alpha\.example\.com\s+proj-alpha-sara$/,
    );
    // Columns line up.
    expect(lines[1].indexOf('edit')).toBe(lines[0].indexOf('ROLE'));
  });

  it('resolves a name, ACCOUNT/NAME or id, and refuses an ambiguous name', async () => {
    const home = makeHome();
    const ambiguous = await cli(home, ['repo', 'view', 'alpha']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("Sara's sites/alpha");
    expect(ambiguous.stderr).toContain('Personal/alpha');

    const qualified = await cli(home, ['repo', 'view', "Sara's sites/alpha"]);
    expect(qualified.code).toBe(0);
    expect(qualified.stdout).toMatch(/account:\s+Sara's sites/);
    expect(qualified.stdout).toContain(`${fake.host}/git/proj-alpha-sara.git`);
    expect(qualified.stdout).toMatch(/site:\s+https:\/\/alpha\.example\.com/);

    const unique = await cli(home, ['repo', 'view', 'beta', '--json']);
    expect(JSON.parse(unique.stdout)).toEqual({
      id: 'proj-beta',
      name: 'beta',
      account: 'Personal',
      role: 'edit',
      gitUrl: `${fake.host}/git/proj-beta.git`,
      siteUrl: null,
      lastPublishState: 'failed',
    });

    const byId = await cli(home, ['repo', 'view', 'proj-alpha-personal']);
    expect(byId.stdout).toMatch(/role:\s+view/);

    const missing = await cli(home, ['repo', 'view', 'gamma']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No project named "gamma"');
  });

  it('clones into ~/cloudflare/<account>/<project> by default, and the clone names its project', async () => {
    const home = makeHome();
    expect((await cli(home, ['auth', 'setup-git'])).code).toBe(0);
    const result = await cli(home, ['repo', 'clone', "Sara's sites/alpha"]);
    const target = join(home, 'cloudflare/sara-s-sites/alpha');
    expect(result.stderr).not.toContain('cloudchef:');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Cloned alpha into ${target}`);
    expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe('<h1>alpha</h1>\n');

    const view = await cli(home, ['repo', 'view'], { cwd: target });
    expect(view.code).toBe(0);
    expect(view.stdout).toMatch(/id:\s+proj-alpha-sara/);
  });

  it('clones under the configured clone-dir, which CLOUDCHEF_CLONE_DIR and DIR override', async () => {
    const home = makeHome();
    expect((await cli(home, ['auth', 'setup-git'])).code).toBe(0);
    expect((await cli(home, ['config', 'get', 'clone-dir'])).stdout).toBe('~/cloudflare\n');
    expect((await cli(home, ['config', 'set', 'clone-dir', '~/work'])).code).toBe(0);
    expect(readFileSync(join(home, '.config/cloudchef/config'), 'utf8')).toBe('clone-dir=~/work\n');
    expect((await cli(home, ['config', 'list'])).stdout).toBe('clone-dir=~/work\n');

    const configured = await cli(home, ['repo', 'clone', 'beta']);
    expect(configured.stdout).toContain(`into ${join(home, 'work/personal/beta')}`);
    expect(existsSync(join(home, 'work/personal/beta/index.html'))).toBe(true);

    const fromEnvironment = await cli(home, ['repo', 'clone', 'beta'], { env: { CLOUDCHEF_CLONE_DIR: '~/elsewhere' } });
    expect(fromEnvironment.stdout).toContain(`into ${join(home, 'elsewhere/personal/beta')}`);
    expect(existsSync(join(home, 'elsewhere/personal/beta/index.html'))).toBe(true);

    const explicit = await cli(home, ['repo', 'clone', 'beta', '~/here'], { env: { CLOUDCHEF_CLONE_DIR: '~/x' } });
    expect(explicit.stdout).toContain(`into ${join(home, 'here')}`);
    expect(existsSync(join(home, 'here/index.html'))).toBe(true);
  });

  it('uploads the committed files of a git repository as a zip and adds the cloudchef remote', async () => {
    const home = makeHome();
    const repo = join(home, 'site');
    mkdirSync(join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');

    const empty = await cli(home, ['repo', 'create', 'site'], { cwd: repo });
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain('no commits');

    writeFileSync(join(repo, 'index.html'), '<p>hi</p>\n');
    writeFileSync(join(repo, 'src/app.js'), 'export {};\n');
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Site');
    writeFileSync(join(repo, 'draft.txt'), 'not committed\n');

    const result = await cli(home, ['repo', 'create', 'my site', '--account', "Sara's sites"], { cwd: repo });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Uploading the current folder');
    expect(result.stdout).toContain('Created my site (proj-new). It is publishing now.');
    expect(result.stdout).toContain('git pull cloudchef main --allow-unrelated-histories');

    const upload = fake.uploads.at(-1)!;
    expect(upload.contentType).toBe('application/zip');
    expect(upload.query.get('name')).toBe('my site');
    expect(upload.query.get('account')).toBe("Sara's sites");
    const zip = await JSZip.loadAsync(upload.body);
    const files = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort();
    expect(files).toEqual(['.gitignore', 'index.html', 'src/app.js']);
    expect(await zip.file('index.html')!.async('string')).toBe('<p>hi</p>\n');
    expect(git(repo, 'remote', 'get-url', 'cloudchef').trim()).toBe(`${fake.host}/git/proj-new.git`);
  });

  it('uploads a plain folder without its ignored files', async () => {
    const home = makeHome();
    const folder = join(home, 'plain');
    mkdirSync(join(folder, 'node_modules/x'), { recursive: true });
    writeFileSync(join(folder, 'index.html'), '<p>plain</p>\n');
    writeFileSync(join(folder, '.gitignore'), 'node_modules\n.dev.vars\n');
    writeFileSync(join(folder, '.dev.vars'), 'KEY=1\n');
    writeFileSync(join(folder, 'node_modules/x/index.js'), '\n');

    const result = await cli(home, ['repo', 'create', 'plain', '--source', folder]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('Uploading the current folder');
    expect(result.stdout).toContain('cloudchef repo clone proj-new');
    const zip = await JSZip.loadAsync(fake.uploads.at(-1)!.body);
    expect(
      Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['.gitignore', 'index.html']);
  });
});

describe('cloudchef run', () => {
  it('lists runs with a header and short commits', async () => {
    const result = await cli(makeHome(), ['run', 'list', 'beta']);
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^STATE\s+KIND\s+BRANCH\s+COMMIT\s+UPDATED\s+ID$/);
    expect(lines[1]).toMatch(/^failed\s+production\s+main\s+abcdef1\s+2026-10-27T10:00:00Z\s+run-2$/);
    expect(lines).toHaveLength(3);
  });

  it('prints the newest run and its log', async () => {
    const home = makeHome();
    const view = await cli(home, ['run', 'view', '--project', 'beta']);
    expect(view.stdout).toMatch(/state:\s+failed/);
    expect(view.stdout).toContain('--log');

    const log = await cli(home, ['run', 'view', '--project', 'beta', '--log']);
    expect(log).toMatchObject({ code: 0, stdout: 'npm run build\nError: Cannot find module "./missing"\n' });

    const older = await cli(home, ['run', 'view', 'run-1', '--project', 'beta']);
    expect(older.stdout).toMatch(/branch:\s+feature/);
  });

  it('watches until the run finishes and exits by its outcome', async () => {
    const home = makeHome();
    const succeeded = await cli(home, ['run', 'watch', '--project', 'watched', '--interval', '0']);
    expect(succeeded.code).toBe(0);
    const states = succeeded.stdout
      .trimEnd()
      .split('\n')
      .map((line) => line.split(/\s+/)[1]);
    expect(states).toEqual(['queued', 'building', 'succeeded']);

    const failed = await cli(home, ['run', 'watch', '--project', 'broken', '--interval', '0']);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('cloudchef run view run-b --project proj-broken --log');
  });

  it('reruns the newest publish', async () => {
    const result = await cli(makeHome(), ['run', 'rerun', '--project', 'beta']);
    expect(result.code).toBe(0);
    expect(fake.reruns.at(-1)).toBe('proj-beta:run-2');
    expect(result.stdout).toContain('Started publish run-3');
  });
});

describe('cloudchef install and skill', () => {
  it('keeps the bundled skill identical to public/cli/SKILL.md', async () => {
    const home = makeHome();
    const result = await cli(home, ['skill', 'install', '--dir', join(home, 'skills')]);
    expect(result.code).toBe(0);
    expect(readFileSync(join(home, 'skills/cloudchef/SKILL.md'), 'utf8')).toBe(
      readFileSync(join(rootDir, 'public/cli/SKILL.md'), 'utf8'),
    );
  });

  it('installs the command and, with Claude Code present, the skill', async () => {
    const home = makeHome(false);
    mkdirSync(join(home, '.claude'));
    const bin = join(home, 'bin');
    const result = await runBash([INSTALLER], home, { env: { CLOUDCHEF_INSTALL_DIR: bin } });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(statSync(join(bin, 'cloudchef')).mode & 0o111).not.toBe(0);
    expect(existsSync(join(home, '.claude/skills/cloudchef/SKILL.md'))).toBe(true);
    expect(result.stdout).toContain(`export PATH="${bin}:$PATH"`);
    expect(result.stdout.trimEnd().endsWith('Next: cloudchef auth login')).toBe(true);
  });

  it('passes shellcheck when it is installed', () => {
    const which = spawnSync('sh', ['-c', 'command -v shellcheck']);
    if (which.status !== 0) {
      return;
    }
    const checked = spawnSync('shellcheck', ['-s', 'bash', SCRIPT, INSTALLER], { encoding: 'utf8' });
    expect(checked.stdout).toBe('');
  });

  it('prints help for each command', async () => {
    const home = makeHome();
    for (const args of [['help'], ['repo', 'create', '--help'], ['help', 'run', 'watch'], ['config', '--help']]) {
      const result = await cli(home, args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Usage:');
    }
    expect((await cli(home, ['--version'])).stdout).toMatch(/^cloudchef \d+\.\d+\.\d+\n$/);
  });
});
