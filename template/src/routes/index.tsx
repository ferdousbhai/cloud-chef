import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100 sm:px-8 lg:px-12">
      <div className="mx-auto grid max-w-6xl gap-12 border-t border-slate-700 pt-8 lg:grid-cols-[15rem_1fr]">
        <aside className="text-sm text-slate-300">
          <p className="font-mono text-xs text-cyan-300">cloudchef / worker</p>
          <p className="mt-3 leading-6">TanStack Start on Cloudflare</p>
        </aside>

        <section className="max-w-3xl">
          <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-7xl">
            Ready to build.
          </h1>
          <p className="mt-8 max-w-2xl text-lg leading-8 text-slate-300">
            This project starts with a Worker and a web application. Add only
            the storage, AI, or Agent capabilities the product actually needs.
          </p>

          <dl className="mt-12 divide-y divide-slate-800 border-y border-slate-800 text-sm">
            <div className="grid gap-2 py-4 sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium text-slate-100">Runtime</dt>
              <dd className="text-slate-300">Cloudflare Workers</dd>
            </div>
            <div className="grid gap-2 py-4 sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium text-slate-100">Framework</dt>
              <dd className="text-slate-300">TanStack Start</dd>
            </div>
            <div className="grid gap-2 py-4 sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium text-slate-100">Capabilities</dt>
              <dd className="text-slate-300">Explicit and demand-driven</dd>
            </div>
          </dl>
        </section>
      </div>
    </main>
  );
}
