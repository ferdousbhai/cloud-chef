/**
 * The application's own request handler. Both Worker entrypoints call it and add CloudChef's
 * security headers to whatever it returns, so a framework added later (a React SPA, TanStack
 * Start, React Router, Hono) only has to be reached from here.
 *
 * Pages and API requests arrive here first; Vite's hashed bundles under /assets are served
 * statically without invoking the Worker.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(url);
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || !acceptsHtml(request)) {
      return asset;
    }
    // A client-side route: serve the app shell and let the browser render the path.
    return env.ASSETS.fetch(new URL("/", url));
  },
};

function handleApi(url: URL): Response {
  if (url.pathname === "/api/health") {
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

function acceptsHtml(request: Request): boolean {
  return (
    request.method === "GET" &&
    (request.headers.get("Accept") ?? "").includes("text/html")
  );
}
