import type { ReactNode } from 'react';
import { ClientHeader } from '~/components/ClientRouteComponents';
import { Toaster } from '~/components/ui/Toaster';

/** The frame of every showcase page: CloudChef's header, then the page, scrolling under it. */
export function ShowcaseShell({ children }: { children: ReactNode }) {
  return (
    <div className="showcase-page flex size-full flex-col overflow-y-auto">
      <ClientHeader />
      {children}
      <Toaster />
    </div>
  );
}

/** A page's empty or missing state, centered in the space under the header. */
export function ShowcaseNotice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-md flex-1 content-center gap-3 px-4 py-16 text-center">
      <h1 className="text-xl font-semibold text-content-primary">{title}</h1>
      {children ? <div className="grid gap-4 text-sm text-content-secondary">{children}</div> : null}
    </main>
  );
}
