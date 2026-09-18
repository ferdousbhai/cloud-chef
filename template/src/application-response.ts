const APPLICATION_CSP_BASELINE =
  "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'";
const WORKERS_PREVIEW_CSP_BASELINE =
  "base-uri 'self'; frame-ancestors https://cloudchef.build; object-src 'none'; form-action 'self'";
const HSTS_MIN_AGE_SECONDS = "31536000";

type ApplicationSecurityOptions = {
  workersPreview?: boolean;
};

export async function finalizeApplicationResponse(
  request: Request,
  agentResponse: Response | null,
  fetchApplication: () => Response | Promise<Response>,
): Promise<Response> {
  if (agentResponse) {
    return agentResponse;
  }
  return withApplicationSecurityHeaders(await fetchApplication(), {
    workersPreview: isVersionedWorkersPreviewRequest(request),
  });
}

export function withApplicationSecurityHeaders(
  response: Response,
  options: ApplicationSecurityOptions = {},
): Response {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  applyContentSecurityPolicyBaseline(
    headers,
    options.workersPreview
      ? WORKERS_PREVIEW_CSP_BASELINE
      : APPLICATION_CSP_BASELINE,
  );
  applyHstsFloor(headers);
  if (options.workersPreview) {
    headers.delete("X-Frame-Options");
  } else {
    headers.set("X-Frame-Options", "DENY");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const WORKER_LABEL = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const ACCOUNT_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const VERSIONED_WORKERS_PREVIEW_HOSTNAME = new RegExp(
  `^[0-9a-f]{8}-${WORKER_LABEL}\\.${ACCOUNT_LABEL}\\.workers\\.dev$`,
);

function isVersionedWorkersPreviewRequest(request: Request): boolean {
  return VERSIONED_WORKERS_PREVIEW_HOSTNAME.test(new URL(request.url).hostname);
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
