import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Cross2Icon, InfoCircledIcon } from '@radix-ui/react-icons';
import { getUserRuntimeSession } from '~/lib/cloudflare/runtime-session';

/** Where this browser remembers that the tip on what the workspace keeps was closed. */
const STORAGE_TIP_CLOSED_KEY = 'cloudchef.terminal.storage-tip-closed';

/** How often the runtime capability the socket's address carries is refreshed, so a reconnect uses a live one. */
const CAPABILITY_REFRESH_MS = 60_000;
/** Reconnecting waits a second, doubling to at most this long, and stops after the last attempt. */
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_ATTEMPTS = 10;

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/**
 * A shell in this project's workspace container, beside the chat: for people who would rather work themselves,
 * with their own tools (a coding agent such as Claude Code included). It reattaches to the same shell after a
 * reload or a dropped connection.
 */
export function TerminalPanel({ workspaceId }: { workspaceId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return undefined;
    }
    let disposed = false;
    let session: { endpoint: string; token: string } | null = null;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0b0d12' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    const encoder = new TextEncoder();
    let socket: WebSocket | null = null;
    let attempts = 0;
    let reconnectTimer: number | undefined;
    const report = (next: ConnectionState) => {
      if (!disposed) {
        setState(next);
      }
    };
    const send = (data: string | Uint8Array) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    };
    // Keystrokes go as binary frames, a resize as JSON text; the shell's output comes back as binary frames.
    const input = terminal.onData((data) => send(encoder.encode(data)));
    const resizes = terminal.onResize(({ cols, rows }) => send(JSON.stringify({ cols, rows })));
    const connect = () => {
      if (disposed || !session) {
        return;
      }
      report('connecting');
      const url = new URL('/v1/terminal', session.endpoint);
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
      url.searchParams.set('chat', workspaceId);
      url.searchParams.set('capability', session.token);
      url.searchParams.set('cols', String(terminal.cols));
      url.searchParams.set('rows', String(terminal.rows));
      const next = new WebSocket(url);
      next.binaryType = 'arraybuffer';
      socket = next;
      next.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          attempts = 0;
          report('connected');
          terminal.write(new Uint8Array(event.data));
          return;
        }
        // Text frames are control messages: `ready` once the shell is attached. A runtime from before Sandbox 1.0
        // also sends a header before each output frame, which carries nothing the output frame does not.
        if (String(event.data).includes('"ready"')) {
          attempts = 0;
          report('connected');
          terminal.focus();
          send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        }
      });
      next.addEventListener('close', () => {
        if (socket !== next || disposed) {
          return;
        }
        socket = null;
        report('disconnected');
        if (attempts >= RECONNECT_ATTEMPTS) {
          return;
        }
        const delay = Math.min(1_000 * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
        attempts += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
    };
    const refresh = async () => {
      session = await getUserRuntimeSession();
    };
    void refresh()
      .then(connect)
      .catch(() => report('disconnected'));
    const refreshTimer = window.setInterval(() => void refresh().catch(() => undefined), CAPABILITY_REFRESH_MS);
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(element);
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      resize.disconnect();
      window.clearTimeout(reconnectTimer);
      input.dispose();
      resizes.dispose();
      socket?.close();
      socket = null;
      terminal.dispose();
    };
  }, [workspaceId]);

  return (
    <div className="flex size-full min-h-0 flex-col bg-[#0b0d12]">
      {state !== 'connected' && (
        <div
          className="border-b border-bolt-elements-borderColor px-3 py-1 text-xs text-content-tertiary"
          role="status"
        >
          {state === 'connecting' ? 'Connecting to your workspace…' : 'Not connected. Trying again…'}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="size-full p-2" />
        <StorageTip />
      </div>
    </div>
  );
}

/**
 * A tip over the terminal's corner on what the workspace keeps: the project and the home folder live on its own
 * storage, while the container's disk, where installed programs go, starts fresh each time the workspace wakes from
 * sleep. Closed, it stays closed in this browser, as a small button that shows it again.
 */
export function StorageTip() {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_TIP_CLOSED_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const show = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(STORAGE_TIP_CLOSED_KEY, next ? '0' : '1');
    } catch {
      // Remembered only until the page reloads; nothing else depends on it.
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        aria-label="What this workspace keeps"
        title="What this workspace keeps"
        className="absolute right-3 top-2 grid size-7 place-items-center rounded-full text-content-tertiary hover:bg-white/10 hover:text-content-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500"
        onClick={() => show(true)}
      >
        <InfoCircledIcon aria-hidden />
      </button>
    );
  }
  return (
    <aside
      aria-label="Tip"
      className="absolute right-3 top-2 flex w-72 max-w-[calc(100%-1.5rem)] items-start gap-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 text-xs text-content-secondary shadow-panel"
    >
      <InfoCircledIcon aria-hidden className="mt-0.5 shrink-0 text-content-accent" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold text-content-primary">Tip: </span>
        Your project and home folder (~) are kept. Programs you install are removed when the workspace sleeps, after 10
        minutes unused.
      </p>
      <button
        type="button"
        aria-label="Close tip"
        className="-m-1 grid size-6 shrink-0 place-items-center rounded text-content-tertiary hover:text-content-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500"
        onClick={() => show(false)}
      >
        <Cross2Icon aria-hidden />
      </button>
    </aside>
  );
}
