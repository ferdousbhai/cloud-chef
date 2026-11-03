/**
 * Only cloudchef.build may frame the app: its preview pane shows the app's site beside the chat that
 * builds it. Every other site is refused.
 */
const APPLICATION_CSP_BASELINE =
  "base-uri 'self'; frame-ancestors https://cloudchef.build; object-src 'none'; form-action 'self'";
/**
 * Scripts and workers only from the app's own origin, so a CDN library or analytics tag added later shows
 * up in the browser console. Report-only: an enforced copy would block scripts an app's own policy allows by
 * nonce. Inline scripts are allowed here, since TanStack Start and React's dev preamble write them on every
 * page and reporting them would bury the off-origin loads this is for. An app whose own policy already
 * governs scripts is left to it.
 */
const APPLICATION_SCRIPT_CSP_REPORT_ONLY =
  "script-src 'self' 'unsafe-inline'; worker-src 'self' blob:";
const HSTS_MIN_AGE_SECONDS = "31536000";

export async function finalizeApplicationResponse(
  agentResponse: Response | null,
  fetchApplication: () => Response | Promise<Response>,
): Promise<Response> {
  if (agentResponse) {
    return agentResponse;
  }
  return withApplicationSecurityHeaders(await fetchApplication());
}

export function withApplicationSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  applyContentSecurityPolicyBaseline(
    headers,
    "Content-Security-Policy",
    APPLICATION_CSP_BASELINE,
  );
  if (!governsScripts(response.headers.get("Content-Security-Policy"))) {
    applyContentSecurityPolicyBaseline(
      headers,
      "Content-Security-Policy-Report-Only",
      APPLICATION_SCRIPT_CSP_REPORT_ONLY,
    );
  }
  applyHstsFloor(headers);
  // X-Frame-Options can't name the one site allowed to frame the app; the CSP above does.
  headers.delete("X-Frame-Options");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyContentSecurityPolicyBaseline(
  headers: Headers,
  name: "Content-Security-Policy" | "Content-Security-Policy-Report-Only",
  baseline: string,
): void {
  const current = headers.get(name);
  if (!current) {
    headers.set(name, baseline);
  } else if (!current.split(",").some((policy) => policy.trim() === baseline)) {
    // A CSP list enforces every policy independently. Appending keeps a
    // response's stricter resource policy while making this baseline mandatory.
    headers.append(name, baseline);
  }
}

function governsScripts(policy: string | null): boolean {
  return (
    policy
      ?.split(/[;,]/)
      .some((directive) =>
        /^(?:script-src|default-src)(?:\s|$)/i.test(directive.trim()),
      ) ?? false
  );
}

function applyHstsFloor(headers: Headers): void {
  const current = headers.get("Strict-Transport-Security");
  const directives =
    current?.split(";").map((directive) => directive.trim()) ?? [];
  const maxAgeDirectives = directives.filter((directive) =>
    /^max-age(?:\s*=|$)/i.test(directive),
  );
  const maxAge =
    maxAgeDirectives.length === 1 && maxAgeDirectives[0].length <= 64
      ? /^max-age\s*=\s*(\d{1,20})$/i.exec(maxAgeDirectives[0])?.[1]
      : undefined;
  const normalizedMaxAge = maxAge?.replace(/^0+(?=\d)/, "");
  const meetsFloor =
    normalizedMaxAge !== undefined &&
    (normalizedMaxAge.length > HSTS_MIN_AGE_SECONDS.length ||
      (normalizedMaxAge.length === HSTS_MIN_AGE_SECONDS.length &&
        normalizedMaxAge >= HSTS_MIN_AGE_SECONDS));
  if (current && maxAgeDirectives.length === 1 && meetsFloor) {
    return;
  }
  const retainedDirectives = directives.filter(
    (directive) => directive && !/^max-age(?:\s*=|$)/i.test(directive),
  );
  headers.set(
    "Strict-Transport-Security",
    [`max-age=${HSTS_MIN_AGE_SECONDS}`, ...retainedDirectives].join("; "),
  );
}
