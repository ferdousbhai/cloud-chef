import type { ReactNode } from 'react';

export function ToolResultFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-bolt-elements-artifacts-borderColor bg-bolt-elements-background-depth-1 font-mono text-xs text-content-primary">
      <div className="max-h-[320px] overflow-auto px-2.5 py-2">{children}</div>
    </div>
  );
}
