/**
 * Only cloudchef.build may frame the app: its preview pane shows the app's site beside the chat that
 * builds it. Every other site is refused.
 */
const APPLICATION_CSP_BASELINE =
  "base-uri 'self'; frame-ancestors https://cloudchef.build; object-src 'none'; form-action 'self'";
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
  applyContentSecurityPolicyBaseline(headers, APPLICATION_CSP_BASELINE);
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
  baseline: string,
): void {
  const current = headers.get("Content-Security-Policy");
  if (!current) {
    headers.set("Content-Security-Policy", baseline);
  } else if (!current.split(",").some((policy) => policy.trim() === baseline)) {
    // A CSP list enforces every policy independently. Appending keeps a
    // response's stricter resource policy while making this baseline mandatory.
    headers.append("Content-Security-Policy", baseline);
  }
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
