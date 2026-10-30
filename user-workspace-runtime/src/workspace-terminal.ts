import { z } from 'zod';
import { CONTAINER_TOOL_ENV } from './computer-sandbox';
import { CONTAINER_PNPM_STORE_DIR } from './container-toolchain';
import { shellQuote } from './shell-quote';
import { WORK_DIR } from '../../cloudchef-agent/constants';

/**
 * The terminal's home folder. Everything under /home is kept with the workspace, so what a person signs in to
 * there (a coding agent's login, `gh auth`, their own ~/.gitconfig) is still there after the container restarts.
 * It sits beside the project, never in it, so it is not part of the project's files, checkpoints or limits; it
 * does take room in the workspace's own storage, which is why caches and installed tools are kept off it below.
 */
export const TERMINAL_HOME = '/home/user';

/** The container's own disk, wiped on every restart: where caches and installed tools go instead. */
const CONTAINER_HOME = '/root';

/** The path the runtime Worker forwards a person's terminal WebSocket to on their workspace's Durable Object. */
export const TERMINAL_PATH = '/_cloudchef/terminal';

/** The one shell session a workspace container keeps, which every visit reattaches to. */
const TERMINAL_SESSION = 'workspace';

export type TerminalSize = { cols: number; rows: number };

/**
 * Downloads and installs that would otherwise land in the kept home: caches, npm's and pnpm's stores, and
 * per-user installs (XDG data and state, where installers such as Claude Code's put their binaries). Logins
 * stay: they live in the home itself or under ~/.config. git needs nothing here: the workspace's git wrapper
 * keeps the project's identity and hooks in the project's own history, which ~/.gitconfig only adds to.
 */
export function terminalEnvironment() {
  return {
    ...CONTAINER_TOOL_ENV,
    TERM: 'xterm-256color',
    HOME: TERMINAL_HOME,
    XDG_CACHE_HOME: `${CONTAINER_HOME}/.cache`,
    XDG_DATA_HOME: `${CONTAINER_HOME}/.local/share`,
    XDG_STATE_HOME: `${CONTAINER_HOME}/.local/state`,
    npm_config_cache: `${CONTAINER_HOME}/.npm`,
    npm_config_store_dir: CONTAINER_PNPM_STORE_DIR,
    PNPM_HOME: `${CONTAINER_HOME}/.local/share/pnpm`,
  };
}

/**
 * The prompt the login shell reads after Debian's own (`/etc/profile` sources `profile.d` last): the project's name
 * and where in it the shell is, such as `alberta-plan-glossary/src$`, instead of `root@` and the container's 64-character
 * name. A person's own ~/.profile or ~/.bashrc still overrides it.
 */
export const TERMINAL_PROMPT_FILE = '/etc/profile.d/cloudchef-prompt.sh';

const TERMINAL_PROMPT = String.raw`__cloudchef_where() {
  case $PWD in
    ${WORK_DIR}) ;;
    ${WORK_DIR}/*) printf '/%s' "${'$'}{PWD#${WORK_DIR}/}" ;;
    *) printf ':%s' "$(dirs +0)" ;;
  esac
}
PS1='${'$'}{CLOUDCHEF_PROJECT:-project}$(__cloudchef_where)$ '`;

/** A login shell (started in the project folder, its `cwd`), creating the home the first time. The terminal panel says what is kept. */
export function terminalCommand() {
  const home = shellQuote(TERMINAL_HOME);
  return [
    '/bin/bash',
    '-c',
    [
      `mkdir -p ${home}`,
      `cat > ${shellQuote(TERMINAL_PROMPT_FILE)} <<'CLOUDCHEF_PROMPT'`,
      TERMINAL_PROMPT,
      'CLOUDCHEF_PROMPT',
      'exec /bin/bash -l',
    ].join('\n'),
  ] as const;
}

/**
 * The tmux client a terminal connection runs: it attaches to the container's one session, or starts it in `cwd`
 * with the terminal's environment and login shell. tmux keeps the shell when the page goes away, so a reload or a
 * dropped connection reattaches to the same shell; a new container starts a new one.
 */
export function terminalSessionCommand(cwd: string, projectName: string): string[] {
  return [
    'tmux',
    'new-session',
    '-A',
    '-s',
    TERMINAL_SESSION,
    '-c',
    cwd,
    ...Object.entries({ ...terminalEnvironment(), CLOUDCHEF_PROJECT: projectName }).flatMap(([name, value]) => [
      '-e',
      `${name}=${value}`,
    ]),
    ...terminalCommand(),
  ];
}

/** The terminal's size as the page asks for it, within what a screen can show. */
export function terminalSize(url: URL): TerminalSize {
  const read = (name: string, min: number, max: number, fallback: number) => {
    const value = Number(url.searchParams.get(name));
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };
  return { cols: read('cols', 20, 500, 80), rows: read('rows', 5, 200, 24) };
}

/** A resize the page sends as text: `{"cols":N,"rows":N}` (Sandbox 0.x's addon adds `"type":"resize"`). Anything else is ignored. */
export function parseTerminalResize(text: string): TerminalSize | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = terminalResizeSchema.safeParse(value);
  return parsed.success ? { cols: parsed.data.cols, rows: parsed.data.rows } : null;
}

const terminalResizeSchema = z.object({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});

/**
 * Bridge a WebSocket to a tmux client run on a pseudo-terminal in the container. Keystrokes arrive as binary
 * messages and resizes as JSON text; the terminal's output goes back as binary. Closing the socket ends only the
 * tmux client, never the shell it is attached to. The socket is accepted directly, not hibernated: hibernation
 * would drop the process handle the bridge holds.
 */
export async function bridgeTerminal(
  container: Pick<Container, 'exec'>,
  options: { cwd: string; projectName: string; size: TerminalSize },
): Promise<Response> {
  const abort = new AbortController();
  const tmux = await container.exec(terminalSessionCommand(options.cwd, options.projectName), {
    pty: options.size,
    env: terminalEnvironment(),
    cwd: options.cwd,
    signal: abort.signal,
  });
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.binaryType = 'arraybuffer';
  server.accept();
  // A page loaded before this runtime still runs Sandbox 0.x's terminal addon, which waits for `ready` and reads
  // each output frame after a `chunk` header naming its length. The current page ignores both.
  server.send(JSON.stringify({ type: 'ready' }));
  let sent = 0;
  const stdin = tmux.stdin?.getWriter();
  let exited = false;
  const markExited = () => {
    exited = true;
  };
  tmux.exitCode.then(markExited, markExited);
  server.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      stdin?.write(new Uint8Array(event.data)).catch(() => undefined);
    } else {
      const size = parseTerminalResize(String(event.data));
      if (size) {
        try {
          tmux.resize(size.cols, size.rows);
        } catch {
          // The client already exited; the close that follows says so.
        }
      }
    }
  });
  server.addEventListener('close', () => {
    if (!exited) {
      abort.abort();
    }
  });
  const forward = async () => {
    if (tmux.stdout) {
      for await (const chunk of tmux.stdout) {
        if (!(chunk instanceof Uint8Array)) {
          continue;
        }
        sent += chunk.byteLength;
        server.send(JSON.stringify({ type: 'chunk', cursor: String(sent), byteLength: chunk.byteLength }));
        server.send(chunk);
      }
    }
    server.close(1000, `Terminal closed with code ${await tmux.exitCode}`);
  };
  void forward().catch(() => {
    try {
      server.close(1011, 'Terminal output failed');
    } catch {
      // Already closed.
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}
