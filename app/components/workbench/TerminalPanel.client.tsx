import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SandboxAddon, type ConnectionState } from '@cloudflare/sandbox/xterm';
import '@xterm/xterm/css/xterm.css';
import { getUserRuntimeSession } from '~/lib/cloudflare/runtime-session';

/** How often the runtime capability the socket's address carries is refreshed, so a reconnect uses a live one. */
const CAPABILITY_REFRESH_MS = 60_000;

/**
 * A shell in this project's workspace container, beside the chat: for people who would rather work themselves,
 * with their own tools (a coding agent such as Claude Code included). It reattaches to the same shell after a
 * reload or a dropped connection.
 */
export function TerminalPanel({ chatId }: { chatId: string }) {
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
    const sandbox = new SandboxAddon({
      getWebSocketUrl: ({ cursor }) => {
        const url = new URL('/v1/terminal', session?.endpoint);
        url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        url.searchParams.set('chat', chatId);
        url.searchParams.set('capability', session?.token ?? '');
        url.searchParams.set('cols', String(terminal.cols));
        url.searchParams.set('rows', String(terminal.rows));
        if (cursor) {
          url.searchParams.set('cursor', cursor);
        }
        return url.toString();
      },
      onStateChange: (next) => {
        if (!disposed) {
          setState(next);
        }
      },
    });
    terminal.loadAddon(sandbox);
    terminal.open(element);
    fit.fit();
    const refresh = async () => {
      session = await getUserRuntimeSession();
    };
    void refresh()
      .then(() => {
        if (!disposed) {
          sandbox.connect({ sandboxId: chatId });
        }
      })
      .catch(() => {
        if (!disposed) {
          setState('disconnected');
        }
      });
    const refreshTimer = window.setInterval(() => void refresh().catch(() => undefined), CAPABILITY_REFRESH_MS);
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(element);
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      resize.disconnect();
      sandbox.dispose();
      terminal.dispose();
    };
  }, [chatId]);

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
      <div ref={containerRef} className="min-h-0 flex-1 p-2" />
    </div>
  );
}
