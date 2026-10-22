import { readBodyTextPrefix } from '~/lib/bounded-body';
import {
  toolFailure,
  toolSuccess,
  type CloudChefToolResult,
  type ToolResultCoverage,
} from 'cloudchef-agent/tool-result';

/**
 * The model reading a GitHub project's own live site: its pages, and the JSON its pages load, which is
 * where a site keeps the copy it serves from its database or CMS. Only the addresses the control plane
 * reports for the repository are reachable (its GitHub homepage and the links its pipeline posted), only
 * by GET, and only so much of a response is read.
 */
export type LinkedSiteFetchInput = { url: string; format?: 'text' | 'html'; offset?: number };

/** At most this much of a response is read; the rest is left unread. */
export const SITE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
/** One result carries this many characters; `offset` reads on from there. */
export const SITE_FETCH_PAGE_CHARACTERS = 30_000;
const SITE_FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Formats the model can read: text, HTML, JSON, XML, and scripts. Images and binaries are refused. */
const READABLE_CONTENT_TYPE =
  /^(text\/[\w.+-]+|application\/(json|xml|javascript|ecmascript|x-javascript|[\w.-]+\+json|[\w.-]+\+xml))$/;

export async function fetchLinkedSitePage(
  input: LinkedSiteFetchInput,
  deps: {
    /** The site's https origins, from the control plane. */
    origins: () => Promise<readonly string[]>;
    fetch: (request: string, init: RequestInit) => Promise<Response>;
    signal?: AbortSignal;
  },
): Promise<CloudChefToolResult> {
  const requested = parseSiteUrl(input.url);
  if (!requested) {
    return toolFailure('Give a full https address, such as https://example.com/about.');
  }
  let origins: readonly string[];
  try {
    origins = await deps.origins();
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : "CloudChef could not look up the project's site.");
  }
  if (origins.length === 0) {
    return toolFailure(
      "No address is known for this project's site yet: set the repository's website on GitHub (its About " +
        'settings), or publish a preview so its pipeline reports a link.',
    );
  }
  const allowed = new Set(origins);
  const outside = (url: URL) =>
    toolFailure(`${url.origin} is not one of this project's sites. It can read: ${[...allowed].join(', ')}.`, {
      origins: [...allowed],
    });
  if (!allowed.has(requested.origin)) {
    return outside(requested);
  }
  const timeout = AbortSignal.timeout(SITE_FETCH_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  let url = requested;
  let response: Response;
  for (let redirects = 0; ; redirects += 1) {
    try {
      response = await deps.fetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/*;q=0.8',
          'user-agent': 'CloudChef site reader',
        },
        signal,
      });
    } catch {
      return toolFailure(`${url.href} did not answer${timeout.aborted ? ' in time' : ''}.`);
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      break;
    }
    await response.body?.cancel();
    const next = parseSiteUrl(location, url);
    if (!next || !allowed.has(next.origin)) {
      return next ? outside(next) : toolFailure(`${url.href} redirects to an address CloudChef can't follow.`);
    }
    if (redirects >= MAX_REDIRECTS) {
      return toolFailure(`${requested.href} redirects too many times.`);
    }
    url = next;
  }
  const contentType = (response.headers.get('content-type') ?? 'text/plain').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!READABLE_CONTENT_TYPE.test(contentType)) {
    await response.body?.cancel();
    return toolFailure(`${url.href} answered ${response.status} with ${contentType}, which isn't text.`);
  }
  const { text: body, truncated } = await readBodyTextPrefix(response, SITE_FETCH_MAX_BYTES);
  const html = contentType === 'text/html' || contentType === 'application/xhtml+xml';
  const content = html && input.format !== 'html' ? htmlToText(body) : body;
  const start = Math.min(input.offset ?? 0, content.length);
  const end = Math.min(content.length, start + SITE_FETCH_PAGE_CHARACTERS);
  const complete = end === content.length && !truncated;
  const notes = [
    truncated ? `only its first ${SITE_FETCH_MAX_BYTES / (1024 * 1024)} MB were read` : '',
    end < content.length ? `continue with offset ${end}` : '',
    html && input.format !== 'html' && content.trim().length < 200
      ? 'the page has little text without its scripts: its copy may load from JSON, so try format html or the API it calls'
      : '',
  ].filter(Boolean);
  const summary = `GET ${url.href}: ${response.status}, ${contentType}, characters ${start}–${end} of ${content.length}${
    notes.length > 0 ? `; ${notes.join('; ')}` : ''
  }.`;
  const data = { url: url.href, status: response.status, contentType, content: content.slice(start, end) };
  const coverage: ToolResultCoverage = { complete, start, end, total: content.length };
  if (end < content.length) {
    coverage.nextCursor = String(end);
  }
  return response.ok ? toolSuccess(summary, data, coverage) : toolFailure(summary, data, coverage);
}

/** An https URL without credentials, or null: a site is only ever read over https. */
function parseSiteUrl(value: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return null;
  }
  return url;
}

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['mdash', '—'],
  ['ndash', '–'],
  ['hellip', '…'],
  ['rsquo', '’'],
  ['lsquo', '‘'],
  ['rdquo', '”'],
  ['ldquo', '“'],
  ['copy', '©'],
]);

/** An HTML page's readable text: no scripts, styles, or tags, a line per block, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(
      /<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|ul|ol|tr|table|blockquote|title|figcaption|dt|dd|form|label|button)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
      if (name.startsWith('#')) {
        const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return NAMED_ENTITIES.get(name.toLowerCase()) ?? entity;
    })
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v ]+/g, ' ').trim())
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim();
}
