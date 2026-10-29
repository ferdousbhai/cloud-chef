import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * `/llms.txt` (https://llmstxt.org) tells AI agents and tools what the app is. The build writes it from
 * what the app's pages already say about themselves: the home page's `<title>` and description are its
 * heading and summary, and every page the build emits is listed with its own. A `public/llms.txt` the
 * project writes replaces it, so an app with more to say (its API, its docs) says it there.
 */
export type LlmsTxtPage = { path: string; title: string; description: string };

export function llmsTxtPlugin(projectDir: string): Plugin {
  return {
    name: "cloudchef-llms-txt",
    // After Vite's own HTML plugin has emitted the pages.
    enforce: "post",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle(_options, bundle) {
      if (existsSync(resolve(projectDir, "public/llms.txt"))) {
        return;
      }
      const pages = Object.values(bundle).flatMap((output) =>
        output.type === "asset" && output.fileName.endsWith(".html")
          ? [readPage(output.fileName, String(output.source))]
          : [],
      );
      const content = renderLlmsTxt(pages);
      if (content) {
        this.emitFile({ type: "asset", fileName: "llms.txt", source: content });
      }
    },
  };
}

/** Null when the build has no page with a title to describe the app by. */
export function renderLlmsTxt(pages: readonly LlmsTxtPage[]): string | null {
  const sorted = [...pages].sort(
    (a, b) =>
      pageDepth(a.path) - pageDepth(b.path) || a.path.localeCompare(b.path),
  );
  const home = sorted.find((page) => page.path === "/") ?? sorted[0];
  if (!home?.title) {
    return null;
  }
  const lines = [`# ${home.title}`, ""];
  if (home.description) {
    lines.push(`> ${home.description}`, "");
  }
  lines.push("## Pages", "");
  for (const page of sorted) {
    const name = page.path === "/" ? "Home" : page.title || page.path;
    lines.push(
      `- [${name}](${page.path})${page.description && page.description !== home.description ? `: ${page.description}` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A built page's address, title and description: `about/index.html` is `/about/`, `about.html` is `/about`. */
export function readPage(fileName: string, html: string): LlmsTxtPage {
  const path = `/${fileName.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "")}`;
  return {
    path,
    title: textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]),
    description: textOf(metaDescription(html)),
  };
}

function metaDescription(html: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (/\bname\s*=\s*["']?description["'\s/>]/i.test(tag)) {
      return /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i
        .exec(tag)
        ?.slice(1)
        .find((value) => value !== undefined);
    }
  }
  return undefined;
}

function textOf(value: string | undefined): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function pageDepth(path: string): number {
  return path === "/" ? 0 : path.split("/").filter(Boolean).length;
}
