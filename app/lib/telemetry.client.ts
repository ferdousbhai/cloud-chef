import { telemetryCorrelationIdStore } from '~/lib/cloudflare/runtime-session';
import type { ClientTelemetryEvent, ProductTelemetryEvent } from './client-telemetry-events';

declare global {
  interface Navigator {
    /** Global Privacy Control: shipped by several browsers but not yet part of lib.dom. */
    readonly globalPrivacyControl?: boolean;
  }
}

type TelemetryContext = {
  level?: 'error' | 'warning' | 'info';
  outcome?: 'success' | 'failure' | 'cancelled';
  failureReason?: 'authorization' | 'network' | 'timeout' | 'validation' | 'deployment' | 'unknown';
  durationMs?: number;
  retryCount?: number;
  workspaceRevision?: number;
  /** Which preview guarantee an event is about: a checkpoint-bound build, or a live dev server. */
  previewMode?: 'production' | 'dev';
};

type SanitizedTelemetryContext = Omit<TelemetryContext, 'level'>;

type TelemetryEnvelope = {
  schemaVersion: 1;
  event: ClientTelemetryEvent | ProductTelemetryEvent;
  level: NonNullable<TelemetryContext['level']>;
  journeyId: string;
  correlationId?: string;
  errorEventId?: string;
  occurredAt: string;
  page: PageKind;
  context: SanitizedTelemetryContext;
};

const TELEMETRY_ENDPOINT = '/api/client-telemetry';
const JOURNEY_STORAGE_KEY = 'cloudchef:telemetry:journey';
const TELEMETRY_PREFERENCE_STORAGE_KEY = 'cloudchef:telemetry:preference';
// Every funnel stage is counted once per journey. Only prompt submission is a
// repeated action rather than a stage, so it is named as the exception and a new
// funnel event is claimed once by default.
const REPEATED_PRODUCT_EVENTS = new Set<ProductTelemetryEvent>(['prompt_submitted']);
const OPAQUE_ID_PATTERN = /^[0-9a-f-]{36}$/i;

// Stages are claimed in memory as well as in session storage. Emitters such as
// the per-tool card effect run once per rendered instance, so a claim that only
// lived in storage re-counted whenever storage was cleared or unavailable.
const claimedStages = new Set<ProductTelemetryEvent>();

/**
 * The correlation ID the control plane minted for this browser's runtime session.
 * CloudChef never sends the browser-owned journey ID to the server as a join key;
 * the server mints its own opaque ID and the browser echoes this one back.
 */
function correlationId(): string | null {
  const value = telemetryCorrelationIdStore.get();
  return value !== null && OPAQUE_ID_PATTERN.test(value) ? value : null;
}

export async function captureMessage(event: ClientTelemetryEvent, context?: TelemetryContext): Promise<void> {
  console.warn(event, context);
  await emitTelemetry(event, context);
}

export async function captureException(
  event: ClientTelemetryEvent,
  error: unknown,
  context?: TelemetryContext,
): Promise<void> {
  console.error(error, context);
  await emitTelemetry(event, { ...context, level: context?.level ?? 'error', outcome: 'failure' });
}

export async function captureProductEvent(event: ProductTelemetryEvent, context?: TelemetryContext): Promise<void> {
  if (!productTelemetryEnabled()) {
    return;
  }
  if (!REPEATED_PRODUCT_EVENTS.has(event) && !claimOncePerJourney(event)) {
    return;
  }
  await emitTelemetry(event, context);
}

async function emitTelemetry(
  event: ClientTelemetryEvent | ProductTelemetryEvent,
  context: TelemetryContext = {},
): Promise<void> {
  if (!productTelemetryEnabled()) {
    return;
  }
  const level = context.level ?? 'info';
  const correlation = correlationId();
  const envelope: TelemetryEnvelope = {
    schemaVersion: 1,
    event,
    level,
    journeyId: journeyId(),
    occurredAt: new Date().toISOString(),
    page: pageKind(),
    context: sanitizeContext(context),
  };
  if (correlation) {
    envelope.correlationId = correlation;
  }
  if (level === 'error') {
    envelope.errorEventId = crypto.randomUUID();
  }
  const payload = JSON.stringify(envelope);
  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    });
  } catch {
    // Telemetry is deliberately best-effort and must never interrupt the product journey.
  }
}

/** Only allowlisted, non-identifying fields reach the wire; anything unset stays absent. */
function sanitizeContext(context: TelemetryContext): SanitizedTelemetryContext {
  const sanitized: SanitizedTelemetryContext = {};
  if (context.outcome) {
    sanitized.outcome = context.outcome;
  }
  if (context.failureReason) {
    sanitized.failureReason = context.failureReason;
  }
  if (validMetric(context.durationMs)) {
    sanitized.durationMs = context.durationMs;
  }
  if (validMetric(context.retryCount)) {
    sanitized.retryCount = context.retryCount;
  }
  if (validMetric(context.workspaceRevision)) {
    sanitized.workspaceRevision = context.workspaceRevision;
  }
  if (context.previewMode) {
    sanitized.previewMode = context.previewMode;
  }
  return sanitized;
}

function validMetric(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

export function productTelemetryEnabled(): boolean {
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1') {
    return false;
  }
  return safeLocalStorageGet(TELEMETRY_PREFERENCE_STORAGE_KEY) === 'enabled';
}

export function setProductTelemetryEnabled(enabled: boolean): void {
  safeLocalStorageSet(TELEMETRY_PREFERENCE_STORAGE_KEY, enabled ? 'enabled' : 'disabled');
}

function journeyId(): string {
  const existing = safeSessionStorageGet(JOURNEY_STORAGE_KEY);
  if (existing && OPAQUE_ID_PATTERN.test(existing)) {
    return existing;
  }
  const created = crypto.randomUUID();
  safeSessionStorageSet(JOURNEY_STORAGE_KEY, created);
  return created;
}

function claimOncePerJourney(event: ProductTelemetryEvent): boolean {
  const key = `cloudchef:telemetry:once:${event}`;
  if (claimedStages.has(event) || safeSessionStorageGet(key) === 'true') {
    return false;
  }
  claimedStages.add(event);
  safeSessionStorageSet(key, 'true');
  return true;
}

function safeSessionStorageGet(key: string): string | null {
  try {
    return window.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSessionStorageSet(key: string, value: string): void {
  try {
    window.sessionStorage?.setItem(key, value);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

type PageKind = 'home' | 'settings' | 'chat' | 'other';

function pageKind(): PageKind {
  const pathname = window.location.pathname;
  if (pathname === '/') {
    return 'home';
  }
  if (pathname === '/settings') {
    return 'settings';
  }
  if (pathname.startsWith('/chat/')) {
    return 'chat';
  }
  return 'other';
}
